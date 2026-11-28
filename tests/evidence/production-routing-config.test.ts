import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import {
  PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV,
  isLocalEvidenceRuntime,
  resolveEvidencePreparationDependencies,
  resolveProductionRoutingEvidencePreparationDependencies,
} from "../../src/server/evidence/production-routing-config";
import { EvidenceCandidatePreparationError } from "../../src/server/evidence/errors";
import {
  GcpKmsDekProvider,
  crc32c,
  type GcpKmsClient,
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

// Exact immutable CryptoKeyVersion resource form accepted by the adapter.
const VALID_CRYPTO_KEY_VERSION =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/7";
const VALID_CRYPTO_KEY_REFERENCE =
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

  async encrypt(request: Parameters<GcpKmsClient["encrypt"]>[0]) {
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

  async decrypt(): Promise<readonly [GcpKmsDecryptResponse]> {
    throw new Error("decrypt is not exercised by this composition test");
  }
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

test("missing KMS configuration fails closed", () => {
  withProductionRuntime();
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

test("malformed KMS key resources fail closed", () => {
  withProductionRuntime();
  const malformed = [
    // CryptoKey parent, not an immutable CryptoKeyVersion.
    VALID_CRYPTO_KEY_REFERENCE,
    // Alias instead of a resource path.
    "aliases/ponte-evidence",
    // Wrong region.
    VALID_CRYPTO_KEY_VERSION.replace("africa-south1", "us-east1"),
    // Malformed version segment.
    VALID_CRYPTO_KEY_VERSION.replace("/7", "/0"),
    VALID_CRYPTO_KEY_VERSION.replace("/7", "/abc"),
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

test("missing Registry deployment configuration fails closed even with valid KMS configuration", () => {
  withProductionRuntime();
  process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = VALID_CRYPTO_KEY_VERSION;
  try {
    // The production configuration source takes no input and reports
    // CONFIG_MISSING until a reviewed deployment manifest exists. No
    // Registry address is invented and no environment variable is accepted
    // as proof of a deployment.
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

test("production configuration selects the GCP provider through the service dependency-selection path", () => {
  withProductionRuntime();
  process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = VALID_CRYPTO_KEY_VERSION;
  const client = new MockKmsClient();
  let factoryInvocations = 0;
  try {
    // Mocked test fixture: a test-scoped Registry configuration and an
    // injected mocked KMS client. This exercises the composition function
    // only — it is not a real Registry deployment or real KMS operation.
    const dependencies = resolveEvidencePreparationDependencies({
      readerConfig: testScopedReaderConfig(),
      clientFactory: () => {
        factoryInvocations += 1;
        return client;
      },
    });
    assert.equal(dependencies.provider.provider, KMS_PROVIDER.GCP_CLOUD_KMS);
    assert.ok(dependencies.provider instanceof GcpKmsDekProvider);
    assert.equal(dependencies.registryAddress, TEST_REGISTRY);
    assert.equal(factoryInvocations, 1);

    const direct = resolveProductionRoutingEvidencePreparationDependencies({
      readerConfig: testScopedReaderConfig(),
      clientFactory: () => new MockKmsClient(),
    });
    assert.equal(direct.provider.provider, KMS_PROVIDER.GCP_CLOUD_KMS);
    assert.equal(direct.registryAddress, TEST_REGISTRY);
  } finally {
    restoreEnvironment();
  }
});

test("the selected GCP provider executes the preparation contract with an injected mocked KMS client", async () => {
  withProductionRuntime();
  process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = VALID_CRYPTO_KEY_VERSION;
  const client = new MockKmsClient();
  try {
    const { provider } = resolveEvidencePreparationDependencies({
      readerConfig: testScopedReaderConfig(),
      clientFactory: () => client,
    });
    const result = await provider.createAndWrapDek({
      canonicalContext: Buffer.alloc(96),
    });

    // The provider executed the real adapter contract through the injected
    // mock. The output is the deterministic mock fixture: mocked test-only
    // ciphertext, explicitly not real Cloud KMS ciphertext.
    assert.equal(client.encryptRequests.length, 1);
    assert.equal(client.encryptRequests[0].name, VALID_CRYPTO_KEY_VERSION);
    assert.equal(result.kmsProvider, KMS_PROVIDER.GCP_CLOUD_KMS);
    assert.equal(
      result.wrappedDekAlgorithm,
      WRAPPED_DEK_ALGORITHM.GOOGLE_SYMMETRIC_ENCRYPTION,
    );
    assert.equal(
      result.wrappedDekFormat,
      WRAPPED_DEK_FORMAT.GCP_KMS_ENCRYPT_CIPHERTEXT_V1,
    );
    assert.equal(result.kmsKeyReference, VALID_CRYPTO_KEY_REFERENCE);
    assert.equal(result.kmsKeyVersion, VALID_CRYPTO_KEY_VERSION);
    assert.deepEqual(result.wrappedDek, TEST_CIPHERTEXT);
    assert.equal(isLocalTestOnlyDekWrappingMetadata(result), false);
  } finally {
    restoreEnvironment();
  }
});

test("local synthetic provider behavior remains unchanged and KMS settings are ignored in development/test", async () => {
  withLocalGuards();
  // A valid KMS environment setting exists, but development/test execution
  // must not instantiate ADC or contact Google Cloud: the selector resolves
  // the guarded local provider and never reaches the production resolver.
  process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = VALID_CRYPTO_KEY_VERSION;
  const client = new MockKmsClient();
  let factoryInvocations = 0;
  try {
    assert.equal(isLocalEvidenceRuntime(), true);
    const dependencies = resolveEvidencePreparationDependencies({
      readerConfig: testScopedReaderConfig(),
      clientFactory: () => {
        factoryInvocations += 1;
        return client;
      },
    });
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
  process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = VALID_CRYPTO_KEY_VERSION;
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

test("no KMS client or ADC lookup occurs at module-import time", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const repoRoot = path.resolve(here, "../..");
  const preload = path.resolve(here, "helpers/count-kms-client-constructions.mjs");
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
        [PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV]: VALID_CRYPTO_KEY_VERSION,
      },
    },
  );
  assert.equal(output.trim(), "0");
});
