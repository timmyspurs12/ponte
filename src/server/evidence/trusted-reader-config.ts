/**
 * Operator-pinned trusted-reader configuration (Phase 2C.2A).
 *
 * The configuration this module validates is the *only* thing that can enable the
 * production reader. It must arrive from server-side configuration — never from a
 * request body, header, query string, client-supplied file or URL.
 *
 * ## Why this does not import the canonical manifest validator
 *
 * `contracts/tools/registry-deployment-manifest.mjs` is the authoritative manifest
 * validator, and this module deliberately does **not** import it. That file:
 *
 * - imports `node:fs` and `node:path` at module scope;
 * - ends with a `if (import.meta.url === ...) main()` CLI entry point;
 * - pulls in `registry-build-identity.mjs`, which reads foundry artifacts off disk.
 *
 * Importing it from `src/` would drag build-only tooling and a CLI into the Next.js
 * server bundle, and would make module-loading depend on filesystem layout. So this
 * module revalidates the *same fields with the same constants*, imported from
 * `registry-deployment-constants.mjs`, which is 19 lines of pure frozen values and
 * safe for runtime use.
 *
 * This is a deliberate, documented duplication of *assertions*, not of format. The
 * canonical manifest remains the artefact of record and is validated by the existing
 * tooling in CI; a manifest accepted here must also satisfy that tool. To keep the
 * two from silently drifting, `tests/evidence/trusted-reader-config.test.ts`
 * cross-checks this validator against the canonical one on the same inputs.
 *
 * ## There is no production manifest in this repository
 *
 * No real Registry deployment manifest exists yet, so `resolveTrustedReaderConfig()`
 * returns `null` in this configuration and the reader stays disabled. This module
 * never invents an address, transaction hash or deployment record.
 */

import "server-only";

import {
  ARBITRUM_SEPOLIA_CHAIN_ID as MANIFEST_CHAIN_ID,
  DEPLOYMENT_MANIFEST_VERSION,
  EXPECTED_BUILD_CONFIGURATION,
  REGISTRY_CONTRACT_NAME,
  REGISTRY_CONTRACT_VERSION,
} from "../../../contracts/tools/registry-deployment-constants.mjs";

/** The official Arbitrum Sepolia endpoint, documented as the no-API-key option. */
export const ARBITRUM_SEPOLIA_RPC_URL =
  "https://sepolia-rollup.arbitrum.io/rpc";

export type TrustedReaderConfigFailure =
  | "CONFIG_MISSING"
  | "CONFIG_NOT_OBJECT"
  | "CONFIG_UNEXPECTED_KEY"
  | "CONFIG_MANIFEST_VERSION"
  | "CONFIG_CHAIN_ID"
  | "CONFIG_CONTRACT_NAME"
  | "CONFIG_CONTRACT_VERSION"
  | "CONFIG_ADDRESS"
  | "CONFIG_TRANSACTION_HASH"
  | "CONFIG_BLOCK_NUMBER"
  | "CONFIG_RUNTIME_HASH"
  | "CONFIG_RPC_URL"
  | "CONFIG_TIMEOUT"
  | "CONFIG_BUILD_IDENTITY_MISSING";

export type TrustedReaderConfigResult =
  | { readonly ok: true; readonly config: TrustedReaderConfig }
  | { readonly ok: false; readonly failure: TrustedReaderConfigFailure };

/**
 * The validated, immutable configuration a reader is built from.
 *
 * `registryAddress` and `runtimeBytecodeHash` are the two values an attacker would
 * most want to control: the first decides which contract is consulted, the second
 * decides which bytecode counts as "our Registry". Both come only from here.
 */
export interface TrustedReaderConfig {
  readonly rpcUrl: string;
  readonly timeoutMs: number;
  readonly chainId: string;
  readonly registryAddress: string;
  readonly runtimeBytecodeHash: string;
  readonly deploymentTransactionHash: string;
  readonly deploymentBlockNumber: string;
  /** Administrator the manifest pins; used by the positive control call. */
  readonly administrator: string;
}

const CONFIG_KEYS = new Set([
  "manifest",
  "rpcUrl",
  "timeoutMs",
  "buildIdentity",
]);

