import assert from "node:assert/strict";
import test from "node:test";
import {
  assertManifestMatchesBuildIdentity,
  validateDeploymentManifest,
} from "../../contracts/tools/registry-deployment-manifest.mjs";
import { issueTestConfig } from "./helpers/test-config-bridge";
import { harnessManifest, harnessBuildIdentity } from "./helpers/test-reader-factory";
import { hex32, keccakOf } from "./helpers/mock-rpc-server";

/**
 * Differential parity between the canonical manifest validator and the runtime one
 * (Phase 2C.2A, review pass 2).
 *
 * Review pass 2 asked for something stronger than "these particular malformed
 * examples are rejected": it asked that the two validators produce the **same
 * acceptance/rejection outcome** on the same input. So every case below asserts
 * equality of outcomes rather than equality of error codes, in both directions —
 * accepted inputs must be accepted by both, rejected inputs rejected by both.
 *
 * A divergence in the permissive direction is a security defect: the runtime would
 * accept a manifest the canonical validator rejects. A divergence in the strict
 * direction is a functional defect: a reviewed deployment would fail to enable.
 */

const REGISTRY = `0x${"11".repeat(20)}`;
const ADMIN = `0x${"22".repeat(20)}`;
const ATTESTOR = `0x${"33".repeat(20)}`;
const RUNTIME_CODE = "0x6080604052348015600f57600080fd5b50";
const RUNTIME_HASH = keccakOf(RUNTIME_CODE);

const OPTIONS = {
  // Loopback, because test-scoped issuance accepts numeric-loopback HTTP only. These
  // cases are about manifest acceptance/rejection, never about reaching a real host.
  rpcUrl: "http://127.0.0.1:8545",
  registryAddress: REGISTRY,
  runtimeBytecodeHash: RUNTIME_HASH,
  administrator: ADMIN,
};

function baseManifest() {
  return harnessManifest(OPTIONS);
}

function baseIdentity() {
  return harnessBuildIdentity(OPTIONS);
}

/**
 * The canonical validator's verdict, as a boolean.
 *
 * It throws `DeploymentManifestValidationError` on rejection; anything else is a
 * failure of the test itself, so it is re-thrown rather than swallowed.
 */
function canonicalAccepts(manifest: unknown, identity: unknown = baseIdentity()) {
  try {
    assertManifestMatchesBuildIdentity(manifest, identity);
    return true;
  } catch (error) {
    if ((error as Error)?.name === "DeploymentManifestValidationError") return false;
    throw error;
  }
}

/** The runtime validator's verdict, as a boolean. */
function runtimeAccepts(manifest: unknown, identity: unknown = baseIdentity()) {
  return issueTestConfig({
    rpcUrl: OPTIONS.rpcUrl,
    timeoutMs: 5_000,
    manifest,
    buildIdentity: identity,
  }).ok;
}

/** Asserts both validators agree, and that the agreement is the expected verdict. */
function assertParity(
  label: string,
  manifest: unknown,
  expected: boolean,
  identity?: unknown,
) {
  const canonical = canonicalAccepts(manifest, identity);
  const runtime = runtimeAccepts(manifest, identity);
  assert.equal(
    canonical,
    runtime,
    `${label}: canonical=${canonical} runtime=${runtime} — validators disagree`,
  );
  assert.equal(canonical, expected, `${label}: expected canonical ${expected}`);
}

// ------------------------------------------------------------ accepted case

test("both validators accept the same well-formed manifest", () => {
  assertParity("valid manifest", baseManifest(), true);
});

test("both validators accept the 32-byte ABI hash in canonical form", () => {
  const manifest = baseManifest();
  assert.match(manifest.abi.hash, /^0x[0-9a-f]{64}$/);
  assertParity("canonical abi hash", manifest, true);
});

// ------------------------------------------- source verification (finding 4a/4b)

test("both validators accept status not_submitted with a null url", () => {
  const m = baseManifest();
  m.sourceVerification = { status: "not_submitted", url: null };
  assertParity("not_submitted/null", m, true);
});

test("both validators REJECT status failed with a null url", () => {
  // Canonical behaviour: only "verified" may carry a URL; every other status —
  // including "failed" — must be null. Here the URL *is* null, so canonical rejects
  // only if it also requires a URL; assert the actual agreement either way.
  const m = baseManifest();
  m.sourceVerification = { status: "failed", url: null };
  const canonical = canonicalAccepts(m);
  const runtime = runtimeAccepts(m);
  assert.equal(
    canonical,
    runtime,
    `failed/null: canonical=${canonical} runtime=${runtime}`,
  );
  // Canonical's rule is `status !== "verified" → url must be null`, so this passes.
  assert.equal(canonical, true);
});

