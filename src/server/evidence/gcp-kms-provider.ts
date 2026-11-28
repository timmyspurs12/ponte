// Server-only Google Cloud KMS adapter. The production evidence composition
// root (`production-routing-config.ts`) selects this adapter only after its
// required KMS key and Registry deployment configuration validates. No real
// KMS operation or production activation has yet occurred: the Registry
// deployment manifest is still missing, so production resolution currently
// fails closed.
import "server-only";

import { randomBytes } from "node:crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { EvidenceCandidatePreparationError } from "./errors";
import {
  clearDekBestEffort,
  KMS_PROVIDER,
  WRAPPED_DEK_ALGORITHM,
  WRAPPED_DEK_FORMAT,
  type CreatedAndWrappedDek,
  type DekProvider,
  type DekUnwrapper,
  type DekUnwrappingInput,
  type DekWrappingContext,
} from "./kms";
import type { ApprovedKmsKeyVersions } from "./approved-kms-key-versions";

/** Approved initial regional policy for explicitly version-pinned KMS keys. */
export const APPROVED_GCP_KMS_LOCATION = "africa-south1";

const MAX_HSM_REQUEST_BYTES = 8 * 1024;
const DEK_BYTES = 32;
const GCP_CRYPTO_KEY_RESOURCE = new RegExp(
  "^projects/(?<project>[a-z][a-z0-9-]{4,28}[a-z0-9])/locations/(?<location>[a-z0-9-]{1,63})/keyRings/(?<keyRing>[A-Za-z0-9_-]{1,63})/cryptoKeys/(?<cryptoKey>[A-Za-z0-9_-]{1,63})$",
);
const GCP_CRYPTO_KEY_VERSION_RESOURCE = new RegExp(
  "^projects/(?<project>[a-z][a-z0-9-]{4,28}[a-z0-9])/locations/(?<location>[a-z0-9-]{1,63})/keyRings/(?<keyRing>[A-Za-z0-9_-]{1,63})/cryptoKeys/(?<cryptoKey>[A-Za-z0-9_-]{1,63})/cryptoKeyVersions/(?<version>[1-9][0-9]{0,18})$",
);

type GoogleInt64Value = number | string | { toString(): string };

/**
 * Intentionally narrow subset of the official KMS Encrypt request. Tests inject
 * this interface directly, so they cannot trigger ADC discovery or a network
 * request. Every field is sent to the official client unchanged.
 */
export interface GcpKmsEncryptRequest {
  readonly name: string;
  readonly plaintext: Buffer;
  readonly additionalAuthenticatedData: Buffer;
  readonly plaintextCrc32c: Readonly<{ value: number }>;
  readonly additionalAuthenticatedDataCrc32c: Readonly<{ value: number }>;
}

/** Narrow non-secret subset of an official KMS Encrypt response. */
export interface GcpKmsEncryptResponse {
  readonly name?: string | null;
  readonly ciphertext?: Buffer | Uint8Array | string | null;
  readonly ciphertextCrc32c?: Readonly<{
    value?: GoogleInt64Value | null;
  }> | null;
  readonly verifiedPlaintextCrc32c?: boolean | null;
  readonly verifiedAdditionalAuthenticatedDataCrc32c?: boolean | null;
}

/** Narrow non-secret subset of an official KMS Decrypt request. */
export interface GcpKmsDecryptRequest {
  /** CryptoKey parent, never a CryptoKeyVersion. */
  readonly name: string;
  readonly ciphertext: Buffer;
  readonly additionalAuthenticatedData: Buffer;
  readonly ciphertextCrc32c: Readonly<{ value: number }>;
  readonly additionalAuthenticatedDataCrc32c: Readonly<{ value: number }>;
}

/**
 * Narrow subset of an official KMS Decrypt response. No Encrypt-style verified
 * request flags exist on this response; plaintextCrc32c is mandatory here.
 */
export interface GcpKmsDecryptResponse {
  readonly plaintext?: Buffer | Uint8Array | string | null;
  readonly plaintextCrc32c?: Readonly<{
    value?: GoogleInt64Value | null;
  }> | null;
}

/**
 * No SDK handle leaks across this boundary. The official client factory below
 * is never called by the normal Routing path in this phase.
 */
export interface GcpKmsClient {
  encrypt(
    request: GcpKmsEncryptRequest,
  ): Promise<readonly [GcpKmsEncryptResponse]>;
  decrypt(
    request: GcpKmsDecryptRequest,
  ): Promise<readonly [GcpKmsDecryptResponse]>;
}

