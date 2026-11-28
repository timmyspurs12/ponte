import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVED_KMS_VERSIONS_TEST_SEAM_ERROR,
  resetApprovedKmsKeyVersionsCacheForTest,
  resolveApprovedKmsKeyVersions,
  resolveApprovedKmsKeyVersionsForTest,
  validateApprovedKmsKeyVersions,
  type ApprovedKmsKeyVersions,
} from "../../src/server/evidence/approved-kms-key-versions";
import { PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV } from "../../src/server/evidence/production-routing-config";

// Exact immutable GCP resource forms accepted by the adapter's parser.
const PARENT =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence";
const VERSION_1 = `${PARENT}/cryptoKeyVersions/7`;
const VERSION_2 = `${PARENT}/cryptoKeyVersions/8`;
const VERSION_3 = `${PARENT}/cryptoKeyVersions/9`;
const OTHER_PARENT =
  "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/other-key";
const OTHER_PARENT_VERSION = `${OTHER_PARENT}/cryptoKeyVersions/7`;
const WRONG_LOCATION =
  "projects/ponte-kms-12345/locations/us-east1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/7";
const WRONG_LOCATION_PARENT =
  "projects/ponte-kms-12345/locations/us-east1/keyRings/ponte-evidence/cryptoKeys/route-evidence";
const ALIAS = "aliases/ponte-evidence";

const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  [PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV]:
    process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV],
};

function restoreEnvironment(): void {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/**
 * Activates the test runtime and pins the PR #24 current-version
 * configuration to `version`, so the seam's consistency check passes.
 */
function withTestRuntime(version: string): void {
  Object.assign(process.env, {
    NODE_ENV: "test",
    [PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV]: version,
  });
}

function withProductionRuntime(): void {
  Object.assign(process.env, { NODE_ENV: "production" });
  delete process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV];
}

function config(
  currentWriteVersion: string,
  approvedHistoricalVersions: readonly string[] = [],
  cryptoKeyReference: string = PARENT,
): Record<string, unknown> {
  return { cryptoKeyReference, currentWriteVersion, approvedHistoricalVersions };
}

test("missing reviewed configuration fails closed with CONFIG_MISSING", () => {
  withProductionRuntime();
  try {
    const result = resolveApprovedKmsKeyVersions();
    assert.deepEqual(result, { ok: false, failure: "CONFIG_MISSING" });
  } finally {
    restoreEnvironment();
  }
});

test("a valid single current version with no historical versions resolves", () => {
  withTestRuntime(VERSION_1);
  try {
    resetApprovedKmsKeyVersionsCacheForTest();
    const result = resolveApprovedKmsKeyVersionsForTest(config(VERSION_1));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.config, {
        cryptoKeyReference: PARENT,
        currentWriteVersion: VERSION_1,
        approvedHistoricalVersions: [],
      });
    }
  } finally {
    restoreEnvironment();
  }
});

test("a valid current version with multiple historical versions resolves", () => {
  withTestRuntime(VERSION_2);
  try {
    resetApprovedKmsKeyVersionsCacheForTest();
    const result = resolveApprovedKmsKeyVersionsForTest(
      config(VERSION_2, [VERSION_1, VERSION_3]),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.config.currentWriteVersion, VERSION_2);
      assert.deepEqual(result.config.approvedHistoricalVersions, [
        VERSION_1,
        VERSION_3,
      ]);
      assert.equal(result.config.cryptoKeyReference, PARENT);
    }
  } finally {
    restoreEnvironment();
  }
});

test("a current write version absent from the approved set fails closed", () => {
  withTestRuntime(VERSION_1);
  try {
    resetApprovedKmsKeyVersionsCacheForTest();
    // No current write version can be approved: the field is absent.
    const result = resolveApprovedKmsKeyVersionsForTest({
      cryptoKeyReference: PARENT,
      approvedHistoricalVersions: [],
    });
    assert.deepEqual(result, { ok: false, failure: "CONFIG_INVALID" });
  } finally {
    restoreEnvironment();
  }
});

test("duplicate historical versions fail closed", () => {
  withTestRuntime(VERSION_1);
  try {
    resetApprovedKmsKeyVersionsCacheForTest();
    const result = resolveApprovedKmsKeyVersionsForTest(
      config(VERSION_1, [VERSION_2, VERSION_2]),
    );
    assert.deepEqual(result, { ok: false, failure: "CONFIG_INVALID" });
  } finally {
    restoreEnvironment();
  }
});

test("the current write version duplicated as a historical version fails closed", () => {
  withTestRuntime(VERSION_1);
  try {
    resetApprovedKmsKeyVersionsCacheForTest();
    const result = resolveApprovedKmsKeyVersionsForTest(
      config(VERSION_1, [VERSION_1, VERSION_2]),
    );
    assert.deepEqual(result, { ok: false, failure: "CONFIG_INVALID" });
  } finally {
    restoreEnvironment();
  }
});

