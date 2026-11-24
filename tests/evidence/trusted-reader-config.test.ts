import assert from "node:assert/strict";
import test from "node:test";
import {
  assertManifestMatchesBuildIdentity,
  validateDeploymentManifest,
} from "../../contracts/tools/registry-deployment-manifest.mjs";
import {
  isBrandedReaderConfig,
  resolveTrustedReaderConfig,
} from "../../src/server/evidence/trusted-reader-config";
import { issueTestConfig } from "./helpers/test-config-bridge";
import {
  evidenceChainReaderUnavailableReason,
  resolveEvidenceChainReader,
  resolveTrustedEvidenceReader,
} from "../../src/server/evidence/chain-reader-runtime";
import { TrustedEvidenceChainReader } from "../../src/server/evidence/trusted-reader";
import { isTrustedAnchorVerification } from "../../src/server/evidence/trusted-authorization";
import { hex32, keccakOf } from "./helpers/mock-rpc-server";

/**
 * Configuration, provenance and cross-validator parity tests
 * (Phase 2C.2A, review pass 1).
 *
 * Three things are asserted here:
 *
 * 1. the production reader stays disabled and cannot be enabled by input;
 * 2. only a branded configuration can construct a reader;
 * 3. the runtime validator agrees with the canonical manifest validator on every
 *    field the canonical one checks — valid and tampered alike.
 */

const REGISTRY = `0x${"11".repeat(20)}`;
const ADMIN = `0x${"22".repeat(20)}`;
const ATTESTOR = `0x${"33".repeat(20)}`;
const RUNTIME_CODE = "0x6080604052348015600f57600080fd5b50";
const RUNTIME_HASH = keccakOf(RUNTIME_CODE);
const ABI_HASH = `0x${"aa".repeat(32)}`;

function validManifest() {
  return {
    manifestVersion: 1,
    chainId: "421614",
    contract: { name: "PonteRouteDecisionEvidenceRegistry", version: "1.0.0" },
    deployment: {
      registryAddress: REGISTRY,
      transactionHash: hex32("deployment-tx"),
      blockNumber: "12000000",
      runtimeBytecodeHash: RUNTIME_HASH,
    },
    roles: { administrator: ADMIN, initialAttestor: ATTESTOR },
    build: {
      solidityCompiler: "0.8.28+commit.7893614a",
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "prague",
      viaIR: false,
      runtimeBytecodeHashAlgorithm: "keccak256",
      runtimeBytecodeHash: RUNTIME_HASH,
    },
    abi: { version: 1, hashAlgorithm: "sha256", hash: ABI_HASH },
    sourceVerification: { status: "not_submitted", url: null },
  };
}

function buildIdentity() {
  return {
    contract: { name: "PonteRouteDecisionEvidenceRegistry", version: "1.0.0" },
    compiler: "0.8.28+commit.7893614a",
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "prague",
    viaIR: false,
    runtimeBytecodeHashAlgorithm: "keccak256",
    runtimeBytecodeHash: RUNTIME_HASH,
    abi: { version: 1, hashAlgorithm: "sha256", hash: ABI_HASH },
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    manifest: validManifest(),
    // Test-scoped issuance accepts numeric-loopback HTTP only (review pass 4), so the
    // fixture uses a loopback literal. These tests are about manifest validation, not
    // about reaching a real endpoint.
    rpcUrl: "http://127.0.0.1:8545",
    timeoutMs: 5_000,
    buildIdentity: buildIdentity(),
    ...overrides,
  };
}

// ------------------------------------------------- production stays disabled

test("the production reader is disabled and its resolver takes no input", () => {
  assert.equal(resolveEvidenceChainReader(), null);
  assert.equal(resolveTrustedEvidenceReader(), null);
  const resolved = resolveTrustedReaderConfig();
  assert.equal(resolved.ok, false);
  // The production resolver accepts no arguments at all: calling it with one must
  // not change its answer, and the parameter has been removed from the signature.
  assert.equal(resolveTrustedReaderConfig.length, 0);
  assert.match(evidenceChainReaderUnavailableReason(), /no pinned Registry deployment manifest/);
});

test("no environment variable can enable the reader", () => {
  // Scope the assertion to the *trusted reader's* namespace. `.env.local` legitimately
  // sets `PONTE_LOCAL_EVIDENCE_TEST_*` for the unrelated local routing provider, which
  // must not be mistaken for a trusted-reader switch. Neither
  // `trusted-reader-config.ts` nor `trusted-reader.ts` reads `process.env` at all; this
  // test pins that no reader-specific variable exists to be read.
  const before = Object.keys(process.env).filter((k) =>
    /PONTE.*(TRUSTED_READER|READER_CONFIG|EVIDENCE_RPC|REGISTRY_MANIFEST|DEPLOYMENT_MANIFEST)/i.test(
      k,
    ),
  );
  assert.deepEqual(before, [], "no trusted-reader env var exists");
  process.env.PONTE_RPC_URL = "https://evil.example";
  process.env.PONTE_REGISTRY_MANIFEST = "/tmp/m.json";
  try {
    assert.equal(resolveEvidenceChainReader(), null);
    assert.equal(resolveTrustedEvidenceReader(), null);
  } finally {
    delete process.env.PONTE_RPC_URL;
    delete process.env.PONTE_REGISTRY_MANIFEST;
  }
});