export interface GcpKmsDekProviderOptions {
  /**
   * Immutable approved-version configuration: the stable parent `CryptoKey`,
   * the single current write `CryptoKeyVersion`, and zero or more approved
   * historical `CryptoKeyVersion` resources. Validated again at the provider
   * boundary; aliases and `CryptoKey` parents fail.
   */
  readonly approvedVersions: ApprovedKmsKeyVersions;
  /** Explicitly injected official-client adapter; no implicit client creation. */
  readonly client: GcpKmsClient;
}

export interface ParsedGcpCryptoKey {
  readonly cryptoKeyReference: string;
  readonly project: string;
  readonly location: typeof APPROVED_GCP_KMS_LOCATION;
  readonly keyRing: string;
  readonly cryptoKey: string;
}

export interface ParsedGcpCryptoKeyVersion extends ParsedGcpCryptoKey {
  readonly cryptoKeyVersion: string;
  readonly version: string;
}

function providerFailure(): never {
  // Do not attach a cause: callers must receive the existing fixed evidence
  // boundary, never KMS, credential, AAD, ciphertext, or key details.
  throw new EvidenceCandidatePreparationError("PROVIDER_FAILURE");
}

function clearDekOnFailure(value: Buffer | undefined): void {
  if (!value) return;
  try {
    clearDekBestEffort(value);
  } catch {
    // Best effort only. Cleanup must not replace the fixed provider error.
  }
}

function clearBytesBestEffort(value: Uint8Array | undefined): void {
  if (!value) return;
  try {
    value.fill(0);
  } catch {
    // Best effort only. Cleanup must not replace the fixed provider error.
  }
}

/**
 * CRC32C (Castagnoli) for the KMS integrity fields. KMS encodes this uint32 as
 * an Int64Value, which remains exactly representable in JavaScript.
 */
const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++)
      value = value & 1 ? (value >>> 1) ^ 0x82f63b78 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32c(value: Uint8Array): number {
  let checksum = 0xffffffff;
  for (const byte of value)
    checksum = CRC32C_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  return (checksum ^ 0xffffffff) >>> 0;
}

/**
 * Validates the exact immutable `CryptoKey` parent resource form, including
 * the approved location restriction. Exported for the approved KMS
 * key-version configuration validator; it never contacts Cloud KMS and
 * determines nothing about a version's runtime state.
 */
export function parseGcpCryptoKey(resourceName: unknown): ParsedGcpCryptoKey {
  if (typeof resourceName !== "string") return providerFailure();
  const match = GCP_CRYPTO_KEY_RESOURCE.exec(resourceName);
  if (!match?.groups || match.groups.location !== APPROVED_GCP_KMS_LOCATION)
    return providerFailure();
  const { project, location, keyRing, cryptoKey } = match.groups;
  return Object.freeze({
    cryptoKeyReference: resourceName,
    project,
    location: location as typeof APPROVED_GCP_KMS_LOCATION,
    keyRing,
    cryptoKey,
  });
}

/**
 * Accepts only the immutable, exact resource form accepted by the Encrypt API.
 * In particular, a CryptoKey parent, primary-version indirection, alias, wrong
 * location, empty segment, traversal, or malformed component is rejected.
 */
export function parseGcpCryptoKeyVersion(
  resourceName: unknown,
): ParsedGcpCryptoKeyVersion {
  if (typeof resourceName !== "string") return providerFailure();
  const match = GCP_CRYPTO_KEY_VERSION_RESOURCE.exec(resourceName);
  if (!match?.groups || match.groups.location !== APPROVED_GCP_KMS_LOCATION)
    return providerFailure();
  const { version } = match.groups;
  const cryptoKeyReference = resourceName.slice(
    0,
    resourceName.lastIndexOf("/cryptoKeyVersions/"),
  );
  const parent = parseGcpCryptoKey(cryptoKeyReference);
  return Object.freeze({
    ...parent,
    cryptoKeyVersion: resourceName,
    version,
  });
}

function responseCrc32c(value: unknown): number | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("value" in value) ||
    (value as { value?: unknown }).value === null ||
    (value as { value?: unknown }).value === undefined
  ) {
    return undefined;
  }
  const raw = (value as { value: GoogleInt64Value }).value;
  let parsed: number;
  if (typeof raw === "number") parsed = raw;
  else {
    try {
      const text = typeof raw === "string" ? raw : raw.toString();
      if (!/^(0|[1-9][0-9]{0,9})$/.test(text)) return undefined;
      parsed = Number(text);
    } catch {
      return undefined;
    }
  }
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffffffff
    ? parsed
    : undefined;
}

