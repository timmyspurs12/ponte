import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptEvidenceEnvelope,
  EVIDENCE_CONTENT_ALGORITHM,
  EVIDENCE_ENVELOPE_VERSION,
  encryptEvidenceEnvelope,
  EvidenceEnvelopeAuthenticationError,
  EvidenceEnvelopeOperationError,
  EvidenceEnvelopeValidationError,
  type DecryptEvidenceEnvelopeInput,
} from "../../src/server/evidence/envelope";

const syntheticDek = Buffer.from("01".repeat(32), "hex");
const syntheticPlaintext = Buffer.from(
  "synthetic private route-decision evidence only",
  "utf8",
);
const syntheticAad = Buffer.from(
  "PONTE_PRIVATE_ROUTE_EVIDENCE_V1|synthetic-record|synthetic-business|421614",
  "utf8",
);

function encrypt() {
  return encryptEvidenceEnvelope({
    plaintext: syntheticPlaintext,
    dek: syntheticDek,
    canonicalAad: syntheticAad,
  });
}

function decryptInput(
  overrides: Partial<DecryptEvidenceEnvelopeInput> = {},
): DecryptEvidenceEnvelopeInput {
  return {
    ...encrypt(),
    dek: syntheticDek,
    canonicalAad: syntheticAad,
    ...overrides,
  };
}

const isValidationError = (error: unknown) =>
  error instanceof EvidenceEnvelopeValidationError;
const isAuthenticationError = (error: unknown) =>
  error instanceof EvidenceEnvelopeAuthenticationError;
const isOperationError = (error: unknown) =>
  error instanceof EvidenceEnvelopeOperationError;

/**
 * A test-only, scoped observation of the private cleanup implementation. It
 * intercepts Buffer.fill without adding any test API or capability to the
 * application module, and always restores the native method before returning.
 */
function captureTemporaryZeroFills<T>(operation: () => T): {
  result: T | undefined;
  error: unknown;
  cleared: Buffer[];
} {
  const originalFill = Buffer.prototype.fill;
  const cleared: Buffer[] = [];
  Buffer.prototype.fill = function (this: Buffer, ...args: unknown[]): Buffer {
    if (args[0] === 0) cleared.push(this);
    return Reflect.apply(originalFill, this, args) as Buffer;
  } as typeof Buffer.prototype.fill;

  try {
    return { result: operation(), error: undefined, cleared };
  } catch (error) {
    return { result: undefined, error, cleared };
  } finally {
    Buffer.prototype.fill = originalFill;
  }
}

test("AES-256-GCM envelope round-trips synthetic private evidence", () => {
  const envelope = encrypt();

  assert.equal(envelope.envelopeVersion, EVIDENCE_ENVELOPE_VERSION);
  assert.equal(envelope.contentAlgorithm, EVIDENCE_CONTENT_ALGORITHM);
  assert.equal(envelope.nonce.length, 12);
  assert.equal(envelope.authenticationTag.length, 16);
  assert.equal(Buffer.isBuffer(envelope.ciphertext), true);
  assert.equal(envelope.ciphertext.length > 0, true);
  assert.deepEqual(
    decryptEvidenceEnvelope({
      ...envelope,
      dek: syntheticDek,
      canonicalAad: syntheticAad,
    }),
    syntheticPlaintext,
  );
});

test("successful decryption preserves the returned plaintext while clearing both temporary chunks", () => {
  const envelope = encrypt();
  const observed = captureTemporaryZeroFills(() =>
    decryptEvidenceEnvelope({
      ...envelope,
      dek: syntheticDek,
      canonicalAad: syntheticAad,
    }),
  );

  assert.equal(observed.error, undefined);
  assert.ok(observed.result);
  assert.deepEqual(observed.result, syntheticPlaintext);
  assert.equal(observed.cleared.length, 2);
  for (const temporaryChunk of observed.cleared) {
    assert.notStrictEqual(temporaryChunk, observed.result);
    assert.equal(
      [...temporaryChunk].every((byte) => byte === 0),
      true,
    );
  }
  assert.deepEqual(observed.result, syntheticPlaintext);
});

