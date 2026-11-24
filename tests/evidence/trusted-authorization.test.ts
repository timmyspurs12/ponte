import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getAddress, toBeHex, zeroPadValue } from "ethers";
import {
  EVIDENCE_ANCHORED_TOPIC,
  evaluateAnchorObservation,
  isAnchorEvaluationProof,
  type ChainObservation,
  type ExpectedAnchorCommitment,
} from "../../src/server/evidence/anchor-verification";
import {
  isTrustedAnchorVerification,
  isTrustedObservedAnchor,
  rebindTrustedResult,
  runTrustedVerification,
} from "../../src/server/evidence/trusted-authorization";
import { createTestReader } from "./helpers/test-reader-factory";
import {
  hex32,
  keccakOf,
  quantity,
  startMockRpcServer,
  type MockRpcServer,
  type RpcCall,
} from "./helpers/mock-rpc-server";

/**
 * Adversarial tests for the trusted-authorization boundary (review pass 1).
 *
 * These attack the **runtime** export table and the issued objects, not the TypeScript
 * types. Every test here would have passed incorrectly against the previous revision,
 * where `sealTrustedObservation` and `createTrustedAnchorVerification` were exported
 * and did not cross-check proof and seal.
 */

const CHAIN_ID = 421614;
const REGISTRY = `0x${"11".repeat(20)}`;
const ADMIN = `0x${"22".repeat(20)}`;
const ATTESTOR = `0x${"33".repeat(20)}`;
const RUNTIME_CODE = "0x6080604052348015600f57600080fd5b50";
const RUNTIME_HASH = keccakOf(RUNTIME_CODE);
const TX_HASH = hex32("adv-transaction");
const OTHER_TX = hex32("adv-other-transaction");
const BLOCK_HASH = hex32("adv-block");
const EVIDENCE_ID = hex32("adv-evidence");
const PAYLOAD_HASH = hex32("adv-payload");
const PREVIOUS_HASH = `0x${"00".repeat(32)}`;
const RECEIPT_BLOCK = 12345678;

const EXPECTED: ExpectedAnchorCommitment = {
  chainId: String(CHAIN_ID),
  registryAddress: REGISTRY,
  evidenceId: EVIDENCE_ID,
  payloadHash: PAYLOAD_HASH,
  evidenceKind: 1,
  sequence: "1",
  previousPayloadHash: PREVIOUS_HASH,
};

function anchorLog(overrides: { evidenceId?: string; attestor?: string } = {}) {
  return {
    address: REGISTRY,
    topics: [
      EVIDENCE_ANCHORED_TOPIC,
      overrides.evidenceId ?? EVIDENCE_ID,
      PAYLOAD_HASH,
      zeroPadValue(getAddress(overrides.attestor ?? ATTESTOR), 32),
    ],
    data: `0x${toBeHex(1n, 32).slice(2)}${toBeHex(1n, 32).slice(2)}${PREVIOUS_HASH.slice(2)}`,
  };
}

function world(
  overrides: Partial<Record<string, unknown>> = {},
  logOverrides: { evidenceId?: string } = {},
) {
  return {
    eth_chainId: quantity(CHAIN_ID),
    eth_getCode: RUNTIME_CODE,
    eth_call: `0x${zeroPadValue(getAddress(ADMIN), 32).slice(2)}`,
    eth_getTransactionByHash: { hash: TX_HASH, from: ATTESTOR, to: REGISTRY },
    eth_getTransactionReceipt: {
      transactionHash: TX_HASH,
      status: "0x1",
      from: ATTESTOR,
      to: REGISTRY,
      blockNumber: quantity(RECEIPT_BLOCK),
      blockHash: BLOCK_HASH,
      logs: [anchorLog(logOverrides)],
    },
    eth_getBlockByNumber: (call: RpcCall) =>
      call.params[0] === "finalized"
        ? { number: quantity(RECEIPT_BLOCK + 50), hash: hex32("adv-finalized") }
        : { number: quantity(RECEIPT_BLOCK), hash: BLOCK_HASH },
    ...overrides,
  } as Record<string, unknown>;
}

let server: MockRpcServer;

before(async () => {
  server = await startMockRpcServer(() => {
    throw new Error("not configured");
  });
});

after(async () => {
  await server.close();
});

function readerFor(w: Record<string, unknown>) {
  server.setHandler((call: RpcCall) => {
    const entry = w[call.method];
    if (entry === undefined) throw new Error(`method not stubbed: ${call.method}`);
    if (typeof entry === "function") return (entry as (c: RpcCall) => unknown)(call);
    return entry;
  });
  server.setRawResponder(null);
  return createTestReader({
    rpcUrl: server.url,
    registryAddress: REGISTRY,
    runtimeBytecodeHash: RUNTIME_HASH,
    administrator: ADMIN,
  });
}

