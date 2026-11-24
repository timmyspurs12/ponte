/**
 * Test-only reader construction (Phase 2C.2A, review pass 2).
 *
 * The production reader has no exported test hooks at all: no
 * `validateTestReaderConfig`, no `registerTestTransport`, no transport constructor
 * argument. This harness is the entire reason that is workable for tests, and it lives
 * under `tests/` so it can never be bundled into the application.
 *
 * Two things are deliberately true here:
 *
 * 1. It builds a **test-scoped** reader. `runTrustedVerification` refuses such a reader
 *    with `READER_NOT_TRUSTED`, so nothing constructed here can authorize a
 *    confirmation. Tests that need authorization go through
 *    `tests/.../operator-reader-harness.ts` instead.
 * 2. Transport injection is achieved by swapping `globalThis.fetch` for the duration of
 *    a call rather than by a production injection point. That is the only remaining way
 *    to point the real transport at a loopback server, and it cannot leak into
 *    production because no production module calls this.
 */

import { TrustedEvidenceChainReader } from "../../../src/server/evidence/trusted-reader";
import type { OperatorTrustedReaderConfig } from "../../../src/server/evidence/trusted-reader-config";
import { issueTestConfig } from "./test-config-bridge";

export interface TestReaderOptions {
  readonly rpcUrl: string;
  readonly registryAddress: string;
  readonly runtimeBytecodeHash: string;
  readonly administrator: string;
  readonly timeoutMs?: number;
  readonly initialAttestor?: string;
  readonly abiHash?: string;
  readonly sourceVerification?: { status: string; url: string | null };
}

/** The manifest shape the harness builds. Exported so parity tests can tamper it. */
export function harnessManifest(options: TestReaderOptions) {
  return {
    manifestVersion: 1,
    chainId: "421614",
    contract: { name: "PonteRouteDecisionEvidenceRegistry", version: "1.0.0" },
    deployment: {
      registryAddress: options.registryAddress,
      transactionHash: `0x${"a1".repeat(32)}`,
      blockNumber: "12000000",
      runtimeBytecodeHash: options.runtimeBytecodeHash,
    },
    roles: {
      administrator: options.administrator,
      initialAttestor: options.initialAttestor ?? `0x${"33".repeat(20)}`,
    },
    build: {
      solidityCompiler: "0.8.28+commit.7893614a",
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "prague",
      viaIR: false,
      runtimeBytecodeHashAlgorithm: "keccak256",
      runtimeBytecodeHash: options.runtimeBytecodeHash,
    },
    abi: {
      version: 1,
      hashAlgorithm: "sha256",
      hash: options.abiHash ?? `0x${"aa".repeat(32)}`,
    },
    sourceVerification: options.sourceVerification ?? {
      status: "not_submitted",
      url: null,
    },
  };
}

export function harnessBuildIdentity(options: TestReaderOptions) {
  return {
    contract: { name: "PonteRouteDecisionEvidenceRegistry", version: "1.0.0" },
    compiler: "0.8.28+commit.7893614a",
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "prague",
    viaIR: false,
    runtimeBytecodeHashAlgorithm: "keccak256",
    runtimeBytecodeHash: options.runtimeBytecodeHash,
    abi: {
      version: 1,
      hashAlgorithm: "sha256",
      hash: options.abiHash ?? `0x${"aa".repeat(32)}`,
    },
  };
}

/** Builds the config input object the harness passes to the bridge. */
export function harnessConfigInput(options: TestReaderOptions) {
  return {
    rpcUrl: options.rpcUrl,
    timeoutMs: options.timeoutMs ?? 5_000,
    manifest: harnessManifest(options),
    buildIdentity: harnessBuildIdentity(options),
  };
}

/**
 * Builds a **test-scoped** reader. It can perform real RPC parsing against a loopback
 * server, but the pipeline refuses to authorize from it.
 */
export function createTestReader(
  options: TestReaderOptions,
): TrustedEvidenceChainReader {
  const result = issueTestConfig(harnessConfigInput(options));
  if (!result.ok)
    throw new Error(`test reader config rejected: ${result.failure}`);
  return new TrustedEvidenceChainReader(result.config);
}

/**
 * Runs `fn` with `globalThis.fetch` replaced by `fetchImpl`, restoring it afterwards.
 *
 * This is how the suite reaches a loopback mock server now that the production reader
 * has no injection point. Nested calls are unsafe and are rejected, so a failure in one
 * test cannot silently affect another.
 */
export async function withFetch<T>(
  fetchImpl: typeof fetch,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  if ((original as { __patched?: boolean }).__patched)
    throw new Error("withFetch: already patched");
  const patched = fetchImpl as typeof fetch & { __patched?: boolean };
  patched.__patched = true;
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    delete (patched as { __patched?: boolean }).__patched;
    globalThis.fetch = original;
  }
}

/** The config type, re-exported so harness helpers can be typed. */
export type HarnessConfig = OperatorTrustedReaderConfig;
