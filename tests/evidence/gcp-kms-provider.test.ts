import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVED_GCP_KMS_LOCATION,
  crc32c,
  GcpKmsDekProvider,
  type GcpKmsClient,
  type GcpKmsEncryptRequest,
  type GcpKmsEncryptResponse,
  parseGcpCryptoKeyVersion,
} from "../../src/server/evidence/gcp-kms-provider";
import { EvidenceCandidatePreparationError } from "../../src/server/evidence/errors";
import {
  isLocalTestOnlyDekWrappingMetadata,
  KMS_PROVIDER,
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

class MockKmsClient implements GcpKmsClient {
  readonly requests: GcpKmsEncryptRequest[] = [];

  constructor(
    private readonly handler: (
      request: GcpKmsEncryptRequest,
    ) => GcpKmsEncryptResponse | Promise<GcpKmsEncryptResponse>,
  ) {}

  async encrypt(
    request: GcpKmsEncryptRequest,
  ): Promise<readonly [GcpKmsEncryptResponse]> {
    this.requests.push(request);
    return [await this.handler(request)];
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
