import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV } from "../../src/server/evidence/kms-config-constants";
import { resetApprovedKmsKeyVersionsCacheForTest } from "../../src/server/evidence/approved-kms-key-versions";
import {
  PRODUCTION_RESOLVER_TEST_SEAM_ERROR,
  assertOperatorScopedReaderConfig,
  isLocalEvidenceRuntime,
  resetProductionKmsClientCacheForTest,
  resolveEvidencePreparationDependencies,
  resolveProductionRoutingEvidencePreparationDependencies,
  resolveProductionRoutingEvidencePreparationDependenciesForTest,
} from "../../src/server/evidence/production-routing-config";
import { EvidenceCandidatePreparationError } from "../../src/server/evidence/errors";
import {
  GcpKmsDekProvider,
  crc32c,
  type GcpKmsClient,
  type GcpKmsDecryptRequest,
  type GcpKmsDecryptResponse,
  type GcpKmsEncryptRequest,
  type GcpKmsEncryptResponse,
} from "../../src/server/evidence/gcp-kms-provider";
import {
  isLocalTestOnlyDekWrappingMetadata,
  KMS_PROVIDER,
  WRAPPED_DEK_ALGORITHM,
  WRAPPED_DEK_FORMAT,
} from "../../src/server/evidence/kms";
import { resolveTrustedReaderConfig } from "../../src/server/evidence/trusted-reader-config";
import { issueTestConfig } from "./helpers/test-config-bridge";
import { harnessConfigInput } from "./helpers/test-reader-factory";

// Exact immutable CryptoKeyVersion resource forms accepted by the adapter.
const KEY_VERSION_A =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/7";
const KEY_VERSION_1 =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/11";
const KEY_VERSION_2 =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/12";
const KEY_VERSION_3 =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/13";
const KEY_VERSION_4 =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/14";
const KEY_VERSION_5 =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/15";
const KEY_VERSION_6 =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/16";
const KEY_VERSION_7 =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/17";
const KEY_REFERENCE =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence";
const TEST_REGISTRY = "0x1111111111111111111111111111111111111111";
const TEST_CIPHERTEXT = Buffer.from(
  "mocked-kms-ciphertext-fixture-not-real-cloud-kms-v1",
  "utf8",
);

const isProviderFailure = (error: unknown): boolean =>
  error instanceof EvidenceCandidatePreparationError &&
  error.code === "PROVIDER_FAILURE";

const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  [PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV]:
    process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV],
  DATABASE_URL: process.env.DATABASE_URL,
  PONTE_DEV_AUTH: process.env.PONTE_DEV_AUTH,
  PONTE_LOCAL_EVIDENCE_TEST_PROVIDER: process.env.PONTE_LOCAL_EVIDENCE_TEST_PROVIDER,
  PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS:
    process.env.PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS,
};

function restoreEnvironment(): void {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function withLocalGuards(): void {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://ponte:local-only@127.0.0.1:54329/ponte",
    PONTE_DEV_AUTH: "1",
    PONTE_LOCAL_EVIDENCE_TEST_PROVIDER: "1",
    PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS: TEST_REGISTRY,
  });
}

function withProductionRuntime(): void {
  Object.assign(process.env, { NODE_ENV: "production" });
  delete process.env.DATABASE_URL;
  delete process.env.PONTE_DEV_AUTH;
  delete process.env.PONTE_LOCAL_EVIDENCE_TEST_PROVIDER;
  delete process.env.PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS;
}

/**
 * A deterministic mocked KMS client. Its output is mocked test-only
 * ciphertext — it is not real Cloud KMS ciphertext and proves nothing about
 * a live KMS operation.
 */
class MockKmsClient implements GcpKmsClient {
  readonly encryptRequests: GcpKmsEncryptRequest[] = [];
  readonly decryptRequests: GcpKmsDecryptRequest[] = [];

  async encrypt(request: GcpKmsEncryptRequest) {
    this.encryptRequests.push(request);
    const response: GcpKmsEncryptResponse = {
      name: request.name,
      ciphertext: TEST_CIPHERTEXT,
      ciphertextCrc32c: { value: crc32c(TEST_CIPHERTEXT) },
      verifiedPlaintextCrc32c: true,
      verifiedAdditionalAuthenticatedDataCrc32c: true,
    };
    return [response] as const;
  }