/**
 * A genuine, fully authorized result from the real pipeline.
 *
 * **Review pass 3: this can no longer be produced in tests.** Operator issuance was
 * removed from production source, so every reader the suite can construct is
 * test-scoped, and the provenance gate refuses it before any observation is read.
 *
 * The tests that attack seal and binding properties therefore require a result that
 * only a genuinely operator-pinned reader can produce, which requires a real reviewed
 * deployment manifest that does not exist yet. They are marked `skip` with this reason
 * rather than deleted (losing the intent) or faked (which is exactly the vulnerability
 * this phase is closing).
 *
 * Keeping the source is **not** coverage: a skipped callback never runs, so these tests
 * are not evidence that seal issuance, trusted-result issuance or the successful rebind
 * path work. No executed test in this repository reaches `issueSeal()`,
 * `issueTrustedVerification()` or a successful `runTrustedVerification()` /
 * `rebindTrustedResult()`.
 *
 * What *is* executed below: every rejection and forgery path that does not need a
 * sealed result, plus the post-issuance forgery tests in `tests-backend/`, which use
 * hand-built look-alikes.
 */
async function genuine(): Promise<Awaited<ReturnType<typeof runTrustedVerification>>> {
  return runTrustedVerification(readerFor(world()), EXPECTED, TX_HASH);
}

/**
 * Why a seal-dependent test cannot run yet.
 *
 * This string is only a `skip` reason. It is **not** separately asserted anywhere, so
 * nothing fails if these tests rot: the callbacks below never execute, and their bodies
 * are not even typechecked against a working success path. An earlier revision of this
 * comment claimed it was "asserted, so it cannot rot silently", which was untrue.
 */
const SEAL_BLOCKED =
  "requires a genuinely operator-pinned reader (no deployment manifest exists)";

// ---------------------------------------------------------------- forgery

test("a plain object cannot pass the trusted-verification check", () => {
  assert.equal(isTrustedAnchorVerification({}), false);
  assert.equal(isTrustedAnchorVerification({ verified: true }), false);
  assert.equal(
    isTrustedAnchorVerification({
      verified: true,
      status: "verified",
      proof: {},
      seal: {},
      binding: {},
    }),
    false,
  );
  assert.equal(isTrustedAnchorVerification(null), false);
  assert.equal(isTrustedAnchorVerification("verified"), false);
});

test("a genuine result survives a spread copy but the copy does not", { skip: SEAL_BLOCKED }, async () => {
  const outcome = await genuine();
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  // Branding is identity-based, so a copy of a genuine result is not genuine.
  assert.equal(isTrustedAnchorVerification({ ...outcome.result }), false);
  assert.equal(isTrustedAnchorVerification(structuredClone(outcome.result)), false);
  assert.equal(
    isTrustedAnchorVerification(
      JSON.parse(JSON.stringify({ verified: true, status: "verified" })),
    ),
    false,
  );
});

test("a seal cannot be paired with an evaluation proof for another transaction", { skip: SEAL_BLOCKED }, async () => {
  const outcome = await genuine();
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  // An evaluation proof for a *different* observation: same shape, different tx.
  const otherObservation: ChainObservation = {
    chainId: String(CHAIN_ID),
    transactionHash: OTHER_TX,
    transactionFrom: ATTESTOR,
    transactionTo: REGISTRY,
    receipt: {
      transactionHash: OTHER_TX,
      status: "success",
      from: ATTESTOR,
      to: REGISTRY,
      blockNumber: String(RECEIPT_BLOCK),
      blockHash: BLOCK_HASH,
      logs: [anchorLog()],
    },
    registryIdentity: "verified",
  };
  const foreignProof = evaluateAnchorObservation(EXPECTED, otherObservation);
  // That evaluation succeeds on its own terms...
  assert.equal(isAnchorEvaluationProof(foreignProof), true);

  // ...but substituting it into a genuine result is rejected, because the binding no
  // longer matches the seal's own observation.
  const spliced = { ...outcome.result, proof: foreignProof };
  assert.equal(isTrustedAnchorVerification(spliced), false);
  assert.equal(rebindTrustedResult(spliced as never), null);
});

test("swapping the seal for a different genuine seal is rejected", { skip: SEAL_BLOCKED }, async () => {
  const a = await genuine();
  const b = await genuine();
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  // Both are genuine, but a result carrying A's proof with B's seal was never issued
  // by the module, so the WeakSet check fails.
  const spliced = { ...a.result, seal: b.result.seal };
  assert.equal(isTrustedAnchorVerification(spliced), false);
  assert.equal(rebindTrustedResult(spliced as never), null);
});

