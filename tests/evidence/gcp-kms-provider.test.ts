import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVED_GCP_KMS_LOCATION,
  crc32c,
  GcpKmsDekProvider,
  type GcpKmsClient,
  type GcpKmsDecryptRequest,
  type GcpKmsDecryptResponse,
  type GcpKmsEncryptRequest,
  type GcpKmsEncryptResponse,
  parseGcpCryptoKeyVersion,
} from "../../src/server/evidence/gcp-kms-provider";
import {
  decryptEvidenceEnvelope,
  encryptEvidenceEnvelope,
  EvidenceEnvelopeAuthenticationError,
} from "../../src/server/evidence/envelope";
import { EvidenceCandidatePreparationError } from "../../src/server/evidence/errors";
import {
  isLocalTestOnlyDekWrappingMetadata,
  KMS_PROVIDER,
  type DekUnwrappingInput,
  WRAPPED_DEK_ALGORITHM,
  WRAPPED_DEK_FORMAT,
} from "../../src/server/evidence/kms";

const CRYPTO_KEY_VERSION =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/7";
const CRYPTO_KEY_REFERENCE =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence";
const CANONICAL_CONTEXT = Buffer.from(
  "PONTE_KMS_WRAPPING_CONTEXT_V1 deterministic test context",
  "utf8",
);
const TEST_CIPHERTEXT = Buffer.from(
  "deterministic-kms-ciphertext-fixture-v1",
  "utf8",
);
const TEST_RECOVERED_DEK = Buffer.from(
  "b4e2c83dc532a47c4d4a110e4f22d3d47ec6986b34aa3e3b4f783b9791a9de0c",
  "hex",
);

const isProviderFailure = (error: unknown): boolean =>
  error instanceof EvidenceCandidatePreparationError &&
  error.code === "PROVIDER_FAILURE";

// This deterministic mock exercises adapter-side protocol checks only. It is
// not evidence that a live KMS Encrypt operation succeeded.
function successfulResponse(
  overrides: Partial<GcpKmsEncryptResponse> = {},
): GcpKmsEncryptResponse {
  return {
    name: CRYPTO_KEY_VERSION,
    ciphertext: TEST_CIPHERTEXT,
    ciphertextCrc32c: { value: crc32c(TEST_CIPHERTEXT) },
    verifiedPlaintextCrc32c: true,
    verifiedAdditionalAuthenticatedDataCrc32c: true,
    ...overrides,
  };
}

function successfulDecryptResponse(
  overrides: Partial<GcpKmsDecryptResponse> = {},
): GcpKmsDecryptResponse {
  const plaintext = Buffer.from(TEST_RECOVERED_DEK);
  return {
    plaintext,
    plaintextCrc32c: { value: crc32c(plaintext) },
    ...overrides,
  };
}

// This deterministic mock exercises adapter-side protocol checks only. It
// never discovers credentials or contacts live Google Cloud KMS.
class MockKmsClient implements GcpKmsClient {
  readonly requests: GcpKmsEncryptRequest[] = [];
  readonly decryptRequests: GcpKmsDecryptRequest[] = [];

  constructor(
    private readonly handler: (
      request: GcpKmsEncryptRequest,
    ) => GcpKmsEncryptResponse | Promise<GcpKmsEncryptResponse>,
    private readonly decryptHandler: (
      request: GcpKmsDecryptRequest,
    ) => GcpKmsDecryptResponse | Promise<GcpKmsDecryptResponse> = () =>
      successfulDecryptResponse(),
  ) {}

  async encrypt(
    request: GcpKmsEncryptRequest,
  ): Promise<readonly [GcpKmsEncryptResponse]> {
    this.requests.push(request);
    return [await this.handler(request)];
  }

  async decrypt(
    request: GcpKmsDecryptRequest,
  ): Promise<readonly [GcpKmsDecryptResponse]> {
    this.decryptRequests.push(request);
    return [await this.decryptHandler(request)];
  }
}

function provider(client: GcpKmsClient): GcpKmsDekProvider {
  return new GcpKmsDekProvider({
    cryptoKeyVersion: CRYPTO_KEY_VERSION,
    client,
  });
}

function assertCleared(request: GcpKmsEncryptRequest): void {
  assert.deepEqual(request.plaintext, Buffer.alloc(32));
}

function unwrapInput(
  overrides: Partial<DekUnwrappingInput> = {},
): DekUnwrappingInput {
  return {
    kmsProvider: KMS_PROVIDER.GCP_CLOUD_KMS,
    kmsKeyReference: CRYPTO_KEY_REFERENCE,
    kmsKeyVersion: CRYPTO_KEY_VERSION,
    wrappedDekAlgorithm: WRAPPED_DEK_ALGORITHM.GOOGLE_SYMMETRIC_ENCRYPTION,
    wrappedDekFormat: WRAPPED_DEK_FORMAT.GCP_KMS_ENCRYPT_CIPHERTEXT_V1,
    wrappedDek: Buffer.from(TEST_CIPHERTEXT),
    canonicalContext: CANONICAL_CONTEXT,
    ...overrides,
  };
}

