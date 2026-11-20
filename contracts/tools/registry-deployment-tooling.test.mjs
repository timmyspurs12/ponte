import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ARBITRUM_SEPOLIA_CHAIN_ID,
  EXPECTED_BUILD_CONFIGURATION,
} from "./registry-deployment-constants.mjs";
import {
  keccak256Hex,
  readRegistryBuildIdentity,
} from "./registry-build-identity.mjs";
import {
  DeploymentManifestValidationError,
  assertManifestMatchesBuildIdentity,
  validateDeploymentManifest,
} from "./registry-deployment-manifest.mjs";
import {
  REGISTRY_INTERFACE_SELECTORS,
  verifyRegistryDeployment,
} from "./verify-registry-deployment.mjs";

const ADMINISTRATOR = "0x1111111111111111111111111111111111111111";
const INITIAL_ATTESTOR = "0x2222222222222222222222222222222222222222";
const REGISTRY_ADDRESS = "0x3333333333333333333333333333333333333333";
const TRANSACTION_HASH = `0x${"4".repeat(64)}`;
const ABI_HASH = `0x${"5".repeat(64)}`;
const DEMO_RUNTIME_BYTECODE = "0x6001600055";

function fixtureManifest(
  runtimeBytecodeHash = keccak256Hex(
    Buffer.from(DEMO_RUNTIME_BYTECODE.slice(2), "hex"),
  ),
) {
  return {
    manifestVersion: 1,
    chainId: ARBITRUM_SEPOLIA_CHAIN_ID,
    contract: {
      name: "PonteRouteDecisionEvidenceRegistry",
      version: "1.0.0",
    },
    deployment: {
      registryAddress: REGISTRY_ADDRESS,
      transactionHash: TRANSACTION_HASH,
      blockNumber: "12345",
      runtimeBytecodeHash,
    },
    roles: {
      administrator: ADMINISTRATOR,
      initialAttestor: INITIAL_ATTESTOR,
    },
    build: {
      solidityCompiler: EXPECTED_BUILD_CONFIGURATION.solidityCompiler,
      optimizer: { ...EXPECTED_BUILD_CONFIGURATION.optimizer },
      evmVersion: EXPECTED_BUILD_CONFIGURATION.evmVersion,
      viaIR: EXPECTED_BUILD_CONFIGURATION.viaIR,
      runtimeBytecodeHashAlgorithm:
        EXPECTED_BUILD_CONFIGURATION.runtimeBytecodeHashAlgorithm,
      runtimeBytecodeHash,
    },
    abi: {
      version: 1,
      hashAlgorithm: "sha256",
      hash: ABI_HASH,
    },
    sourceVerification: {
      status: "not_submitted",
      url: null,
    },
  };
}

function abiAddress(address) {
  return `0x${"0".repeat(24)}${address.slice(2)}`;
}

function abiBoolean(value) {
  return `0x${"0".repeat(63)}${value ? "1" : "0"}`;
}

function successfulRpc(overrides = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "eth_chainId") return overrides.chainId ?? "0x66eee";
    if (method === "eth_getCode")
      return overrides.code ?? DEMO_RUNTIME_BYTECODE;
    if (method === "eth_call") {
      const data = params[0].data;
      if (data === REGISTRY_INTERFACE_SELECTORS.admin) {
        return overrides.administrator ?? abiAddress(ADMINISTRATOR);
      }
      if (data.startsWith(REGISTRY_INTERFACE_SELECTORS.isAttestor)) {
        const account = `0x${data.slice(-40)}`;
        if (account === ADMINISTRATOR) {
          return overrides.administratorAttestor ?? abiBoolean(false);
        }
        if (account === INITIAL_ATTESTOR) {
          return overrides.attestor ?? abiBoolean(true);
        }
        throw new Error("unexpected test attestor address");
      }
      if (data.startsWith(REGISTRY_INTERFACE_SELECTORS.evidenceHead)) {
        return overrides.evidenceHead ?? `0x${"0".repeat(128)}`;
      }
      throw new Error("unexpected test calldata");
    }
    throw new Error("unexpected test method");
  };
  return { rpc, calls };
}

