import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getAddress, toBeHex, zeroPadValue } from "ethers";
import {
  EVIDENCE_ANCHORED_TOPIC,
  evaluateAnchorObservation,
  isAnchorEvaluationProof,
  type ExpectedAnchorCommitment,
} from "../../src/server/evidence/anchor-verification";
import { runTrustedVerification } from "../../src/server/evidence/trusted-authorization";
import {
  isTrustedAnchorVerification,
  type TrustedPipelineOutcome,
} from "../../src/server/evidence/trusted-authorization";
import type { TrustedEvidenceChainReader } from "../../src/server/evidence/trusted-reader";
import { createTestReader } from "./helpers/test-reader-factory";
import { isAnchorConfirmationFailure } from "./helpers/failure-guard";
import {
  hex32,
  keccakOf,
  quantity,
  startMockRpcServer,
  type MockRpcServer,
  type RpcCall,
} from "./helpers/mock-rpc-server";

/**
 * Pipeline tests (Phase 2C.2A).
 *
 * These assert the central security property of the phase: a result that
 * authorizes confirmation exists only when a real reader acquired a real
 * observation over a real transport. Synthetic data still reaches the evaluator,
 * but never becomes a `TrustedAnchorVerification`.
 */

const CHAIN_ID = 421614;
const REGISTRY = `0x${"11".repeat(20)}`;
const ADMIN = `0x${"22".repeat(20)}`;
const ATTESTOR = `0x${"33".repeat(20)}`;
const RUNTIME_CODE = "0x6080604052348015600f57600080fd5b50";
const RUNTIME_HASH = keccakOf(RUNTIME_CODE);
const TX_HASH = hex32("pipeline-transaction");
const BLOCK_HASH = hex32("pipeline-block");
const EVIDENCE_ID = hex32("pipeline-evidence");
const PAYLOAD_HASH = hex32("pipeline-payload");
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

const CONFIG = {
  rpcUrl: "http://127.0.0.1:1",
  timeoutMs: 5_000,
  registryAddress: REGISTRY,
  runtimeBytecodeHash: RUNTIME_HASH,
  administrator: ADMIN,
} as const;

function log() {
  return {
    address: REGISTRY,
    topics: [
      EVIDENCE_ANCHORED_TOPIC,
      EVIDENCE_ID,
      PAYLOAD_HASH,
      zeroPadValue(getAddress(ATTESTOR), 32),
    ],
    data: `0x${toBeHex(1n, 32).slice(2)}${toBeHex(1n, 32).slice(2)}${PREVIOUS_HASH.slice(2)}`,
  };
}

function world(overrides: Partial<Record<string, unknown>> = {}) {
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
      logs: [log()],
    },
    eth_getBlockByNumber: (call: RpcCall) =>
      call.params[0] === "finalized"
        ? { number: quantity(RECEIPT_BLOCK + 100), hash: hex32("finalized") }
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

function readerWith(w: Record<string, unknown>) {
  server.setHandler((call: RpcCall) => {
    const entry = w[call.method];
    if (entry === undefined)
      throw new Error(`method not stubbed: ${call.method}`);
    if (typeof entry === "function")
      return (entry as (c: RpcCall) => unknown)(call);
    return entry;
  });
  server.setRawResponder(null);
  return createTestReader({ ...CONFIG, rpcUrl: server.url });
}

function trusted(outcome: TrustedPipelineOutcome) {
  return outcome.ok ? outcome.result : null;
}

// ------------------------------------------------------------------ happy path

test("a correct finalized observation yields a trusted verification", async () => {
  const outcome = await runTrustedVerification(
    readerWith(world()),
    EXPECTED,
    TX_HASH,
  );
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const result = trusted(outcome);
  assert.ok(result);
  assert.equal(isTrustedAnchorVerification(result), true);
  assert.equal(isAnchorEvaluationProof(result.proof), true);
  // The seal records the finality the reader observed.
  assert.equal(result.seal.finality.level, "finalized");
  assert.equal(result.seal.finality.receiptBlockNumber, String(RECEIPT_BLOCK));
  assert.equal(result.seal.registryAddress, REGISTRY);
  assert.equal(result.seal.transactionHash, TX_HASH);
});

test("the pipeline result is frozen", async () => {
  const outcome = await runTrustedVerification(
    readerWith(world()),
    EXPECTED,
    TX_HASH,
  );
  const result = trusted(outcome);
  assert.ok(result);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.seal), true);
});

// ------------------------------------------------------------- reader failures

test("a wrong chain short-circuits before any transaction read", async () => {
  const reader = readerWith(world({ eth_chainId: quantity(1) }));
  // Baseline: the shared server accumulates calls across tests, so measure the
  // delta rather than the absolute count.
  const before = server.calls.length;
  const outcome = await runTrustedVerification(reader, EXPECTED, TX_HASH);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure, "WRONG_CHAIN");
  const issued = server.calls.slice(before).map((c) => c.method);
  assert.deepEqual(issued, ["eth_chainId"]);
  assert.ok(!issued.includes("eth_getTransactionByHash"));
});

