// Approved historical KMS key-version configuration (Phase 2D.2.2, PR A).
//
// This module establishes the **trust boundary only**: a fail-closed,
// server-controlled contract describing the versions of the existing GCP
// symmetric Cloud KMS key that this deployment approves. It distinguishes:
//
// - the stable parent `CryptoKey` resource (`cryptoKeyReference`),
// - the single current write `CryptoKeyVersion` (`currentWriteVersion`),
// - zero or more explicitly approved historical `CryptoKeyVersion`
//   resources (`approvedHistoricalVersions`).
//
// ## Trust boundary
//
// The resolver takes **no caller-supplied arguments**. The configuration
// authority is a server-controlled, reviewed deployment configuration
// source — the same class of source as the Registry deployment manifest
// (`resolveTrustedReaderConfig()`). No request data, database row,
// caller-supplied value, or client-controlled value is configuration
// authority. No key resource is invented and no version is fabricated:
// until a genuinely reviewed configuration exists, resolution fails
// closed with the stable `CONFIG_MISSING` result.
//
// ## Same-parent restriction
//
// Every approved version (the current write version and each historical
// version) must parse as an exact immutable `CryptoKeyVersion` resource
// through the adapter's own parser (`parseGcpCryptoKeyVersion`,
// `parseGcpCryptoKey`) and must derive to exactly the one configured
// parent `CryptoKey`. Cross-key configuration is rejected, so this
// contract can never authorize decryption against a second key.
//
// ## Consistency with the PR #24 current-version configuration
//
// The existing `PONTE_KMS_CRYPTO_KEY_VERSION` environment variable is the
// PR #24 authority for the write version selected by the production
// composition root. It is not a second, independent source of the current
// version: every successful resolution enforces exact consistency between
// the reviewed configuration's `currentWriteVersion` and the validated
// `PONTE_KMS_CRYPTO_KEY_VERSION`. The two sources must agree exactly; any
// absence, malformation, or mismatch fails closed with `CONFIG_INVALID`.
//
// ## Process immutability
//
// The approved set, the parent reference and the current write version are
// one configuration unit. Once the process-scoped configuration is
// initialized, a later resolution that yields a different unit fails
// closed with `CONFIG_CHANGED` and requires a process restart; the
// configuration is never silently reloaded or replaced while requests may
// be using it. This follows the immutable process-configuration principle
// introduced in PR #24 and does not alter the KMS client lifecycle.
//
// ## Test-only boundary
//
// Mock injection lives behind
// `resolveApprovedKmsKeyVersionsForTest()`, which throws unless
// `NODE_ENV === "test"`, and `resetApprovedKmsKeyVersionsCacheForTest()`
// clears the process-scoped cache (equivalent to a process restart) so
// tests initialize their own configuration independently. Production-
// facing resolution accepts no injected key lists.
import "server-only";

import {
  parseGcpCryptoKey,
  parseGcpCryptoKeyVersion,
  type ParsedGcpCryptoKeyVersion,
} from "./gcp-kms-provider";
import { PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV } from "./production-routing-config";

/** Stable failure codes for the approved KMS key-version configuration. */
export type ApprovedKmsKeyVersionsFailure =
  | "CONFIG_MISSING"
  | "CONFIG_INVALID"
  | "CONFIG_CHANGED";

/**
 * The approved versions of one GCP symmetric Cloud KMS key. All resource
 * strings are exact immutable provider resource forms; the historical list
 * is an ordered, unique, same-parent set.
 */
export interface ApprovedKmsKeyVersions {
  /** Stable parent `CryptoKey` resource shared by every approved version. */
  readonly cryptoKeyReference: string;
  /** The single current write `CryptoKeyVersion` resource. */
  readonly currentWriteVersion: string;
  /** Zero or more explicitly approved historical `CryptoKeyVersion` resources. */
  readonly approvedHistoricalVersions: readonly string[];
}

export type ApprovedKmsKeyVersionsResult =
  | { readonly ok: true; readonly config: ApprovedKmsKeyVersions }
  | { readonly ok: false; readonly failure: ApprovedKmsKeyVersionsFailure };