test("CRC32C uses the published Castagnoli vector", () => {
  assert.equal(crc32c(Buffer.from("123456789", "utf8")), 0xe3069283);
});

test("accepts only an immutable approved-region CryptoKeyVersion resource", () => {
  const parsed = parseGcpCryptoKeyVersion(CRYPTO_KEY_VERSION);
  assert.deepEqual(parsed, {
    cryptoKeyVersion: CRYPTO_KEY_VERSION,
    cryptoKeyReference: CRYPTO_KEY_REFERENCE,
    project: "ponte-kms-12345",
    location: APPROVED_GCP_KMS_LOCATION,
    keyRing: "ponte-evidence",
    cryptoKey: "route-evidence",
    version: "7",
  });

  for (const invalid of [
    "projects/short/locations/africa-south1/keyRings/ring/cryptoKeys/key/cryptoKeyVersions/7",
    "projects/ponte-kms-12345/locations/us-central1/keyRings/ring/cryptoKeys/key/cryptoKeyVersions/7",
    "projects/ponte-kms-12345/locations/africa-south1/keyRings/ring/cryptoKeys/key",
    "projects/ponte-kms-12345/locations/africa-south1/keyRings/ring/cryptoKeys/key/cryptoKeyVersions/latest",
    "projects/ponte-kms-12345/locations/africa-south1/keyRings/ring/cryptoKeys/key/cryptoKeyVersions/0",
    "projects/ponte-kms-12345/locations/africa-south1/keyRings/ring/cryptoKeys/not a key/cryptoKeyVersions/7",
    "projects/ponte-kms-12345/locations/africa-south1/keyRings/ring/cryptoKeys/key/cryptoKeyVersions/7/aliases/primary",
    "projects/ponte-kms-12345/locations/africa-south1/keyRings/not a ring/cryptoKeys/key/cryptoKeyVersions/7",
  ]) {
    assert.throws(() => parseGcpCryptoKeyVersion(invalid), isProviderFailure);
  }
});

test("the adapter composes and validates a deterministic mocked Encrypt protocol response", async () => {
  const client = new MockKmsClient(() => successfulResponse());
  const result = await provider(client).createAndWrapDek({
    canonicalContext: CANONICAL_CONTEXT,
  });
  const request = client.requests[0];

  assert.equal(client.requests.length, 1);
  assert.equal(request.name, CRYPTO_KEY_VERSION);
  assert.strictEqual(request.additionalAuthenticatedData, CANONICAL_CONTEXT);
  assert.equal(request.plaintext.length, 32);
  assert.notDeepEqual(request.plaintext, Buffer.alloc(32));
  assert.equal(request.plaintextCrc32c.value, crc32c(request.plaintext));
  assert.equal(
    request.additionalAuthenticatedDataCrc32c.value,
    crc32c(CANONICAL_CONTEXT),
  );
  assert.deepEqual(result.wrappedDek, TEST_CIPHERTEXT);
  assert.equal(result.kmsProvider, KMS_PROVIDER.GCP_CLOUD_KMS);
  assert.equal(
    result.wrappedDekAlgorithm,
    WRAPPED_DEK_ALGORITHM.GOOGLE_SYMMETRIC_ENCRYPTION,
  );
  assert.equal(
    result.wrappedDekFormat,
    WRAPPED_DEK_FORMAT.GCP_KMS_ENCRYPT_CIPHERTEXT_V1,
  );
  assert.equal(result.kmsKeyReference, CRYPTO_KEY_REFERENCE);
  assert.equal(result.kmsKeyVersion, CRYPTO_KEY_VERSION);
  assert.equal(isLocalTestOnlyDekWrappingMetadata(result), false);
});

test("missing or mismatched returned CryptoKeyVersion fails closed and clears the DEK", async () => {
  for (const name of [
    undefined,
    "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/8",
  ]) {
    const client = new MockKmsClient(() => successfulResponse({ name }));
    await assert.rejects(
      provider(client).createAndWrapDek({
        canonicalContext: CANONICAL_CONTEXT,
      }),
      isProviderFailure,
    );
    assert.equal(client.requests.length, 1);
    assertCleared(client.requests[0]);
  }
});

