import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import sha3 from "js-sha3";

import {
  ARBITRUM_SEPOLIA_CHAIN_ID,
  DEPLOYMENT_VERIFICATION_RESULT_VERSION,
  DEPLOYMENT_VERIFIER_NAME,
} from "./registry-deployment-constants.mjs";
import {
  DEFAULT_REGISTRY_ARTIFACT_PATH,
  keccak256Hex,
  readRegistryBuildIdentity,
} from "./registry-build-identity.mjs";
import {
  DeploymentManifestValidationError,
  assertManifestMatchesBuildIdentity,
  validateDeploymentManifest,
} from "./registry-deployment-manifest.mjs";

const { keccak256 } = sha3;

export const REGISTRY_INTERFACE_SELECTORS = Object.freeze({
  admin: `0x${keccak256("admin()").slice(0, 8)}`,
  isAttestor: `0x${keccak256("isAttestor(address)").slice(0, 8)}`,
  evidenceHead: `0x${keccak256("evidenceHead(bytes32)").slice(0, 8)}`,
});

export class RegistryRpcError extends Error {
  constructor(code) {
    super(code);
    this.name = "RegistryRpcError";
    this.code = code;
  }
}

function rpcFail(code) {
  throw new RegistryRpcError(code);
}

function normalizeRpcHex(value, expectedBytes) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value))
    rpcFail("RPC_INVALID_HEX");
  const normalized = value.toLowerCase();
  if (
    expectedBytes !== undefined &&
    normalized.length !== 2 + expectedBytes * 2
  ) {
    rpcFail("RPC_INVALID_HEX_LENGTH");
  }
  return normalized;
}

function parseRpcQuantity(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value))
    rpcFail("RPC_INVALID_QUANTITY");
  return BigInt(value).toString();
}

function encodeAddressArgument(address) {
  return `${REGISTRY_INTERFACE_SELECTORS.isAttestor}${"0".repeat(24)}${address.slice(2)}`;
}

function decodeAbiAddress(value) {
  const word = normalizeRpcHex(value, 32);
  if (word.slice(2, 26) !== "0".repeat(24))
    rpcFail("RPC_ADMIN_RESPONSE_INVALID");
  return `0x${word.slice(-40)}`;
}

function decodeAbiBoolean(value) {
  const word = normalizeRpcHex(value, 32);
  if (word === `0x${"0".repeat(64)}`) return false;
  if (word === `0x${"0".repeat(63)}1`) return true;
  rpcFail("RPC_ATTESTOR_RESPONSE_INVALID");
}

function decodeEmptyEvidenceHead(value) {
  return normalizeRpcHex(value, 64) === `0x${"0".repeat(128)}`;
}

function emptyCheck(expected) {
  return { expected, actual: null, ok: null };
}

function baseResult(manifest) {
  return {
    schemaVersion: DEPLOYMENT_VERIFICATION_RESULT_VERSION,
    verifier: DEPLOYMENT_VERIFIER_NAME,
    status: "failed",
    errorCode: null,
    manifest: {
      chainId: manifest.chainId,
      registryAddress: manifest.deployment.registryAddress,
      transactionHash: manifest.deployment.transactionHash,
      runtimeBytecodeHash: manifest.deployment.runtimeBytecodeHash,
    },
    checks: {
      chainId: emptyCheck(ARBITRUM_SEPOLIA_CHAIN_ID),
      runtimeBytecode: emptyCheck(manifest.deployment.runtimeBytecodeHash),
      administrator: {
        ...emptyCheck(manifest.roles.administrator),
        attestorStatus: emptyCheck(false),
      },
      initialAttestor: emptyCheck(true),
      interface: {
        admin: emptyCheck(REGISTRY_INTERFACE_SELECTORS.admin),
        isAttestor: emptyCheck(REGISTRY_INTERFACE_SELECTORS.isAttestor),
        evidenceHead: emptyCheck(REGISTRY_INTERFACE_SELECTORS.evidenceHead),
        ok: null,
      },
    },
  };
}