  async decrypt(request: GcpKmsDecryptRequest): Promise<readonly [GcpKmsDecryptResponse]> {
    this.decryptRequests.push(request);
    throw new Error("decrypt is not exercised by this composition test");
  }
}

/**
 * A deterministic approved-version configuration fixture whose current
 * write version matches the `PONTE_KMS_CRYPTO_KEY_VERSION` authority the
 * production resolver enforces. This is a mocked test fixture, never a
 * reviewed deployment configuration.
 */
function testApprovedVersions(
  currentWriteVersion: string,
  approvedHistoricalVersions: readonly string[] = [],
) {
  return {
    cryptoKeyReference: KEY_REFERENCE,
    currentWriteVersion,
    approvedHistoricalVersions,
  };
}

function testScopedReaderConfig() {
  const result = issueTestConfig(
    harnessConfigInput({
      rpcUrl: "http://127.0.0.1:8545",
      registryAddress: TEST_REGISTRY,
      runtimeBytecodeHash: `0x${"aa".repeat(32)}`,
      administrator: `0x${"22".repeat(20)}`,
    }),
  );
  if (!result.ok) throw new Error(`test config rejected: ${result.failure}`);
  return result;
}

test("missing reviewed approved-version configuration fails closed in production", () => {
  withProductionRuntime();
  // The production resolver takes no arguments and reads only the single
  // reviewed deployment configuration source, which does not exist yet:
  // resolution reports CONFIG_MISSING and composition fails closed.
  delete process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV];
  try {
    assert.throws(
      () => resolveProductionRoutingEvidencePreparationDependencies(),
      isProviderFailure,
    );
    assert.throws(
      () => resolveEvidencePreparationDependencies(),
      isProviderFailure,
    );
  } finally {
    restoreEnvironment();
  }
});

test("production composition never accepts malformed KMS key resources", () => {
  withProductionRuntime();
  // The production resolver does not read the environment variable as a
  // configuration authority: every malformed form is irrelevant because
  // the reviewed configuration source is absent (CONFIG_MISSING) and
  // composition fails closed regardless.
  const malformed = [
    // CryptoKey parent, not an immutable CryptoKeyVersion.
    KEY_REFERENCE,
    // Alias instead of a resource path.
    "aliases/ponte-evidence",
    // Wrong region.
    KEY_VERSION_A.replace("africa-south1", "us-east1"),
    // Malformed version segment.
    KEY_VERSION_A.replace("/7", "/0"),
    KEY_VERSION_A.replace("/7", "/abc"),
    // Malformed resource shape.
    "not-a-kms-resource",
    "projects//locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/7",
  ];
  try {
    for (const resource of malformed) {
      process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = resource;
      assert.throws(
        () => resolveProductionRoutingEvidencePreparationDependencies(),
        isProviderFailure,
        `expected fail-closed for ${resource}`,
      );
    }
  } finally {
    restoreEnvironment();
  }
});

test("missing reviewed configuration fails closed even with a valid KMS environment setting", () => {
  withProductionRuntime();
  process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = KEY_VERSION_A;
  try {
    // The production configuration source takes no input and reports
    // CONFIG_MISSING until reviewed deployment configuration exists: both
    // the approved KMS key-version unit and the Registry manifest. No
    // Registry address is invented, no key resource is invented, and no
    // environment variable is accepted as proof of a deployment.
    assert.deepEqual(resolveTrustedReaderConfig(), {
      ok: false,
      failure: "CONFIG_MISSING",
    });
    assert.throws(
      () => resolveProductionRoutingEvidencePreparationDependencies(),
      isProviderFailure,
    );
    assert.throws(
      () => resolveEvidencePreparationDependencies(),
      isProviderFailure,
    );
  } finally {
    restoreEnvironment();
  }
});

test("production-facing functions are option-free", () => {
  // The production resolver and the service selector accept no arguments:
  // no caller-injected Registry configuration and no caller-injected KMS
  // client factory can reach the production path.
  assert.equal(
    resolveProductionRoutingEvidencePreparationDependencies.length,
    0,
  );
  assert.equal(resolveEvidencePreparationDependencies.length, 0);
});