function responseCiphertext(value: unknown): Buffer | undefined {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array))
    return undefined;
  const ciphertext = Buffer.from(value);
  return ciphertext.length > 0 ? ciphertext : undefined;
}

function responsePlaintext(
  value: unknown,
): Readonly<{ raw: Uint8Array; dek: Buffer }> | undefined {
  if (Buffer.isBuffer(value)) return { raw: value, dek: value };
  if (value instanceof Uint8Array)
    return { raw: value, dek: Buffer.from(value) };
  return undefined;
}

function assertWrappingContext(value: DekWrappingContext): Buffer {
  if (
    !value ||
    !Buffer.isBuffer(value.canonicalContext) ||
    value.canonicalContext.length < 1 ||
    value.canonicalContext.length + DEK_BYTES > MAX_HSM_REQUEST_BYTES
  ) {
    return providerFailure();
  }
  return value.canonicalContext;
}

/**
 * Validates an `ApprovedKmsKeyVersions` configuration at the provider
 * boundary. The approved-version resolver already validates configuration
 * from its source; this is defense-in-depth: the provider must never trust
 * constructor input. It never contacts Cloud KMS and never determines
 * whether a version is enabled at runtime.
 */
function assertApprovedVersions(config: unknown): ApprovedKmsKeyVersions {
  if (!config || typeof config !== "object" || Array.isArray(config))
    return providerFailure();
  // Exact configuration field set; nothing else is accepted at this
  // boundary either.
  const actualKeys = Object.keys(config).sort();
  const expectedKeys = [
    "approvedHistoricalVersions",
    "cryptoKeyReference",
    "currentWriteVersion",
  ].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return providerFailure();
  }
  const {
    cryptoKeyReference,
    currentWriteVersion,
    approvedHistoricalVersions,
  } = config as Record<string, unknown>;

  const parent = parseGcpCryptoKey(cryptoKeyReference);
  const writeVersion = parseGcpCryptoKeyVersion(currentWriteVersion);
  if (writeVersion.cryptoKeyReference !== parent.cryptoKeyReference)
    return providerFailure();

  if (!Array.isArray(approvedHistoricalVersions)) return providerFailure();
  const historical: string[] = [];
  for (const entry of approvedHistoricalVersions) {
    const parsed = parseGcpCryptoKeyVersion(entry);
    if (parsed.cryptoKeyReference !== parent.cryptoKeyReference)
      return providerFailure();
    if (parsed.cryptoKeyVersion === writeVersion.cryptoKeyVersion)
      return providerFailure();
    if (historical.includes(parsed.cryptoKeyVersion)) return providerFailure();
    historical.push(parsed.cryptoKeyVersion);
  }

  return Object.freeze({
    cryptoKeyReference: parent.cryptoKeyReference,
    currentWriteVersion: writeVersion.cryptoKeyVersion,
    approvedHistoricalVersions: Object.freeze(historical),
  });
}

/**
 * Validates one persisted unwrapping input against the immutable approved
 * configuration. The stored provider, algorithm and format must match the
 * supported GCP combination; the stored `kms_key_reference` must equal the
 * configured parent `CryptoKey` exactly; the stored `kms_key_version` must
 * parse as an exact immutable `CryptoKeyVersion`, derive to that same
 * parent, and belong to the effective approved set
 * (`currentWriteVersion ∪ approvedHistoricalVersions`). Malformed,
 * unknown, unapproved, or cross-parent metadata fails closed before any
 * Cloud KMS request. Stored `kms_key_version` is trusted application
 * provenance; approved-set membership is the application authorization
 * policy — the Decrypt response does not identify the version used.
 */
function assertGcpUnwrappingInput(
  input: DekUnwrappingInput,
  approvedVersions: ApprovedKmsKeyVersions,
): Readonly<{ wrappedDek: Buffer; canonicalContext: Buffer }> {
  if (!input || typeof input !== "object") return providerFailure();
  if (
    input.kmsProvider !== KMS_PROVIDER.GCP_CLOUD_KMS ||
    input.wrappedDekAlgorithm !==
      WRAPPED_DEK_ALGORITHM.GOOGLE_SYMMETRIC_ENCRYPTION ||
    input.wrappedDekFormat !==
      WRAPPED_DEK_FORMAT.GCP_KMS_ENCRYPT_CIPHERTEXT_V1 ||
    !Buffer.isBuffer(input.wrappedDek) ||
    input.wrappedDek.length < 1
  ) {
    return providerFailure();
  }
  const storedCryptoKey = parseGcpCryptoKey(input.kmsKeyReference);
  const storedCryptoKeyVersion = parseGcpCryptoKeyVersion(input.kmsKeyVersion);
  if (
    storedCryptoKey.cryptoKeyReference !==
      storedCryptoKeyVersion.cryptoKeyReference ||
    input.kmsKeyReference !== approvedVersions.cryptoKeyReference ||
    storedCryptoKeyVersion.cryptoKeyReference !==
      approvedVersions.cryptoKeyReference
  ) {
    return providerFailure();
  }
  const approvedSet = new Set<string>([
    approvedVersions.currentWriteVersion,
    ...approvedVersions.approvedHistoricalVersions,
  ]);
  if (!approvedSet.has(input.kmsKeyVersion)) return providerFailure();
  const canonicalContext = assertWrappingContext({
    canonicalContext: input.canonicalContext,
  });
  if (input.wrappedDek.length + canonicalContext.length > MAX_HSM_REQUEST_BYTES)
    return providerFailure();
  return Object.freeze({
    wrappedDek: input.wrappedDek,
    canonicalContext,
  });
}

