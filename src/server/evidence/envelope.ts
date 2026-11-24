// Application-side content encryption only. This module deliberately contains
// no KMS client, provider implementation, DEK generation, persistence, or
// lifecycle integration.
import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const EVIDENCE_ENVELOPE_VERSION = 1;
export const EVIDENCE_CONTENT_ALGORITHM = "AES-256-GCM";

export interface EncryptedEvidenceEnvelope {
  ciphertext: Buffer;
  nonce: Buffer;
  authenticationTag: Buffer;
  envelopeVersion: typeof EVIDENCE_ENVELOPE_VERSION;
  contentAlgorithm: typeof EVIDENCE_CONTENT_ALGORITHM;
}

export interface EncryptEvidenceEnvelopeInput {
  /** Private evidence bytes. This module never logs or persists them. */
  plaintext: Buffer;
  /** Caller-owned plaintext 32-byte DEK; it is never retained or cleared here. */
  dek: Buffer;
  /** Required, canonical non-secret AAD constructed and validated by the caller. */
  canonicalAad: Buffer;
}

export interface DecryptEvidenceEnvelopeInput extends EncryptedEvidenceEnvelope {
  /** Caller-owned plaintext 32-byte DEK; it is never retained or cleared here. */
  dek: Buffer;
  /** The exact canonical AAD supplied when this envelope was encrypted. */
  canonicalAad: Buffer;
}

export class EvidenceEnvelopeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceEnvelopeValidationError";
  }
}

export class EvidenceEnvelopeOperationError extends Error {
  constructor() {
    super("evidence envelope operation failed");
    this.name = "EvidenceEnvelopeOperationError";
  }
}

export class EvidenceEnvelopeAuthenticationError extends Error {
  constructor() {
    super("evidence envelope authentication failed");
    this.name = "EvidenceEnvelopeAuthenticationError";
  }
}

function fail(message: string): never {
  throw new EvidenceEnvelopeValidationError(message);
}

function assertObject(value: unknown, field: string): void {
  if (typeof value !== "object" || value === null)
    fail(`${field} must be an object`);
}

function assertBuffer(value: unknown, field: string): asserts value is Buffer {
  if (!Buffer.isBuffer(value)) fail(`${field} must be a Buffer`);
}

function assertDek(value: unknown): asserts value is Buffer {
  assertBuffer(value, "dek");
  if (value.length !== 32) fail("dek must be exactly 32 bytes");
}

function assertCanonicalAad(value: unknown): asserts value is Buffer {
  assertBuffer(value, "canonicalAad");
  if (value.length < 1) fail("canonicalAad must be a non-empty Buffer");
}

function assertPlaintext(value: unknown): asserts value is Buffer {
  assertBuffer(value, "plaintext");
  if (value.length < 1) fail("plaintext must be a non-empty Buffer");
}

function assertCiphertext(value: unknown): asserts value is Buffer {
  assertBuffer(value, "ciphertext");
  if (value.length < 1) fail("ciphertext must be a non-empty Buffer");
}

function assertNonce(value: unknown): asserts value is Buffer {
  assertBuffer(value, "nonce");
  if (value.length !== 12) fail("nonce must be exactly 12 bytes");
}

function assertAuthenticationTag(value: unknown): asserts value is Buffer {
  assertBuffer(value, "authenticationTag");
  if (value.length !== 16) fail("authenticationTag must be exactly 16 bytes");
}

function assertEnvelopeVersion(value: unknown): void {
  if (value !== EVIDENCE_ENVELOPE_VERSION)
    fail(`envelopeVersion must be ${EVIDENCE_ENVELOPE_VERSION}`);
}

function assertContentAlgorithm(value: unknown): void {
  if (value !== EVIDENCE_CONTENT_ALGORITHM)
    fail(`contentAlgorithm must be ${EVIDENCE_CONTENT_ALGORITHM}`);
}

function validateEncryptionInput(
  input: EncryptEvidenceEnvelopeInput,
): asserts input is EncryptEvidenceEnvelopeInput {
  assertObject(input, "encryption input");
  assertPlaintext(input.plaintext);
  assertDek(input.dek);
  assertCanonicalAad(input.canonicalAad);
}

function validateDecryptionInput(
  input: DecryptEvidenceEnvelopeInput,
): asserts input is DecryptEvidenceEnvelopeInput {
  assertObject(input, "decryption input");
  assertCiphertext(input.ciphertext);
  assertNonce(input.nonce);
  assertAuthenticationTag(input.authenticationTag);
  assertEnvelopeVersion(input.envelopeVersion);
  assertContentAlgorithm(input.contentAlgorithm);
  assertDek(input.dek);
  assertCanonicalAad(input.canonicalAad);
}

function clearTemporaryPlaintextBestEffort(value: Buffer | undefined): void {
  try {
    value?.fill(0);
  } catch {
    // Buffer clearing is best effort and must not replace the crypto outcome.
  }
}

/**
 * Encrypts one non-empty private evidence payload with AES-256-GCM.
 *
 * A fresh 12-byte CSPRNG nonce is generated for every invocation. The returned
 * object intentionally has no plaintext DEK. The caller owns `input.dek` and
 * remains responsible for clearing its temporary DEK buffer after all required
 * uses; this function neither retains nor mutates that caller-owned buffer.
 */
export function encryptEvidenceEnvelope(
  input: EncryptEvidenceEnvelopeInput,
): EncryptedEvidenceEnvelope {
  validateEncryptionInput(input);

  let nonce: Buffer;
  try {
    nonce = randomBytes(12);
  } catch {
    throw new EvidenceEnvelopeOperationError();
  }

  try {
    const cipher = createCipheriv("aes-256-gcm", input.dek, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(input.canonicalAad);
    const ciphertext = Buffer.concat([
      cipher.update(input.plaintext),
      cipher.final(),
    ]);
    const authenticationTag = cipher.getAuthTag();

    return {
      ciphertext,
      nonce,
      authenticationTag,
      envelopeVersion: EVIDENCE_ENVELOPE_VERSION,
      contentAlgorithm: EVIDENCE_CONTENT_ALGORITHM,
    };
  } catch {
    throw new EvidenceEnvelopeOperationError();
  }
}

/**
 * Authenticates then returns a private evidence plaintext. No plaintext is
 * returned to the caller unless AES-GCM authentication completes successfully.
 * The temporary decipher chunks are overwritten in `finally` after their
 * separate returned Buffer has been constructed. The caller owns `input.dek`
 * and is responsible for best-effort clearing after use; Node.js does not
 * guarantee secure zeroization of runtime/native copies.
 */
export function decryptEvidenceEnvelope(
  input: DecryptEvidenceEnvelopeInput,
): Buffer {
  validateDecryptionInput(input);

  let intermediatePlaintext: Buffer | undefined;
  let finalPlaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", input.dek, input.nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(input.canonicalAad);
    decipher.setAuthTag(input.authenticationTag);
    intermediatePlaintext = decipher.update(input.ciphertext);
    finalPlaintext = decipher.final();
    return Buffer.concat([intermediatePlaintext, finalPlaintext]);
  } catch {
    throw new EvidenceEnvelopeAuthenticationError();
  } finally {
    clearTemporaryPlaintextBestEffort(intermediatePlaintext);
    clearTemporaryPlaintextBestEffort(finalPlaintext);
  }
}