test("the test-only seam rejects use outside the test environment", () => {
  withProductionRuntime();
  process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = KEY_VERSION_A;
  try {
    assert.throws(
      () =>
        resolveProductionRoutingEvidencePreparationDependenciesForTest({
          readerConfig: testScopedReaderConfig(),
          clientFactory: () => new MockKmsClient(),
          approvedVersions: testApprovedVersions(KEY_VERSION_A),
        }),
      (error: unknown) =>
        error instanceof Error && error.message === PRODUCTION_RESOLVER_TEST_SEAM_ERROR,
    );
  } finally {
    restoreEnvironment();
  }
});

test("a test-scoped Registry brand is never production deployment authority", () => {
  // The operator-scope guard rejects a test-scoped brand outright; the
  // production path applies it to whatever the server-controlled source
  // returns.
  assert.throws(
    () => assertOperatorScopedReaderConfig(testScopedReaderConfig().config),
    isProviderFailure,
  );
});

test("production configuration selects the GCP provider through the test-only seam", () => {
  withLocalGuards();
  // Simulate a process restart: this test initializes its own
  // immutable configuration independently of other tests.
  resetApprovedKmsKeyVersionsCacheForTest();
  resetProductionKmsClientCacheForTest();
  process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = KEY_VERSION_1;
  const client = new MockKmsClient();
  let factoryInvocations = 0;
  try {
    // Mocked test fixture: a test-scoped Registry configuration and an
    // injected mocked KMS client. This exercises the composition function
    // only — it is not a real Registry deployment or real KMS operation.
    const dependencies =
      resolveProductionRoutingEvidencePreparationDependenciesForTest({
        readerConfig: testScopedReaderConfig(),
        clientFactory: () => {
          factoryInvocations += 1;
          return client;
        },
        approvedVersions: testApprovedVersions(KEY_VERSION_1),
      });
    assert.equal(dependencies.provider.provider, KMS_PROVIDER.GCP_CLOUD_KMS);
    assert.ok(dependencies.provider instanceof GcpKmsDekProvider);
    assert.equal(dependencies.registryAddress, TEST_REGISTRY);
    assert.equal(factoryInvocations, 1);
  } finally {
    restoreEnvironment();
  }
});

test("the selected GCP provider executes the preparation contract with an injected mocked KMS client", async () => {
  withLocalGuards();
  // Simulate a process restart: this test initializes its own
  // immutable configuration independently of other tests.
  resetApprovedKmsKeyVersionsCacheForTest();
  resetProductionKmsClientCacheForTest();
  process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = KEY_VERSION_2;
  const client = new MockKmsClient();
  try {
    const { provider } =
      resolveProductionRoutingEvidencePreparationDependenciesForTest({
        readerConfig: testScopedReaderConfig(),
        clientFactory: () => client,
        approvedVersions: testApprovedVersions(KEY_VERSION_2),
      });
    const result = await provider.createAndWrapDek({
      canonicalContext: Buffer.alloc(96),
    });

    // The provider executed the real adapter contract through the injected
    // mock. The output is the deterministic mock fixture: mocked test-only
    // ciphertext, explicitly not real Cloud KMS ciphertext.
    assert.equal(client.encryptRequests.length, 1);
    assert.equal(client.encryptRequests[0].name, KEY_VERSION_2);
    assert.equal(result.kmsProvider, KMS_PROVIDER.GCP_CLOUD_KMS);
    assert.equal(
      result.wrappedDekAlgorithm,
      WRAPPED_DEK_ALGORITHM.GOOGLE_SYMMETRIC_ENCRYPTION,
    );
    assert.equal(
      result.wrappedDekFormat,
      WRAPPED_DEK_FORMAT.GCP_KMS_ENCRYPT_CIPHERTEXT_V1,
    );
    assert.equal(result.kmsKeyReference, KEY_REFERENCE);
    assert.equal(result.kmsKeyVersion, KEY_VERSION_2);
    assert.deepEqual(result.wrappedDek, TEST_CIPHERTEXT);
    assert.equal(isLocalTestOnlyDekWrappingMetadata(result), false);
  } finally {
    restoreEnvironment();
  }
});

