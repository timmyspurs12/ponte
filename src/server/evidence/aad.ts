// Canonical private-evidence binding and KMS wrapping context only. This module
// deliberately contains no KMS client, key material, persistence, or encryption.
import "server-only";

import {
  AbiCoder,
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import {
  ARBITRUM_SEPOLIA_CHAIN_ID,
  EVIDENCE_SCHEMA_VERSION,
} from "./commitment";

const abi = AbiCoder.defaultAbiCoder();
const ZERO_BYTES16 = `0x${"00".repeat(16)}`;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AAD_TYPES = [
  "bytes32",
  "uint16",
  "bytes16",
  "bytes16",
  "bytes16",
  "bytes16",
  "bytes32",
  "uint16",
  "uint256",
  "address",
] as const;
const KMS_WRAPPING_CONTEXT_TYPES = ["bytes32", "uint16", "bytes32"] as const;

export const PRIVATE_EVIDENCE_AAD_VERSION = 1;
export const KMS_WRAPPING_CONTEXT_VERSION = 1;
export const PRIVATE_EVIDENCE_AAD_DOMAIN = keccak256(
  toUtf8Bytes("PONTE_PRIVATE_ROUTE_EVIDENCE_V1"),
);
export const KMS_WRAPPING_CONTEXT_DOMAIN = keccak256(
  toUtf8Bytes("PONTE_KMS_DEK_WRAP_CONTEXT_V1"),
);
export const CANONICAL_AAD_V1_LENGTH = AAD_TYPES.length * 32;
export const KMS_WRAPPING_CONTEXT_V1_LENGTH =
  KMS_WRAPPING_CONTEXT_TYPES.length * 32;

export interface CanonicalPrivateEvidenceAadInput {
  aadVersion: number;
  evidenceRecordId: string;
  businessId: string;
  invoiceId: string;
  quoteId: string;
  publicEvidenceId: string;
  evidenceSchemaVersion: number;
  chainId: bigint;
  registryAddress: string;
}

export interface CanonicalPrivateEvidenceAad {
  aadVersion: typeof PRIVATE_EVIDENCE_AAD_VERSION;
  evidenceRecordId: string;
  businessId: string;
  invoiceId: string;
  quoteId: string;
  publicEvidenceId: string;
  evidenceSchemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  chainId: typeof ARBITRUM_SEPOLIA_CHAIN_ID;
  registryAddress: string;
}

export class EvidenceAadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceAadValidationError";
  }
}

function fail(message: string): never {
  throw new EvidenceAadValidationError(message);
}

function assertExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${field} must be a plain object`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    fail(`${field} must contain exactly the canonical AAD fields`);
  }
}

/**
 * Validates an identity UUID at the persisted-evidence boundary and returns its
 * lowercase hyphenated representation. It never accepts a zero UUID.
 */
export function canonicalizeEvidenceUuid(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value))
    fail(`${field} must be a canonical UUID`);
  const normalized = value.toLowerCase();
  if (uuidBytes(normalized) === ZERO_BYTES16) fail(`${field} must not be zero`);
  return normalized;
}

function uuidBytes(value: string): string {
  return `0x${value.replaceAll("-", "")}`;
}

function canonicalBytes32(
  value: unknown,
  field: string,
  allowZero = true,
): string {
  if (typeof value !== "string" || !isHexString(value, 32))
    fail(`${field} must be an exact bytes32 hex value`);
  const normalized = value.toLowerCase();
  if (!allowZero && normalized === ZERO_BYTES32)
    fail(`${field} must not be zero`);
  return normalized;
}

function canonicalAddress(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field} must be a valid EVM address`);
  try {
    const normalized = getAddress(value).toLowerCase();
    if (normalized === ZERO_ADDRESS) fail(`${field} must not be zero`);
    return normalized;
  } catch (error) {
    if (error instanceof EvidenceAadValidationError) throw error;
    return fail(`${field} must be a valid EVM address`);
  }
}

function assertFixedValue(
  value: unknown,
  expected: number | bigint,
  field: string,
): void {
  if (value !== expected) fail(`${field} is not supported`);
}

/**
 * Validates and normalizes the fixed AAD v1 record binding. UUIDs must use the
 * hyphenated PostgreSQL shape and are normalized to lowercase, as are hashes
 * and addresses for persistence and JSON.
 */
