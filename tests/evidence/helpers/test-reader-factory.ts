/**
 * Test-only construction of a trusted reader (Phase 2C.2A, review pass 1).
 *
 * The production constructor accepts only a configuration this codebase branded, and
 * accepts **no** transport argument. That means the test suite cannot hand the
 * production reader a mock transport directly — which is the point.
 *
 * This harness therefore takes the one sanctioned route: it validates a
 * **test-scoped** configuration (`testOnly: true`), registers a transport against
 * that brand through `registerTestTransport`, and constructs the real reader. The
 * resulting reader is genuinely test-scoped, and `assertAuthorizable` refuses to let
 * a test treat it as a production authorization path unless the test explicitly opts
 * in — so a test cannot accidentally prove something about production behaviour.
 *
 * Lives under `tests/`, so it is never bundled into the application.
 */

import {
  TrustedEvidenceChainReader,
  registerTestTransport,
} from "../../../src/server/evidence/trusted-reader";
import {
  validateTestReaderConfig,
  type OperatorTrustedReaderConfig,
} from "../../../src/server/evidence/trusted-reader-config";

export interface TestReaderOptions {
  readonly rpcUrl: string;
  readonly registryAddress: string;
  readonly runtimeBytecodeHash: string;
  readonly administrator: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** Builds a test-scoped reader. Throws if the configuration is rejected. */
export function createTestReader(
  options: TestReaderOptions,
): TrustedEvidenceChainReader {
  const result = validateTestReaderConfig({
    rpcUrl: options.rpcUrl,
    timeoutMs: options.timeoutMs ?? 5_000,
    manifest: {
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
        initialAttestor: `0x${"33".repeat(20)}`,
      },
      build: {
        solidityCompiler: "0.8.28+commit.7893614a",
        optimizer: { enabled: true, runs: 200 },
        evmVersion: "prague",
        viaIR: false,
        runtimeBytecodeHashAlgorithm: "keccak256",
        runtimeBytecodeHash: options.runtimeBytecodeHash,
      },
      abi: { version: 1, hashAlgorithm: "sha256", hash: `0x${"aa".repeat(32)}` },
      sourceVerification: { status: "not_submitted", url: null },
    },
    buildIdentity: {
      contract: { name: "PonteRouteDecisionEvidenceRegistry", version: "1.0.0" },
      compiler: "0.8.28+commit.7893614a",
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "prague",
      viaIR: false,
      runtimeBytecodeHashAlgorithm: "keccak256",
      runtimeBytecodeHash: options.runtimeBytecodeHash,
      abi: { version: 1, hashAlgorithm: "sha256", hash: `0x${"aa".repeat(32)}` },
    },
  });
  if (!result.ok)
    throw new Error(`test reader config rejected: ${result.failure}`);

  const config: OperatorTrustedReaderConfig = result.config;
  if (options.fetchImpl)
    // Registered through the private channel; only a test-scoped brand is accepted.
    registerTransport(config, options.fetchImpl);

  return new TrustedEvidenceChainReader(config);
}

function registerTransport(
  config: OperatorTrustedReaderConfig,
  fetchImpl: typeof fetch,
) {
  registerTestTransport(config, fetchImpl);
}
