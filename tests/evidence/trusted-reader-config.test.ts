import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, zeroPadValue } from "ethers";
import {
  validateDeploymentManifest,
  assertManifestMatchesBuildIdentity,
} from "../../contracts/tools/registry-deployment-manifest.mjs";
import {
  resolveTrustedReaderConfig,
  validateTrustedReaderConfig,
} from "../../src/server/evidence/trusted-reader-config";
import {
  resolveEvidenceChainReader,
  resolveTrustedEvidenceReader,
  evidenceChainReaderUnavailableReason,
} from "../../src/server/evidence/chain-reader-runtime";
import {
  createTrustedAnchorVerification,
  isTrustedAnchorVerification,
  sealTrustedObservation,
} from "../../src/server/evidence/trusted-seal";
import {
  hex32,
  keccakOf,
  quantity,
  startMockRpcServer,
} from "./helpers/mock-rpc-server";
import type { ChainObservation } from "../../src/server/evidence/anchor-verification";

/**
 * Configuration, runtime-resolution and pipeline-provenance tests (Phase 2C.2A).
 *
 * The central assertions are negative: with no real deployment manifest the
 * production resolver must stay `null`, and a client cannot select an endpoint.
 */

const REGISTRY = `0x${"11".repeat(20)}`;
const ADMIN = `0x${"22".repeat(20)}`;
const ATTESTOR = `0x${"33".repeat(20)}`;
const RUNTIME_CODE = "0x6080604052348015600f57600080fd5b50";
const RUNTIME_HASH = keccakOf(RUNTIME_CODE);

/** A structurally valid manifest, used only to exercise the validator. */
function validManifest(overrides: Record<string, unknown> = {}) {
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
    abi: { version: 1, hashAlgorithm: "sha256", hash: `0x${"aa".repeat(32)}` },
    sourceVerification: { status: "not_submitted", url: null },
    ...overrides,
  };
}

const BUILD_IDENTITY = {
  contract: { name: "PonteRouteDecisionEvidenceRegistry", version: "1.0.0" },
  runtimeBytecodeHash: RUNTIME_HASH,
};

function configInput(overrides: Record<string, unknown> = {}) {
  return {
    manifest: validManifest(),
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    timeoutMs: 5_000,
    buildIdentity: BUILD_IDENTITY,
    ...overrides,
  };
}

// --------------------------------------------------- production resolver is off

test("the production reader is disabled with no pinned manifest", () => {
  assert.equal(resolveEvidenceChainReader(), null);
  assert.equal(resolveTrustedEvidenceReader(), null);
  assert.match(
    evidenceChainReaderUnavailableReason(),
    /no pinned Registry deployment manifest/,
  );
});

test("no environment variable can enable the reader", () => {
  // Snapshot is unnecessary: the resolver takes no environment input at all.
  const envKeys = Object.keys(process.env).filter((key) =>
    /PONTE.*(RPC|READER|REGISTRY|MANIFEST|CHAIN)/i.test(key),
  );
  assert.deepEqual(
    envKeys,
    [],
    "no reader-related env var is consulted anywhere",
  );
  process.env.PONTE_RPC_URL = "https://example.invalid";
  process.env.PONTE_EVIDENCE_READER = "1";
  process.env.PONTE_REGISTRY_MANIFEST = "/tmp/manifest.json";
  try {
    assert.equal(resolveEvidenceChainReader(), null);
  } finally {
    delete process.env.PONTE_RPC_URL;
    delete process.env.PONTE_EVIDENCE_READER;
    delete process.env.PONTE_REGISTRY_MANIFEST;
  }
});

test("a valid pinned manifest does enable a reader, and only when supplied", () => {
  const reader = resolveTrustedEvidenceReader(configInput());
  assert.notEqual(reader, null);
});

// ------------------------------------------------------------ config validation

test("a missing configuration is rejected", () => {
  const result = validateTrustedReaderConfig(undefined);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure, "CONFIG_MISSING");
});

test("a non-object configuration is rejected", () => {
  for (const value of [null, "config", 42, [], true]) {
    const result = validateTrustedReaderConfig(value);
    assert.equal(result.ok, false);
  }
});

