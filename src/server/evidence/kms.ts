// This contract deliberately contains no cloud SDK, credentials, KMS client,
// encryption routine, or key-administration surface.
import "server-only";

export const KMS_PROVIDER = Object.freeze({
  GCP_CLOUD_KMS: "gcp-cloud-kms",
  AWS_KMS: "aws-kms",
} as const);

export type KmsProviderIdentifier =
  (typeof KMS_PROVIDER)[keyof typeof KMS_PROVIDER];

export const WRAPPED_DEK_ALGORITHM = Object.freeze({
  GOOGLE_SYMMETRIC_ENCRYPTION: "GOOGLE_SYMMETRIC_ENCRYPTION",
  AWS_KMS_GENERATE_DATA_KEY_AES_256: "AWS_KMS_GENERATE_DATA_KEY_AES_256",
} as const);

export type WrappedDekAlgorithmIdentifier =
  (typeof WRAPPED_DEK_ALGORITHM)[keyof typeof WRAPPED_DEK_ALGORITHM];

export const WRAPPED_DEK_FORMAT = Object.freeze({
  GCP_KMS_ENCRYPT_CIPHERTEXT_V1: "gcp-kms-encrypt-ciphertext-v1",
  AWS_KMS_GENERATE_DATA_KEY_CIPHERTEXT_BLOB_V1:
    "aws-kms-generate-data-key-ciphertext-blob-v1",
} as const);

export type WrappedDekFormatIdentifier =
  (typeof WRAPPED_DEK_FORMAT)[keyof typeof WRAPPED_DEK_FORMAT];

export interface DekWrappingMetadata {
  /** Provider that created and wrapped this fresh DEK. */
  kmsProvider: KmsProviderIdentifier;
  /** Stable provider key resource/reference, never a display label or alias. */
  kmsKeyReference: string;
  /** Exact provider key version or key-material identifier for this operation. */
  kmsKeyVersion: string;
  /** Provider operation/algorithm identifier for the opaque wrapped bytes. */
  wrappedDekAlgorithm: WrappedDekAlgorithmIdentifier;
  /** Versioned, non-secret serialization discriminator for those opaque bytes. */
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
        WRAPPED_DEK_FORMAT.AWS_KMS_GENERATE_DATA_KEY_CIPHERTEXT_BLOB_V1)
  );
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
  if (
    typeof result.kmsProvider !== "string" ||
    !providerIdentifier.test(result.kmsProvider)
  ) {
    fail("kmsProvider must be a supported provider identifier");
  }
  if (
    typeof result.wrappedDekAlgorithm !== "string" ||
    !algorithmIdentifier.test(result.wrappedDekAlgorithm)
  ) {
    fail(
      "wrappedDekAlgorithm must be a provider operation/algorithm identifier",
    );
  }
  if (
    typeof result.wrappedDekFormat !== "string" ||
    !formatIdentifier.test(result.wrappedDekFormat)
  ) {
    fail("wrappedDekFormat must be a versioned format identifier");
  }
  assertProviderKeyIdentifier(result.kmsKeyReference, "kmsKeyReference");
  assertProviderKeyIdentifier(result.kmsKeyVersion, "kmsKeyVersion");
  if (!isSupportedCombination(result))
    fail(
      "unsupported KMS provider, wrapped-DEK algorithm, or format combination",
    );
  return result;
}

/**
 * Overwrites the caller-owned Buffer when possible. Node.js and the runtime do
 * not guarantee secure zeroization: copies, GC behavior, provider buffers, and
 * native memory remain outside this best-effort helper's control.
 */
export function clearDekBestEffort(dek: Buffer): void {
  dek.fill(0);
}
