// This contract deliberately contains no cloud SDK, credentials, KMS client,
// encryption routine, or key-administration surface.
import "server-only";

export const KMS_PROVIDER = Object.freeze({
  /** Only a future real Cloud KMS adapter may emit this provenance value. */
  GCP_CLOUD_KMS: "gcp-cloud-kms",
  /** Only a future real AWS KMS adapter may emit this provenance value. */
  AWS_KMS: "aws-kms",
  /**
   * Synthetic local test data only. It is not a KMS operation, key, envelope,
   * registry deployment, or on-chain attestation.
   */
  LOCAL_TEST_ONLY: "local-test-only",
} as const);

export type KmsProviderIdentifier =
  (typeof KMS_PROVIDER)[keyof typeof KMS_PROVIDER];

export const WRAPPED_DEK_ALGORITHM = Object.freeze({
  GOOGLE_SYMMETRIC_ENCRYPTION: "GOOGLE_SYMMETRIC_ENCRYPTION",
  AWS_KMS_GENERATE_DATA_KEY_AES_256: "AWS_KMS_GENERATE_DATA_KEY_AES_256",
  /** Fresh random test bytes; not a provider wrapping operation. */
  LOCAL_TEST_RANDOM_BYTES_V1: "LOCAL_TEST_RANDOM_BYTES_V1",
} as const);

export type WrappedDekAlgorithmIdentifier =
  (typeof WRAPPED_DEK_ALGORITHM)[keyof typeof WRAPPED_DEK_ALGORITHM];

export const WRAPPED_DEK_FORMAT = Object.freeze({
  GCP_KMS_ENCRYPT_CIPHERTEXT_V1: "gcp-kms-encrypt-ciphertext-v1",
  AWS_KMS_GENERATE_DATA_KEY_CIPHERTEXT_BLOB_V1:
    "aws-kms-generate-data-key-ciphertext-blob-v1",
  /** Opaque synthetic local-test bytes; never an interoperable KMS ciphertext. */
  LOCAL_TEST_RANDOM_BYTES_V1: "local-test-random-bytes-v1",
} as const);

export type WrappedDekFormatIdentifier =
  (typeof WRAPPED_DEK_FORMAT)[keyof typeof WRAPPED_DEK_FORMAT];

export interface DekWrappingMetadata {
  /**
   * Provenance of this fresh DEK's opaque companion bytes. GCP/AWS values are
   * reserved for genuine provider operations; local-test-only is synthetic.
   */
  kmsProvider: KmsProviderIdentifier;
  /**
   * Stable provider key resource/reference, or a local-test-only marker for
   * synthetic data. It is never a display label or credential.
   */
  kmsKeyReference: string;
  /** Exact provider key/material identifier, or a local-test-only marker. */
  kmsKeyVersion: string;
  /** Provider operation identifier, or the explicit synthetic test algorithm. */
  wrappedDekAlgorithm: WrappedDekAlgorithmIdentifier;
  /** Versioned non-secret serialization discriminator for opaque bytes. */
  wrappedDekFormat: WrappedDekFormatIdentifier;
}

/**
 * Canonical non-secret context constructed by the application from the
 * approved AAD version and digest. It never contains private evidence
 * plaintext, salts, or preimages.
 */
export interface DekWrappingContext {
  canonicalContext: Buffer;
}

/**
 * Result of one provider operation that both creates a fresh DEK and wraps it.
 * A provider implementation may generate the DEK locally before wrapping it,
 * or may receive provider-generated plaintext plus a wrapped form. In either
 * case, plaintextDek is the sole 32-byte AES-256-GCM content key.
 */
export interface CreatedAndWrappedDek extends DekWrappingMetadata {
  plaintextDek: Buffer;
  wrappedDek: Buffer;
}

/**
 * Narrow provider boundary. It intentionally has no generic SDK handle, key
 * creation, rotation, listing, deletion, or caller-supplied-DEK method.
 */