test("the published JSON schema pins the V1 chain, contract, and build settings", () => {
  const schema = JSON.parse(
    readFileSync("ponte-registry-deployment-manifest.schema.json", "utf8"),
  );
  assert.equal(schema.properties.manifestVersion.const, 1);
  assert.equal(schema.properties.chainId.const, ARBITRUM_SEPOLIA_CHAIN_ID);
  assert.equal(
    schema.properties.contract.properties.name.const,
    "PonteRouteDecisionEvidenceRegistry",
  );
  assert.equal(
    schema.properties.build.properties.solidityCompiler.const,
    "0.8.28+commit.7893614a",
  );
  assert.equal(
    schema.properties.build.properties.optimizer.properties.runs.const,
    200,
  );
});

test("reads the pinned Foundry registry build identity", () => {
  const identity = readRegistryBuildIdentity();
  assert.equal(identity.contract.name, "PonteRouteDecisionEvidenceRegistry");
  assert.equal(identity.compiler, "0.8.28+commit.7893614a");
  assert.deepEqual(identity.optimizer, { enabled: true, runs: 200 });
  assert.equal(identity.evmVersion, "prague");
  assert.equal(identity.viaIR, false);
  assert.equal(identity.runtimeBytecodeBytes > 0, true);
  assert.match(identity.runtimeBytecodeHash, /^0x[0-9a-f]{64}$/);
  assert.match(identity.abi.hash, /^0x[0-9a-f]{64}$/);
});

test("strict manifest accepts only a complete canonical test fixture", () => {
  const manifest = validateDeploymentManifest(fixtureManifest());
  assert.equal(manifest.chainId, ARBITRUM_SEPOLIA_CHAIN_ID);
  assert.equal(manifest.roles.administrator, ADMINISTRATOR);
  assert.equal(manifest.sourceVerification.url, null);
});

test("manifest matches the local artifact only when every build identity field agrees", () => {
  const identity = readRegistryBuildIdentity();
  const fixture = fixtureManifest(identity.runtimeBytecodeHash);
  fixture.abi = { ...identity.abi };
  fixture.build = {
    solidityCompiler: identity.compiler,
    optimizer: { ...identity.optimizer },
    evmVersion: identity.evmVersion,
    viaIR: identity.viaIR,
    runtimeBytecodeHashAlgorithm: identity.runtimeBytecodeHashAlgorithm,
    runtimeBytecodeHash: identity.runtimeBytecodeHash,
  };
  const manifest = assertManifestMatchesBuildIdentity(fixture, identity);
  assert.equal(
    manifest.deployment.runtimeBytecodeHash,
    identity.runtimeBytecodeHash,
  );

  fixture.abi.hash = ABI_HASH;
  assert.throws(
    () => assertManifestMatchesBuildIdentity(fixture, identity),
    (error) =>
      error instanceof DeploymentManifestValidationError &&
      error.code === "MANIFEST_BUILD_IDENTITY_MISMATCH",
  );
});

test("manifest rejects wrong chain, malformed roles, missing transaction data, and inconsistent hashes", () => {
  const cases = [
    [
      "wrong chain",
      (manifest) => (manifest.chainId = "1"),
      "MANIFEST_CHAIN_ID_MISMATCH",
    ],
    [
      "zero administrator",
      (manifest) => (manifest.roles.administrator = `0x${"0".repeat(40)}`),
      "ROLES_ADMINISTRATOR_ZERO_ADDRESS",
    ],
    [
      "same roles",
      (manifest) => (manifest.roles.initialAttestor = ADMINISTRATOR),
      "ROLES_MUST_BE_SEPARATED",
    ],
    [
      "malformed registry",
      (manifest) => (manifest.deployment.registryAddress = "0x1234"),
      "DEPLOYMENT_REGISTRY_ADDRESS_INVALID_ADDRESS",
    ],
    [
      "missing transaction",
      (manifest) => delete manifest.deployment.transactionHash,
      "DEPLOYMENT_UNEXPECTED_OR_MISSING_FIELDS",
    ],
    [
      "inconsistent runtime hash",
      (manifest) =>
        (manifest.build.runtimeBytecodeHash = `0x${"6".repeat(64)}`),
      "RUNTIME_BYTECODE_HASH_INCONSISTENT",
    ],
  ];

  for (const [, mutate, expectedCode] of cases) {
    const manifest = fixtureManifest();
    mutate(manifest);
    assert.throws(
      () => validateDeploymentManifest(manifest),
      (error) =>
        error instanceof DeploymentManifestValidationError &&
        error.code === expectedCode,
    );
  }
});