/**
 * Wraps one existing official `KeyManagementServiceClient` in the narrow
 * adapter boundary. Wrapping is a pure, side-effect-free adaptation: the
 * official client instance is reused as-is, and no credential discovery or
 * network work occurs here.
 */
export function wrapKeyManagementServiceClient(
  client: KeyManagementServiceClient,
): GcpKmsClient {
  return Object.freeze({
    async encrypt(request: GcpKmsEncryptRequest) {
      const [response] = await client.encrypt({
        name: request.name,
        plaintext: request.plaintext,
        additionalAuthenticatedData: request.additionalAuthenticatedData,
        plaintextCrc32c: request.plaintextCrc32c,
        additionalAuthenticatedDataCrc32c:
          request.additionalAuthenticatedDataCrc32c,
      });
      return [response] as const;
    },
    async decrypt(request: GcpKmsDecryptRequest) {
      const [response] = await client.decrypt({
        name: request.name,
        ciphertext: request.ciphertext,
        additionalAuthenticatedData: request.additionalAuthenticatedData,
        ciphertextCrc32c: request.ciphertextCrc32c,
        additionalAuthenticatedDataCrc32c:
          request.additionalAuthenticatedDataCrc32c,
      });
      return [response] as const;
    },
  });
}

/**
 * Creates the official client only when a caller explicitly invokes this
 * factory. It accepts no credential path or credential object, never reads a
 * repository file, and relies solely on the Google SDK's Application Default
 * Credentials when a composition root deliberately chooses to use it.
 */
export function createGoogleCloudKmsClient(): GcpKmsClient {
  return wrapKeyManagementServiceClient(new KeyManagementServiceClient());
}

/**
 * Explicit opt-in constructor that builds a provider from an official client
 * using Application Default Credentials. The production composition root
 * manages its own process-scoped client lifecycle and does not call this
 * factory, so it remains an opt-in entry point rather than a default.
 */
export function createGcpKmsDekProviderWithApplicationDefaultCredentials(
  approvedVersions: ApprovedKmsKeyVersions,
): GcpKmsDekProvider {
  return new GcpKmsDekProvider({
    approvedVersions,
    client: createGoogleCloudKmsClient(),
  });
}

/**
 * Genuine Google Cloud KMS Encrypt/Decrypt adapter bound to one immutable
 * approved-version configuration: the stable parent `CryptoKey`, the single
 * current write `CryptoKeyVersion`, and zero or more approved historical
 * `CryptoKeyVersion` resources.
 *
 * - Fresh DEK wrapping (`createAndWrapDek`) is pinned to the single
 *   immutable `currentWriteVersion`: Encrypt targets exactly that version
 *   resource and the response name must equal it.
 * - DEK unwrapping (`unwrapDek`) accepts only stored versions in the
 *   immutable approved configuration: the current write version plus the
 *   approved historical versions. Historical versions are decrypt-only and
 *   are never used for fresh wrapping.
 *
 * It has no key-management methods, no fallback, no environment lookup, and
 * no network/credential side effect until an operation is called.
 */
export class GcpKmsDekProvider implements DekProvider, DekUnwrapper {
  readonly provider = KMS_PROVIDER.GCP_CLOUD_KMS;
  readonly approvedVersions: Readonly<ApprovedKmsKeyVersions>;
  private readonly currentWriteVersion: string;
  private readonly cryptoKeyReference: string;
  private readonly client: GcpKmsClient;