/** Stable message for the test-only seam's production rejection. */
export const APPROVED_KMS_VERSIONS_TEST_SEAM_ERROR =
  "approved KMS key-version configuration test seam is unavailable outside the test environment";

/** Exact configuration field set; nothing else is accepted. */
const CONFIG_FIELDS = [
  "cryptoKeyReference",
  "currentWriteVersion",
  "approvedHistoricalVersions",
] as const;

let approvedKmsKeyVersionsCache: ApprovedKmsKeyVersions | undefined;

function configurationInvalid(): {
  readonly ok: false;
  readonly failure: "CONFIG_INVALID";
} {
  return { ok: false, failure: "CONFIG_INVALID" };
}

/**
 * Parses one exact immutable `CryptoKeyVersion` resource, returning
 * `undefined` when the adapter parser rejects it. The parser itself
 * validates the parent `CryptoKey` form and the approved location, so a
 * successful parse is sufficient resource validation.
 */
function tryParseVersion(
  resource: unknown,
): ParsedGcpCryptoKeyVersion | undefined {
  try {
    return parseGcpCryptoKeyVersion(resource);
  } catch {
    // Malformed resources fail closed here as configuration errors, never
    // as provider-operation errors and never with provider details.
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Validates a raw configuration object into the frozen
 * `ApprovedKmsKeyVersions` contract. It never contacts Cloud KMS, never
 * determines whether a version is enabled at runtime, and never accepts
 * partial or invented resources.
 */
export function validateApprovedKmsKeyVersions(
  raw: unknown,
): { readonly ok: true; readonly config: ApprovedKmsKeyVersions } | {
  readonly ok: false;
  readonly failure: "CONFIG_INVALID";
} {
  if (!isPlainObject(raw)) return configurationInvalid();

  const actualKeys = Object.keys(raw).sort();
  const expectedKeys = [...CONFIG_FIELDS].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return configurationInvalid();
  }

  const { cryptoKeyReference, currentWriteVersion, approvedHistoricalVersions } =
    raw;

  // The parent CryptoKey resource: exact form, approved location.
  let parent: ReturnType<typeof parseGcpCryptoKey> | undefined;
  try {
    parent = parseGcpCryptoKey(cryptoKeyReference);
  } catch {
    return configurationInvalid();
  }
  if (!parent) return configurationInvalid();

  // The current write version: exact form and exactly this parent.
  const writeVersion = tryParseVersion(currentWriteVersion);
  if (!writeVersion) return configurationInvalid();
  if (writeVersion.cryptoKeyReference !== parent.cryptoKeyReference)
    return configurationInvalid();

  // Historical versions: exact form, exactly this parent, unique, and never
  // the current write version.
  if (!Array.isArray(approvedHistoricalVersions))
    return configurationInvalid();
  const historical: string[] = [];
  for (const entry of approvedHistoricalVersions) {
    if (typeof entry !== "string" || entry.length === 0)
      return configurationInvalid();
    const parsed = tryParseVersion(entry);
    if (!parsed) return configurationInvalid();
    if (parsed.cryptoKeyReference !== parent.cryptoKeyReference)
      return configurationInvalid();
    if (parsed.cryptoKeyVersion === writeVersion.cryptoKeyVersion)
      return configurationInvalid();
    if (historical.includes(parsed.cryptoKeyVersion))
      return configurationInvalid();
    historical.push(parsed.cryptoKeyVersion);
  }

  return {
    ok: true,
    config: Object.freeze({
      cryptoKeyReference: parent.cryptoKeyReference,
      currentWriteVersion: writeVersion.cryptoKeyVersion,
      approvedHistoricalVersions: Object.freeze(historical),
    }),
  };
}

/**
 * Enforces exact consistency between the reviewed configuration's current
 * write version and the PR #24 `PONTE_KMS_CRYPTO_KEY_VERSION` authority.
 * The two sources may not disagree; absence or malformation of the
 * environment configuration is itself a disagreement.
 */
function enforceCurrentVersionConsistency(
  config: ApprovedKmsKeyVersions,
): ApprovedKmsKeyVersionsResult {
  const configured = process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV];
  const parsed = tryParseVersion(configured);
  if (!parsed || parsed.cryptoKeyVersion !== config.currentWriteVersion)
    return configurationInvalid();
  return { ok: true, config };
}

