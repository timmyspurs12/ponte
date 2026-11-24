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
 * **No function in this module turns caller input into operator authority.** Review
 * pass 3 removed the last one. `resolveTrustedReaderConfig()` is the single
 * server-controlled source and takes no input at all; it currently reports
 * `CONFIG_MISSING` unconditionally. The only issuer that accepts input,
 * `__issueTestConfigForHarness`, always produces a test-scoped brand, which the
 * pipeline refuses by definition.
 *
 * Test configurations are a *separate* brand (`testOnly: true`) so a test-scoped
 * reader can never be mistaken for an operator one. The refusal does not depend on any
 * build-time or run-time switch:
 *
 * 1. the only issuer reachable here always sets `testOnly: true`;
 * 2. the reader records that as `operatorScoped: false` in its module-private registry
 *    entry;
 * 3. `acquireForVerification()` tests that flag unconditionally, before it invokes the
 *    acquisition closure, and returns `READER_NOT_TRUSTED`.
 *
 * There is **no test-harness flag, environment variable, build define or request field**
 * anywhere in this codebase that alters step 3. An earlier revision of this comment
 * claimed the pipeline refused test readers "outside an explicit test harness flag that
 * is itself compile-time absent from production builds"; no such flag exists, and this
 * comment now describes the actual mechanism.
 *
 * ## Why this does not import the canonical manifest validator
 *
 * `contracts/tools/registry-deployment-manifest.mjs` imports `node:fs`,
 * `node:path` and ends with a `process.argv` CLI entry point. Importing it would
 * drag build-only tooling into the Next.js server bundle. This module revalidates
 * the same fields against `registry-deployment-constants.mjs` (pure, no imports),
 * and `tests/evidence/trusted-reader-config.test.ts` cross-checks both validators
 * on identical inputs so they cannot silently drift.
 *
 * ## No production manifest exists
 *
 * `resolveTrustedReaderConfig()` takes no arguments and returns
 * `{ ok: false, failure: "CONFIG_MISSING" }` unconditionally: there is no real
 * deployment manifest, so no address or bytecode hash can be pinned. Nothing invents
 * one, and no caller can supply one.
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
 * A branded configuration. Only the module-private `validate`/`brand` path can create
 * one; the class itself is not exported.
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

/**
 * Canonical lowercase address.
 *
 * The canonical validator tests `/^0x[0-9a-f]{40}$/` against the value **as given**,
 * so an uppercase (checksummed) address is rejected. This module must agree, so the
 * pattern is applied to the raw string and no case folding happens before the check.
 */
function canonicalAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return CANONICAL_ADDRESS.test(value) ? value : null;
}

/**
 * Canonical non-zero bytes32.
 *
 * Like the address helper, this does not case fold: the canonical validator rejects
 * uppercase hex, so accepting it here would be a divergence in the permissive
 * direction.
 */
