/**
 * Operator-pinned trusted-reader configuration (Phase 2C.2A, review pass 1).
 *
 * ## Provenance, not shape
 *
 * Validating an object proves only that it *looks* like configuration. Any request
 * handler could construct a structurally valid object with an attacker-chosen
 * Registry address and RPC endpoint, and a plain validator would happily bless it.
 *
 * So a validated configuration is returned as a branded `OperatorTrustedReaderConfig`
 * instance: an unexported class, registered in a module-private `WeakSet`, carrying
 * a private field. `TrustedEvidenceChainReader`'s constructor accepts nothing else.
 * There is no exported function that turns arbitrary caller input into production
 * authority except `issueOperatorConfig`, which is called only by
 * `resolveTrustedReaderConfig()` — the single server-controlled source.
 *
 * Test configurations are a *separate* brand (`testOnly: true`) so a test-scoped
 * reader can never be mistaken for an operator one, and the pipeline refuses to
 * authorize from a test-scoped reader outside an explicit test harness flag that is
 * itself compile-time absent from production builds.
 *
 * ## Why this does not import the canonical manifest validator
 *
 * `contracts/tools/registry-deployment-manifest.mjs` imports `node:fs`,
 * `node:path` and ends with a `process.argv` CLI entry point. Importing it would
 * drag build-only tooling into the Next.js server bundle. This module revalidates
 * fhe same fields against `registry-deployment-constants.mjs` (pure, no imports),
 * and `tests/evidence/trusted-reader-config.test.ts` cross-checks both validators
 * on identical inputs so they cannot silently drift.
 *
 * ## No production manifest exists
 *
 * `resolveTrustedReaderConfig()` returns `null`: there is no real deployment
 * manifest, so no address or bytecode hash can be pinned. Nothing invents one.
 */

import "server-only";

import {
  ARBITRUM_SEPOLIA_CHAIN_ID as MANIFEST_CHAIN_ID,
  DEPLOYMENT_MANIFEST_VERSION,
  EXPECTED_BUILD_CONFIGURATION,
  REGISTRY_ABI_VERSION,
  REGISTRY_CONTRACT_NAME,
  REGISTRY_CONTRACT_VERSION,
  RUNTIME_BYTECODE_HASH_ALGORITHM,
  ABI_HASH_ALGORITHM,
} from "../../../contracts/tools/registry-deployment-constants.mjs";

/** The official Arbitrum Sepolia endpoint, documented as the no-API-key option. */
export const ARBITRUM_SEPOLIA_RPC_URL = "https://sepolia-rollup.arbitrum.io/rpc";

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
  | "CONFIG_BUILD_IDENTITY_MISSING"
  | "CONFIG_BUILD_CONFIGURATION"
  | "CONFIG_ABI_INVALID"
  | "CONFIG_SOURCE_VERIFICATION_INVALID";

/** Validated configuration values. Internal; consumers see the branded class. */
export interface TrustedReaderConfigValues {
  readonly rpcUrl: string;
  readonly timeoutMs: number;
  readonly chainId: string;
  readonly registryAddress: string;
  readonly runtimeBytecodeHash: string;
  readonly deploymentTransactionHash: string;
  readonly deploymentBlockNumber: string;
  readonly administrator: string;
  readonly testOnly: boolean;
}

/**
 * A branded configuration. Only `issueOperatorConfig` / `issueTestConfig` can create
 * one, and both are module-private; the class is not exported either.
 */
class BrandedTrustedReaderConfig implements TrustedReaderConfigValues {
  readonly #token: symbol;

  constructor(
    readonly rpcUrl: string,
    readonly timeoutMs: number,
    readonly chainId: string,
    readonly registryAddress: string,
    readonly runtimeBytecodeHash: string,
    readonly deploymentTransactionHash: string,
    readonly deploymentBlockNumber: string,
    readonly administrator: string,
    readonly testOnly: boolean,
  ) {
    this.#token = CONFIG_PRIVATE;
  }

  owns(value: unknown): boolean {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as BrandedTrustedReaderConfig).#token === CONFIG_PRIVATE
    );
  }
}

const CONFIG_PRIVATE = Symbol.for("ponte.trusted-reader-config.v1");
const BRANDED = new WeakSet<object>();

/** The public shape consumers may reference in types. */
export type OperatorTrustedReaderConfig = TrustedReaderConfigValues;

function brand(values: TrustedReaderConfigValues): OperatorTrustedReaderConfig {
  const config = new BrandedTrustedReaderConfig(
    values.rpcUrl,
    values.timeoutMs,
    values.chainId,
    values.registryAddress,
    values.runtimeBytecodeHash,
    values.deploymentTransactionHash,
    values.deploymentBlockNumber,
    values.administrator,
    values.testOnly,
  );
  BRANDED.add(config);
  return Object.freeze(config) as OperatorTrustedReaderConfig;
}

