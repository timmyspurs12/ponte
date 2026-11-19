import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCreatedAndWrappedDek,
  clearDekBestEffort,
  DekProviderContractError,
  KMS_PROVIDER,
  type CreatedAndWrappedDek,
  type DekProvider,
  WRAPPED_DEK_ALGORITHM,
  WRAPPED_DEK_FORMAT,
} from "../../src/server/evidence/kms";

function syntheticGcpResult(): CreatedAndWrappedDek {
  return {
    plaintextDek: Buffer.alloc(32, 1),
    wrappedDek: Buffer.from("synthetic-provider-opaque-ciphertext", "utf8"),
    kmsProvider: KMS_PROVIDER.GCP_CLOUD_KMS,
    kmsKeyReference:
      "projects/test/locations/africa-south1/keyRings/test/cryptoKeys/evidence",
    kmsKeyVersion:
      "projects/test/locations/africa-south1/keyRings/test/cryptoKeys/evidence/cryptoKeyVersions/1",
    wrappedDekAlgorithm: WRAPPED_DEK_ALGORITHM.GOOGLE_SYMMETRIC_ENCRYPTION,
    wrappedDekFormat: WRAPPED_DEK_FORMAT.GCP_KMS_ENCRYPT_CIPHERTEXT_V1,
  };
}

const isContractError = (error: unknown) =>
  error instanceof DekProviderContractError;

test("provider-neutral boundary accommodates a locally created fresh DEK and complete GCP metadata", async () => {
  const provider: DekProvider = {
    provider: KMS_PROVIDER.GCP_CLOUD_KMS,
    async createAndWrapDek(context) {
      assert.deepEqual(
        context.canonicalContext,
        Buffer.from("synthetic-context"),
      );
      return syntheticGcpResult();
    },
  };

  const result = await provider.createAndWrapDek({
    canonicalContext: Buffer.from("synthetic-context"),
  });
  assert.strictEqual(assertCreatedAndWrappedDek(result), result);
  assert.deepEqual(
    result.wrappedDek,
    Buffer.from("synthetic-provider-opaque-ciphertext", "utf8"),
  );
});

test("provider-neutral boundary accommodates a provider-created plaintext and wrapped DEK pair", async () => {
  const provider: DekProvider = {
    provider: KMS_PROVIDER.AWS_KMS,
    async createAndWrapDek(context) {
      assert.deepEqual(
        context.canonicalContext,
        Buffer.from("synthetic-context"),
      );
      return {
        plaintextDek: Buffer.alloc(32, 2),
        wrappedDek: Buffer.from("synthetic-aws-ciphertext-blob"),
        kmsProvider: KMS_PROVIDER.AWS_KMS,
        kmsKeyReference:
          "arn:aws:kms:af-south-1:111122223333:key/12345678-1234-1234-1234-1234567890ab",
        kmsKeyVersion:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        wrappedDekAlgorithm:
          WRAPPED_DEK_ALGORITHM.AWS_KMS_GENERATE_DATA_KEY_AES_256,
        wrappedDekFormat:
          WRAPPED_DEK_FORMAT.AWS_KMS_GENERATE_DATA_KEY_CIPHERTEXT_BLOB_V1,
      };
    },
  };

  const result = await provider.createAndWrapDek({
    canonicalContext: Buffer.from("synthetic-context"),
  });
  assert.equal(result.plaintextDek.length, 32);
  assert.equal(result.wrappedDek.length > 0, true);
  assert.strictEqual(assertCreatedAndWrappedDek(result), result);
});

test("rejects plaintext DEKs with any length other than 32 bytes", () => {
  for (const length of [0, 31, 33]) {
    const result = syntheticGcpResult();
    result.plaintextDek = Buffer.alloc(length, 1);
    assert.throws(() => assertCreatedAndWrappedDek(result), isContractError);
  }
});

test("rejects incomplete metadata, unknown providers, and unsupported metadata tuples", () => {
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
    { kmsKeyReference: "" },
    { kmsKeyVersion: "missing version" },
  ];

  for (const overrides of cases) {
    const result = { ...syntheticGcpResult(), ...overrides };
    assert.throws(
      () => assertCreatedAndWrappedDek(result as CreatedAndWrappedDek),
      isContractError,
    );
  }
});

test("best-effort clearing mutates only the caller-owned temporary DEK buffer", () => {
  const dek = Buffer.alloc(32, 7);
  clearDekBestEffort(dek);
  assert.deepEqual(dek, Buffer.alloc(32));
});