test("two valid dependency resolutions reuse one KMS client", async () => {
  withLocalGuards();
  // Simulate a process restart: this test initializes its own
  // immutable configuration independently of other tests.
  resetApprovedKmsKeyVersionsCacheForTest();
  resetProductionKmsClientCacheForTest();
  process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = KEY_VERSION_3;
  const client = new MockKmsClient();
  let factoryInvocations = 0;
  const options = {
    readerConfig: testScopedReaderConfig(),
    clientFactory: () => {
      factoryInvocations += 1;
      return client;
    },
    approvedVersions: testApprovedVersions(KEY_VERSION_3),
  };
  try {
    const first =
      resolveProductionRoutingEvidencePreparationDependenciesForTest(options);
    const second =
      resolveProductionRoutingEvidencePreparationDependenciesForTest(options);

    // The client factory ran once: the second resolution reused the client
    // created for the first instead of constructing a fresh one.
    assert.equal(factoryInvocations, 1);

    // Both providers share the same underlying mocked client: both
    // preparation calls land on the same recorded request list.
    await first.provider.createAndWrapDek({ canonicalContext: Buffer.alloc(96) });
    await second.provider.createAndWrapDek({ canonicalContext: Buffer.alloc(96) });
    assert.equal(client.encryptRequests.length, 2);
  } finally {
    restoreEnvironment();
  }
});

test("a changed key version fails closed instead of closing or replacing the active client", () => {
  withLocalGuards();
  // Simulate a process restart: this test initializes its own
  // immutable configuration independently of other tests.
  resetApprovedKmsKeyVersionsCacheForTest();
  resetProductionKmsClientCacheForTest();
  process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = KEY_VERSION_4;
  const clientA = new MockKmsClient();
  let factoryA = 0;
  const clientB = new MockKmsClient();
  let factoryB = 0;
  try {
    // The first valid resolution initializes the process-scoped client and
    // records key version 4.
    const first =
      resolveProductionRoutingEvidencePreparationDependenciesForTest({
        readerConfig: testScopedReaderConfig(),
        clientFactory: () => {
          factoryA += 1;
          return clientA;
        },
        approvedVersions: testApprovedVersions(KEY_VERSION_4),
      });
    assert.equal(first.provider.provider, KMS_PROVIDER.GCP_CLOUD_KMS);

    // The configured key version changes within the process. The resolver
    // must fail closed with the existing provider boundary: it never closes
    // or replaces the active client, and it never constructs a client for
    // the changed configuration.
    process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = KEY_VERSION_5;
    assert.throws(
      () =>
        resolveProductionRoutingEvidencePreparationDependenciesForTest({
          readerConfig: testScopedReaderConfig(),
          clientFactory: () => {
            factoryB += 1;
            return clientB;
          },
          approvedVersions: testApprovedVersions(KEY_VERSION_5),
        }),
      isProviderFailure,
    );
    assert.equal(factoryB, 0);
    assert.equal(clientA.encryptRequests.length, 0);
  } finally {
    restoreEnvironment();
  }
});

test("the existing client remains reusable when the configured key version is restored", async () => {
  withLocalGuards();
  // Simulate a process restart: this test initializes its own
  // immutable configuration independently of other tests.
  resetApprovedKmsKeyVersionsCacheForTest();
  resetProductionKmsClientCacheForTest();
  process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = KEY_VERSION_4;
  const clientA = new MockKmsClient();
  let factoryA = 0;
  const clientB = new MockKmsClient();
  let factoryB = 0;
  try {
    const first =
      resolveProductionRoutingEvidencePreparationDependenciesForTest({
        readerConfig: testScopedReaderConfig(),
        clientFactory: () => {
          factoryA += 1;
          return clientA;
        },
        approvedVersions: testApprovedVersions(KEY_VERSION_4),
      });

    // A changed configuration fails closed and must not corrupt the
    // existing cache entry.
    process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = KEY_VERSION_5;
    assert.throws(
      () =>
        resolveProductionRoutingEvidencePreparationDependenciesForTest({
          readerConfig: testScopedReaderConfig(),
          clientFactory: () => {
            factoryB += 1;
            return clientB;
          },
          approvedVersions: testApprovedVersions(KEY_VERSION_5),
        }),
      isProviderFailure,
    );

    // Restoring the original key version keeps the original client
    // reusable: no new client is constructed and the same mock client
    // serves the restored resolution.
    process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = KEY_VERSION_4;
    const restored =
      resolveProductionRoutingEvidencePreparationDependenciesForTest({
        readerConfig: testScopedReaderConfig(),
        clientFactory: () => {
          factoryA += 1;
          return clientA;
        },
        approvedVersions: testApprovedVersions(KEY_VERSION_4),
      });
    assert.equal(restored.provider.provider, KMS_PROVIDER.GCP_CLOUD_KMS);
    assert.equal(factoryA, 1);
    assert.equal(factoryB, 0);

    // The restored resolution is served by the original mock client: its
    // recorded requests grow on the same object.
    const result = await restored.provider.createAndWrapDek({
      canonicalContext: Buffer.alloc(96),
    });
    assert.equal(clientA.encryptRequests.length, 1);
    assert.equal(result.kmsKeyVersion, KEY_VERSION_4);
  } finally {
    restoreEnvironment();
  }
});