test("a historical version under a different parent CryptoKey fails closed", () => {
  withTestRuntime(VERSION_1);
  try {
    resetApprovedKmsKeyVersionsCacheForTest();
    const result = resolveApprovedKmsKeyVersionsForTest(
      config(VERSION_1, [OTHER_PARENT_VERSION]),
    );
    assert.deepEqual(result, { ok: false, failure: "CONFIG_INVALID" });
  } finally {
    restoreEnvironment();
  }
});

test("a current write version under a different parent than the configured parent fails closed", () => {
  withTestRuntime(OTHER_PARENT_VERSION);
  try {
    resetApprovedKmsKeyVersionsCacheForTest();
    // The configured parent is PARENT, but the current write version
    // derives from OTHER_PARENT: the two disagree.
    const result = resolveApprovedKmsKeyVersionsForTest(
      config(OTHER_PARENT_VERSION, [], PARENT),
    );
    assert.deepEqual(result, { ok: false, failure: "CONFIG_INVALID" });
  } finally {
    restoreEnvironment();
  }
});

test("malformed parent and version resources fail closed", () => {
  withTestRuntime(VERSION_1);
  try {
    resetApprovedKmsKeyVersionsCacheForTest();
    const malformed = [
      // Malformed parent.
      config(VERSION_1, [], "not-a-resource"),
      config(VERSION_1, [], PARENT + "/"),
      config(VERSION_1, [], ""),
      // Malformed current version.
      config("not-a-resource"),
      config(PARENT),
      config(""),
      config(`${PARENT}/cryptoKeyVersions/0`),
      config(`${PARENT}/cryptoKeyVersions/abc`),
      // Malformed historical entry.
      config(VERSION_1, ["not-a-resource"]),
      config(VERSION_1, [PARENT]),
      config(VERSION_1, [""]),
    ];
    for (const entry of malformed) {
      const result = resolveApprovedKmsKeyVersionsForTest(entry);
      assert.deepEqual(
        result,
        { ok: false, failure: "CONFIG_INVALID" },
        `expected fail-closed for ${JSON.stringify(entry)}`,
      );
    }
  } finally {
    restoreEnvironment();
  }
});

test("a wrong-location resource fails closed", () => {
  withTestRuntime(VERSION_1);
  try {
    resetApprovedKmsKeyVersionsCacheForTest();
    const result = resolveApprovedKmsKeyVersionsForTest(
      config(WRONG_LOCATION, [], WRONG_LOCATION_PARENT),
    );
    assert.deepEqual(result, { ok: false, failure: "CONFIG_INVALID" });
  } finally {
    restoreEnvironment();
  }
});

test("an alias or CryptoKey parent supplied where a version is required fails closed", () => {
  withTestRuntime(VERSION_1);
  try {
    resetApprovedKmsKeyVersionsCacheForTest();
    const cases = [
      // Alias as the current write version.
      config(ALIAS),
      // CryptoKey parent as the current write version.
      config(PARENT),
      // Alias as a historical version.
      config(VERSION_1, [ALIAS]),
      // CryptoKey parent as a historical version.
      config(VERSION_1, [PARENT]),
    ];
    for (const entry of cases) {
      const result = resolveApprovedKmsKeyVersionsForTest(entry);
      assert.deepEqual(
        result,
        { ok: false, failure: "CONFIG_INVALID" },
        `expected fail-closed for ${JSON.stringify(entry)}`,
      );
    }
  } finally {
    restoreEnvironment();
  }
});

test("empty and malformed configuration entries fail closed", () => {
  withTestRuntime(VERSION_1);
  try {
    resetApprovedKmsKeyVersionsCacheForTest();
    const cases = [
      // Empty historical entry list is not an entry; this is a non-array.
      config(VERSION_1, "not-an-array" as unknown as string[]),
      config(VERSION_1, [42 as unknown as string]),
      config(VERSION_1, [null as unknown as string]),
      config(VERSION_1, [undefined as unknown as string]),
      // Non-string fields.
      { cryptoKeyReference: 42, currentWriteVersion: VERSION_1, approvedHistoricalVersions: [] },
      { cryptoKeyReference: PARENT, currentWriteVersion: 42, approvedHistoricalVersions: [] },
      // Extra or missing fields.
      {
        cryptoKeyReference: PARENT,
        currentWriteVersion: VERSION_1,
        approvedHistoricalVersions: [],
        extraField: "unexpected",
      },
      { cryptoKeyReference: PARENT, approvedHistoricalVersions: [] },
      // Not an object at all.
      null,
      "not-an-object",
      42,
    ];
    for (const entry of cases) {
      const result = resolveApprovedKmsKeyVersionsForTest(entry);
      assert.deepEqual(
        result,
        { ok: false, failure: "CONFIG_INVALID" },
        `expected fail-closed for ${JSON.stringify(entry)}`,
      );
    }
  } finally {
    restoreEnvironment();
  }
});