const CANONICAL_ADDRESS = /^0x[0-9a-f]{40}$/;
const NONZERO_BYTES32 = /^0x[0-9a-f]{64}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(failure: TrustedReaderConfigFailure): TrustedReaderConfigResult {
  return { ok: false, failure };
}

function canonicalAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lowered = value.toLowerCase();
  return CANONICAL_ADDRESS.test(lowered) ? lowered : null;
}

function nonzeroBytes32(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lowered = value.toLowerCase();
  if (!NONZERO_BYTES32.test(lowered)) return null;
  return lowered === ZERO_BYTES32 ? null : lowered;
}

function positiveDecimal(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return POSITIVE_DECIMAL.test(value) ? value : null;
}

/** Exact-key assertion: a manifest with extra fields is rejected, not tolerated. */
function exactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value);
  if (actual.length !== keys.length) return false;
  return keys.every((key) => actual.includes(key));
}

/**
 * Validates an operator-supplied configuration object.
 *
 * This mirrors the assertions of `validateDeploymentManifest` +
 * `assertManifestMatchesBuildIdentity` for the fields the runtime needs, using the
 * same pinned constants. Anything unexpected is rejected.
 */
export function validateTrustedReaderConfig(
  input: unknown,
): TrustedReaderConfigResult {
  if (input === undefined || input === null) return fail("CONFIG_MISSING");
  if (!isPlainObject(input)) return fail("CONFIG_NOT_OBJECT");
  for (const key of Object.keys(input))
    if (!CONFIG_KEYS.has(key)) return fail("CONFIG_UNEXPECTED_KEY");

  const { manifest, buildIdentity, rpcUrl, timeoutMs } = input;

  // ---- endpoint and timeout ----
  if (typeof rpcUrl !== "string") return fail("CONFIG_RPC_URL");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rpcUrl);
  } catch {
    return fail("CONFIG_RPC_URL");
  }
  if (parsedUrl.protocol !== "https:") return fail("CONFIG_RPC_URL");
  if (parsedUrl.username || parsedUrl.password) return fail("CONFIG_RPC_URL");
  if (!Number.isInteger(timeoutMs)) return fail("CONFIG_TIMEOUT");
  const timeout = timeoutMs as number;
  if (timeout < 100 || timeout > 30_000) return fail("CONFIG_TIMEOUT");

  // ---- manifest envelope ----
  if (
    !exactKeys(manifest, [
      "manifestVersion",
      "chainId",
      "contract",
      "deployment",
      "roles",
      "build",
      "abi",
      "sourceVerification",
    ])
  )
    return fail("CONFIG_NOT_OBJECT");
  if (manifest.manifestVersion !== DEPLOYMENT_MANIFEST_VERSION)
    return fail("CONFIG_MANIFEST_VERSION");
  if (manifest.chainId !== MANIFEST_CHAIN_ID) return fail("CONFIG_CHAIN_ID");

  if (!exactKeys(manifest.contract, ["name", "version"]))
    return fail("CONFIG_CONTRACT_NAME");
  if (manifest.contract.name !== REGISTRY_CONTRACT_NAME)
    return fail("CONFIG_CONTRACT_NAME");
  if (manifest.contract.version !== REGISTRY_CONTRACT_VERSION)
    return fail("CONFIG_CONTRACT_VERSION");

  // The build must be the reviewed local build, byte for byte.
  if (
    !exactKeys(manifest.build, [
      "solidityCompiler",
      "optimizer",
      "evmVersion",
      "viaIR",
      "runtimeBytecodeHashAlgorithm",
      "runtimeBytecodeHash",
    ])
  )
    return fail("CONFIG_BUILD_IDENTITY_MISSING");
  if (
    manifest.build.solidityCompiler !==
    EXPECTED_BUILD_CONFIGURATION.solidityCompiler
  )
    return fail("CONFIG_BUILD_IDENTITY_MISSING");
  if (
    !exactKeys(manifest.build.optimizer, ["enabled", "runs"]) ||
    manifest.build.optimizer.enabled !==
      EXPECTED_BUILD_CONFIGURATION.optimizer.enabled ||
    manifest.build.optimizer.runs !==
      EXPECTED_BUILD_CONFIGURATION.optimizer.runs
  )
    return fail("CONFIG_BUILD_IDENTITY_MISSING");
  if (manifest.build.evmVersion !== EXPECTED_BUILD_CONFIGURATION.evmVersion)
    return fail("CONFIG_BUILD_IDENTITY_MISSING");
  if (manifest.build.viaIR !== EXPECTED_BUILD_CONFIGURATION.viaIR)
    return fail("CONFIG_BUILD_IDENTITY_MISSING");
  if (
    manifest.build.runtimeBytecodeHashAlgorithm !==
    EXPECTED_BUILD_CONFIGURATION.runtimeBytecodeHashAlgorithm
  )
    return fail("CONFIG_BUILD_IDENTITY_MISSING");

  // ---- deployment (the trusted address and hash) ----
  if (
    !exactKeys(manifest.deployment, [
      "registryAddress",
      "transactionHash",
      "blockNumber",
      "runtimeBytecodeHash",
    ])
  )
    return fail("CONFIG_ADDRESS");
  const registryAddress = canonicalAddress(manifest.deployment.registryAddress);
  if (!registryAddress || registryAddress === ZERO_ADDRESS)
    return fail("CONFIG_ADDRESS");
  const deploymentTransactionHash = nonzeroBytes32(
    manifest.deployment.transactionHash,
  );
  if (!deploymentTransactionHash) return fail("CONFIG_TRANSACTION_HASH");
  const deploymentBlockNumber = positiveDecimal(
    manifest.deployment.blockNumber,
  );
  if (!deploymentBlockNumber) return fail("CONFIG_BLOCK_NUMBER");
  const runtimeBytecodeHash = nonzeroBytes32(
    manifest.deployment.runtimeBytecodeHash,
  );
  if (!runtimeBytecodeHash) return fail("CONFIG_RUNTIME_HASH");
  // The manifest's build hash and deployment hash must agree, exactly as the
  // canonical validator requires; otherwise "pinned" would be two different values.
  if (
    nonzeroBytes32(manifest.build.runtimeBytecodeHash) !== runtimeBytecodeHash
  )
    return fail("CONFIG_RUNTIME_HASH");

  // ---- roles ----
  if (!exactKeys(manifest.roles, ["administrator", "initialAttestor"]))
    return fail("CONFIG_ADDRESS");
  const administrator = canonicalAddress(manifest.roles.administrator);
  const initialAttestor = canonicalAddress(manifest.roles.initialAttestor);
  if (!administrator || administrator === ZERO_ADDRESS)
    return fail("CONFIG_ADDRESS");
  if (!initialAttestor || initialAttestor === ZERO_ADDRESS)
    return fail("CONFIG_ADDRESS");
  if (administrator === initialAttestor) return fail("CONFIG_ADDRESS");

  // ---- build identity cross-check (operator-pinned artifact) ----
  if (!isPlainObject(buildIdentity))
    return fail("CONFIG_BUILD_IDENTITY_MISSING");
  if (
    (buildIdentity as { runtimeBytecodeHash?: unknown }).runtimeBytecodeHash !==
    runtimeBytecodeHash
  )
    return fail("CONFIG_BUILD_IDENTITY_MISSING");
  if (
    (buildIdentity as { contract?: { name?: unknown } }).contract?.name !==
    REGISTRY_CONTRACT_NAME
  )
    return fail("CONFIG_BUILD_IDENTITY_MISSING");

  return {
    ok: true,
    config: Object.freeze({
      rpcUrl: parsedUrl.toString(),
      timeoutMs: timeout,
      chainId: MANIFEST_CHAIN_ID,
      registryAddress,
      runtimeBytecodeHash,
      deploymentTransactionHash,
      deploymentBlockNumber,
      administrator,
    }),
  };
}

/**
 * Resolves the production reader configuration from server-side state.
 *
 * Returns `null` because **no real deployment manifest exists**. There is no
 * environment variable, file path or request field that can substitute one: the
 * parameter exists so tests can exercise the validator directly, and so a future
 * phase can wire a reviewed manifest in one place.
 */
export function resolveTrustedReaderConfig(
  pinned: unknown = undefined,
): TrustedReaderConfigResult {
  return validateTrustedReaderConfig(pinned);
}