export interface DekProvider {
  readonly provider: KmsProviderIdentifier;
  createAndWrapDek(context: DekWrappingContext): Promise<CreatedAndWrappedDek>;
}

/**
 * Exact persisted wrapping metadata, opaque wrapped bytes, and the original
 * canonical wrapping context required to recover one DEK. Synthetic providers
 * are deliberately not required to implement this separate capability.
 */
export interface DekUnwrappingInput extends DekWrappingMetadata {
  readonly wrappedDek: Buffer;
  readonly canonicalContext: Buffer;
}

/**
 * Narrow recovery boundary. A successful caller owns the returned 32-byte DEK
 * and must clear it best effort after use; no plaintext fallback exists.
 */
export interface DekUnwrapper {
  readonly provider: KmsProviderIdentifier;
  unwrapDek(input: DekUnwrappingInput): Promise<Buffer>;
}

/**
 * Result of one provider operation that rewraps an existing DEK under the
 * provider's current write version. The opaque wrapped bytes are the only
 * secret-bearing content; no plaintext DEK is returned.
 */
export interface RewrappedDek extends DekWrappingMetadata {
  readonly wrappedDek: Buffer;
}

/**
 * Narrow cryptographic rewrapping boundary. A provider implementation
 * recovers an existing DEK through the approved-version unwrap path,
 * rewraps the exact same 32-byte DEK under its current write version using
 * the original canonical wrapping context, validates the new wrapped result,
 * and clears the recovered plaintext internally on success and every
 * failure path. It performs no database mutation and returns no plaintext.
 */
export interface DekRewrapper {
  readonly provider: KmsProviderIdentifier;
  rewrapDek(input: DekUnwrappingInput): Promise<RewrappedDek>;
}

export class DekProviderContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DekProviderContractError";
  }
}

const providerIdentifier = /^[a-z][a-z0-9-]{1,31}$/;
const algorithmIdentifier = /^[A-Z][A-Z0-9_]{2,63}$/;
const formatIdentifier = /^[a-z][a-z0-9-]{2,63}$/;
const providerKeyIdentifier = /^[A-Za-z0-9][A-Za-z0-9:/._+=,@-]{0,2047}$/;
export const LOCAL_TEST_KEY_PROVENANCE_PREFIX = "local-test-only/";

function fail(message: string): never {
  throw new DekProviderContractError(message);
}

function assertProviderKeyIdentifier(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2048 ||
    !providerKeyIdentifier.test(value)
  ) {
    fail(`${field} must be a non-empty provider resource/version identifier`);
  }
}

export function isLocalTestOnlyDekWrappingMetadata(
  metadata: Pick<
    DekWrappingMetadata,
    | "kmsProvider"
    | "kmsKeyReference"
    | "kmsKeyVersion"
    | "wrappedDekAlgorithm"
    | "wrappedDekFormat"
  >,
): boolean {
  return (
    metadata.kmsProvider === KMS_PROVIDER.LOCAL_TEST_ONLY &&
    metadata.wrappedDekAlgorithm ===
      WRAPPED_DEK_ALGORITHM.LOCAL_TEST_RANDOM_BYTES_V1 &&
    metadata.wrappedDekFormat ===
      WRAPPED_DEK_FORMAT.LOCAL_TEST_RANDOM_BYTES_V1 &&
    metadata.kmsKeyReference.startsWith(LOCAL_TEST_KEY_PROVENANCE_PREFIX) &&
    metadata.kmsKeyVersion.startsWith(LOCAL_TEST_KEY_PROVENANCE_PREFIX)
  );
}

