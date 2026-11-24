export const ARBITRUM_SEPOLIA_CHAIN_ID = "421614";
export const DEPLOYMENT_MANIFEST_VERSION = 1;
export const REGISTRY_CONTRACT_NAME = "PonteRouteDecisionEvidenceRegistry";
export const REGISTRY_CONTRACT_VERSION = "1.0.0";
export const REGISTRY_ABI_VERSION = 1;
export const RUNTIME_BYTECODE_HASH_ALGORITHM = "keccak256";
export const ABI_HASH_ALGORITHM = "sha256";

// These values are pinned by contracts/foundry.toml and the locked solc package.
export const EXPECTED_BUILD_CONFIGURATION = Object.freeze({
  solidityCompiler: "0.8.28+commit.7893614a",
  optimizer: Object.freeze({ enabled: true, runs: 200 }),
  evmVersion: "prague",
  viaIR: false,
  runtimeBytecodeHashAlgorithm: RUNTIME_BYTECODE_HASH_ALGORITHM,
});

export const DEPLOYMENT_VERIFICATION_RESULT_VERSION = 1;
export const DEPLOYMENT_VERIFIER_NAME = "ponte-registry-deployment-verifier";