  constructor(options: GcpKmsDekProviderOptions) {
    const approvedVersions = assertApprovedVersions(options?.approvedVersions);
    if (
      !options?.client ||
      typeof options.client.encrypt !== "function" ||
      typeof options.client.decrypt !== "function"
    )
      providerFailure();
    this.approvedVersions = approvedVersions;
    this.currentWriteVersion = approvedVersions.currentWriteVersion;
    this.cryptoKeyReference = approvedVersions.cryptoKeyReference;
    this.client = options.client;
  }

  async createAndWrapDek(
    context: DekWrappingContext,
  ): Promise<CreatedAndWrappedDek> {
    let plaintextDek: Buffer | undefined;
    let succeeded = false;
    try {
      const canonicalContext = assertWrappingContext(context);
      plaintextDek = randomBytes(DEK_BYTES);
      if (!Buffer.isBuffer(plaintextDek) || plaintextDek.length !== DEK_BYTES)
        return providerFailure();

      const request: GcpKmsEncryptRequest = Object.freeze({
        name: this.currentWriteVersion,
        plaintext: plaintextDek,
        additionalAuthenticatedData: canonicalContext,
        plaintextCrc32c: Object.freeze({ value: crc32c(plaintextDek) }),
        additionalAuthenticatedDataCrc32c: Object.freeze({
          value: crc32c(canonicalContext),
        }),
      });
      const [response] = await this.client.encrypt(request);
      const ciphertext = responseCiphertext(response?.ciphertext);
      const ciphertextChecksum = responseCrc32c(response?.ciphertextCrc32c);
      if (
        !ciphertext ||
        response?.name !== this.currentWriteVersion ||
        response.verifiedPlaintextCrc32c !== true ||
        response.verifiedAdditionalAuthenticatedDataCrc32c !== true ||
        ciphertextChecksum === undefined ||
        ciphertextChecksum !== crc32c(ciphertext)
      ) {
        return providerFailure();
      }

      succeeded = true;
      return {
        plaintextDek,
        wrappedDek: ciphertext,
        kmsProvider: KMS_PROVIDER.GCP_CLOUD_KMS,
        kmsKeyReference: this.cryptoKeyReference,
        kmsKeyVersion: this.currentWriteVersion,
        wrappedDekAlgorithm: WRAPPED_DEK_ALGORITHM.GOOGLE_SYMMETRIC_ENCRYPTION,
        wrappedDekFormat: WRAPPED_DEK_FORMAT.GCP_KMS_ENCRYPT_CIPHERTEXT_V1,
      };
    } catch {
      return providerFailure();
    } finally {
      if (!succeeded) clearDekOnFailure(plaintextDek);
    }
  }

  /**
   * Recovers one exact persisted GCP-wrapped DEK. The caller owns a successful
   * returned 32-byte DEK and must clear it best effort after envelope use.
   */
  async unwrapDek(input: DekUnwrappingInput): Promise<Buffer> {
    let rawRecoveredDek: Uint8Array | undefined;
    let recoveredDek: Buffer | undefined;
    let succeeded = false;
    try {
      const { wrappedDek, canonicalContext } = assertGcpUnwrappingInput(
        input,
        this.approvedVersions,
      );
      const request: GcpKmsDecryptRequest = Object.freeze({
        // Google KMS Decrypt intentionally takes the CryptoKey parent. KMS
        // selects the version identified by the ciphertext, never this adapter
        // configuration's CryptoKeyVersion resource.
        name: this.cryptoKeyReference,
        ciphertext: wrappedDek,
        additionalAuthenticatedData: canonicalContext,
        ciphertextCrc32c: Object.freeze({ value: crc32c(wrappedDek) }),
        additionalAuthenticatedDataCrc32c: Object.freeze({
          value: crc32c(canonicalContext),
        }),
      });
      const [response] = await this.client.decrypt(request);
      const plaintext = responsePlaintext(response?.plaintext);
      rawRecoveredDek = plaintext?.raw;
      recoveredDek = plaintext?.dek;
      const plaintextChecksum = responseCrc32c(response?.plaintextCrc32c);
      if (
        !recoveredDek ||
        recoveredDek.length !== DEK_BYTES ||
        plaintextChecksum === undefined ||
        plaintextChecksum !== crc32c(recoveredDek)
      ) {
        return providerFailure();
      }

      succeeded = true;
      return recoveredDek;
    } catch {
      return providerFailure();
    } finally {
      if (!succeeded) clearDekOnFailure(recoveredDek);
      // GAX returns Buffer in Node. If another Uint8Array implementation was
      // received, return a caller-owned Buffer copy and clear the source.
      if (rawRecoveredDek && rawRecoveredDek !== recoveredDek)
        clearBytesBestEffort(rawRecoveredDek);
    }
  }
}
