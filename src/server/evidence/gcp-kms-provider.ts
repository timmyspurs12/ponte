// Dormant, server-only Google Cloud KMS adapter. No application composition
// root imports or selects it in this phase.
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
  /** Exact immutable CryptoKeyVersion resource; aliases and CryptoKey parents fail. */
  readonly cryptoKeyVersion: string;
  /** Explicitly injected official-client adapter; no implicit client creation. */
  readonly client: GcpKmsClient;
}

interface ParsedGcpCryptoKey {
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

function parseGcpCryptoKey(resourceName: unknown): ParsedGcpCryptoKey {
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

function assertGcpUnwrappingInput(
  input: DekUnwrappingInput,
  expectedCryptoKeyReference: string,
  expectedCryptoKeyVersion: string,
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
    input.kmsKeyReference !== expectedCryptoKeyReference ||
    input.kmsKeyVersion !== expectedCryptoKeyVersion
  ) {
    return providerFailure();
  }
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
 * Creates the official client only when a caller explicitly invokes this
 * factory. It accepts no credential path or credential object, never reads a
 * repository file, and relies solely on the Google SDK's Application Default
 * Credentials when a future composition root deliberately chooses to use it.
 */
export function createGoogleCloudKmsClient(): GcpKmsClient {
  const client = new KeyManagementServiceClient();
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
 * Explicit opt-in constructor for a future composition root. It is intentionally
 * unused: normal Routing continues to select only its guarded local test
 * provider in this phase.
 */
export function createGcpKmsDekProviderWithApplicationDefaultCredentials(
  cryptoKeyVersion: string,
): GcpKmsDekProvider {
  return new GcpKmsDekProvider({
    cryptoKeyVersion,
    client: createGoogleCloudKmsClient(),
  });
}

/**
 * Genuine Google Cloud KMS Encrypt/Decrypt adapter, pinned to one immutable
 * version. It has no key-management methods, no fallback, no environment
 * lookup, and no network/credential side effect until an operation is called.
 */
export class GcpKmsDekProvider implements DekProvider, DekUnwrapper {
  readonly provider = KMS_PROVIDER.GCP_CLOUD_KMS;
  readonly cryptoKeyVersion: string;
  readonly cryptoKeyReference: string;
  private readonly client: GcpKmsClient;

  constructor(options: GcpKmsDekProviderOptions) {
    const parsed = parseGcpCryptoKeyVersion(options?.cryptoKeyVersion);
    if (
      !options?.client ||
      typeof options.client.encrypt !== "function" ||
      typeof options.client.decrypt !== "function"
    )
      providerFailure();
    this.cryptoKeyVersion = parsed.cryptoKeyVersion;
    this.cryptoKeyReference = parsed.cryptoKeyReference;
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
        name: this.cryptoKeyVersion,
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
        response?.name !== this.cryptoKeyVersion ||
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
        kmsKeyVersion: this.cryptoKeyVersion,
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
        this.cryptoKeyReference,
        this.cryptoKeyVersion,
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