test("a failed initialization attempt never leaves a partially replaced cache entry", async () => {
  withLocalGuards();
  // Simulate a process restart: this test initializes its own
  // immutable configuration independently of other tests.
  resetApprovedKmsKeyVersionsCacheForTest();
  resetProductionKmsClientCacheForTest();
  process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = KEY_VERSION_6;
  let throwingFactoryCalls = 0;
  const client = new MockKmsClient();
  try {
    // The first initialization attempt fails: the cache must stay
    // uninitialized rather than referencing a client that was never
    // successfully created.
    assert.throws(
      () =>
        resolveProductionRoutingEvidencePreparationDependenciesForTest({
          readerConfig: testScopedReaderConfig(),
          clientFactory: () => {
            throwingFactoryCalls += 1;
            throw new Error("mocked KMS client construction failure");
          },
          approvedVersions: testApprovedVersions(KEY_VERSION_6),
        }),
      isProviderFailure,
    );
    assert.equal(throwingFactoryCalls, 1);

    // A subsequent valid initialization for the same key version succeeds
    // and initializes the cache normally.
    const initialized =
      resolveProductionRoutingEvidencePreparationDependenciesForTest({
        readerConfig: testScopedReaderConfig(),
        clientFactory: () => client,
        approvedVersions: testApprovedVersions(KEY_VERSION_6),
      });
    assert.equal(initialized.provider.provider, KMS_PROVIDER.GCP_CLOUD_KMS);

    // The initialized cache now rejects a changed key version instead of
    // replacing the successfully initialized client.
    process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = KEY_VERSION_7;
    assert.throws(
      () =>
        resolveProductionRoutingEvidencePreparationDependenciesForTest({
          readerConfig: testScopedReaderConfig(),
          clientFactory: () => client,
          approvedVersions: testApprovedVersions(KEY_VERSION_7),
        }),
      isProviderFailure,
    );

    await initialized.provider.createAndWrapDek({
      canonicalContext: Buffer.alloc(96),
    });
    assert.equal(client.encryptRequests.length, 1);
  } finally {
    restoreEnvironment();
  }
});

test("missing or invalid KMS configuration does not construct a client", () => {
  withLocalGuards();
  const client = new MockKmsClient();
  let factoryInvocations = 0;
  try {
    delete process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV];
    assert.throws(
      () =>
        resolveProductionRoutingEvidencePreparationDependenciesForTest({
          readerConfig: testScopedReaderConfig(),
          clientFactory: () => {
            factoryInvocations += 1;
            return client;
          },
          approvedVersions: testApprovedVersions(KEY_VERSION_7),
        }),
      isProviderFailure,
    );
    process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = KEY_REFERENCE;
    assert.throws(
      () =>
        resolveProductionRoutingEvidencePreparationDependenciesForTest({
          readerConfig: testScopedReaderConfig(),
          clientFactory: () => {
            factoryInvocations += 1;
            return client;
          },
          approvedVersions: testApprovedVersions(KEY_VERSION_7),
        }),
      isProviderFailure,
    );
    assert.equal(factoryInvocations, 0);
  } finally {
    restoreEnvironment();
  }
});