function nonzeroBytes32(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!NONZERO_BYTES32.test(value)) return null;
  return value === ZERO_BYTES32 ? null : value;
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
  if (parsedUrl.username || parsedUrl.password) return fail("CONFIG_RPC_URL");

  if (testOnly) {
    // ---- test scope: numeric loopback HTTP only ----
    //
    // Review pass 4 found that this branch admitted *any* HTTPS endpoint, because the
    // loopback condition was only consulted when the protocol was not HTTPS. A
    // server-side module could therefore obtain a test-scoped brand for a remote host,
    // construct a reader, and make it issue outbound requests through the public
    // `readAnchorObservation` method. The pipeline still refused to authorize from it,
    // but the outbound capability should never have existed.
    //
    // The restriction is enforced here, at issuance, using the single loopback
    // predicate in this module, before any brand is created. Test configuration exists
    // to reach an in-process mock; it has no legitimate use against a real host, and
    // TLS to loopback is refused too so there is exactly one accepted shape.
    if (!isNumericLoopbackHttpUrl(rpcUrl)) return fail("CONFIG_RPC_URL");
  } else {
    // ---- operator scope: HTTPS unconditionally ----
    //
    // Unreachable today: `resolveTrustedReaderConfig()` takes no input and always
    // reports `CONFIG_MISSING`, so no operator brand is ever produced. The branch is
    // kept because it is the shape a reviewed deployment will use.
    if (parsedUrl.protocol !== "https:") return fail("CONFIG_RPC_URL");
  }
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
  const abiHash = manifest.abi.hash;
  if (!/^0x[0-9a-f]{64}$/.test(abiHash) || abiHash === ZERO_BYTES32)
    return fail("CONFIG_ABI_INVALID");

  // ---- source verification (parity with the canonical validator) ----
  if (!exactKeys(manifest.sourceVerification, ["status", "url"]))
    return fail("CONFIG_SOURCE_VERIFICATION_INVALID");
  const status = manifest.sourceVerification.status;
  if (!["not_submitted", "verified", "failed"].includes(status as string))
    return fail("CONFIG_SOURCE_VERIFICATION_INVALID");
  const url = manifest.sourceVerification.url;
  // Exact parity with the canonical `assertHttpsUrlOrNull`: the URL must be `null`
  // for ANY status other than "verified" — including "failed" — and when verified it
  // must be an HTTPS URL with no embedded username or password.
  if (status !== "verified") {
    if (url !== null) return fail("CONFIG_SOURCE_VERIFICATION_INVALID");
  } else {
    if (typeof url !== "string") return fail("CONFIG_SOURCE_VERIFICATION_INVALID");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fail("CONFIG_SOURCE_VERIFICATION_INVALID");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      return fail("CONFIG_SOURCE_VERIFICATION_INVALID");
  }

  // ---- build identity cross-check (operator-pinned artifact) ----
  //
  // Parity note (review pass 2): the canonical validator compares only the fields
  // listed below and tolerates extra keys on the build identity, which is a trusted
  // artifact read from the repository rather than attacker-supplied JSON. The runtime
  // validator matches that behaviour exactly, and `tests/evidence/manifest-parity.test.ts`
  // asserts the agreement. The *manifest* remains exact-keys, in both validators.
  if (!isPlainObject(buildIdentity))
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
    buildIdentity.abi.hash !== abiHash
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
 * Test-scoped configuration issuance.
 *
 * **Review pass 3 removed operator issuance from production entirely.** Earlier
 * revisions exposed `__issueConfigForHarness(input, operatorScope)`, which could mint a
 * configuration that the trusted pipeline accepted. That function is gone: no code in
 * `src/` can produce an operator-scoped brand, because the only issuer here always sets
 * `testOnly: true`.
 *
 * A test-scoped brand is refused by `runTrustedVerification` before any work is done, so
 * it cannot authorize a confirmation however it is constructed. That makes this
 * function safe to expose for tests: it mints something the authorization boundary
 * rejects by definition.
 *
 * There is deliberately no parameter to make it operator-scoped. A caller cannot pass a
 * flag, an option, or an environment value to change that.
 *
 * @internal Imported only by the test bridge under `tests/`.
 */
export function __issueTestConfigForHarness(
  input: unknown,
): TrustedReaderConfigResult {
  // `validate` enforces numeric-loopback HTTP for test scope itself, so the endpoint
  // restriction sits at the issuance boundary rather than in a caller that might not
  // be reached. There is no argument that relaxes it.
  return validate(input, true);
}

/**
 * Loopback validation for the **test** configuration path.
 *
 * Review pass 3 tightened this: the accepted forms are numeric loopback literals only.
 * Hostname resolution is never used to establish loopback, so `localhost` and any DNS
 * name are rejected — a name is not a literal and its resolution is not something this
 * code controls. Link-local, private-range, remote and IPv4-mapped-IPv6 forms are all
 * rejected, and IPv4-mapped IPv6 is *not* normalized into acceptance.
 *
 * This function does not authorize anything by itself; it narrows where a test-scoped
 * reader may connect. Operator scope no longer exists in this module.
 */
export function isNumericLoopbackHttpUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  if (parsed.username || parsed.password) return false;
  return isNumericLoopbackHost(parsed.hostname);
}

/** True only for `127.0.0.0/8` or `::1`, written as a literal. */
export function isNumericLoopbackHost(hostname: string): boolean {
  // IPv6 literal arrives bracketed from `URL.hostname`, e.g. `[::1]`.
  const bare = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  if (bare === "::1") return true;
  // Anything else containing a colon is a non-loopback IPv6 form, including
  // IPv4-mapped (`::ffff:127.0.0.1`), which is rejected rather than normalized.
  if (bare.includes(":")) return false;
  // Reject IPv4-mapped-in-hostname and octal/hex tricks by requiring four plain
  // decimal octets with no leading zeros beyond a single `0`.
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return false;
    if (Number(part) > 255) return false;
  }
  return parts[0] === "127";
}

/**
 * The single server-controlled configuration source.
 *
 * Takes **no parameters**. An earlier revision accepted a caller-supplied `pinned`
 * argument, which would have let any module manufacture a production reader; that
 * parameter is gone.
 *
 * Review pass 3: this is now the only function in `src/` that could return an
 * operator-scoped configuration, and it never does — it reports unavailable
 * unconditionally. Operator brands cannot be minted in this codebase at all until a
 * real reviewed manifest exists.
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