test("nested observation data cannot be mutated after issuance", { skip: SEAL_BLOCKED }, async () => {
  const outcome = await genuine();
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const seal = outcome.result.seal;
  assert.equal(Object.isFrozen(seal), true);
  assert.equal(Object.isFrozen(seal.observation), true);
  assert.equal(Object.isFrozen(seal.observation.receipt), true);
  assert.equal(Object.isFrozen(seal.observation.receipt?.logs), true);
  assert.equal(Object.isFrozen(seal.observation.receipt?.logs[0]), true);
  assert.equal(Object.isFrozen(seal.observation.receipt?.logs[0].topics), true);
  assert.equal(Object.isFrozen(seal.finality), true);
  assert.equal(Object.isFrozen(outcome.result.binding), true);

  // Attempts throw in strict mode rather than silently changing what is represented.
  assert.throws(() => {
    (seal.observation as { transactionHash: string }).transactionHash = OTHER_TX;
  }, /read only|Cannot assign/i);
  assert.throws(() => {
    (seal.finality as { finalizedBlockNumber: string }).finalizedBlockNumber = "1";
  }, /read only|Cannot assign/i);
  assert.throws(() => {
    (seal.observation.receipt!.logs as unknown as unknown[]).push({});
  }, /not extensible|read only|Cannot add/i);

  // And the representation is unchanged.
  assert.equal(seal.observation.transactionHash, TX_HASH);
});

test("the binding is deeply frozen and deeply copied", { skip: SEAL_BLOCKED }, async () => {
  const outcome = await genuine();
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const { binding } = outcome.result;
  assert.equal(binding.transactionHash, TX_HASH);
  assert.equal(binding.chainId, String(CHAIN_ID));
  assert.equal(binding.registryAddress, REGISTRY);
  assert.equal(binding.evidenceId, EVIDENCE_ID);
  assert.equal(binding.payloadHash, PAYLOAD_HASH);
  assert.equal(binding.evidenceKind, 1);
  assert.equal(binding.sequence, "1");
  assert.equal(binding.previousPayloadHash, PREVIOUS_HASH);
  assert.equal(binding.receiptBlockNumber, String(RECEIPT_BLOCK));
  assert.equal(binding.receiptBlockHash, BLOCK_HASH);
  assert.equal(binding.attestor, ATTESTOR.toLowerCase());
  assert.equal(binding.finalizedBlockNumber, String(RECEIPT_BLOCK + 50));
  assert.equal(binding.runtimeBytecodeHash, RUNTIME_HASH);
  assert.equal(Object.isFrozen(binding), true);
});

test("rebindTrustedResult re-derives rather than trusting the stored binding", { skip: SEAL_BLOCKED }, async () => {
  const outcome = await genuine();
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const derived = rebindTrustedResult(outcome.result);
  assert.ok(derived);
  for (const key of Object.keys(derived) as (keyof typeof derived)[]) {
    assert.equal(derived[key], outcome.result.binding[key]);
  }
});

test("a result with a tampered binding is refused by rebindTrustedResult", { skip: SEAL_BLOCKED }, async () => {
  const outcome = await genuine();
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  // The result object is frozen, so a tamper attempt must fail rather than produce a
  // misleading object; verify both the freeze and that a hand-built variant carrying a
  // mismatched binding is not accepted.
  assert.throws(() => {
    (outcome.result.binding as { payloadHash: string }).payloadHash = hex32("tampered");
  }, /read only|Cannot assign/i);
  assert.equal(rebindTrustedResult({ ...outcome.result } as never), null);
});

test("a genuine pipeline result still succeeds end to end", { skip: SEAL_BLOCKED }, async () => {
  const outcome = await genuine();
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  if (!outcome.ok) return;
  assert.equal(isTrustedAnchorVerification(outcome.result), true);
  assert.equal(isTrustedObservedAnchor(outcome.result.seal), true);
  assert.equal(isAnchorEvaluationProof(outcome.result.proof), true);
  assert.equal(outcome.result.seal.finality.level, "finalized");
});

test("a reader whose observation names a different registry cannot authorize", async () => {
  // The transaction and receipt point somewhere other than the pinned Registry, so
  // acquisition fails before any binding is considered.
  const bad = world({
    eth_getTransactionByHash: {
      hash: TX_HASH,
      from: ATTESTOR,
      to: `0x${"99".repeat(20)}`,
    },
  });
  const outcome = await runTrustedVerification(readerFor(bad), EXPECTED, TX_HASH);
  assert.equal(outcome.ok, false);
});

test("an event for a different evidence id cannot authorize", async () => {
  // The provenance gate runs before any observation is read, so the caller observes
  // `READER_NOT_TRUSTED` rather than an evaluation failure. The evaluation-level
  // assertion lives in `trusted-pipeline.test.ts`, where the reader is driven directly.
  const outcome = await runTrustedVerification(
    readerFor(world({}, { evidenceId: hex32("different-evidence") })),
    EXPECTED,
    TX_HASH,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure, "READER_NOT_TRUSTED");
});