test("a valid empty historical list resolves (zero approved historical versions)", () => {
  withTestRuntime(VERSION_1);
  try {
    resetApprovedKmsKeyVersionsCacheForTest();
    const result = resolveApprovedKmsKeyVersionsForTest(
      config(VERSION_1, []),
    );
    assert.equal(result.ok, true);
  } finally {
    restoreEnvironment();
  }
});

test("configuration modification after initialization fails closed with CONFIG_CHANGED", () => {
  withTestRuntime(VERSION_1);
  try {
    resetApprovedKmsKeyVersionsCacheForTest();
    const first = resolveApprovedKmsKeyVersionsForTest(config(VERSION_1));
    assert.equal(first.ok, true);

    // A changed parent, write version, or approved set is one changed
    // configuration unit: it must fail closed, not silently reload. The
    // PR #24 environment authority moves with the reviewed configuration so
    // the change passes validation and is caught by immutability instead.
    process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = VERSION_2;
    const changed = resolveApprovedKmsKeyVersionsForTest(
      config(VERSION_2, [VERSION_1]),
    );
    assert.deepEqual(changed, { ok: false, failure: "CONFIG_CHANGED" });

    // A failed change never corrupts the initialized cache: the original
    // configuration unit remains resolvable once the environment authority
    // is restored.
    process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = VERSION_1;
    const restored = resolveApprovedKmsKeyVersionsForTest(config(VERSION_1));
    assert.equal(restored.ok, true);
    if (restored.ok) {
      assert.equal(restored.config.currentWriteVersion, VERSION_1);
    }
  } finally {
    restoreEnvironment();
  }
});

test("a changed parent reference fails closed as a different configuration unit", () => {
  withTestRuntime(VERSION_1);
  try {
    resetApprovedKmsKeyVersionsCacheForTest();
    const first = resolveApprovedKmsKeyVersionsForTest(config(VERSION_1));
    assert.equal(first.ok, true);

    // A different parent (with its own version) is a different
    // configuration unit: it must fail closed, not silently reload.
    process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = OTHER_PARENT_VERSION;
    const changed = resolveApprovedKmsKeyVersionsForTest(
      config(OTHER_PARENT_VERSION, [], OTHER_PARENT),
    );
    assert.deepEqual(changed, { ok: false, failure: "CONFIG_CHANGED" });
  } finally {
    restoreEnvironment();
  }
});

test("existing PR #24 current-version configuration disagreement fails closed", () => {
  withTestRuntime(VERSION_2);
  try {
    resetApprovedKmsKeyVersionsCacheForTest();
    // The reviewed configuration's write version does not match the PR #24
    // environment authority: the two sources disagree.
    const mismatched = resolveApprovedKmsKeyVersionsForTest(config(VERSION_1));
    assert.deepEqual(mismatched, { ok: false, failure: "CONFIG_INVALID" });

    // A malformed PR #24 environment value is also a disagreement.
    process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = "not-a-resource";
    const malformed = resolveApprovedKmsKeyVersionsForTest(config(VERSION_1));
    assert.deepEqual(malformed, { ok: false, failure: "CONFIG_INVALID" });

    // An absent PR #24 environment value is also a disagreement.
    delete process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV];
    const absent = resolveApprovedKmsKeyVersionsForTest(config(VERSION_1));
    assert.deepEqual(absent, { ok: false, failure: "CONFIG_INVALID" });
  } finally {
    restoreEnvironment();
  }
});

test("the test-only seam is rejected outside the test environment", () => {
  withProductionRuntime();
  try {
    assert.throws(
      () => resolveApprovedKmsKeyVersionsForTest(config(VERSION_1)),
      (error: unknown) =>
        error instanceof Error &&
        error.message === APPROVED_KMS_VERSIONS_TEST_SEAM_ERROR,
    );
    assert.throws(
      () => resetApprovedKmsKeyVersionsCacheForTest(),
      (error: unknown) =>
        error instanceof Error &&
        error.message === APPROVED_KMS_VERSIONS_TEST_SEAM_ERROR,
    );
  } finally {
    restoreEnvironment();
  }
});

test("the standalone validator enforces the same contract without a cache", () => {
  withTestRuntime(VERSION_1);
  try {
    const valid = validateApprovedKmsKeyVersions(config(VERSION_1, [VERSION_2]));
    assert.equal(valid.ok, true);
    if (valid.ok) {
      const frozen: ApprovedKmsKeyVersions = valid.config;
      assert.equal(Object.isFrozen(frozen), true);
      assert.equal(Object.isFrozen(frozen.approvedHistoricalVersions), true);
    }
    const invalid = validateApprovedKmsKeyVersions(config(VERSION_1, [VERSION_2, VERSION_2]));
    assert.deepEqual(invalid, { ok: false, failure: "CONFIG_INVALID" });
  } finally {
    restoreEnvironment();
  }
});
