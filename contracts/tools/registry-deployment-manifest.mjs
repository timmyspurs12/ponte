import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ABI_HASH_ALGORITHM,
  ARBITRUM_SEPOLIA_CHAIN_ID,
  DEPLOYMENT_MANIFEST_VERSION,
  EXPECTED_BUILD_CONFIGURATION,
  REGISTRY_ABI_VERSION,
  REGISTRY_CONTRACT_NAME,
  REGISTRY_CONTRACT_VERSION,
  RUNTIME_BYTECODE_HASH_ALGORITHM,
} from "./registry-deployment-constants.mjs";
import {
  DEFAULT_REGISTRY_ARTIFACT_PATH,
  readRegistryBuildIdentity,
} from "./registry-build-identity.mjs";

export class DeploymentManifestValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "DeploymentManifestValidationError";
    this.code = code;
  }
}

function fail(code) {
  throw new DeploymentManifestValidationError(code);
}

function assertExactKeys(value, label, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label}_INVALID_OBJECT`);
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (
    actual.length !== allowed.length ||
    actual.some((key, index) => key !== allowed[index])
  ) {
    fail(`${label}_UNEXPECTED_OR_MISSING_FIELDS`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string") fail(`${label}_INVALID_STRING`);
  return value;
}

function assertCanonicalAddress(value, label) {
  const address = assertString(value, label);
  if (!/^0x[0-9a-f]{40}$/.test(address)) fail(`${label}_INVALID_ADDRESS`);
  if (address === `0x${"0".repeat(40)}`) fail(`${label}_ZERO_ADDRESS`);
  return address;
}

function assertNonzeroBytes32(value, label) {
  const hash = assertString(value, label);
  if (!/^0x[0-9a-f]{64}$/.test(hash)) fail(`${label}_INVALID_BYTES32`);
  if (hash === `0x${"0".repeat(64)}`) fail(`${label}_ZERO_BYTES32`);
  return hash;
}

function assertPositiveDecimal(value, label) {
  const decimal = assertString(value, label);
  if (!/^[1-9][0-9]*$/.test(decimal)) fail(`${label}_INVALID_POSITIVE_DECIMAL`);
  return decimal;
}

function assertHttpsUrlOrNull(value, status) {
  if (status !== "verified") {
    if (value !== null) fail("SOURCE_VERIFICATION_URL_MUST_BE_NULL");
    return null;
  }
  const text = assertString(value, "SOURCE_VERIFICATION_URL");
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password) {
      fail("SOURCE_VERIFICATION_URL_INVALID");
    }
  } catch (error) {
    if (error instanceof DeploymentManifestValidationError) throw error;
    fail("SOURCE_VERIFICATION_URL_INVALID");
  }
  return text;
}

function validateBuild(build, deployment) {
  assertExactKeys(build, "BUILD", [
    "solidityCompiler",
    "optimizer",
    "evmVersion",
    "viaIR",
    "runtimeBytecodeHashAlgorithm",
    "runtimeBytecodeHash",
  ]);
  if (
    build.solidityCompiler !== EXPECTED_BUILD_CONFIGURATION.solidityCompiler
  ) {
    fail("BUILD_SOLIDITY_COMPILER_MISMATCH");
  }
  assertExactKeys(build.optimizer, "BUILD_OPTIMIZER", ["enabled", "runs"]);
  if (
    build.optimizer.enabled !==
      EXPECTED_BUILD_CONFIGURATION.optimizer.enabled ||
    build.optimizer.runs !== EXPECTED_BUILD_CONFIGURATION.optimizer.runs
  ) {
    fail("BUILD_OPTIMIZER_MISMATCH");
  }
  if (build.evmVersion !== EXPECTED_BUILD_CONFIGURATION.evmVersion)
    fail("BUILD_EVM_VERSION_MISMATCH");
  if (build.viaIR !== EXPECTED_BUILD_CONFIGURATION.viaIR)
    fail("BUILD_VIA_IR_MISMATCH");
  if (build.runtimeBytecodeHashAlgorithm !== RUNTIME_BYTECODE_HASH_ALGORITHM) {
    fail("BUILD_RUNTIME_HASH_ALGORITHM_MISMATCH");
  }
  const runtimeBytecodeHash = assertNonzeroBytes32(
    build.runtimeBytecodeHash,
    "BUILD_RUNTIME_BYTECODE_HASH",
  );
  if (runtimeBytecodeHash !== deployment.runtimeBytecodeHash)
    fail("RUNTIME_BYTECODE_HASH_INCONSISTENT");
  return Object.freeze({
    solidityCompiler: build.solidityCompiler,
    optimizer: Object.freeze({
      enabled: build.optimizer.enabled,
      runs: build.optimizer.runs,
    }),
    evmVersion: build.evmVersion,
    viaIR: build.viaIR,
    runtimeBytecodeHashAlgorithm: build.runtimeBytecodeHashAlgorithm,
    runtimeBytecodeHash,
  });
}

/**
 * Strictly validates an already-deployed public registry manifest.
 * It deliberately does not synthesize manifests or accept a local fixture as a deployment record.
 */
export function validateDeploymentManifest(value) {
  assertExactKeys(value, "MANIFEST", [
    "manifestVersion",
    "chainId",
    "contract",
    "deployment",
    "roles",
    "build",
    "abi",
    "sourceVerification",
  ]);
  if (value.manifestVersion !== DEPLOYMENT_MANIFEST_VERSION)
    fail("MANIFEST_VERSION_UNSUPPORTED");
  if (value.chainId !== ARBITRUM_SEPOLIA_CHAIN_ID)
    fail("MANIFEST_CHAIN_ID_MISMATCH");

  assertExactKeys(value.contract, "CONTRACT", ["name", "version"]);
  if (value.contract.name !== REGISTRY_CONTRACT_NAME)
    fail("CONTRACT_NAME_MISMATCH");
  if (value.contract.version !== REGISTRY_CONTRACT_VERSION)
    fail("CONTRACT_VERSION_MISMATCH");

  assertExactKeys(value.deployment, "DEPLOYMENT", [
    "registryAddress",
    "transactionHash",
    "blockNumber",
    "runtimeBytecodeHash",
  ]);
  const deployment = Object.freeze({
    registryAddress: assertCanonicalAddress(
      value.deployment.registryAddress,
      "DEPLOYMENT_REGISTRY_ADDRESS",
    ),
    transactionHash: assertNonzeroBytes32(
      value.deployment.transactionHash,
      "DEPLOYMENT_TRANSACTION_HASH",
    ),
    blockNumber: assertPositiveDecimal(
      value.deployment.blockNumber,
      "DEPLOYMENT_BLOCK_NUMBER",
    ),
    runtimeBytecodeHash: assertNonzeroBytes32(
      value.deployment.runtimeBytecodeHash,
      "DEPLOYMENT_RUNTIME_BYTECODE_HASH",
    ),
  });

  assertExactKeys(value.roles, "ROLES", ["administrator", "initialAttestor"]);
  const roles = Object.freeze({
    administrator: assertCanonicalAddress(
      value.roles.administrator,
      "ROLES_ADMINISTRATOR",
    ),
    initialAttestor: assertCanonicalAddress(
      value.roles.initialAttestor,
      "ROLES_INITIAL_ATTESTOR",
    ),
  });
  if (roles.administrator === roles.initialAttestor)
    fail("ROLES_MUST_BE_SEPARATED");

  const build = validateBuild(value.build, deployment);

  assertExactKeys(value.abi, "ABI", ["version", "hashAlgorithm", "hash"]);
  if (value.abi.version !== REGISTRY_ABI_VERSION) fail("ABI_VERSION_MISMATCH");
  if (value.abi.hashAlgorithm !== ABI_HASH_ALGORITHM)
    fail("ABI_HASH_ALGORITHM_MISMATCH");
  const abi = Object.freeze({
    version: value.abi.version,
    hashAlgorithm: value.abi.hashAlgorithm,
    hash: assertNonzeroBytes32(value.abi.hash, "ABI_HASH"),
  });

  assertExactKeys(value.sourceVerification, "SOURCE_VERIFICATION", [
    "status",
    "url",
  ]);
  if (
    !["not_submitted", "verified", "failed"].includes(
      value.sourceVerification.status,
    )
  ) {
    fail("SOURCE_VERIFICATION_STATUS_INVALID");
  }
  const sourceVerification = Object.freeze({
    status: value.sourceVerification.status,
    url: assertHttpsUrlOrNull(
      value.sourceVerification.url,
      value.sourceVerification.status,
    ),
  });

  return Object.freeze({
    manifestVersion: value.manifestVersion,
    chainId: value.chainId,
    contract: Object.freeze({
      name: value.contract.name,
      version: value.contract.version,
    }),
    deployment,
    roles,
    build,
    abi,
    sourceVerification,
  });
}

/**
 * Proves a manifest's claimed build fields are identical to a locally rebuilt artifact.
 * Chain bytecode validation remains the verifier module's separate responsibility.
 */
export function assertManifestMatchesBuildIdentity(
  manifestInput,
  buildIdentity,
) {
  const manifest = validateDeploymentManifest(manifestInput);
  if (!buildIdentity || typeof buildIdentity !== "object")
    fail("BUILD_IDENTITY_INVALID");
  if (
    buildIdentity.contract?.name !== manifest.contract.name ||
    buildIdentity.contract?.version !== manifest.contract.version ||
    buildIdentity.compiler !== manifest.build.solidityCompiler ||
    buildIdentity.optimizer?.enabled !== manifest.build.optimizer.enabled ||
    buildIdentity.optimizer?.runs !== manifest.build.optimizer.runs ||
    buildIdentity.evmVersion !== manifest.build.evmVersion ||
    buildIdentity.viaIR !== manifest.build.viaIR ||
    buildIdentity.runtimeBytecodeHashAlgorithm !==
      manifest.build.runtimeBytecodeHashAlgorithm ||
    buildIdentity.runtimeBytecodeHash !== manifest.build.runtimeBytecodeHash ||
    buildIdentity.abi?.version !== manifest.abi.version ||
    buildIdentity.abi?.hashAlgorithm !== manifest.abi.hashAlgorithm ||
    buildIdentity.abi?.hash !== manifest.abi.hash
  ) {
    fail("MANIFEST_BUILD_IDENTITY_MISMATCH");
  }
  return manifest;
}

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("MANIFEST_UNREADABLE");
  }
}

function parseArgs(argv) {
  let manifestPath;
  let artifactPath = DEFAULT_REGISTRY_ARTIFACT_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      (option !== "--manifest" && option !== "--artifact") ||
      value === undefined
    ) {
      fail("USAGE: --manifest <path> [--artifact <path>]");
    }
    if (option === "--manifest") manifestPath = value;
    if (option === "--artifact") artifactPath = value;
    index += 1;
  }
  if (!manifestPath) fail("USAGE: --manifest <path> [--artifact <path>]");
  return { manifestPath, artifactPath };
}

function main() {
  const { manifestPath, artifactPath } = parseArgs(process.argv.slice(2));
  const manifest = assertManifestMatchesBuildIdentity(
    readManifest(resolve(process.cwd(), manifestPath)),
    readRegistryBuildIdentity(resolve(process.cwd(), artifactPath)),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: "valid",
        chainId: manifest.chainId,
        registryAddress: manifest.deployment.registryAddress,
        runtimeBytecodeHash: manifest.deployment.runtimeBytecodeHash,
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
