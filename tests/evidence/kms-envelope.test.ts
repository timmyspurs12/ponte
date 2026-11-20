import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCreatedAndWrappedDek,
  assertDekProviderResult,
  assertDekWrappingMetadata,
  clearDekBestEffort,
  createAndValidateWrappedDek,
  DekProviderContractError,
  isLocalTestOnlyDekWrappingMetadata,
  KMS_PROVIDER,
  type CreatedAndWrappedDek,
  type DekProvider,
  type DekWrappingMetadata,
  WRAPPED_DEK_ALGORITHM,
  WRAPPED_DEK_FORMAT,
} from "../../src/server/evidence/kms";

function localTestResult(): CreatedAndWrappedDek {
  return {
    plaintextDek: Buffer.alloc(32, 1),
    wrappedDek: Buffer.from("local-test-random-bytes", "utf8"),
    kmsProvider: KMS_PROVIDER.LOCAL_TEST_ONLY,
    kmsKeyReference: "local-test-only/kms-envelope/evidence",
    kmsKeyVersion: "local-test-only/kms-envelope/v1",
    wrappedDekAlgorithm: WRAPPED_DEK_ALGORITHM.LOCAL_TEST_RANDOM_BYTES_V1,
    wrappedDekFormat: WRAPPED_DEK_FORMAT.LOCAL_TEST_RANDOM_BYTES_V1,
  };
}

const reviewedGcpMetadata: DekWrappingMetadata = {
  kmsProvider: KMS_PROVIDER.GCP_CLOUD_KMS,
  kmsKeyReference:
    "projects/example/locations/us-central1/keyRings/example/cryptoKeys/evidence",
  kmsKeyVersion:
    "projects/example/locations/us-central1/keyRings/example/cryptoKeys/evidence/cryptoKeyVersions/1",
  wrappedDekAlgorithm: WRAPPED_DEK_ALGORITHM.GOOGLE_SYMMETRIC_ENCRYPTION,
  wrappedDekFormat: WRAPPED_DEK_FORMAT.GCP_KMS_ENCRYPT_CIPHERTEXT_V1,
};

const reviewedAwsMetadata: DekWrappingMetadata = {
  kmsProvider: KMS_PROVIDER.AWS_KMS,
  kmsKeyReference:
    "arn:aws:kms:af-south-1:111122223333:key/12345678-1234-1234-1234-1234567890ab",
  kmsKeyVersion:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  wrappedDekAlgorithm: WRAPPED_DEK_ALGORITHM.AWS_KMS_GENERATE_DATA_KEY_AES_256,
  wrappedDekFormat:
    WRAPPED_DEK_FORMAT.AWS_KMS_GENERATE_DATA_KEY_CIPHERTEXT_BLOB_V1,
};

const isContractError = (error: unknown) =>
  error instanceof DekProviderContractError;

test("controlled providers emit only explicit local-test provenance", async () => {
  const provider: DekProvider = {
    provider: KMS_PROVIDER.LOCAL_TEST_ONLY,
    async createAndWrapDek(context) {
      assert.deepEqual(
        context.canonicalContext,
        Buffer.from("synthetic-context"),
      );
      return localTestResult();
    },
  };

  const result = await createAndValidateWrappedDek(provider, {
    canonicalContext: Buffer.from("synthetic-context"),
  });
  assert.strictEqual(assertCreatedAndWrappedDek(result), result);
  assert.strictEqual(assertDekProviderResult(provider, result), result);
  assert.equal(isLocalTestOnlyDekWrappingMetadata(result), true);
  assert.notEqual(result.kmsProvider, KMS_PROVIDER.GCP_CLOUD_KMS);
  assert.notEqual(result.kmsProvider, KMS_PROVIDER.AWS_KMS);
  assert.deepEqual(
    result.wrappedDek,
    Buffer.from("local-test-random-bytes", "utf8"),
  );
});

test("reviewed GCP and AWS provenance tuples remain recognized as non-local metadata", () => {
  for (const metadata of [reviewedGcpMetadata, reviewedAwsMetadata]) {
    assert.strictEqual(assertDekWrappingMetadata(metadata), metadata);
    assert.equal(isLocalTestOnlyDekWrappingMetadata(metadata), false);
  }
});

test("provider-bound validation rejects a real-provider tuple from a local test declaration", () => {
  const localProvider: DekProvider = {
    provider: KMS_PROVIDER.LOCAL_TEST_ONLY,
    async createAndWrapDek() {
      return localTestResult();
    },
  };
  const realTupleWithSyntheticBuffers: CreatedAndWrappedDek = {
    plaintextDek: Buffer.alloc(32, 2),
    wrappedDek: Buffer.from("not-emitted-by-a-provider"),
    ...reviewedGcpMetadata,
  };

  assert.throws(
    () => assertDekProviderResult(localProvider, realTupleWithSyntheticBuffers),
    isContractError,
  );
});

test("rejects plaintext DEKs with any length other than 32 bytes", () => {
  for (const length of [0, 31, 33]) {
    const result = localTestResult();
    result.plaintextDek = Buffer.alloc(length, 1);
    assert.throws(() => assertCreatedAndWrappedDek(result), isContractError);
  }
});

test("provider-bound validation rejects incomplete metadata and unsupported metadata tuples", () => {
  const provider: DekProvider = {
    provider: KMS_PROVIDER.LOCAL_TEST_ONLY,
    async createAndWrapDek() {
      return localTestResult();
    },
  };
  const cases: Array<Partial<CreatedAndWrappedDek>> = [
    { wrappedDek: Buffer.alloc(0) },
    { kmsProvider: "unknown-kms" as CreatedAndWrappedDek["kmsProvider"] },
    {
      wrappedDekAlgorithm:
        WRAPPED_DEK_ALGORITHM.AWS_KMS_GENERATE_DATA_KEY_AES_256,
    },
    {
      wrappedDekFormat:
        WRAPPED_DEK_FORMAT.AWS_KMS_GENERATE_DATA_KEY_CIPHERTEXT_BLOB_V1,
    },
    { kmsKeyReference: "projects/pretend/cryptoKeys/evidence" },
    { kmsKeyVersion: "projects/pretend/cryptoKeyVersions/1" },
    { kmsKeyReference: "" },
    { kmsKeyVersion: "missing version" },
  ];

  for (const overrides of cases) {
    const result = { ...localTestResult(), ...overrides };
    assert.throws(
      () => assertDekProviderResult(provider, result as CreatedAndWrappedDek),
      isContractError,
    );
  }
});

test("metadata-only validation preserves the explicit local-test distinction", () => {
  const result = localTestResult();
  const metadata = {
    kmsProvider: result.kmsProvider,
    kmsKeyReference: result.kmsKeyReference,
    kmsKeyVersion: result.kmsKeyVersion,
    wrappedDekAlgorithm: result.wrappedDekAlgorithm,
    wrappedDekFormat: result.wrappedDekFormat,
  };
  assert.strictEqual(assertDekWrappingMetadata(metadata), metadata);
  assert.equal(isLocalTestOnlyDekWrappingMetadata(metadata), true);
  assert.throws(
    () =>
      assertDekWrappingMetadata({
        ...metadata,
        wrappedDekFormat:
          WRAPPED_DEK_FORMAT.AWS_KMS_GENERATE_DATA_KEY_CIPHERTEXT_BLOB_V1,
      }),
    isContractError,
  );
});

test("best-effort clearing mutates only the caller-owned temporary DEK buffer", () => {
  const dek = Buffer.alloc(32, 7);
  clearDekBestEffort(dek);
  assert.deepEqual(dek, Buffer.alloc(32));
});