/**
 * True when two resolved configurations are the same approved unit: the
 * same parent, the same current write version, and the same historical
 * set. The historical set is compared as a sorted set, so a reordering
 * of the reviewed list is not a semantic change.
 */
function isSameConfiguration(
  cached: ApprovedKmsKeyVersions,
  resolved: ApprovedKmsKeyVersions,
): boolean {
  if (cached.cryptoKeyReference !== resolved.cryptoKeyReference) return false;
  if (cached.currentWriteVersion !== resolved.currentWriteVersion)
    return false;
  const cachedHistorical = [...cached.approvedHistoricalVersions].sort();
  const resolvedHistorical = [...resolved.approvedHistoricalVersions].sort();
  return (
    cachedHistorical.length === resolvedHistorical.length &&
    cachedHistorical.every((value, index) => value === resolvedHistorical[index])
  );
}

/**
 * Completes a successful resolution under the process-immutability
 * policy: an initialized cache that differs from the newly resolved unit
 * fails closed with `CONFIG_CHANGED`; the cache is written only once,
 * atomically, on the first successful resolution.
 */
function applyConfigurationImmutability(
  resolved: ApprovedKmsKeyVersions,
): ApprovedKmsKeyVersionsResult {
  if (approvedKmsKeyVersionsCache) {
    if (!isSameConfiguration(approvedKmsKeyVersionsCache, resolved))
      return { ok: false, failure: "CONFIG_CHANGED" };
    return { ok: true, config: approvedKmsKeyVersionsCache };
  }
  approvedKmsKeyVersionsCache = resolved;
  return { ok: true, config: resolved };
}

/**
 * Resolves the approved KMS key-version configuration from the single
 * server-controlled, reviewed deployment configuration source. This
 * production-facing function takes **no arguments**: no caller-supplied
 * key list, and no caller-supplied Registry configuration, can enter the
 * production trust boundary.
 *
 * No reviewed KMS deployment configuration exists in the repository today,
 * so production resolution fails closed with the stable `CONFIG_MISSING`
 * result — exactly like the Registry deployment manifest. Wiring a real
 * reviewed configuration is a deployment prerequisite; nothing here
 * invents a key resource or fabricates versions.
 */
export function resolveApprovedKmsKeyVersions(): ApprovedKmsKeyVersionsResult {
  // The reviewed deployment configuration source is absent until an
  // operator-pinned KMS deployment configuration exists. No placeholder
  // source is read and no configuration is synthesized.
  return { ok: false, failure: "CONFIG_MISSING" };
}

/**
 * Test-only seam for exercising the configuration contract without Google
 * Cloud credentials, network calls, or a reviewed deployment manifest.
 * Throws unless `NODE_ENV === "test"`; the injected configuration is a
 * mocked test fixture, never production deployment authority.
 */
export function resolveApprovedKmsKeyVersionsForTest(
  config: unknown,
): ApprovedKmsKeyVersionsResult {
  if (process.env.NODE_ENV !== "test")
    throw new Error(APPROVED_KMS_VERSIONS_TEST_SEAM_ERROR);
  const validated = validateApprovedKmsKeyVersions(config);
  if (!validated.ok) return validated;
  const consistent = enforceCurrentVersionConsistency(validated.config);
  if (!consistent.ok) return consistent;
  return applyConfigurationImmutability(consistent.config);
}

/**
 * Test-only: simulates a process restart by clearing the process-scoped
 * configuration cache, so tests initialize their own immutable
 * configuration independently of each other. Throws unless
 * `NODE_ENV === "test"`; never called from production code.
 */
export function resetApprovedKmsKeyVersionsCacheForTest(): void {
  if (process.env.NODE_ENV !== "test")
    throw new Error(APPROVED_KMS_VERSIONS_TEST_SEAM_ERROR);
  approvedKmsKeyVersionsCache = undefined;
}