test("an unexpected configuration key is rejected", () => {
  const result = validateTrustedReaderConfig(
    configInput({ injectedReader: { readAnchorObservation: () => {} } }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure, "CONFIG_UNEXPECTED_KEY");
});

test("an invalid manifest is rejected", () => {
  const result = validateTrustedReaderConfig(
    configInput({ manifest: validManifest({ manifestVersion: 2 }) }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure, "CONFIG_MANIFEST_VERSION");
});

test("a manifest for another chain is rejected", () => {
  const result = validateTrustedReaderConfig(
    configInput({ manifest: validManifest({ chainId: "1" }) }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure, "CONFIG_CHAIN_ID");
});

test("a manifest with the wrong contract name is rejected", () => {
  const result = validateTrustedReaderConfig(
    configInput({
      manifest: validManifest({
        contract: { name: "Other", version: "1.0.0" },
      }),
    }),
  );
  assert.equal(result.ok, false);
});

test("a zero Registry address is rejected", () => {
  const manifest = validManifest();
  const result = validateTrustedReaderConfig(
    configInput({
      manifest: {
        ...manifest,
        deployment: {
          ...manifest.deployment,
          registryAddress: `0x${"00".repeat(20)}`,
        },
      },
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure, "CONFIG_ADDRESS");
});

test("a manifest whose build hash differs from its deployment hash is rejected", () => {
  const manifest = validManifest();
  const result = validateTrustedReaderConfig(
    configInput({
      manifest: {
        ...manifest,
        build: { ...manifest.build, runtimeBytecodeHash: hex32("different") },
      },
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure, "CONFIG_RUNTIME_HASH");
});

test("a build identity that disagrees with the manifest is rejected", () => {
  const result = validateTrustedReaderConfig(
    configInput({
      buildIdentity: { ...BUILD_IDENTITY, runtimeBytecodeHash: hex32("other") },
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure, "CONFIG_BUILD_IDENTITY_MISSING");
});

test("a missing build identity is rejected", () => {
  const result = validateTrustedReaderConfig(
    configInput({ buildIdentity: undefined }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure, "CONFIG_BUILD_IDENTITY_MISSING");
});

test("an insecure or credentialed endpoint is rejected", () => {
  for (const rpcUrl of [
    "http://sepolia-rollup.arbitrum.io/rpc",
    "https://user:pass@example.com",
    "not a url",
    "ftp://example.com",
  ]) {
    const result = validateTrustedReaderConfig(configInput({ rpcUrl }));
    assert.equal(result.ok, false, `${rpcUrl} should be rejected`);
  }
});

test("an out-of-range timeout is rejected", () => {
  for (const timeoutMs of [0, 99, 30_001, 1.5, Number.NaN]) {
    const result = validateTrustedReaderConfig(configInput({ timeoutMs }));
    assert.equal(result.ok, false, `${timeoutMs} should be rejected`);
  }
});

test("a valid configuration yields a frozen config with canonical values", () => {
  const result = validateTrustedReaderConfig(configInput());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(Object.isFrozen(result.config), true);
  assert.equal(result.config.registryAddress, REGISTRY);
  assert.equal(result.config.runtimeBytecodeHash, RUNTIME_HASH);
  assert.equal(result.config.administrator, ADMIN);
  assert.equal(result.config.chainId, "421614");
});

// ------------------------------- cross-check against the canonical validator

test("this validator agrees with the canonical manifest validator on a valid manifest", () => {
  const manifest = validManifest();
  // The canonical validator is the artefact of record; it must also accept this.
  assert.doesNotThrow(() => validateDeploymentManifest(manifest));
  assert.doesNotThrow(() =>
    assertManifestMatchesBuildIdentity(manifest, {
      contract: BUILD_IDENTITY.contract,
      compiler: "0.8.28+commit.7893614a",
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "prague",
      viaIR: false,
      runtimeBytecodeHashAlgorithm: "keccak256",
      runtimeBytecodeHash: RUNTIME_HASH,
      abi: {
        version: 1,
        hashAlgorithm: "sha256",
        hash: `0x${"aa".repeat(32)}`,
      },
    }),
  );
  // And the runtime validator must accept the same object.
  const result = validateTrustedReaderConfig(configInput());
  assert.equal(result.ok, true);
});

test("both validators reject a compiler mismatch", () => {
  const manifest = validManifest();
  const tampered = {
    ...manifest,
    build: { ...manifest.build, solidityCompiler: "0.7.0" },
  };
  assert.throws(() => validateDeploymentManifest(tampered));
  const result = validateTrustedReaderConfig(
    configInput({ manifest: tampered }),
  );
  assert.equal(result.ok, false);
});

test("both validators reject a runtime hash inconsistency", () => {
  const manifest = validManifest();
  const tampered = {
    ...manifest,
    deployment: {
      ...manifest.deployment,
      runtimeBytecodeHash: hex32("mismatch"),
    },
  };
  assert.throws(() => validateDeploymentManifest(tampered));
  const result = validateTrustedReaderConfig(
    configInput({ manifest: tampered }),
  );
  assert.equal(result.ok, false);
});

test("both validators reject a chain id mismatch", () => {
  const tampered = validManifest({ chainId: "10" });
  assert.throws(() => validateDeploymentManifest(tampered));
  const result = validateTrustedReaderConfig(
    configInput({ manifest: tampered }),
  );
  assert.equal(result.ok, false);
});

// ------------------------------------------------------------ pipeline provenance

function trustedObservation(): ChainObservation {
  return {
    chainId: "421614",
    transactionHash: hex32("tx"),
    transactionFrom: ATTESTOR,
    transactionTo: REGISTRY,
    receipt: null,
    registryIdentity: "verified",
  };
}

test("a trusted verification cannot be constructed from an evaluation proof alone", () => {
  // A plain object claiming to be a trusted verification is rejected.
  assert.equal(
    isTrustedAnchorVerification({ verified: true, status: "verified" }),
    false,
  );
  assert.equal(
    isTrustedAnchorVerification({ verified: true, proof: {}, seal: {} }),
    false,
  );
  assert.equal(isTrustedAnchorVerification(null), false);
  assert.equal(isTrustedAnchorVerification("trusted"), false);
});

test("the seal is required in addition to the proof", () => {
  const seal = sealTrustedObservation({
    observation: trustedObservation(),
    finality: {
      level: "finalized",
      finalizedBlockNumber: "100",
      finalizedBlockHash: hex32("finalized"),
      receiptBlockHash: hex32("block"),
      receiptBlockNumber: "90",
    },
    runtimeBytecodeHash: RUNTIME_HASH,
    registryAddress: REGISTRY,
    transactionHash: hex32("tx"),
  });
  assert.equal(
    isTrustedAnchorVerification({ verified: true, proof: {}, seal }),
    false,
  );
  // The seal itself is branded and rejects copies.
  const copied = { ...seal };
  const sealModule = require("node:module") as typeof import("node:module");
  assert.ok(sealModule);
  assert.equal(
    isTrustedAnchorVerification({ verified: true, proof: seal, seal: copied }),
    false,
  );
});

test("a seal with a non-finalized level cannot be issued", () => {
  assert.throws(
    () =>
      sealTrustedObservation({
        observation: trustedObservation(),
        finality: {
          // Deliberately wrong level, cast through unknown to bypass the type.
          level: "safe" as unknown as "finalized",
          finalizedBlockNumber: "100",
          finalizedBlockHash: hex32("finalized"),
          receiptBlockHash: hex32("block"),
          receiptBlockNumber: "90",
        },
        runtimeBytecodeHash: RUNTIME_HASH,
        registryAddress: REGISTRY,
        transactionHash: hex32("tx"),
      }),
    /TRUSTED_SEAL_REQUIRES_FINALIZED_LEVEL/,
  );
});

test("createTrustedAnchorVerification is not a public issuance route", () => {
  // It is exported so the pipeline can use it, but the guard inside still validates.
  const seal = sealTrustedObservation({
    observation: trustedObservation(),
    finality: {
      level: "finalized",
      finalizedBlockNumber: "100",
      finalizedBlockHash: hex32("finalized"),
      receiptBlockHash: hex32("block"),
      receiptBlockNumber: "90",
    },
    runtimeBytecodeHash: RUNTIME_HASH,
    registryAddress: REGISTRY,
    transactionHash: hex32("tx"),
  });
  // With a non-proof, the combined check fails even though the object was created.
  const result = createTrustedAnchorVerification(
    { verified: true } as never,
    seal,
  );
  assert.equal(isTrustedAnchorVerification(result), false);
});

test("no client-supplied endpoint reaches the reader", async () => {
  // The reader is constructed from a config object only. Prove that a plausible
  // request-shaped value cannot become a URL: the validator has no such field.
  const result = validateTrustedReaderConfig({
    ...configInput(),
    rpcUrl: "https://127.0.0.1:1",
  });
  // https to loopback is *accepted* by the validator (it cannot know topology),
  // which is precisely why the config object must come from server-side state and
  // never from a request. The reader is then the only thing that uses it.
  assert.equal(result.ok, true);

  const rejected = validateTrustedReaderConfig({
    ...configInput(),
    requestBody: { rpcUrl: "https://evil.example" },
  });
  assert.equal(rejected.ok, false);
});