function isSupportedCombination(metadata: DekWrappingMetadata): boolean {
  return (
    (metadata.kmsProvider === KMS_PROVIDER.GCP_CLOUD_KMS &&
      metadata.wrappedDekAlgorithm ===
        WRAPPED_DEK_ALGORITHM.GOOGLE_SYMMETRIC_ENCRYPTION &&
      metadata.wrappedDekFormat ===
        WRAPPED_DEK_FORMAT.GCP_KMS_ENCRYPT_CIPHERTEXT_V1) ||
    (metadata.kmsProvider === KMS_PROVIDER.AWS_KMS &&
      metadata.wrappedDekAlgorithm ===
        WRAPPED_DEK_ALGORITHM.AWS_KMS_GENERATE_DATA_KEY_AES_256 &&
      metadata.wrappedDekFormat ===
        WRAPPED_DEK_FORMAT.AWS_KMS_GENERATE_DATA_KEY_CIPHERTEXT_BLOB_V1) ||
    isLocalTestOnlyDekWrappingMetadata(metadata)
  );
}

/**
 * Validates the non-secret provider metadata carried alongside opaque wrapped
 * DEK bytes. It deliberately accepts no plaintext DEK, performs no provider
 * work, and is safe for final persistence revalidation.
 */
export function assertDekWrappingMetadata(
  metadata: DekWrappingMetadata,
): DekWrappingMetadata {
  if (
    typeof metadata.kmsProvider !== "string" ||
    !providerIdentifier.test(metadata.kmsProvider)
  ) {
    fail("kmsProvider must be a supported provider identifier");
  }
  if (
    typeof metadata.wrappedDekAlgorithm !== "string" ||
    !algorithmIdentifier.test(metadata.wrappedDekAlgorithm)
  ) {
    fail(
      "wrappedDekAlgorithm must be a provider operation/algorithm identifier",
    );
  }
  if (
    typeof metadata.wrappedDekFormat !== "string" ||
    !formatIdentifier.test(metadata.wrappedDekFormat)
  ) {
    fail("wrappedDekFormat must be a versioned format identifier");
  }
  assertProviderKeyIdentifier(metadata.kmsKeyReference, "kmsKeyReference");
  assertProviderKeyIdentifier(metadata.kmsKeyVersion, "kmsKeyVersion");
  if (!isSupportedCombination(metadata))
    fail(
      "unsupported KMS provider, wrapped-DEK algorithm, or format combination",
    );
  return metadata;
}

/**
 * Validates only the provider-neutral result boundary. It does not encrypt,
 * decrypt, generate a key, call a provider, or log any sensitive bytes.
 */
export function assertCreatedAndWrappedDek(
  result: CreatedAndWrappedDek,
): CreatedAndWrappedDek {
  if (
    !Buffer.isBuffer(result.plaintextDek) ||
    result.plaintextDek.length !== 32
  )
    fail("plaintextDek must be exactly 32 bytes");
  if (!Buffer.isBuffer(result.wrappedDek) || result.wrappedDek.length < 1)
    fail("wrappedDek must be non-empty opaque bytes");
  assertDekWrappingMetadata(result);
  return result;
}

/**
 * Validates a provider result at the provider boundary. A provider declaration
 * is not merely descriptive: the returned provider metadata must identify that
 * same provider, after the provider-neutral result has passed validation.
 */
export function assertDekProviderResult(
  provider: DekProvider,
  result: CreatedAndWrappedDek,
): CreatedAndWrappedDek {
  const validated = assertCreatedAndWrappedDek(result);
  if (provider.provider !== validated.kmsProvider)
    fail("declared provider must match result kmsProvider");
  return validated;
}

/**
 * Calls the narrow provider operation and validates its returned metadata at
 * that boundary. It does not create a provider, generate a key, or make any
 * network request itself.
 */
export async function createAndValidateWrappedDek(
  provider: DekProvider,
  context: DekWrappingContext,
): Promise<CreatedAndWrappedDek> {
  return assertDekProviderResult(
    provider,
    await provider.createAndWrapDek(context),
  );
}

/**
 * Overwrites the caller-owned Buffer when possible. Node.js and the runtime do
 * not guarantee secure zeroization: copies, GC behavior, provider buffers, and
 * native memory remain outside this best-effort helper's control.
 */
export function clearDekBestEffort(dek: Buffer): void {
  dek.fill(0);
}