export function canonicalizePrivateEvidenceAad(
  input: CanonicalPrivateEvidenceAadInput,
): CanonicalPrivateEvidenceAad {
  assertExactKeys(
    input,
    [
      "aadVersion",
      "evidenceRecordId",
      "businessId",
      "invoiceId",
      "quoteId",
      "publicEvidenceId",
      "evidenceSchemaVersion",
      "chainId",
      "registryAddress",
    ],
    "AAD input",
  );
  assertFixedValue(
    input.aadVersion,
    PRIVATE_EVIDENCE_AAD_VERSION,
    "aadVersion",
  );
  assertFixedValue(
    input.evidenceSchemaVersion,
    EVIDENCE_SCHEMA_VERSION,
    "evidenceSchemaVersion",
  );
  assertFixedValue(input.chainId, ARBITRUM_SEPOLIA_CHAIN_ID, "chainId");

  return {
    aadVersion: PRIVATE_EVIDENCE_AAD_VERSION,
    evidenceRecordId: canonicalizeEvidenceUuid(
      input.evidenceRecordId,
      "evidenceRecordId",
    ),
    businessId: canonicalizeEvidenceUuid(input.businessId, "businessId"),
    invoiceId: canonicalizeEvidenceUuid(input.invoiceId, "invoiceId"),
    quoteId: canonicalizeEvidenceUuid(input.quoteId, "quoteId"),
    publicEvidenceId: canonicalBytes32(
      input.publicEvidenceId,
      "publicEvidenceId",
      false,
    ),
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    chainId: ARBITRUM_SEPOLIA_CHAIN_ID,
    registryAddress: canonicalAddress(input.registryAddress, "registryAddress"),
  };
}

function asBuffer(encodedHex: string): Buffer {
  return Buffer.from(encodedHex.slice(2), "hex");
}

/**
 * Returns exactly 320 bytes of Solidity abi.encode data for the frozen AAD v1
 * field order. It never serializes JSON or delimiter-separated identifiers.
 */
export function buildCanonicalPrivateEvidenceAad(
  input: CanonicalPrivateEvidenceAadInput,
): Buffer {
  const canonical = canonicalizePrivateEvidenceAad(input);
  return asBuffer(
    abi.encode(AAD_TYPES, [
      PRIVATE_EVIDENCE_AAD_DOMAIN,
      canonical.aadVersion,
      uuidBytes(canonical.evidenceRecordId),
      uuidBytes(canonical.businessId),
      uuidBytes(canonical.invoiceId),
      uuidBytes(canonical.quoteId),
      canonical.publicEvidenceId,
      canonical.evidenceSchemaVersion,
      canonical.chainId,
      canonical.registryAddress,
    ]),
  );
}

function assertCanonicalAadBuffer(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || value.length !== CANONICAL_AAD_V1_LENGTH)
    fail("canonicalAad must be a canonical AAD v1 Buffer");

  const encoded = `0x${value.toString("hex")}`;
  try {
    const decoded = abi.decode(AAD_TYPES, encoded);
    const reencoded = abi.encode(AAD_TYPES, Array.from(decoded));
    if (reencoded.toLowerCase() !== encoded.toLowerCase())
      fail("canonicalAad must be a canonical AAD v1 Buffer");
    if (
      decoded[0].toLowerCase() !== PRIVATE_EVIDENCE_AAD_DOMAIN ||
      decoded[1] !== BigInt(PRIVATE_EVIDENCE_AAD_VERSION) ||
      decoded[2].toLowerCase() === ZERO_BYTES16 ||
      decoded[3].toLowerCase() === ZERO_BYTES16 ||
      decoded[4].toLowerCase() === ZERO_BYTES16 ||
      decoded[5].toLowerCase() === ZERO_BYTES16 ||
      decoded[6].toLowerCase() === ZERO_BYTES32 ||
      decoded[7] !== BigInt(EVIDENCE_SCHEMA_VERSION) ||
      decoded[8] !== ARBITRUM_SEPOLIA_CHAIN_ID ||
      decoded[9].toLowerCase() === ZERO_ADDRESS
    ) {
      fail("canonicalAad must be a canonical AAD v1 Buffer");
    }
  } catch (error) {
    if (error instanceof EvidenceAadValidationError) throw error;
    fail("canonicalAad must be a canonical AAD v1 Buffer");
  }
  return value;
}

/**
 * Returns exactly 96 bytes of domain-separated KMS wrapping context. The
 * context contains only its version and keccak256 of validated canonical AAD;
 * it contains no raw identifiers or private evidence plaintext.
 */
export function buildKmsWrappingContext(canonicalAad: Buffer): Buffer {
  const validatedAad = assertCanonicalAadBuffer(canonicalAad);
  return asBuffer(
    abi.encode(KMS_WRAPPING_CONTEXT_TYPES, [
      KMS_WRAPPING_CONTEXT_DOMAIN,
      KMS_WRAPPING_CONTEXT_VERSION,
      keccak256(validatedAad),
    ]),
  );
}