test("empty or malformed ciphertext and missing or invalid response CRC32C fail closed", async () => {
  const responses: readonly GcpKmsEncryptResponse[] = [
    successfulResponse({ ciphertext: Buffer.alloc(0) }),
    successfulResponse({ ciphertext: "not-an-opaque-byte-buffer" }),
    successfulResponse({ ciphertextCrc32c: undefined }),
    successfulResponse({ ciphertextCrc32c: { value: 1 } }),
  ];

  for (const response of responses) {
    const client = new MockKmsClient(() => response);
    await assert.rejects(
      provider(client).createAndWrapDek({
        canonicalContext: CANONICAL_CONTEXT,
      }),
      isProviderFailure,
    );
    assertCleared(client.requests[0]);
  }
});

test("KMS request and AAD integrity acknowledgements are mandatory", async () => {
  for (const response of [
    successfulResponse({ verifiedPlaintextCrc32c: false }),
    successfulResponse({ verifiedAdditionalAuthenticatedDataCrc32c: false }),
    successfulResponse({ verifiedPlaintextCrc32c: undefined }),
    successfulResponse({
      verifiedAdditionalAuthenticatedDataCrc32c: undefined,
    }),
  ]) {
    const client = new MockKmsClient(() => response);
    await assert.rejects(
      provider(client).createAndWrapDek({
        canonicalContext: CANONICAL_CONTEXT,
      }),
      isProviderFailure,
    );
    assertCleared(client.requests[0]);
  }
});

test("disabled, destroyed, or otherwise unusable KMS failures are fixed and clear the DEK", async () => {
  // Encrypt reports unusable version state as an RPC error rather than a
  // successful EncryptResponse with a version-state field.
  for (const rawMessage of [
    "FAILED_PRECONDITION: CryptoKeyVersion is disabled",
    "FAILED_PRECONDITION: CryptoKeyVersion is destroyed",
    "PERMISSION_DENIED: private provider details",
  ]) {
    const client = new MockKmsClient(() => {
      throw new Error(rawMessage);
    });
    await assert.rejects(
      provider(client).createAndWrapDek({
        canonicalContext: CANONICAL_CONTEXT,
      }),
      (error: unknown) => {
        assert.equal(isProviderFailure(error), true);
        assert.doesNotMatch(
          (error as Error).message,
          /disabled|destroyed|private/i,
        );
        return true;
      },
    );
    assert.equal(client.requests.length, 1);
    assertCleared(client.requests[0]);
  }
});

test("configuration validation and malformed canonical context fail before any client operation", async () => {
  const client = new MockKmsClient(() => successfulResponse());
  assert.throws(
    () =>
      new GcpKmsDekProvider({
        cryptoKeyVersion: CRYPTO_KEY_REFERENCE,
        client,
      }),
    isProviderFailure,
  );

  await assert.rejects(
    provider(client).createAndWrapDek({ canonicalContext: Buffer.alloc(0) }),
    isProviderFailure,
  );
  assert.equal(client.requests.length, 0);
});

test("the adapter builds a CryptoKey-parent Decrypt request with exact persisted bytes, AAD, and CRC32C", async () => {
  const input = unwrapInput();
  const client = new MockKmsClient(
    () => successfulResponse(),
    () => successfulDecryptResponse(),
  );
  const recoveredDek = await provider(client).unwrapDek(input);
  const request = client.decryptRequests[0];

  assert.equal(client.decryptRequests.length, 1);
  assert.equal(request.name, CRYPTO_KEY_REFERENCE);
  assert.notEqual(request.name, CRYPTO_KEY_VERSION);
  assert.strictEqual(request.ciphertext, input.wrappedDek);
  assert.strictEqual(request.additionalAuthenticatedData, CANONICAL_CONTEXT);
  assert.equal(request.ciphertextCrc32c.value, crc32c(input.wrappedDek));
  assert.equal(
    request.additionalAuthenticatedDataCrc32c.value,
    crc32c(CANONICAL_CONTEXT),
  );
  assert.deepEqual(recoveredDek, TEST_RECOVERED_DEK);
  recoveredDek.fill(0);
});

test("Decrypt rejects mismatched, malformed, synthetic, or non-GCP persisted metadata before KMS", async () => {
  const inputs: readonly DekUnwrappingInput[] = [
    unwrapInput({ kmsKeyReference: `${CRYPTO_KEY_REFERENCE}-other` }),
    unwrapInput({
      kmsKeyVersion:
        "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/latest",
    }),
    unwrapInput({ kmsProvider: KMS_PROVIDER.AWS_KMS }),
    unwrapInput({
      wrappedDekAlgorithm:
        WRAPPED_DEK_ALGORITHM.AWS_KMS_GENERATE_DATA_KEY_AES_256,
    }),
    unwrapInput({
      kmsProvider: KMS_PROVIDER.LOCAL_TEST_ONLY,
      kmsKeyReference: "local-test-only/test-key",
      kmsKeyVersion: "local-test-only/test-version",
      wrappedDekAlgorithm: WRAPPED_DEK_ALGORITHM.LOCAL_TEST_RANDOM_BYTES_V1,
      wrappedDekFormat: WRAPPED_DEK_FORMAT.LOCAL_TEST_RANDOM_BYTES_V1,
    }),
  ];

  for (const input of inputs) {
    const client = new MockKmsClient(() => successfulResponse());
    await assert.rejects(provider(client).unwrapDek(input), isProviderFailure);
    assert.equal(client.decryptRequests.length, 0);
  }
});