// ---------------------------------------------------- construction provenance

test("a reader cannot be constructed from an unbranded configuration", () => {
  // A structurally perfect object — the exact shape a request handler could build.
  const structural = {
    rpcUrl: "http://127.0.0.1:8545",
    timeoutMs: 5_000,
    chainId: "421614",
    registryAddress: REGISTRY,
    runtimeBytecodeHash: RUNTIME_HASH,
    deploymentTransactionHash: hex32("tx"),
    deploymentBlockNumber: "1",
    administrator: ADMIN,
    testOnly: false,
  };
  assert.equal(isBrandedReaderConfig(structural), false);
  assert.throws(
    () => new TrustedEvidenceChainReader(structural as never),
    /TRUSTED_READER_REQUIRES_BRANDED_CONFIG/,
  );
});

test("a reader cannot be constructed from a JSON round-trip of a valid config", () => {
  const result = issueTestConfig(input());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(isBrandedReaderConfig(result.config), true);
  const copy = JSON.parse(JSON.stringify(result.config));
  assert.equal(isBrandedReaderConfig(copy), false);
  assert.throws(
    () => new TrustedEvidenceChainReader(copy as never),
    /TRUSTED_READER_REQUIRES_BRANDED_CONFIG/,
  );
});

test("a test-scoped config branches as test-only", () => {
  const result = issueTestConfig(input());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.config.testOnly, true);
});

test("the read-only test reader never reads as an operator config", () => {
  const result = issueTestConfig(input());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // No exported validator produces an operator brand, so this is the only brand a
  // test can obtain, and it is marked testOnly.
  assert.equal(result.config.testOnly, true);
});

// ----------------------------------------------------- input validation

test("missing, non-object and unexpected-key inputs are rejected", () => {
  for (const value of [undefined, null, "config", 42, [], true]) {
    assert.equal(issueTestConfig(value).ok, false);
  }
  const unexpected = issueTestConfig(input({ requestBody: {} }));
  assert.equal(unexpected.ok, false);
  if (unexpected.ok) return;
  assert.equal(unexpected.failure, "CONFIG_UNEXPECTED_KEY");
});

test("an insecure or credentialed endpoint is rejected", () => {
  for (const rpcUrl of [
    "http://sepolia-rollup.arbitrum.io/rpc",
    "https://user:pass@example.com",
    "http://user:pass@127.0.0.1:8545",
    "not a url",
    "ftp://example.com",
  ]) {
    assert.equal(
      issueTestConfig(input({ rpcUrl })).ok,
      false,
      `${rpcUrl} must be rejected`,
    );
  }
});

test("a loopback http endpoint is allowed only for a test-scoped config", () => {
  const viaTest = issueTestConfig(
    input({ rpcUrl: "http://127.0.0.1:8545" }),
  );
  assert.equal(viaTest.ok, true);
  // The production resolver never reaches this path, and there is no exported
  // operator validator that accepts http.
  const external = issueTestConfig(input({ rpcUrl: "http://evil.example" }));
  assert.equal(external.ok, false);
});

test("an out-of-range timeout is rejected", () => {
  for (const timeoutMs of [0, 99, 30_001, 1.5, Number.NaN]) {
    assert.equal(issueTestConfig(input({ timeoutMs })).ok, false);
  }
});

// ------------------------------------------------ cross-validator parity

/**
 * Each case is asserted against BOTH validators. The canonical validator must reject
 * it, and so must the runtime validator — that is the parity guarantee.
 */