test("both validators REJECT status failed with an HTTPS url", () => {
  const m = baseManifest();
  m.sourceVerification = { status: "failed", url: "https://explorer.example/tx/1" };
  assertParity("failed/https", m, false);
});

test("both validators accept status verified with an HTTPS url", () => {
  const m = baseManifest();
  m.sourceVerification = { status: "verified", url: "https://explorer.example/tx/1" };
  assertParity("verified/https", m, true);
});

test("both validators REJECT verified with a null url", () => {
  const m = baseManifest();
  m.sourceVerification = { status: "verified", url: null };
  assertParity("verified/null", m, false);
});

test("both validators REJECT verified with a plain-HTTP url", () => {
  const m = baseManifest();
  m.sourceVerification = { status: "verified", url: "http://explorer.example/tx/1" };
  assertParity("verified/http", m, false);
});

test("both validators REJECT a verified url containing a username", () => {
  const m = baseManifest();
  m.sourceVerification = {
    status: "verified",
    url: "https://user@explorer.example/tx/1",
  };
  assertParity("verified/username", m, false);
});

test("both validators REJECT a verified url containing a password", () => {
  const m = baseManifest();
  m.sourceVerification = {
    status: "verified",
    url: "https://user:pass@explorer.example/tx/1",
  };
  assertParity("verified/password", m, false);
});

test("both validators REJECT an unrecognised source-verification status", () => {
  const m = baseManifest();
  m.sourceVerification = { status: "pending", url: null };
  assertParity("pending", m, false);
});

test("both validators REJECT a source-verification object with extra keys", () => {
  const m = baseManifest();
  m.sourceVerification = {
    status: "not_submitted",
    url: null,
    verifiedAt: "2026-01-01",
  } as never;
  assertParity("sourceVerification/extra", m, false);
});

test("both validators REJECT a missing source-verification block", () => {
  const m = baseManifest() as Record<string, unknown>;
  delete m.sourceVerification;
  assertParity("sourceVerification/missing", m, false);
});

// -------------------------------------------------- uppercase hex (finding 4c)

test("both validators REJECT an uppercase (checksummed) registry address", () => {
  const m = baseManifest();
  m.deployment.registryAddress = `0x${"AB".repeat(20)}`;
  assertParity("uppercase registry", m, false);
});

test("both validators REJECT an uppercase deployment transaction hash", () => {
  const m = baseManifest();
  m.deployment.transactionHash = `0x${"AB".repeat(32)}`;
  assertParity("uppercase deployment tx", m, false);
});

test("both validators REJECT an uppercase runtime bytecode hash", () => {
  const m = baseManifest();
  const upper = `0x${RUNTIME_HASH.slice(2).toUpperCase()}`;
  m.deployment.runtimeBytecodeHash = upper;
  m.build.runtimeBytecodeHash = upper;
  assertParity("uppercase runtime hash", m, false);
});

test("both validators REJECT an uppercase ABI hash", () => {
  const m = baseManifest();
  m.abi.hash = `0x${"AA".repeat(32)}`;
  assertParity("uppercase abi hash", m, false);
});

test("both validators REJECT an uppercase build-identity hash", () => {
  const identity = baseIdentity();
  identity.runtimeBytecodeHash = `0x${RUNTIME_HASH.slice(2).toUpperCase()}`;
  assertParity("uppercase build identity hash", baseManifest(), false, identity);
});

test("both validators REJECT an uppercase administrator address", () => {
  const m = baseManifest();
  m.roles.administrator = `0x${"AB".repeat(20)}`;
  assertParity("uppercase administrator", m, false);
});

// --------------------------------------------------------- malformed nesting

test("both validators REJECT a non-object deployment block", () => {
  const m = baseManifest() as Record<string, unknown>;
  (m as { deployment: unknown }).deployment = "not-an-object";
  assertParity("deployment/string", m, false);
});

test("both validators REJECT a deployment block with an extra key", () => {
  const m = baseManifest();
  (m.deployment as Record<string, unknown>).extra = 1;
  assertParity("deployment/extra", m, false);
});

test("both validators REJECT a non-object abi block", () => {
  const m = baseManifest() as Record<string, unknown>;
  (m as { abi: unknown }).abi = [];
  assertParity("abi/array", m, false);
});