test("Decrypt rejects empty or non-byte wrapped ciphertext before KMS", async () => {
  for (const wrappedDek of [
    Buffer.alloc(0),
    "not-an-opaque-byte-buffer" as unknown as Buffer,
  ]) {
    const client = new MockKmsClient(() => successfulResponse());
    await assert.rejects(
      provider(client).unwrapDek(unwrapInput({ wrappedDek })),
      isProviderFailure,
    );
    assert.equal(client.decryptRequests.length, 0);
  }
});

test("Decrypt requires a valid plaintext CRC32C and exactly 32 recovered DEK bytes, clearing failures", async () => {
  const invalidResponses = [
    successfulDecryptResponse({ plaintextCrc32c: undefined }),
    successfulDecryptResponse({ plaintextCrc32c: { value: 1 } }),
    (() => {
      const plaintext = Buffer.alloc(31, 0xa5);
      return {
        plaintext,
        plaintextCrc32c: { value: crc32c(plaintext) },
      } satisfies GcpKmsDecryptResponse;
    })(),
  ];

  for (const response of invalidResponses) {
    const recovered = response.plaintext;
    const client = new MockKmsClient(
      () => successfulResponse(),
      () => response,
    );
    await assert.rejects(
      provider(client).unwrapDek(unwrapInput()),
      isProviderFailure,
    );
    assert.equal(client.decryptRequests.length, 1);
    assert.ok(Buffer.isBuffer(recovered));
    assert.deepEqual(recovered, Buffer.alloc(recovered.length));
  }
});

test("Decrypt clears a non-Buffer plaintext response after validation failure", async () => {
  const rawPlaintext = Uint8Array.from(TEST_RECOVERED_DEK);
  const client = new MockKmsClient(
    () => successfulResponse(),
    () => ({
      plaintext: rawPlaintext,
      plaintextCrc32c: { value: 1 },
    }),
  );

  await assert.rejects(
    provider(client).unwrapDek(unwrapInput()),
    isProviderFailure,
  );
  assert.deepEqual(rawPlaintext, new Uint8Array(rawPlaintext.length));
});

test("Decrypt KMS errors are fixed, non-leaking provider errors", async () => {
  for (const rawMessage of [
    "FAILED_PRECONDITION: CryptoKeyVersion is disabled",
    "PERMISSION_DENIED: private provider details",
  ]) {
    const client = new MockKmsClient(
      () => successfulResponse(),
      () => {
        throw new Error(rawMessage);
      },
    );
    await assert.rejects(provider(client).unwrapDek(unwrapInput()), (error) => {
      assert.equal(isProviderFailure(error), true);
      assert.doesNotMatch(
        (error as Error).message,
        /disabled|private|permission/i,
      );
      return true;
    });
  }
});

test("a mocked recovered DEK can hand off to AES-256-GCM decryption and authenticates AAD and DEK", async () => {
  const providerReturnedDek = Buffer.from(TEST_RECOVERED_DEK);
  const client = new MockKmsClient(
    () => successfulResponse(),
    () => ({
      plaintext: providerReturnedDek,
      plaintextCrc32c: { value: crc32c(providerReturnedDek) },
    }),
  );
  const recoveredDek = await provider(client).unwrapDek(unwrapInput());
  const plaintext = Buffer.from("private deterministic evidence", "utf8");
  const envelope = encryptEvidenceEnvelope({
    plaintext,
    dek: recoveredDek,
    canonicalAad: CANONICAL_CONTEXT,
  });

  try {
    assert.deepEqual(
      decryptEvidenceEnvelope({
        ...envelope,
        dek: recoveredDek,
        canonicalAad: CANONICAL_CONTEXT,
      }),
      plaintext,
    );
    assert.throws(
      () =>
        decryptEvidenceEnvelope({
          ...envelope,
          dek: recoveredDek,
          canonicalAad: Buffer.from("wrong canonical AAD", "utf8"),
        }),
      EvidenceEnvelopeAuthenticationError,
    );
    assert.throws(
      () =>
        decryptEvidenceEnvelope({
          ...envelope,
          dek: Buffer.alloc(32, 0x5a),
          canonicalAad: CANONICAL_CONTEXT,
        }),
      EvidenceEnvelopeAuthenticationError,
    );
  } finally {
    // Successful unwrap callers own this buffer and must clear it after use.
    recoveredDek.fill(0);
  }
});