test("failed authentication clears the available intermediate plaintext chunk", () => {
  const envelope = encrypt();
  const observed = captureTemporaryZeroFills(() =>
    decryptEvidenceEnvelope({
      ...envelope,
      dek: syntheticDek,
      canonicalAad: Buffer.from("wrong synthetic AAD", "utf8"),
    }),
  );

  assert.equal(observed.result, undefined);
  assert.equal(isAuthenticationError(observed.error), true);
  assert.equal(observed.cleared.length, 1);
  assert.equal(observed.cleared[0].length > 0, true);
  assert.equal(
    [...observed.cleared[0]].every((byte) => byte === 0),
    true,
  );
});

test("repeated encryption uses fresh nonces and authenticated distinct ciphertext", () => {
  const first = encrypt();
  const second = encrypt();

  assert.notDeepEqual(first.nonce, second.nonce);
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert.deepEqual(
    decryptEvidenceEnvelope({
      ...first,
      dek: syntheticDek,
      canonicalAad: syntheticAad,
    }),
    syntheticPlaintext,
  );
  assert.deepEqual(
    decryptEvidenceEnvelope({
      ...second,
      dek: syntheticDek,
      canonicalAad: syntheticAad,
    }),
    syntheticPlaintext,
  );
});

test("rejects 31-byte and 33-byte DEKs before encryption or decryption", () => {
  for (const length of [31, 33]) {
    const dek = Buffer.alloc(length, 4);
    assert.throws(
      () =>
        encryptEvidenceEnvelope({
          plaintext: syntheticPlaintext,
          dek,
          canonicalAad: syntheticAad,
        }),
      isValidationError,
    );
    assert.throws(
      () => decryptEvidenceEnvelope(decryptInput({ dek })),
      isValidationError,
    );
  }
});

test("rejects malformed nonce and authentication-tag lengths before decryption", () => {
  for (const nonce of [Buffer.alloc(11), Buffer.alloc(13)]) {
    assert.throws(
      () => decryptEvidenceEnvelope(decryptInput({ nonce })),
      isValidationError,
    );
  }
  for (const authenticationTag of [Buffer.alloc(15), Buffer.alloc(17)]) {
    assert.throws(
      () => decryptEvidenceEnvelope(decryptInput({ authenticationTag })),
      isValidationError,
    );
  }
});

test("authenticated decryption rejects tampered ciphertext, tag, nonce, key, and AAD", () => {
  const envelope = encrypt();
  const tamperedCiphertext = Buffer.from(envelope.ciphertext);
  tamperedCiphertext[0] ^= 1;
  const tamperedTag = Buffer.from(envelope.authenticationTag);
  tamperedTag[0] ^= 1;
  const tamperedNonce = Buffer.from(envelope.nonce);
  tamperedNonce[0] ^= 1;

  const cases: Array<Partial<DecryptEvidenceEnvelopeInput>> = [
    { ciphertext: tamperedCiphertext },
    { authenticationTag: tamperedTag },
    { nonce: tamperedNonce },
    { dek: Buffer.alloc(32, 9) },
    { canonicalAad: Buffer.from("different synthetic canonical AAD", "utf8") },
  ];

  for (const overrides of cases) {
    assert.throws(
      () =>
        decryptEvidenceEnvelope({
          ...envelope,
          dek: syntheticDek,
          canonicalAad: syntheticAad,
          ...overrides,
        }),
      isAuthenticationError,
    );
  }
});