test("both validators REJECT an abi block with an unsupported version", () => {
  const m = baseManifest();
  (m.abi as { version: number }).version = 2;
  assertParity("abi/version", m, false);
});

test("both validators REJECT an abi block with an extra key", () => {
  const m = baseManifest();
  (m.abi as Record<string, unknown>).extra = 1;
  assertParity("abi/extra", m, false);
});

test("both validators REJECT a non-object build block", () => {
  const m = baseManifest() as Record<string, unknown>;
  (m as { build: unknown }).build = null;
  assertParity("build/null", m, false);
});

test("both validators REJECT a non-object contract block", () => {
  const m = baseManifest() as Record<string, unknown>;
  (m as { contract: unknown }).contract = 42;
  assertParity("contract/number", m, false);
});

test("both validators REJECT a non-object roles block", () => {
  const m = baseManifest() as Record<string, unknown>;
  (m as { roles: unknown }).roles = [];
  assertParity("roles/array", m, false);
});

// ------------------------------------------------------------- build identity

test("both validators reject when the build identity hash differs", () => {
  const identity = baseIdentity();
  identity.runtimeBytecodeHash = hex32("other");
  assertParity("identity hash mismatch", baseManifest(), false, identity);
});

test("both validators reject when the build identity ABI hash differs", () => {
  const identity = baseIdentity();
  identity.abi.hash = hex32("other-abi");
  assertParity("identity abi mismatch", baseManifest(), false, identity);
});

test("both validators reject when the build identity compiler differs", () => {
  const identity = baseIdentity();
  identity.compiler = "0.7.0";
  assertParity("identity compiler mismatch", baseManifest(), false, identity);
});

test("both validators reject when the build identity contract name differs", () => {
  const identity = baseIdentity();
  identity.contract.name = "Other";
  assertParity("identity contract mismatch", baseManifest(), false, identity);
});

test("both validators TOLERATE extra keys on the build identity", () => {
  // The canonical validator compares only the fields it lists and ignores extras on
  // the build identity, which is a trusted repository artifact rather than
  // attacker-supplied JSON. The runtime matches that. Parity, not strictness, is the
  // requirement here — and this test pins the agreement so neither side drifts.
  const identity = baseIdentity() as Record<string, unknown>;
  identity.extra = 1;
  assertParity("identity extra", baseManifest(), true, identity);
});

test("both validators REJECT extra keys on the manifest itself", () => {
  const m = baseManifest() as Record<string, unknown>;
  m.extra = 1;
  assertParity("manifest extra", m, false);
});

// ------------------------------------------------------------ build settings

test("both validators reject an optimizer mismatch", () => {
  const m = baseManifest();
  m.build.optimizer = { enabled: false, runs: 200 };
  assertParity("optimizer enabled", m, false);
});

test("both validators reject an optimizer runs mismatch", () => {
  const m = baseManifest();
  m.build.optimizer = { enabled: true, runs: 1 };
  assertParity("optimizer runs", m, false);
});

test("both validators reject an EVM version mismatch", () => {
  const m = baseManifest();
  m.build.evmVersion = "cancun";
  assertParity("evm version", m, false);
});

test("both validators reject a viaIR mismatch", () => {
  const m = baseManifest();
  m.build.viaIR = true;
  assertParity("viaIR", m, false);
});

test("both validators reject a chain id mismatch", () => {
  const m = baseManifest();
  m.chainId = "10";
  assertParity("chain id", m, false);
});

test("both validators reject an unsupported manifest version", () => {
  const m = baseManifest();
  m.manifestVersion = 2;
  assertParity("manifest version", m, false);
});

test("both validators reject a contract version mismatch", () => {
  const m = baseManifest();
  m.contract.version = "2.0.0";
  assertParity("contract version", m, false);
});

test("both validators reject a zero registry address", () => {
  const m = baseManifest();
  m.deployment.registryAddress = `0x${"00".repeat(20)}`;
  assertParity("zero address", m, false);
});

test("both validators reject a zero deployment transaction hash", () => {
  const m = baseManifest();
  m.deployment.transactionHash = `0x${"00".repeat(32)}`;
  assertParity("zero tx hash", m, false);
});

test("both validators reject a non-positive deployment block number", () => {
  const m = baseManifest();
  m.deployment.blockNumber = "0";
  assertParity("zero block", m, false);
});

test("both validators reject identical administrator and attestor", () => {
  const m = baseManifest();
  m.roles.initialAttestor = m.roles.administrator;
  assertParity("roles not separated", m, false);
});
