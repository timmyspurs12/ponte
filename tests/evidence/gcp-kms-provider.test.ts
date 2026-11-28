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
  parseGcpCryptoKey,
  parseGcpCryptoKeyVersion,
} from "../../src/server/evidence/gcp-kms-provider";
import type { ApprovedKmsKeyVersions } from "../../src/server/evidence/approved-kms-key-versions";
import {
  decryptEvidenceEnvelope,
  encryptEvidenceEnvelope,
  EvidenceEnvelopeAuthenticationError,
} from "../../src/server/evidence/envelope";
import { EvidenceCandidatePreparationError } from "../../src/server/evidence/errors";
import {
  isLocalTestOnlyDekWrappingMetadata,
  KMS_PROVIDER,
  type DekProvider,
  type DekRewrapper,
  type DekUnwrapper,
  type DekUnwrappingInput,
  type RewrappedDek,
  WRAPPED_DEK_ALGORITHM,
  WRAPPED_DEK_FORMAT,
} from "../../src/server/evidence/kms";

const CRYPTO_KEY_VERSION =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/7";
const CRYPTO_KEY_REFERENCE =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence";
const HISTORICAL_VERSION_1 =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/3";
const HISTORICAL_VERSION_2 =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/5";
const UNKNOWN_VERSION =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/99";
const CROSS_PARENT_VERSION =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/other-key/cryptoKeyVersions/3";
const CROSS_PARENT_REFERENCE =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/other-key";
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

/** Immutable approved-version configuration used by the provider tests. */
function approvedVersions(
  overrides: Partial<ApprovedKmsKeyVersions> = {},
): ApprovedKmsKeyVersions {
  return {
    cryptoKeyReference: CRYPTO_KEY_REFERENCE,
    currentWriteVersion: CRYPTO_KEY_VERSION,
    approvedHistoricalVersions: [],
    ...overrides,
  };
}

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