test("manifest rejects noncanonical source verification metadata", () => {
  const manifest = fixtureManifest();
  manifest.sourceVerification = {
    status: "verified",
    url: "http://example.test/registry",
  };
  assert.throws(
    () => validateDeploymentManifest(manifest),
    (error) =>
      error instanceof DeploymentManifestValidationError &&
      error.code === "SOURCE_VERIFICATION_URL_INVALID",
  );
});

test("verification reports a fixed successful result from controlled RPC responses", async () => {
  const { rpc, calls } = successfulRpc();
  const result = await verifyRegistryDeployment(fixtureManifest(), rpc);
  assert.equal(result.status, "verified");
  assert.equal(result.errorCode, null);
  assert.equal(result.checks.chainId.ok, true);
  assert.equal(result.checks.runtimeBytecode.ok, true);
  assert.equal(result.checks.administrator.ok, true);
  assert.equal(result.checks.administrator.attestorStatus.ok, true);
  assert.equal(result.checks.initialAttestor.ok, true);
  assert.equal(result.checks.interface.ok, true);
  assert.deepEqual(
    calls.map((call) => call.method),
    [
      "eth_chainId",
      "eth_getCode",
      "eth_call",
      "eth_call",
      "eth_call",
      "eth_call",
    ],
  );
});

test("verification stops before bytecode access on the wrong chain", async () => {
  const { rpc, calls } = successfulRpc({ chainId: "0x1" });
  const result = await verifyRegistryDeployment(fixtureManifest(), rpc);
  assert.equal(result.status, "failed");
  assert.equal(result.checks.chainId.ok, false);
  assert.equal(result.checks.runtimeBytecode.ok, null);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["eth_chainId"],
  );
});

test("verification rejects a runtime bytecode hash mismatch before role calls", async () => {
  const { rpc, calls } = successfulRpc({ code: "0x6002600055" });
  const result = await verifyRegistryDeployment(fixtureManifest(), rpc);
  assert.equal(result.status, "failed");
  assert.equal(result.checks.runtimeBytecode.ok, false);
  assert.equal(result.checks.administrator.ok, null);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["eth_chainId", "eth_getCode"],
  );
});

test("verification reports role mismatch while retaining interface inspection", async () => {
  const { rpc } = successfulRpc({
    administrator: abiAddress(INITIAL_ATTESTOR),
  });
  const result = await verifyRegistryDeployment(fixtureManifest(), rpc);
  assert.equal(result.status, "failed");
  assert.equal(result.checks.administrator.ok, false);
  assert.equal(result.checks.initialAttestor.ok, true);
  assert.equal(result.checks.interface.ok, true);
});

test("verification rejects an administrator that is also an attestor", async () => {
  const { rpc } = successfulRpc({ administratorAttestor: abiBoolean(true) });
  const result = await verifyRegistryDeployment(fixtureManifest(), rpc);
  assert.equal(result.status, "failed");
  assert.equal(result.checks.administrator.ok, true);
  assert.equal(result.checks.administrator.attestorStatus.ok, false);
  assert.equal(result.checks.initialAttestor.ok, true);
});

test("verification returns a sanitized machine-readable RPC failure", async () => {
  const result = await verifyRegistryDeployment(fixtureManifest(), async () => {
    throw new Error("controlled transport details must not escape");
  });
  assert.equal(result.status, "rpc_error");
  assert.equal(result.errorCode, "RPC_REQUEST_FAILED");
  assert.equal(result.checks.chainId.ok, null);
});