/** True when `value` is a configuration this module branded. */
export function isBrandedReaderConfig(
  value: unknown,
): value is OperatorTrustedReaderConfig {
  return (
    value instanceof BrandedTrustedReaderConfig &&
    BRANDED.has(value) &&
    value.owns(value)
  );
}

export type TrustedReaderConfigResult =
  | { readonly ok: true; readonly config: OperatorTrustedReaderConfig }
  | { readonly ok: false; readonly failure: TrustedReaderConfigFailure };

const CONFIG_KEYS = new Set(["manifest", "rpcUrl", "timeoutMs", "buildIdentity"]);

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

/** Exact-key assertion: extra fields are rejected, not tolerated. */
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
 * Validates a manifest and build identity into a branded configuration.
 *
 * Parity with the canonical validator is *complete* for every field the runtime
 * consumes, including the nested `abi` and `sourceVerification` blocks, so a
 * manifest accepted here is accepted by `validateDeploymentManifest` and vice
 * versa. Fields the runtime does not consume are still shape-checked rather than
 * ignored.
 *
 * `testOnly` is never controllable by input; only `issueTestConfig` sets it.
 */
function validate(
  input: unknown,
  testOnly: boolean,
  allowLoopbackHttp = false,
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
  const loopback =
    parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost";
  // Production requires HTTPS unconditionally. Only a test-scoped configuration may
  // use plain HTTP, and only against loopback.
  if (parsedUrl.protocol !== "https:") {
    if (!(allowLoopbackHttp && parsedUrl.protocol === "http:" && loopback))
      return fail("CONFIG_RPC_URL");
  }
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

  // ---- build: the reviewed local build, byte for byte ----
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
    return fail("CONFIG_BUILD_CONFIGURATION");
  if (manifest.build.solidityCompiler !== EXPECTED_BUILD_CONFIGURATION.solidityCompiler)
    return fail("CONFIG_BUILD_CONFIGURATION");
  if (
    !exactKeys(manifest.build.optimizer, ["enabled", "runs"]) ||
    manifest.build.optimizer.enabled !==
      EXPECTED_BUILD_CONFIGURATION.optimizer.enabled ||
    manifest.build.optimizer.runs !== EXPECTED_BUILD_CONFIGURATION.optimizer.runs
  )
    return fail("CONFIG_BUILD_CONFIGURATION");
  if (manifest.build.evmVersion !== EXPECTED_BUILD_CONFIGURATION.evmVersion)
    return fail("CONFIG_BUILD_CONFIGURATION");
  if (manifest.build.viaIR !== EXPECTED_BUILD_CONFIGURATION.viaIR)
    return fail("CONFIG_BUILD_CONFIGURATION");
  if (
    manifest.build.runtimeBytecodeHashAlgorithm !== RUNTIME_BYTECODE_HASH_ALGORITHM
  )
    return fail("CONFIG_BUILD_CONFIGURATION");

  // ---- deployment: the trusted address and hash ----
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
  const deploymentBlockNumber = positiveDecimal(manifest.deployment.blockNumber);
  if (!deploymentBlockNumber) return fail("CONFIG_BLOCK_NUMBER");
  const runtimeBytecodeHash = nonzeroBytes32(
    manifest.deployment.runtimeBytecodeHash,
  );
  if (!runtimeBytecodeHash) return fail("CONFIG_RUNTIME_HASH");
  if (nonzeroBytes32(manifest.build.runtimeBytecodeHash) !== runtimeBytecodeHash)
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

  // ---- ABI (parity with the canonical validator) ----
  if (!exactKeys(manifest.abi, ["version", "hashAlgorithm", "hash"]))
    return fail("CONFIG_ABI_INVALID");
  if (manifest.abi.version !== REGISTRY_ABI_VERSION)
    return fail("CONFIG_ABI_INVALID");
  if (manifest.abi.hashAlgorithm !== ABI_HASH_ALGORITHM)
    return fail("CONFIG_ABI_INVALID");
  // Parity with `assertNonzeroBytes32` in the canonical validator: a 0x-prefixed
  // 64-hex value that is not all zeroes.
  if (typeof manifest.abi.hash !== "string")
    return fail("CONFIG_ABI_INVALID");
  const abiHash = manifest.abi.hash.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(abiHash) || abiHash === ZERO_BYTES32)
    return fail("CONFIG_ABI_INVALID");

  // ---- source verification (parity with the canonical validator) ----
  if (!exactKeys(manifest.sourceVerification, ["status", "url"]))
    return fail("CONFIG_SOURCE_VERIFICATION_INVALID");
  const status = manifest.sourceVerification.status;
  if (!["not_submitted", "verified", "failed"].includes(status as string))
    return fail("CONFIG_SOURCE_VERIFICATION_INVALID");
  const url = manifest.sourceVerification.url;
  if (status === "not_submitted") {
    if (url !== null) return fail("CONFIG_SOURCE_VERIFICATION_INVALID");
  } else {
    // `verified` and `failed` require an HTTPS explorer URL.
    if (typeof url !== "string") return fail("CONFIG_SOURCE_VERIFICATION_INVALID");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fail("CONFIG_SOURCE_VERIFICATION_INVALID");
    }
    if (parsed.protocol !== "https:") return fail("CONFIG_SOURCE_VERIFICATION_INVALID");
  }

  // ---- build identity cross-check (operator-pinned artifact) ----
  if (
    !exactKeys(buildIdentity, [
      "contract",
      "compiler",
      "optimizer",
      "evmVersion",
      "viaIR",
      "runtimeBytecodeHashAlgorithm",
      "runtimeBytecodeHash",
      "abi",
    ])
  )
    return fail("CONFIG_BUILD_IDENTITY_MISSING");
  if (!exactKeys(buildIdentity.contract, ["name", "version"]))
    return fail("CONFIG_BUILD_IDENTITY_MISSING");
  if (buildIdentity.contract.name !== REGISTRY_CONTRACT_NAME)
    return fail("CONFIG_BUILD_IDENTITY_MISSING");
  if (buildIdentity.contract.version !== REGISTRY_CONTRACT_VERSION)
    return fail("CONFIG_BUILD_IDENTITY_MISSING");
  if (buildIdentity.compiler !== manifest.build.solidityCompiler)
    return fail("CONFIG_BUILD_IDENTITY_MISSING");
  if (
    !exactKeys(buildIdentity.optimizer, ["enabled", "runs"]) ||
    buildIdentity.optimizer.enabled !==
      EXPECTED_BUILD_CONFIGURATION.optimizer.enabled ||
    buildIdentity.optimizer.runs !== EXPECTED_BUILD_CONFIGURATION.optimizer.runs
  )
    return fail("CONFIG_BUILD_IDENTITY_MISSING");
  if (buildIdentity.evmVersion !== manifest.build.evmVersion)
    return fail("CONFIG_BUILD_IDENTITY_MISSING");
  if (buildIdentity.viaIR !== manifest.build.viaIR)
    return fail("CONFIG_BUILD_IDENTITY_MISSING");
  if (
    buildIdentity.runtimeBytecodeHashAlgorithm !==
    manifest.build.runtimeBytecodeHashAlgorithm
  )
    return fail("CONFIG_BUILD_IDENTITY_MISSING");
  if (buildIdentity.runtimeBytecodeHash !== runtimeBytecodeHash)
    return fail("CONFIG_BUILD_IDENTITY_MISSING");
  if (!exactKeys(buildIdentity.abi, ["version", "hashAlgorithm", "hash"]))
    return fail("CONFIG_ABI_INVALID");
  if (
    buildIdentity.abi.version !== REGISTRY_ABI_VERSION ||
    buildIdentity.abi.hashAlgorithm !== ABI_HASH_ALGORITHM ||
    String(buildIdentity.abi.hash).toLowerCase() !== abiHash
  )
    return fail("CONFIG_ABI_INVALID");

  return {
    ok: true,
    config: brand({
      rpcUrl: parsedUrl.toString(),
      timeoutMs: timeout,
      chainId: MANIFEST_CHAIN_ID,
      registryAddress,
      runtimeBytecodeHash,
      deploymentTransactionHash,
      deploymentBlockNumber,
      administrator,
      testOnly,
    }),
  };
}

/**
 * Validates a **test-scoped** configuration.
 *
 * This is the only exported validator, and it can never produce an operator brand.
 * It is named `...Test...` so an accidental production import is obvious in review,
 * and it permits a loopback `http:` endpoint so the suite can drive the real reader
 * against an in-process mock server. Production configuration requires `https:`.
 */
export function validateTestReaderConfig(
  input: unknown,
): TrustedReaderConfigResult {
  return validate(input, true, true);
}

/**
 * The single server-controlled configuration source.
 *
 * Takes **no parameters**. An earlier revision accepted a caller-supplied `pinned`
 * argument, which would have let any module manufacture a production reader; that
 * parameter is gone.
 *
 * Returns an error because **no real deployment manifest exists**. When one does,
 * it is loaded here — and only here — from a reviewed server-side artefact. There is
 * deliberately no environment variable, file path, request field or flag that can
 * supply it, so the reader cannot be enabled by configuration accident.
 */
export function resolveTrustedReaderConfig(): TrustedReaderConfigResult {
  // Intentionally no input. Gating on an absent manifest, not on configuration.
  return { ok: false, failure: "CONFIG_MISSING" };
}