const PARITY_CASES: Array<[string, () => unknown]> = [
  [
    "compiler mismatch",
    () => {
      const m = validManifest();
      return { ...m, build: { ...m.build, solidityCompiler: "0.7.0" } };
    },
  ],
  [
    "optimizer mismatch",
    () => {
      const m = validManifest();
      return { ...m, build: { ...m.build, optimizer: { enabled: false, runs: 200 } } };
    },
  ],
  [
    "optimizer runs mismatch",
    () => {
      const m = validManifest();
      return { ...m, build: { ...m.build, optimizer: { enabled: true, runs: 1 } } };
    },
  ],
  [
    "contract name mismatch",
    () => {
      const m = validManifest();
      return { ...m, contract: { name: "Other", version: "1.0.0" } };
    },
  ],
  [
    "contract version mismatch",
    () => {
      const m = validManifest();
      return { ...m, contract: { name: m.contract.name, version: "2.0.0" } };
    },
  ],
  [
    "runtime hash mismatch",
    () => {
      const m = validManifest();
      return {
        ...m,
        deployment: { ...m.deployment, runtimeBytecodeHash: hex32("mismatch") },
      };
    },
  ],
  [
    "build hash differs from deployment hash",
    () => {
      const m = validManifest();
      return { ...m, build: { ...m.build, runtimeBytecodeHash: hex32("different") } };
    },
  ],
  [
    "chain id mismatch",
    () => validManifest() && { ...validManifest(), chainId: "10" },
  ],
  [
    "abi version unsupported",
    () => {
      const m = validManifest();
      return { ...m, abi: { ...m.abi, version: 2 } };
    },
  ],
  [
    "abi hash algorithm mismatch",
    () => {
      const m = validManifest();
      return { ...m, abi: { ...m.abi, hashAlgorithm: "keccak256" } };
    },
  ],
  [
    "abi hash not bytes32",
    () => {
      const m = validManifest();
      return { ...m, abi: { ...m.abi, hash: "deadbeef" } };
    },
  ],
  [
    "abi hash zero",
    () => {
      const m = validManifest();
      return { ...m, abi: { ...m.abi, hash: `0x${"00".repeat(32)}` } };
    },
  ],
  [
    "abi extra field",
    () => {
      const m = validManifest();
      return { ...m, abi: { ...m.abi, extra: 1 } };
    },
  ],
  [
    "source verification status invalid",
    () => {
      const m = validManifest();
      return { ...m, sourceVerification: { status: "pending", url: null } };
    },
  ],
  [
    "source verification url must be null when not_submitted",
    () => {
      const m = validManifest();
      return {
        ...m,
        sourceVerification: {
          status: "not_submitted",
          url: "https://explorer.example/tx/1",
        },
      };
    },
  ],
  [
    "source verification url required when verified",
    () => {
      const m = validManifest();
      return { ...m, sourceVerification: { status: "verified", url: null } };
    },
  ],
  [
    "source verification url must be https",
    () => {
      const m = validManifest();
      return {
        ...m,
        sourceVerification: { status: "verified", url: "http://explorer.example/tx/1" },
      };
    },
  ],
  [
    "source verification invalid url",
    () => {
      const m = validManifest();
      return {
        ...m,
        sourceVerification: { status: "verified", url: "not a url" },
      };
    },
  ],
  [
    "roles not separated",
    () => {
      const m = validManifest();
      return { ...m, roles: { administrator: ADMIN, initialAttestor: ADMIN } };
    },
  ],
  [
    "zero registry address",
    () => {
      const m = validManifest();
      return {
        ...m,
        deployment: { ...m.deployment, registryAddress: `0x${"00".repeat(20)}` },
      };
    },
  ],
  [
    "zero deployment transaction hash",
    () => {
      const m = validManifest();
      return {
        ...m,
        deployment: {
          ...m.deployment,
          transactionHash: `0x${"00".repeat(32)}`,
        },
      };
    },
  ],
  [
    "non-positive block number",
    () => {
      const m = validManifest();
      return { ...m, deployment: { ...m.deployment, blockNumber: "0" } };
    },
  ],
  [
    "manifest version unsupported",
    () => ({ ...validManifest(), manifestVersion: 2 }),
  ],
  [
    "evm version mismatch",
    () => {
      const m = validManifest();
      return { ...m, build: { ...m.build, evmVersion: "cancun" } };
    },
  ],
  [
    "viaIR mismatch",
    () => {
      const m = validManifest();
      return { ...m, build: { ...m.build, viaIR: true } };
    },
  ],
];

for (const [label, makeManifest] of PARITY_CASES) {
  test(`both validators reject: ${label}`, () => {
    const manifest = makeManifest() as Record<string, unknown>;
    // The canonical validator must reject it...
    assert.throws(() => validateDeploymentManifest(manifest));
    // ...and so must the runtime validator.
    const result = issueTestConfig(input({ manifest }));
    assert.equal(result.ok, false, `runtime validator should reject: ${label}`);
  });
}

test("both validators accept the same valid manifest", () => {
  const manifest = validManifest();
  assert.doesNotThrow(() => validateDeploymentManifest(manifest));
  assert.doesNotThrow(() =>
    assertManifestMatchesBuildIdentity(manifest, buildIdentity()),
  );
  const result = issueTestConfig(input());
  assert.equal(result.ok, true);
});

test("a build identity that disagrees with the manifest is rejected", () => {
  const mismatch = { ...buildIdentity(), runtimeBytecodeHash: hex32("other") };
  const result = issueTestConfig(input({ buildIdentity: mismatch }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure, "CONFIG_BUILD_IDENTITY_MISSING");
});

test("a missing build identity is rejected", () => {
  const result = issueTestConfig(input({ buildIdentity: undefined }));
  assert.equal(result.ok, false);
});

test("a build identity with a mismatched ABI hash is rejected", () => {
  const identity = {
    ...buildIdentity(),
    abi: { version: 1, hashAlgorithm: "sha256", hash: hex32("other-abi") },
  };
  const result = issueTestConfig(input({ buildIdentity: identity }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure, "CONFIG_ABI_INVALID");
});