function provider(
  client: GcpKmsClient,
  versions: ApprovedKmsKeyVersions = approvedVersions(),
): GcpKmsDekProvider {
  return new GcpKmsDekProvider({ approvedVersions: versions, client });
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

  // The parent CryptoKey parser accepts only the exact immutable parent
  // form in the approved region.
  const parent = parseGcpCryptoKey(CRYPTO_KEY_REFERENCE);
  assert.equal(parent.cryptoKeyReference, CRYPTO_KEY_REFERENCE);
  assert.equal(parent.location, APPROVED_GCP_KMS_LOCATION);
  for (const invalid of [
    "projects/ponte-kms-12345/locations/us-central1/keyRings/ponte-evidence/cryptoKeys/route-evidence",
    // A CryptoKeyVersion resource is not a CryptoKey parent.
    CRYPTO_KEY_VERSION,
  ]) {
    assert.throws(() => parseGcpCryptoKey(invalid), isProviderFailure);
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

test("the provider constructor validates the approved-version configuration before use", () => {
  const client = new MockKmsClient(() => successfulResponse());

  // Missing configuration fails closed at construction.
  assert.throws(
    () => new GcpKmsDekProvider({ client } as never),
    isProviderFailure,
  );

  // Malformed or inconsistent configuration fails closed at construction:
  // a CryptoKey parent instead of a version, a cross-parent version, a
  // duplicated historical version, the current write version duplicated as
  // a historical version, and an unknown field.
  const invalidConfigs: readonly ApprovedKmsKeyVersions[] = [
    approvedVersions({ currentWriteVersion: CRYPTO_KEY_REFERENCE }),
    approvedVersions({ currentWriteVersion: CROSS_PARENT_VERSION }),
    approvedVersions({
      approvedHistoricalVersions: [HISTORICAL_VERSION_1, HISTORICAL_VERSION_1],
    }),
    approvedVersions({ approvedHistoricalVersions: [CRYPTO_KEY_VERSION] }),
    approvedVersions({ approvedHistoricalVersions: [CROSS_PARENT_VERSION] }),
    approvedVersions({ approvedHistoricalVersions: ["not-a-version"] }),
    { ...approvedVersions(), extraField: "not accepted" } as ApprovedKmsKeyVersions,
  ];
  for (const config of invalidConfigs) {
    assert.throws(
      () => new GcpKmsDekProvider({ approvedVersions: config, client }),
      isProviderFailure,
      `expected fail-closed for ${JSON.stringify(config)}`,
    );
  }
});

test("configuration validation and malformed canonical context fail before any client operation", async () => {
  const client = new MockKmsClient(() => successfulResponse());
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

test("Decrypt recovers a DEK wrapped by the current write version", async () => {
  const client = new MockKmsClient(
    () => successfulResponse(),
    () => successfulDecryptResponse(),
  );
  const recoveredDek = await provider(client).unwrapDek(unwrapInput());
  assert.deepEqual(recoveredDek, TEST_RECOVERED_DEK);
  recoveredDek.fill(0);
});

test("Decrypt recovers a DEK wrapped by one approved historical version", async () => {
  const versions = approvedVersions({
    approvedHistoricalVersions: [HISTORICAL_VERSION_1],
  });
  const client = new MockKmsClient(
    () => successfulResponse(),
    () => successfulDecryptResponse(),
  );
  const recoveredDek = await provider(client, versions).unwrapDek(
    unwrapInput({ kmsKeyVersion: HISTORICAL_VERSION_1 }),
  );
  assert.deepEqual(recoveredDek, TEST_RECOVERED_DEK);
  recoveredDek.fill(0);
});

test("Decrypt recovers a DEK wrapped by any of multiple approved historical versions", async () => {
  const versions = approvedVersions({
    approvedHistoricalVersions: [HISTORICAL_VERSION_1, HISTORICAL_VERSION_2],
  });
  for (const historical of [HISTORICAL_VERSION_1, HISTORICAL_VERSION_2]) {
    const client = new MockKmsClient(
      () => successfulResponse(),
      () => successfulDecryptResponse(),
    );
    const recoveredDek = await provider(client, versions).unwrapDek(
      unwrapInput({ kmsKeyVersion: historical }),
    );
    assert.deepEqual(recoveredDek, TEST_RECOVERED_DEK);
    recoveredDek.fill(0);
  }
});

test("an approved historical version and the current write version share one parent", async () => {
  const versions = approvedVersions({
    approvedHistoricalVersions: [HISTORICAL_VERSION_1],
  });
  for (const storedVersion of [CRYPTO_KEY_VERSION, HISTORICAL_VERSION_1]) {
    const client = new MockKmsClient(
      () => successfulResponse(),
      () => successfulDecryptResponse(),
    );
    const recoveredDek = await provider(client, versions).unwrapDek(
      unwrapInput({ kmsKeyVersion: storedVersion }),
    );
    assert.deepEqual(recoveredDek, TEST_RECOVERED_DEK);
    recoveredDek.fill(0);
  }
});

test("Decrypt rejects unapproved, unknown, malformed, or cross-parent versions before KMS", async () => {
  const versions = approvedVersions({
    approvedHistoricalVersions: [HISTORICAL_VERSION_1],
  });
  const inputs: readonly DekUnwrappingInput[] = [
    // A valid version under the same parent that is not approved.
    unwrapInput({ kmsKeyVersion: UNKNOWN_VERSION }),
    // A valid version under a different parent CryptoKey.
    unwrapInput({ kmsKeyVersion: CROSS_PARENT_VERSION }),
    // A malformed version resource.
    unwrapInput({ kmsKeyVersion: `${CRYPTO_KEY_VERSION}-malformed` }),
    unwrapInput({
      kmsKeyVersion:
        "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/latest",
    }),
    // A stored parent reference that does not match the configured parent
    // (a valid CryptoKey reference, but the wrong one).
    unwrapInput({ kmsKeyReference: CROSS_PARENT_REFERENCE }),
    // A stored version whose derived parent differs from the stored
    // reference, and a stored reference that differs from the version's
    // parent.
    unwrapInput({
      kmsKeyReference: CROSS_PARENT_REFERENCE,
      kmsKeyVersion: HISTORICAL_VERSION_1,
    }),
  ];

  for (const input of inputs) {
    const client = new MockKmsClient(
      () => successfulResponse(),
      () => successfulDecryptResponse(),
    );
    await assert.rejects(provider(client, versions).unwrapDek(input), isProviderFailure);
    assert.equal(client.decryptRequests.length, 0);
  }
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
    unwrapInput({ wrappedDekFormat: "not-a-supported-format" as never }),
    unwrapInput({ kmsProvider: "not-a-known-provider" as never }),
    unwrapInput({ canonicalContext: Buffer.alloc(0) }),
    unwrapInput({ canonicalContext: "not-a-context-buffer" as never }),
  ];

  for (const input of inputs) {
    const client = new MockKmsClient(
      () => successfulResponse(),
      () => successfulDecryptResponse(),
    );
    await assert.rejects(provider(client).unwrapDek(input), isProviderFailure);
    assert.equal(client.decryptRequests.length, 0);
  }
});

test("Decrypt rejects empty or non-byte wrapped ciphertext before KMS", async () => {
  for (const wrappedDek of [
    Buffer.alloc(0),
    "not-an-opaque-byte-buffer" as unknown as Buffer,
  ]) {
    const client = new MockKmsClient(
      () => successfulResponse(),
      () => successfulDecryptResponse(),
    );
    await assert.rejects(
      provider(client).unwrapDek(unwrapInput({ wrappedDek })),
      isProviderFailure,
    );
    assert.equal(client.decryptRequests.length, 0);
  }
});

test("Decrypt rejects an oversized request before KMS", async () => {
  const oversizedWrappedDek = Buffer.alloc(8 * 1024, 0x42);
  const client = new MockKmsClient(
    () => successfulResponse(),
    () => successfulDecryptResponse(),
  );
  await assert.rejects(
    provider(client).unwrapDek(
      unwrapInput({ wrappedDek: oversizedWrappedDek }),
    ),
    isProviderFailure,
  );
  assert.equal(client.decryptRequests.length, 0);
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
    (() => {
      const plaintext = Buffer.alloc(33, 0xa5);
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

test("fresh wrapping is pinned to the current write version even when historical versions are approved", async () => {
  const versions = approvedVersions({
    approvedHistoricalVersions: [HISTORICAL_VERSION_1, HISTORICAL_VERSION_2],
  });
  const client = new MockKmsClient(() => successfulResponse());
  const result = await provider(client, versions).createAndWrapDek({
    canonicalContext: CANONICAL_CONTEXT,
  });

  // The Encrypt request targets the exact current write version resource,
  // never any approved historical version.
  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0].name, CRYPTO_KEY_VERSION);
  assert.notEqual(client.requests[0].name, HISTORICAL_VERSION_1);
  assert.notEqual(client.requests[0].name, HISTORICAL_VERSION_2);
  assert.equal(result.kmsKeyVersion, CRYPTO_KEY_VERSION);
  assert.equal(result.kmsKeyReference, CRYPTO_KEY_REFERENCE);
});

test("an Encrypt response naming an approved historical version still fails closed", async () => {
  // The Encrypt response name must equal the exact current write version
  // resource. A response naming an approved historical version is a
  // mismatch and must be rejected even though that version is approved for
  // decryption.
  const versions = approvedVersions({
    approvedHistoricalVersions: [HISTORICAL_VERSION_1],
  });
  const client = new MockKmsClient(() =>
    successfulResponse({ name: HISTORICAL_VERSION_1 }),
  );
  await assert.rejects(
    provider(client, versions).createAndWrapDek({
      canonicalContext: CANONICAL_CONTEXT,
    }),
    isProviderFailure,
  );
  assert.equal(client.requests.length, 1);
  assertCleared(client.requests[0]);
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

test("the provider implements the separate DekRewrapper contract without changing DekProvider or DekUnwrapper", () => {
  const instance = provider(new MockKmsClient(() => successfulResponse()));
  // The provider exposes the three separate capabilities.
  assert.ok(instance instanceof GcpKmsDekProvider);
  assert.equal(typeof (instance as unknown as DekProvider).createAndWrapDek, "function");
  assert.equal(typeof (instance as unknown as DekUnwrapper).unwrapDek, "function");
  assert.equal(typeof (instance as unknown as DekRewrapper).rewrapDek, "function");
  // Type-level: DekProvider declares no rewrapping method. That absence is
  // a compile-time contract (a runtime check cannot inspect an interface);
  // the interface is unchanged in this PR and tsc enforces that callers
  // holding a DekProvider cannot invoke rewrapDek.
  const providerContract: DekProvider = instance;
  assert.equal(providerContract.provider, KMS_PROVIDER.GCP_CLOUD_KMS);
});

test("rewrapping recovers a DEK wrapped by the current write version and rewraps it under the same version", async () => {
  const client = new MockKmsClient(
    () => successfulResponse(),
    () => successfulDecryptResponse(),
  );
  const result = await provider(client).rewrapDek(unwrapInput());

  assert.equal(client.decryptRequests.length, 1);
  assert.equal(client.decryptRequests[0].name, CRYPTO_KEY_REFERENCE);
  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0].name, CRYPTO_KEY_VERSION);
  assert.deepEqual(result.wrappedDek, TEST_CIPHERTEXT);
  assert.equal(result.kmsProvider, KMS_PROVIDER.GCP_CLOUD_KMS);
  assert.equal(result.kmsKeyReference, CRYPTO_KEY_REFERENCE);
  assert.equal(result.kmsKeyVersion, CRYPTO_KEY_VERSION);
  assert.equal(
    result.wrappedDekAlgorithm,
    WRAPPED_DEK_ALGORITHM.GOOGLE_SYMMETRIC_ENCRYPTION,
  );
  assert.equal(
    result.wrappedDekFormat,
    WRAPPED_DEK_FORMAT.GCP_KMS_ENCRYPT_CIPHERTEXT_V1,
  );
  assert.equal(
    (result as unknown as Record<string, unknown>).plaintextDek,
    undefined,
  );
  result.wrappedDek.fill(0);
});

test("rewrapping recovers an approved historical version and rewraps it under the current write version", async () => {
  const versions = approvedVersions({
    approvedHistoricalVersions: [HISTORICAL_VERSION_1],
  });
  for (const storedVersion of [HISTORICAL_VERSION_1, CRYPTO_KEY_VERSION]) {
    const client = new MockKmsClient(
      () => successfulResponse(),
      () => successfulDecryptResponse(),
    );
    const result = await provider(client, versions).rewrapDek(
      unwrapInput({ kmsKeyVersion: storedVersion }),
    );
    // The Decrypt request targets the parent; the Encrypt request targets
    // the exact current write version regardless of the recovered version.
    assert.equal(client.decryptRequests[0].name, CRYPTO_KEY_REFERENCE);
    assert.equal(client.requests[0].name, CRYPTO_KEY_VERSION);
    assert.equal(result.kmsKeyVersion, CRYPTO_KEY_VERSION);
    result.wrappedDek.fill(0);
  }
});

test("rewrapping works with multiple approved historical versions", async () => {
  const versions = approvedVersions({
    approvedHistoricalVersions: [HISTORICAL_VERSION_1, HISTORICAL_VERSION_2],
  });
  for (const storedVersion of [
    HISTORICAL_VERSION_1,
    HISTORICAL_VERSION_2,
    CRYPTO_KEY_VERSION,
  ]) {
    const client = new MockKmsClient(
      () => successfulResponse(),
      () => successfulDecryptResponse(),
    );
    const result = await provider(client, versions).rewrapDek(
      unwrapInput({ kmsKeyVersion: storedVersion }),
    );
    assert.equal(client.requests[0].name, CRYPTO_KEY_VERSION);
    assert.equal(result.kmsKeyVersion, CRYPTO_KEY_VERSION);
    result.wrappedDek.fill(0);
  }
});

test("the DEK passed to Encrypt is byte-for-byte identical to the mocked Decrypt plaintext", async () => {
  const decryptPlaintext = Buffer.from(TEST_RECOVERED_DEK);
  let encryptPlaintextSnapshot: Buffer | undefined;
  const client = new MockKmsClient(
    () => {
      // Snapshot the plaintext at call time, before the rewrapper clears
      // the recovered buffer.
      encryptPlaintextSnapshot = Buffer.from(
        client.requests[client.requests.length - 1].plaintext,
      );
      return successfulResponse();
    },
    () => ({
      plaintext: decryptPlaintext,
      plaintextCrc32c: { value: crc32c(decryptPlaintext) },
    }),
  );
  const result = await provider(client).rewrapDek(unwrapInput());

  assert.ok(encryptPlaintextSnapshot);
  // The snapshot was taken at call time, before the rewrapper cleared the
  // recovered buffer; compare against the original known bytes.
  assert.deepEqual(encryptPlaintextSnapshot, TEST_RECOVERED_DEK);
  assert.equal(encryptPlaintextSnapshot.length, 32);
  result.wrappedDek.fill(0);
  decryptPlaintext.fill(0);
});

test("the recovered DEK buffer is cleared after successful rewrapping", async () => {
  const decryptPlaintext = Buffer.from(TEST_RECOVERED_DEK);
  const client = new MockKmsClient(
    () => successfulResponse(),
    () => ({
      plaintext: decryptPlaintext,
      plaintextCrc32c: { value: crc32c(decryptPlaintext) },
    }),
  );
  const result = await provider(client).rewrapDek(unwrapInput());

  assert.deepEqual(decryptPlaintext, Buffer.alloc(32));
  result.wrappedDek.fill(0);
});

test("the recovered DEK buffer is cleared after Encrypt failure", async () => {
  const decryptPlaintext = Buffer.from(TEST_RECOVERED_DEK);
  const client = new MockKmsClient(
    () => {
      throw new Error("mocked Encrypt RPC failure");
    },
    () => ({
      plaintext: decryptPlaintext,
      plaintextCrc32c: { value: crc32c(decryptPlaintext) },
    }),
  );
  await assert.rejects(provider(client).rewrapDek(unwrapInput()), isProviderFailure);
  assert.deepEqual(decryptPlaintext, Buffer.alloc(32));
});

test("the recovered DEK buffer is cleared after an invalid Encrypt response", async () => {
  const decryptPlaintext = Buffer.from(TEST_RECOVERED_DEK);
  const client = new MockKmsClient(
    () => successfulResponse({ name: HISTORICAL_VERSION_1 }),
    () => ({
      plaintext: decryptPlaintext,
      plaintextCrc32c: { value: crc32c(decryptPlaintext) },
    }),
  );
  await assert.rejects(provider(client).rewrapDek(unwrapInput()), isProviderFailure);
  assert.deepEqual(decryptPlaintext, Buffer.alloc(32));
});

test("the recovered DEK buffer is cleared after a ciphertext CRC32C failure", async () => {
  const decryptPlaintext = Buffer.from(TEST_RECOVERED_DEK);
  const client = new MockKmsClient(
    () => successfulResponse({ ciphertextCrc32c: { value: 1 } }),
    () => ({
      plaintext: decryptPlaintext,
      plaintextCrc32c: { value: crc32c(decryptPlaintext) },
    }),
  );
  await assert.rejects(provider(client).rewrapDek(unwrapInput()), isProviderFailure);
  assert.deepEqual(decryptPlaintext, Buffer.alloc(32));
});

test("rewrapping fails before KMS for unapproved, malformed, or cross-parent metadata", async () => {
  const versions = approvedVersions({
    approvedHistoricalVersions: [HISTORICAL_VERSION_1],
  });
  const inputs: readonly DekUnwrappingInput[] = [
    unwrapInput({ kmsKeyVersion: UNKNOWN_VERSION }),
    unwrapInput({ kmsKeyVersion: CROSS_PARENT_VERSION }),
    unwrapInput({ kmsKeyVersion: `${CRYPTO_KEY_VERSION}-malformed` }),
    unwrapInput({ kmsKeyReference: CROSS_PARENT_REFERENCE }),
    unwrapInput({ kmsKeyReference: CROSS_PARENT_REFERENCE, kmsKeyVersion: HISTORICAL_VERSION_1 }),
    unwrapInput({ kmsProvider: KMS_PROVIDER.AWS_KMS }),
    unwrapInput({
      wrappedDekAlgorithm: WRAPPED_DEK_ALGORITHM.AWS_KMS_GENERATE_DATA_KEY_AES_256,
    }),
    unwrapInput({ wrappedDekFormat: "not-a-supported-format" as never }),
    unwrapInput({ kmsProvider: "not-a-known-provider" as never }),
    unwrapInput({ canonicalContext: Buffer.alloc(0) }),
    unwrapInput({ wrappedDek: Buffer.alloc(0) }),
  ];
  for (const input of inputs) {
    const client = new MockKmsClient(
      () => successfulResponse(),
      () => successfulDecryptResponse(),
    );
    await assert.rejects(
      provider(client, versions).rewrapDek(input),
      isProviderFailure,
    );
    assert.equal(client.decryptRequests.length, 0);
    assert.equal(client.requests.length, 0);
  }
});

test("rewrapping fails closed on Decrypt CRC32C and recovered DEK length failures", async () => {
  const failures: readonly GcpKmsDecryptResponse[] = [
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
  for (const response of failures) {
    const plaintext = response.plaintext;
    const client = new MockKmsClient(
      () => successfulResponse(),
      () => response,
    );
    await assert.rejects(
      provider(client).rewrapDek(unwrapInput()),
      isProviderFailure,
    );
    assert.equal(client.requests.length, 0);
    assert.ok(Buffer.isBuffer(plaintext));
    assert.deepEqual(plaintext, Buffer.alloc(plaintext.length));
  }
});

test("rewrapping fails closed on missing, wrong, or unverified Encrypt response fields", async () => {
  const responses: readonly GcpKmsEncryptResponse[] = [
    successfulResponse({ name: undefined }),
    successfulResponse({ name: HISTORICAL_VERSION_1 }),
    successfulResponse({ verifiedPlaintextCrc32c: false }),
    successfulResponse({ verifiedAdditionalAuthenticatedDataCrc32c: false }),
    successfulResponse({ ciphertext: Buffer.alloc(0) }),
    successfulResponse({ ciphertextCrc32c: undefined }),
    successfulResponse({ ciphertextCrc32c: { value: 1 } }),
  ];
  for (const response of responses) {
    const client = new MockKmsClient(
      () => response,
      () => successfulDecryptResponse(),
    );
    await assert.rejects(
      provider(client).rewrapDek(unwrapInput()),
      isProviderFailure,
    );
    assert.equal(client.requests.length, 1);
    // The recovered DEK must have been cleared on every failure path.
    assertCleared(client.requests[0]);
  }
});

test("rewrapping returns no plaintext DEK and never exposes plaintext in errors", async () => {
  const client = new MockKmsClient(
    () => successfulResponse({ name: undefined }),
    () => successfulDecryptResponse(),
  );
  await assert.rejects(
    provider(client).rewrapDek(unwrapInput()),
    (error: unknown) => {
      assert.equal(isProviderFailure(error), true);
      assert.doesNotMatch(
        (error as Error).message,
        /[0-9a-f]{32}/i,
        "no plaintext DEK hex may appear in the error",
      );
      return true;
    },
  );

  const successClient = new MockKmsClient(
    () => successfulResponse(),
    () => successfulDecryptResponse(),
  );
  const result = await provider(successClient).rewrapDek(unwrapInput());
  // The result carries only the opaque wrapped DEK and metadata.
  assert.deepEqual(Object.keys(result).sort(), [
    "kmsKeyReference",
    "kmsKeyVersion",
    "kmsProvider",
    "wrappedDek",
    "wrappedDekAlgorithm",
    "wrappedDekFormat",
  ]);
  result.wrappedDek.fill(0);
});

test("rewrapping does not mutate the caller input or the original wrapped-DEK buffer", async () => {
  const originalWrappedDek = Buffer.from(TEST_CIPHERTEXT);
  const input = unwrapInput({ wrappedDek: originalWrappedDek });
  const client = new MockKmsClient(
    () => successfulResponse(),
    () => successfulDecryptResponse(),
  );
  const result = await provider(client).rewrapDek(input);

  assert.deepEqual(originalWrappedDek, Buffer.from(TEST_CIPHERTEXT));
  assert.equal(input.kmsKeyVersion, CRYPTO_KEY_VERSION);
  assert.equal(input.kmsKeyReference, CRYPTO_KEY_REFERENCE);
  assert.deepEqual(input.wrappedDek, TEST_CIPHERTEXT);
  result.wrappedDek.fill(0);
});

test("rewrapping snapshots caller-owned buffers before the first await", async () => {
  const originalWrappedDek = Buffer.from(TEST_CIPHERTEXT);
  const originalCanonicalContext = Buffer.from(CANONICAL_CONTEXT);
  const input = unwrapInput({
    wrappedDek: originalWrappedDek,
    canonicalContext: originalCanonicalContext,
  });

  let decryptResolve:
    | ((response: GcpKmsDecryptResponse) => void)
    | undefined;
  const decryptPlaintext = Buffer.from(TEST_RECOVERED_DEK);
  let decryptCiphertextSnapshot: Buffer | undefined;
  let decryptAadSnapshot: Buffer | undefined;
  let encryptPlaintextSnapshot: Buffer | undefined;
  let encryptAadSnapshot: Buffer | undefined;

  const client = new MockKmsClient(
    () => {
      const request = client.requests[client.requests.length - 1];
      encryptPlaintextSnapshot = Buffer.from(request.plaintext);
      encryptAadSnapshot = Buffer.from(request.additionalAuthenticatedData);
      return successfulResponse();
    },
    (request) => {
      // Snapshot the bytes actually supplied in the Decrypt request and
      // hold the response pending.
      decryptCiphertextSnapshot = Buffer.from(request.ciphertext);
      decryptAadSnapshot = Buffer.from(request.additionalAuthenticatedData);
      return new Promise<GcpKmsDecryptResponse>((resolve) => {
        decryptResolve = resolve;
      });
    },
  );

  const rewrapPromise = provider(client).rewrapDek(input);

  // The synchronous portion of rewrapDek() runs before the call returns:
  // input validation, private buffer copies, and the Decrypt request
  // composition. The Decrypt handler has therefore already snapshotted the
  // request bytes and is pending.
  assert.ok(decryptResolve, "Decrypt must be pending before the caller mutates");

  // While Decrypt is pending, mutate the original caller-owned buffers.
  originalWrappedDek.fill(0xaa);
  originalCanonicalContext.fill(0xbb);

  // Resolve Decrypt with a valid 32-byte plaintext DEK and valid CRC32C.
  decryptResolve!({
    plaintext: decryptPlaintext,
    plaintextCrc32c: { value: crc32c(decryptPlaintext) },
  });
  const result = await rewrapPromise;

  // The Decrypt request used the original bytes, captured at call time.
  assert.ok(decryptCiphertextSnapshot);
  assert.ok(decryptAadSnapshot);
  assert.deepEqual(decryptCiphertextSnapshot, Buffer.from(TEST_CIPHERTEXT));
  assert.deepEqual(decryptAadSnapshot, CANONICAL_CONTEXT);

  // The Encrypt request uses the exact original canonical-context bytes,
  // not the mutated caller buffer.
  assert.ok(encryptAadSnapshot);
  assert.deepEqual(encryptAadSnapshot, CANONICAL_CONTEXT);
  assert.notDeepEqual(encryptAadSnapshot, Buffer.alloc(CANONICAL_CONTEXT.length, 0xbb));

  // The DEK passed to Encrypt remains byte-for-byte identical to the
  // recovered DEK.
  assert.ok(encryptPlaintextSnapshot);
  assert.deepEqual(encryptPlaintextSnapshot, TEST_RECOVERED_DEK);
  assert.equal(encryptPlaintextSnapshot.length, 32);

  // The recovered plaintext buffer is still cleared after completion.
  assert.deepEqual(decryptPlaintext, Buffer.alloc(32));

  assert.equal(result.kmsKeyVersion, CRYPTO_KEY_VERSION);
  result.wrappedDek.fill(0);
});

test("rewrapping regression: createAndWrapDek and unwrapDek keep their existing behavior", async () => {
  const versions = approvedVersions({
    approvedHistoricalVersions: [HISTORICAL_VERSION_1],
  });
  const client = new MockKmsClient(
    () => successfulResponse(),
    () => successfulDecryptResponse(),
  );

  // createAndWrapDek still generates a fresh DEK pinned to the current
  // write version and returns plaintext plus wrapped metadata.
  const wrapped = await provider(client, versions).createAndWrapDek({
    canonicalContext: CANONICAL_CONTEXT,
  });
  assert.equal(client.requests[0].name, CRYPTO_KEY_VERSION);
  assert.notDeepEqual(wrapped.plaintextDek, Buffer.alloc(32));
  assert.equal(wrapped.kmsKeyVersion, CRYPTO_KEY_VERSION);
  wrapped.plaintextDek.fill(0);
  wrapped.wrappedDek.fill(0);

  // unwrapDek still returns the recovered 32-byte DEK to the caller.
  const recovered = await provider(client, versions).unwrapDek(
    unwrapInput({ kmsKeyVersion: HISTORICAL_VERSION_1 }),
  );
  assert.deepEqual(recovered, TEST_RECOVERED_DEK);
  recovered.fill(0);
});