test("rejects unsupported envelope metadata and non-Buffer or missing AAD input", () => {
  assert.throws(
    () =>
      decryptEvidenceEnvelope(decryptInput({ envelopeVersion: 2 as never })),
    isValidationError,
  );
  assert.throws(
    () =>
      decryptEvidenceEnvelope(
        decryptInput({ contentAlgorithm: "AES-128-GCM" as never }),
      ),
    isValidationError,
  );
  assert.throws(
    () =>
      encryptEvidenceEnvelope({
        plaintext: syntheticPlaintext,
        dek: syntheticDek,
        canonicalAad: Buffer.alloc(0),
      }),
    isValidationError,
  );
  assert.throws(
    () =>
      encryptEvidenceEnvelope({
        plaintext: "not-a-buffer" as never,
        dek: syntheticDek,
        canonicalAad: syntheticAad,
      }),
    isValidationError,
  );
  assert.throws(
    () =>
      decryptEvidenceEnvelope(
        decryptInput({ ciphertext: "not-a-buffer" as never }),
      ),
    isValidationError,
  );
  assert.throws(
    () =>
      decryptEvidenceEnvelope(
        decryptInput({ canonicalAad: undefined as never }),
      ),
    isValidationError,
  );
});

test("unexpected encryption-operation failures use a generic operation error", () => {
  const originalConcat = Buffer.concat;
  const syntheticInternalMessage = "synthetic internal crypto failure";
  Buffer.concat = () => {
    throw new Error(syntheticInternalMessage);
  };

  try {
    let operationError: unknown;
    try {
      encrypt();
    } catch (error) {
      operationError = error;
    }
    assert.equal(isOperationError(operationError), true);
    assert.equal(
      (operationError as Error).message,
      "evidence envelope operation failed",
    );
    for (const secret of [
      syntheticPlaintext.toString("utf8"),
      syntheticDek.toString("hex"),
      syntheticAad.toString("utf8"),
      syntheticInternalMessage,
    ]) {
      assert.equal(String(operationError).includes(secret), false);
    }
  } finally {
    Buffer.concat = originalConcat;
  }
});

test("encryption leaves the caller-owned DEK untouched and omits it from the result", () => {
  const callerDek = Buffer.from(syntheticDek);
  const expectedDek = Buffer.from(callerDek);
  const envelope = encryptEvidenceEnvelope({
    plaintext: syntheticPlaintext,
    dek: callerDek,
    canonicalAad: syntheticAad,
  });

  assert.deepEqual(callerDek, expectedDek);
  assert.equal("plaintextDek" in envelope, false);
  assert.equal("dek" in envelope, false);
  assert.deepEqual(Object.keys(envelope).sort(), [
    "authenticationTag",
    "ciphertext",
    "contentAlgorithm",
    "envelopeVersion",
    "nonce",
  ]);
});

test("envelope errors and calls do not expose synthetic secrets through messages or logs", () => {
  const calls: unknown[][] = [];
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  const envelope = encrypt();
  const secretFragments = [
    syntheticPlaintext.toString("utf8"),
    syntheticDek.toString("hex"),
    syntheticAad.toString("utf8"),
    envelope.ciphertext.toString("hex"),
    envelope.authenticationTag.toString("hex"),
  ];

  console.log = (...args: unknown[]) => calls.push(args);
  console.info = (...args: unknown[]) => calls.push(args);
  console.warn = (...args: unknown[]) => calls.push(args);
  console.error = (...args: unknown[]) => calls.push(args);
  try {
    const validationError = assert.throws(
      () =>
        encryptEvidenceEnvelope({
          plaintext: syntheticPlaintext,
          dek: Buffer.alloc(31, 6),
          canonicalAad: syntheticAad,
        }),
      isValidationError,
    );
    const authenticationError = assert.throws(
      () =>
        decryptEvidenceEnvelope({
          ...envelope,
          dek: syntheticDek,
          canonicalAad: Buffer.from("wrong synthetic AAD"),
        }),
      isAuthenticationError,
    );

    for (const error of [validationError, authenticationError]) {
      const message = String(error);
      for (const secret of secretFragments)
        assert.equal(message.includes(secret), false);
    }
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
  }

  assert.deepEqual(calls, []);
});