test("a pinned-hash mismatch prevents any proof", async () => {
  const outcome = await runTrustedVerification(
    readerWith(world({ eth_getCode: "0x6080604052348015600f57600080fd5b51" })),
    EXPECTED,
    TX_HASH,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure, "REGISTRY_CODE_HASH_MISMATCH");
});

test("a non-finalized receipt prevents any proof", async () => {
  const outcome = await runTrustedVerification(
    readerWith(
      world({
        eth_getBlockByNumber: (call: RpcCall) =>
          call.params[0] === "finalized"
            ? { number: quantity(RECEIPT_BLOCK - 1), hash: hex32("finalized") }
            : { number: quantity(RECEIPT_BLOCK), hash: BLOCK_HASH },
      }),
    ),
    EXPECTED,
    TX_HASH,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure, "RECEIPT_BLOCK_NOT_FINALIZED");
});

// -------------------------------------------------- evaluation-stage rejections

test("a commitment mismatch is reported as an evaluation rejection", async () => {
  const outcome = await runTrustedVerification(
    readerWith(world()),
    { ...EXPECTED, payloadHash: hex32("other") },
    TX_HASH,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure, "EVALUATION_REJECTED");
  assert.equal(outcome.evaluationFailure, "WRONG_PAYLOAD_HASH");
});

test("a wrong evidence id is an evaluation rejection", async () => {
  const outcome = await runTrustedVerification(
    readerWith(world()),
    { ...EXPECTED, evidenceId: hex32("other") },
    TX_HASH,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.evaluationFailure, "WRONG_EVIDENCE_ID");
});

test("a reverted receipt is an evaluation rejection, not a proof", async () => {
  const w = world();
  w.eth_getTransactionReceipt = {
    ...(w.eth_getTransactionReceipt as Record<string, unknown>),
    status: "0x0",
  };
  const outcome = await runTrustedVerification(
    readerWith(w),
    EXPECTED,
    TX_HASH,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.evaluationFailure, "TRANSACTION_REVERTED");
});

test("an ambiguous event is an evaluation rejection", async () => {
  const w = world();
  w.eth_getTransactionReceipt = {
    ...(w.eth_getTransactionReceipt as Record<string, unknown>),
    logs: [log(), log()],
  };
  const outcome = await runTrustedVerification(
    readerWith(w),
    EXPECTED,
    TX_HASH,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.evaluationFailure, "EVENT_AMBIGUOUS");
});

// ------------------------------------- fabricated inputs cannot reach the seal

test("synthetic observations can be evaluated but never authorized", () => {
  // This mirrors the existing 2C.1 forgery battery: the evaluator still says yes.
  const forged = {
    chainId: String(CHAIN_ID),
    transactionHash: TX_HASH,
    transactionFrom: ATTESTOR,
    transactionTo: REGISTRY,
    receipt: {
      transactionHash: TX_HASH,
      status: "success" as const,
      from: ATTESTOR,
      to: REGISTRY,
      blockNumber: String(RECEIPT_BLOCK),
      blockHash: BLOCK_HASH,
      logs: [log()],
    },
    registryIdentity: "verified" as const,
  };
  const evaluated = evaluateAnchorObservation(EXPECTED, forged);
  assert.equal(isAnchorEvaluationProof(evaluated), true);
  // ... and that is all. It is not a trusted verification.
  assert.equal(isTrustedAnchorVerification(evaluated), false);
  assert.equal(isTrustedAnchorVerification({ ...evaluated, seal: {} }), false);
});

test("a fabricated reader object is rejected by the pipeline", async () => {
  const fakeReader = {
    readAnchorObservation: async () => ({
      ok: true,
      observation: {},
      finality: { level: "finalized" },
      runtimeBytecodeHash: RUNTIME_HASH,
    }),
  };
  // The pipeline requires the class; a structural imitation fails at runtime.
  const outcome = await runTrustedVerification(
    fakeReader as unknown as TrustedEvidenceChainReader,
    EXPECTED,
    TX_HASH,
  );
  assert.equal(outcome.ok, false);
});

test("a fabricated outcome object is not a trusted verification", () => {
  assert.equal(isTrustedAnchorVerification({ ok: true, result: {} }), false);
  assert.equal(isTrustedAnchorVerification({ ok: true }), false);
  assert.equal(
    isTrustedAnchorVerification({
      verified: true,
      status: "verified",
      proof: {},
      seal: {},
    }),
    false,
  );
});

test("an unknown transaction hash yields no proof", async () => {
  const outcome = await runTrustedVerification(
    readerWith(world({ eth_getTransactionByHash: null })),
    EXPECTED,
    hex32("unknown"),
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure, "TRANSACTION_MISSING");
});

test("a zero transaction hash is refused before the pipeline touches the network", async () => {
  server.calls.length = 0;
  const outcome = await runTrustedVerification(
    readerWith(world()),
    EXPECTED,
    `0x${"00".repeat(32)}`,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure, "TRANSACTION_MALFORMED");
  assert.equal(server.calls.length, 0);
});

test("failure guard helper is consistent", () => {
  // Sanity check for the local helper used above.
  assert.equal(
    isAnchorConfirmationFailure("TRUSTED_PROVENANCE_REQUIRED"),
    true,
  );
  assert.equal(isAnchorConfirmationFailure("NOT_A_REAL_FAILURE"), false);
});