test("missing Registry configuration does not construct a client", () => {
  withLocalGuards();
  process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = KEY_VERSION_A;
  const client = new MockKmsClient();
  let factoryInvocations = 0;
  try {
    // Configuration validation completes before any client construction.
    assert.throws(
      () =>
        resolveProductionRoutingEvidencePreparationDependenciesForTest({
          readerConfig: resolveTrustedReaderConfig(),
          clientFactory: () => {
            factoryInvocations += 1;
            return client;
          },
          approvedVersions: testApprovedVersions(KEY_VERSION_A),
        }),
      isProviderFailure,
    );
    assert.equal(factoryInvocations, 0);
  } finally {
    restoreEnvironment();
  }
});

test("local synthetic provider behavior remains unchanged and KMS settings are ignored in development/test", async () => {
  withLocalGuards();
  // A valid KMS environment setting exists, but development/test execution
  // must not instantiate ADC or contact Google Cloud: the selector resolves
  // the guarded local provider and never reaches the production resolver.
  process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = KEY_VERSION_A;
  const client = new MockKmsClient();
  let factoryInvocations = 0;
  try {
    assert.equal(isLocalEvidenceRuntime(), true);
    const dependencies = resolveEvidencePreparationDependencies();
    assert.equal(dependencies.provider.provider, KMS_PROVIDER.LOCAL_TEST_ONLY);
    assert.equal(dependencies.registryAddress, TEST_REGISTRY);
    assert.equal(factoryInvocations, 0);

    const result = await dependencies.provider.createAndWrapDek({
      canonicalContext: Buffer.alloc(96),
    });
    assert.equal(isLocalTestOnlyDekWrappingMetadata(result), true);
  } finally {
    restoreEnvironment();
  }
});

test("local provider still fails closed without every guard", () => {
  withLocalGuards();
  try {
    delete process.env.PONTE_LOCAL_EVIDENCE_TEST_PROVIDER;
    assert.throws(
      () => resolveEvidencePreparationDependencies(),
      isProviderFailure,
    );
    process.env.PONTE_LOCAL_EVIDENCE_TEST_PROVIDER = "1";
    delete process.env.PONTE_DEV_AUTH;
    assert.throws(
      () => resolveEvidencePreparationDependencies(),
      isProviderFailure,
    );
    process.env.PONTE_DEV_AUTH = "1";
    process.env.DATABASE_URL = "postgres://ponte:x@example.invalid/ponte";
    assert.throws(
      () => resolveEvidencePreparationDependencies(),
      isProviderFailure,
    );
  } finally {
    restoreEnvironment();
  }
});

test("production never falls back to the synthetic provider", () => {
  withProductionRuntime();
  // Even with every local guard satisfied, a production runtime selects the
  // production resolver and fails closed on the missing Registry manifest.
  Object.assign(process.env, {
    DATABASE_URL: "postgres://ponte:local-only@127.0.0.1:54329/ponte",
    PONTE_DEV_AUTH: "1",
    PONTE_LOCAL_EVIDENCE_TEST_PROVIDER: "1",
    PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS: TEST_REGISTRY,
  });
  process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = KEY_VERSION_A;
  try {
    assert.equal(isLocalEvidenceRuntime(), false);
    assert.throws(
      () => resolveEvidencePreparationDependencies(),
      isProviderFailure,
    );
  } finally {
    restoreEnvironment();
  }
});