function rpcErrorResult(result, error) {
  result.status = "rpc_error";
  result.errorCode =
    error instanceof RegistryRpcError ? error.code : "RPC_REQUEST_FAILED";
  return result;
}

/**
 * Verifies a deployed registry through an injected JSON-RPC function.
 * The function never creates a signer, broadcasts, or mutates chain state.
 */
export async function verifyRegistryDeployment(manifestInput, rpcCall) {
  const manifest = validateDeploymentManifest(manifestInput);
  if (typeof rpcCall !== "function")
    throw new TypeError("rpcCall must be a function");
  const result = baseResult(manifest);

  let chainId;
  try {
    chainId = parseRpcQuantity(await rpcCall("eth_chainId", []));
  } catch (error) {
    return rpcErrorResult(result, error);
  }
  result.checks.chainId.actual = chainId;
  result.checks.chainId.ok = chainId === ARBITRUM_SEPOLIA_CHAIN_ID;
  if (!result.checks.chainId.ok) return result;

  let runtimeBytecode;
  try {
    runtimeBytecode = normalizeRpcHex(
      await rpcCall("eth_getCode", [
        manifest.deployment.registryAddress,
        "latest",
      ]),
    );
  } catch (error) {
    return rpcErrorResult(result, error);
  }
  const runtimeBytecodeHash =
    runtimeBytecode === "0x"
      ? null
      : keccak256Hex(Buffer.from(runtimeBytecode.slice(2), "hex"));
  result.checks.runtimeBytecode.actual = runtimeBytecodeHash;
  result.checks.runtimeBytecode.ok =
    runtimeBytecodeHash === manifest.deployment.runtimeBytecodeHash;
  if (!result.checks.runtimeBytecode.ok) return result;

  let administrator;
  let administratorIsAttestor;
  let initialAttestor;
  let emptyEvidenceHead;
  try {
    administrator = decodeAbiAddress(
      await rpcCall("eth_call", [
        {
          to: manifest.deployment.registryAddress,
          data: REGISTRY_INTERFACE_SELECTORS.admin,
        },
        "latest",
      ]),
    );
    administratorIsAttestor = decodeAbiBoolean(
      await rpcCall("eth_call", [
        {
          to: manifest.deployment.registryAddress,
          data: encodeAddressArgument(manifest.roles.administrator),
        },
        "latest",
      ]),
    );
    initialAttestor = decodeAbiBoolean(
      await rpcCall("eth_call", [
        {
          to: manifest.deployment.registryAddress,
          data: encodeAddressArgument(manifest.roles.initialAttestor),
        },
        "latest",
      ]),
    );
    emptyEvidenceHead = decodeEmptyEvidenceHead(
      await rpcCall("eth_call", [
        {
          to: manifest.deployment.registryAddress,
          data: `${REGISTRY_INTERFACE_SELECTORS.evidenceHead}${"0".repeat(64)}`,
        },
        "latest",
      ]),
    );
  } catch (error) {
    return rpcErrorResult(result, error);
  }

  result.checks.administrator.actual = administrator;
  result.checks.administrator.ok =
    administrator === manifest.roles.administrator;
  result.checks.administrator.attestorStatus.actual = administratorIsAttestor;
  result.checks.administrator.attestorStatus.ok =
    administratorIsAttestor === false;
  result.checks.initialAttestor.actual = initialAttestor;
  result.checks.initialAttestor.ok = initialAttestor === true;
  result.checks.interface.admin.actual = administrator;
  result.checks.interface.admin.ok = true;
  result.checks.interface.isAttestor.actual = initialAttestor;
  result.checks.interface.isAttestor.ok = true;
  result.checks.interface.evidenceHead.actual = emptyEvidenceHead;
  result.checks.interface.evidenceHead.ok = emptyEvidenceHead === true;
  result.checks.interface.ok =
    result.checks.interface.admin.ok &&
    result.checks.interface.isAttestor.ok &&
    result.checks.interface.evidenceHead.ok;

  if (
    result.checks.administrator.ok &&
    result.checks.administrator.attestorStatus.ok &&
    result.checks.initialAttestor.ok &&
    result.checks.interface.ok
  ) {
    result.status = "verified";
  }
  return result;
}