test("approved historical versions flow through the production composition to the provider", async () => {
  withLocalGuards();
  // Simulate a process restart: this test initializes its own
  // immutable configuration independently of other tests.
  resetApprovedKmsKeyVersionsCacheForTest();
  resetProductionKmsClientCacheForTest();
  process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = KEY_VERSION_1;
  const recoveredDekFixture = Buffer.alloc(32, 0x11);
  const client = new MockKmsClient();
  client.decrypt = async (request: GcpKmsDecryptRequest) => {
    client.decryptRequests.push(request);
    return [
      {
        plaintext: recoveredDekFixture,
        plaintextCrc32c: { value: crc32c(recoveredDekFixture) },
      },
    ];
  };
  try {
    const { provider } =
      resolveProductionRoutingEvidencePreparationDependenciesForTest({
        readerConfig: testScopedReaderConfig(),
        clientFactory: () => client,
        approvedVersions: testApprovedVersions(KEY_VERSION_1, [
          KEY_VERSION_2,
          KEY_VERSION_3,
        ]),
      });
    assert.equal(provider.provider, KMS_PROVIDER.GCP_CLOUD_KMS);
    assert.ok(provider instanceof GcpKmsDekProvider);

    // The provider's effective approved set is the composition input: the
    // current write version plus every approved historical version.
    const recoveredDek = await provider.unwrapDek({
      kmsProvider: KMS_PROVIDER.GCP_CLOUD_KMS,
      kmsKeyReference: KEY_REFERENCE,
      kmsKeyVersion: KEY_VERSION_2,
      wrappedDekAlgorithm: WRAPPED_DEK_ALGORITHM.GOOGLE_SYMMETRIC_ENCRYPTION,
      wrappedDekFormat: WRAPPED_DEK_FORMAT.GCP_KMS_ENCRYPT_CIPHERTEXT_V1,
      wrappedDek: TEST_CIPHERTEXT,
      canonicalContext: Buffer.alloc(96),
    });
    assert.equal(client.decryptRequests.length, 1);
    assert.equal(client.decryptRequests[0].name, KEY_REFERENCE);
    assert.ok(Buffer.isBuffer(recoveredDek));
    recoveredDek.fill(0);
    recoveredDekFixture.fill(0);

    // Fresh wrapping remains pinned to the current write version.
    const wrapped = await provider.createAndWrapDek({
      canonicalContext: Buffer.alloc(96),
    });
    assert.equal(client.encryptRequests[0].name, KEY_VERSION_1);
    assert.equal(wrapped.kmsKeyVersion, KEY_VERSION_1);
  } finally {
    restoreEnvironment();
  }
});

test("an approved-set change after initialization fails closed and requires restart", () => {
  withLocalGuards();
  // Simulate a process restart: this test initializes its own
  // immutable configuration independently of other tests.
  resetApprovedKmsKeyVersionsCacheForTest();
  resetProductionKmsClientCacheForTest();
  process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = KEY_VERSION_1;
  const client = new MockKmsClient();
  try {
    const first =
      resolveProductionRoutingEvidencePreparationDependenciesForTest({
        readerConfig: testScopedReaderConfig(),
        clientFactory: () => client,
        approvedVersions: testApprovedVersions(KEY_VERSION_1, [KEY_VERSION_2]),
      });
    assert.equal(first.provider.provider, KMS_PROVIDER.GCP_CLOUD_KMS);

    // A later resolution that approves a different historical set is a
    // different configuration unit: it fails closed with the provider
    // boundary and never replaces the active client or provider.
    assert.throws(
      () =>
        resolveProductionRoutingEvidencePreparationDependenciesForTest({
          readerConfig: testScopedReaderConfig(),
          clientFactory: () => client,
          approvedVersions: testApprovedVersions(KEY_VERSION_1, [KEY_VERSION_3]),
        }),
      isProviderFailure,
    );
  } finally {
    restoreEnvironment();
  }
});

test("the approved-version test seam is unavailable outside the test environment", () => {
  withProductionRuntime();
  assert.throws(
    () =>
      resolveProductionRoutingEvidencePreparationDependenciesForTest({
        readerConfig: testScopedReaderConfig(),
        clientFactory: () => new MockKmsClient(),
        approvedVersions: testApprovedVersions(KEY_VERSION_1),
      }),
    (error: unknown) =>
      error instanceof Error && error.message === PRODUCTION_RESOLVER_TEST_SEAM_ERROR,
  );
});

test("no KMS client or ADC lookup occurs at module-import time", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const repoRoot = path.resolve(here, "../..");
  const preload = path.resolve(
    here,
    "helpers/count-kms-client-constructions.mjs",
  );
  const target = path.resolve(
    repoRoot,
    "src/server/evidence/production-routing-config.ts",
  );
  const script = `
    require(${JSON.stringify(target)});
    console.log(globalThis.__kmsClientConstructions ?? 0);
  `;
  const output = execFileSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--import",
      preload,
      "-e",
      script,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        [PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV]: KEY_VERSION_A,
      },
    },
  );
  assert.equal(output.trim(), "0");
});