/**
 * Creates a future operator-use JSON-RPC client. Tests inject a fake rpcCall instead.
 * No network request happens until the returned function is invoked.
 */
export function createFetchRpcClient(rpcUrl) {
  let endpoint;
  try {
    endpoint = new URL(rpcUrl);
  } catch {
    throw new RegistryRpcError("RPC_URL_INVALID");
  }
  if (
    !/^https?:$/.test(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new RegistryRpcError("RPC_URL_INVALID");
  }

  let requestId = 0;
  return async function rpcCall(method, params) {
    requestId += 1;
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      });
    } catch {
      rpcFail("RPC_REQUEST_FAILED");
    }
    if (!response.ok) rpcFail("RPC_HTTP_FAILURE");
    let payload;
    try {
      payload = await response.json();
    } catch {
      rpcFail("RPC_INVALID_JSON");
    }
    if (!payload || payload.jsonrpc !== "2.0" || payload.id !== requestId) {
      rpcFail("RPC_INVALID_RESPONSE");
    }
    if (payload.error) rpcFail("RPC_ERROR_RESPONSE");
    if (!("result" in payload)) rpcFail("RPC_INVALID_RESPONSE");
    return payload.result;
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new DeploymentManifestValidationError("MANIFEST_UNREADABLE");
  }
}

function parseArgs(argv) {
  let manifestPath;
  let artifactPath = DEFAULT_REGISTRY_ARTIFACT_PATH;
  let rpcUrl;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      !["--manifest", "--artifact", "--rpc-url"].includes(option) ||
      value === undefined
    ) {
      throw new RegistryRpcError(
        "USAGE: --manifest <path> --rpc-url <url> [--artifact <path>]",
      );
    }
    if (option === "--manifest") manifestPath = value;
    if (option === "--artifact") artifactPath = value;
    if (option === "--rpc-url") rpcUrl = value;
    index += 1;
  }
  if (!manifestPath || !rpcUrl) {
    throw new RegistryRpcError(
      "USAGE: --manifest <path> --rpc-url <url> [--artifact <path>]",
    );
  }
  return { manifestPath, artifactPath, rpcUrl };
}

function invalidManifestResult() {
  return {
    schemaVersion: DEPLOYMENT_VERIFICATION_RESULT_VERSION,
    verifier: DEPLOYMENT_VERIFIER_NAME,
    status: "invalid_manifest",
    errorCode: "INVALID_MANIFEST",
    manifest: null,
    checks: null,
  };
}

async function main() {
  try {
    const { manifestPath, artifactPath, rpcUrl } = parseArgs(
      process.argv.slice(2),
    );
    const manifest = assertManifestMatchesBuildIdentity(
      readJson(resolve(process.cwd(), manifestPath)),
      readRegistryBuildIdentity(resolve(process.cwd(), artifactPath)),
    );
    const result = await verifyRegistryDeployment(
      manifest,
      createFetchRpcClient(rpcUrl),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === "verified" ? 0 : 1;
  } catch (error) {
    if (error instanceof DeploymentManifestValidationError) {
      process.stdout.write(
        `${JSON.stringify(invalidManifestResult(), null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        `${JSON.stringify(
          {
            schemaVersion: DEPLOYMENT_VERIFICATION_RESULT_VERSION,
            verifier: DEPLOYMENT_VERIFIER_NAME,
            status: "invalid_arguments",
            errorCode: "INVALID_ARGUMENTS",
            manifest: null,
            checks: null,
          },
          null,
          2,
        )}\n`,
      );
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
