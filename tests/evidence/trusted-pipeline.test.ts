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
import { evaluateTrustedObservation } from "../../src/server/evidence/trusted-reader";
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

/**
 * Drives the reader directly, bypassing the provenance gate.
 *
 * Review pass 3 removed operator issuance from production, so `runTrustedVerification`
 * now refuses every reader the suite can build. That gate is the subject of
 * `reader-capability.test.ts`. The tests below are about the *reader's* behaviour —
 * decoding, hash pinning, finality ordering, ABI validation — which is reachable
 * directly through `readAnchorObservation` and is the right level to assert it.
 *
 * Nothing here can authorize: the result is a reader result, not a
 * `TrustedAnchorVerification`.
 */
function acquire(w: Record<string, unknown>, hash = TX_HASH) {
  const reader = readerWith(w);
  return reader.readAnchorObservation({
    transactionHash: hash,
    registryAddress: REGISTRY,
  });
}

/**
 * Acquires through the reader, then runs the pure evaluator.
 *
 * The evaluator never authorized anything on its own — it produces an
 * `AnchorEvaluationResult`, which the confirmation boundary rejects with
 * `TRUSTED_PROVENANCE_REQUIRED`. Testing it directly is both reachable and exactly as
 * strong as before.
 */
async function evaluate(
  w: Record<string, unknown>,
  commitment: typeof EXPECTED = EXPECTED,
) {
  const acquired = await acquire(w);
  if (!acquired.ok) throw new Error(`reader failed: ${acquired.failure}`);
  return evaluateTrustedObservation(commitment, acquired);
}

// ------------------------------------------------------------------ happy path

test("the pipeline refuses every reader this suite can build", async () => {
  // Review pass 3 removed operator issuance from production, so there is no way for a
  // test to obtain an operator-scoped reader. This asserts the consequence directly
  // rather than pretending a happy path exists. The positive end-to-end path needs a
  // real reviewed deployment and is recorded as unexercised in the phase document.
  const outcome = await runTrustedVerification(
    readerWith(world()),
    EXPECTED,
    TX_HASH,
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failure, "READER_NOT_TRUSTED");
  assert.equal(isTrustedAnchorVerification(outcome), false);
  assert.equal(trusted(outcome), null);
});

test("the reader itself accepts a correct finalized observation", async () => {
  // The behaviour that used to be asserted through the pipeline, asserted where it now
  // lives. A reader result is not authority: it cannot confirm anything.
  const acquired = await acquire(world());
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  if (!acquired.ok) return;
  assert.equal(acquired.observation.chainId, String(CHAIN_ID));
  assert.equal(acquired.observation.transactionHash, TX_HASH);
  assert.equal(acquired.finality.level, "finalized");
  assert.equal(acquired.finality.receiptBlockNumber, String(RECEIPT_BLOCK));
  assert.equal(acquired.runtimeBytecodeHash, RUNTIME_HASH);
});

// ------------------------------------------------------------- reader failures

test("a wrong chain short-circuits before any transaction read", async () => {
  const reader = readerWith(world({ eth_chainId: quantity(1) }));
  // Baseline: the shared server accumulates calls across tests, so measure the
  // delta rather than the absolute count.
  const before = server.calls.length;
  const outcome = await reader.readAnchorObservation({
    transactionHash: TX_HASH,
    registryAddress: REGISTRY,
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure, "WRONG_CHAIN");
  const issued = server.calls.slice(before).map((c) => c.method);
  assert.deepEqual(issued, ["eth_chainId"]);
  assert.ok(!issued.includes("eth_getTransactionByHash"));
});

test("a pinned-hash mismatch prevents any proof", async () => {
  const outcome = await acquire(
    world({ eth_getCode: "0x6080604052348015600f57600080fd5b51" }),
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure, "REGISTRY_CODE_HASH_MISMATCH");
});

test("a non-finalized receipt prevents any proof", async () => {
  const outcome = await acquire(
    world({
        eth_getBlockByNumber: (call: RpcCall) =>
          call.params[0] === "finalized"
            ? { number: quantity(RECEIPT_BLOCK - 1), hash: hex32("finalized") }
            : { number: quantity(RECEIPT_BLOCK), hash: BLOCK_HASH },
    }),
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure, "RECEIPT_BLOCK_NOT_FINALIZED");
});

// -------------------------------------------------- evaluation-stage rejections

test("a commitment mismatch is reported as an evaluation rejection", async () => {
  const outcome = await evaluate(world(), { ...EXPECTED, payloadHash: hex32("other") });
  assert.equal(outcome.verified, false);
  if (outcome.verified) return;
  assert.equal(outcome.failure, "WRONG_PAYLOAD_HASH");
});

test("a wrong evidence id is an evaluation rejection", async () => {
  const outcome = await evaluate(world(), { ...EXPECTED, evidenceId: hex32("other") });
  assert.equal(outcome.verified, false);
  if (outcome.verified) return;
  assert.equal(outcome.failure, "WRONG_EVIDENCE_ID");
});

test("a reverted receipt is an evaluation rejection, not a proof", async () => {
  const w = world();
  w.eth_getTransactionReceipt = {
    ...(w.eth_getTransactionReceipt as Record<string, unknown>),
    status: "0x0",
  };
  const outcome = await evaluate(w);
  assert.equal(outcome.verified, false);
  if (outcome.verified) return;
  assert.equal(outcome.failure, "TRANSACTION_REVERTED");
});

test("an ambiguous event is an evaluation rejection", async () => {
  const w = world();
  w.eth_getTransactionReceipt = {
    ...(w.eth_getTransactionReceipt as Record<string, unknown>),
    logs: [log(), log()],
  };
  const outcome = await evaluate(w);
  assert.equal(outcome.verified, false);
  if (outcome.verified) return;
  assert.equal(outcome.failure, "EVENT_AMBIGUOUS");
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
  const outcome = await acquire(world({ eth_getTransactionByHash: null }), hex32("unknown"));
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
  // Review pass 2 renamed this to make the distinction explicit: the *requested*
  // hash is malformed, which is a different condition from a mismatch between the
  // requested hash and what the chain returned.
  assert.equal(outcome.failure, "TRANSACTION_HASH_MALFORMED");
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

// ---------------------------------------------------------------------------
// Review pass 2, finding 5: `admin()` ABI decoding
// ---------------------------------------------------------------------------

/** Builds an `admin()` return word from 24 padding chars + 40 address chars. */
function adminWord(padding: string, tail: string) {
  return `0x${padding}${tail}`;
}

test("a canonically padded admin() word is accepted", async () => {
  const outcome = await acquire(world());
  assert.equal(outcome.ok, true, "canonical encoding must be accepted");
});

test("nonzero padding with a correct trailing address is rejected", async () => {
  // The dangerous case: length is right (66 chars) and the trailing 20 bytes are the
  // expected administrator, so a decoder that simply takes the last 40 characters
  // would accept this. Only a padding check catches it.
  const tail = getAddress(ADMIN).slice(2);
  const outcome = await acquire(
    world({ eth_call: adminWord("0".repeat(23) + "1", tail) }),
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failure, "REGISTRY_ADMIN_INVALID");
});

test("fully nonzero padding is rejected", async () => {
  const outcome = await acquire(
    world({ eth_call: adminWord("f".repeat(24), getAddress(ADMIN).slice(2)) }),
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failure, "REGISTRY_ADMIN_INVALID");
});

test("a malformed-length admin() return is rejected", async () => {
  const cases = [
    "0x",
    `0x${"0".repeat(63)}`, // one char short
    adminWord("0".repeat(24), getAddress(ADMIN).slice(2).padEnd(41, "0")), // one char long
    `0x${"0".repeat(64)}`, // a full word of zeros
  ];
  for (const value of cases) {
    const outcome = await acquire(world({ eth_call: value }));
    assert.equal(outcome.ok, false, `accepted malformed admin word ${value.slice(0, 12)}…`);
    if (!outcome.ok)
      assert.equal(
        outcome.failure,
        "REGISTRY_ADMIN_INVALID",
        `wrong failure for ${value.slice(0, 12)}…`,
      );
  }
});

test("a zero administrator is rejected even though its padding is canonical", async () => {
  const outcome = await acquire(
    world({ eth_call: adminWord("0".repeat(24), "0".repeat(40)) }),
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failure, "REGISTRY_ADMIN_INVALID");
});

test("a different administrator is rejected as a mismatch", async () => {
  const other = `0x${"44".repeat(20)}`;
  const outcome = await acquire(
    world({ eth_call: adminWord("0".repeat(24), getAddress(other).slice(2)) }),
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failure, "REGISTRY_ADMIN_MISMATCH");
});

// ---------------------------------------------------------------------------
// Review pass 2, finding 3: the requested transaction hash is load-bearing
// ---------------------------------------------------------------------------

/**
 * Both the reader and the pipeline check that the chain answered about the requested
 * transaction. The reader checks first, so with a genuine reader its code is the one
 * observed; the pipeline's own check is a backstop for any future reader that omits
 * it. These tests therefore assert *rejection*, and that the rejection is for a hash
 * reason, rather than pretending to prove which of the two layers fired.
 */
test("a response about a different transaction is rejected", async () => {
  const otherTx = hex32("a-different-transaction");
  // The node answers every lookup with a different, internally consistent transaction.
  const outcome = await acquire(
      world({
        eth_getTransactionByHash: { hash: otherTx, from: ATTESTOR, to: REGISTRY },
        eth_getTransactionReceipt: {
          transactionHash: otherTx,
          status: "0x1",
          from: ATTESTOR,
          to: REGISTRY,
          blockNumber: quantity(RECEIPT_BLOCK),
          blockHash: BLOCK_HASH,
          logs: [log()],
        },
      }),
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok)
    assert.ok(
      ["TRANSACTION_MISMATCH", "TRANSACTION_MALFORMED"].includes(outcome.failure),
      `expected a hash rejection, got ${outcome.failure}`,
    );
});

test("a receipt naming a different transaction than the observation is rejected", async () => {
  const otherTx = hex32("receipt-of-another-transaction");
  // The transaction lookup is correct; only the receipt names another hash. This is
  // the split-brain case where a reader might otherwise accept the transaction's
  // finality but the receipt's contents.
  const outcome = await acquire(
      world({
        eth_getTransactionReceipt: {
          transactionHash: otherTx,
          status: "0x1",
          from: ATTESTOR,
          to: REGISTRY,
          blockNumber: quantity(RECEIPT_BLOCK),
          blockHash: BLOCK_HASH,
          logs: [log()],
        },
      }),
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok)
    // The reader rejects this as `RECEIPT_MALFORMED` because the receipt's hash
    // disagrees with the transaction it belongs to; the pipeline's own
    // `TRANSACTION_MISMATCH` is the backstop. Either is a rejection for the right
    // reason — the point is that a receipt for another transaction never authorizes.
    assert.ok(
      ["TRANSACTION_MISMATCH", "TRANSACTION_MALFORMED", "RECEIPT_MALFORMED"].includes(
        outcome.failure,
      ),
      `expected a hash rejection, got ${outcome.failure}`,
    );
});

test("a malformed requested hash is rejected before any network call", async () => {
  const malformed = [
    "",
    "0x",
    "not-a-hash",
    `0x${"a".repeat(63)}`,
    `0x${"a".repeat(65)}`,
    `0x${"00".repeat(32)}`, // zero hash
    `0x${"zz".repeat(32)}`, // non-hex
  ];
  for (const hash of malformed) {
    server.calls.length = 0;
    const outcome = await runTrustedVerification(readerWith(world()), EXPECTED, hash);
    assert.equal(outcome.ok, false, `accepted ${JSON.stringify(hash)}`);
    if (!outcome.ok)
      assert.equal(
        outcome.failure,
        "TRANSACTION_HASH_MALFORMED",
        `wrong failure for ${JSON.stringify(hash)}`,
      );
    assert.equal(server.calls.length, 0, `network touched for ${JSON.stringify(hash)}`);
  }
});

test("an uppercase requested hash is normalized, not rejected", async () => {
  // Review pass 2 asked for *normalization*: a checksummed hash names the same
  // transaction, so refusing it would be a usability bug.
  //
  // Review pass 3 removed operator issuance, so the pipeline can no longer reach a
  // successful outcome in tests. What remains observable is the *validation* decision,
  // which runs before the capability gate: an uppercase hash must be accepted as
  // well-formed (reaching `READER_NOT_TRUSTED`) rather than rejected as malformed.
  // The binding of the normalized value into a result is exercised at the reader level
  // by the transaction tests above, and is recorded as unexercised end-to-end.
  const outcome = await runTrustedVerification(
    readerWith(world()),
    EXPECTED,
    TX_HASH.toUpperCase().replace("0X", "0x"),
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok)
    assert.equal(
      outcome.failure,
      "READER_NOT_TRUSTED",
      "an uppercase hash must pass validation, not be treated as malformed",
    );
});

test("a registry mismatch is refused before any network call", async () => {
  // The registry comparison now lives inside the capability boundary, where it runs
  // after the provenance gate and before any I/O. Because no operator-scoped reader can
  // be constructed in this codebase, the gate fires first and the caller observes
  // `READER_NOT_TRUSTED`; the `REGISTRY_ADDRESS_MISMATCH` branch itself is unreachable
  // until a real deployment exists. What is asserted here — and holds regardless — is
  // that a mismatched commitment causes no network traffic at all.
  server.calls.length = 0;
  const outcome = await runTrustedVerification(
    readerWith(world()),
    { ...EXPECTED, registryAddress: `0x${"77".repeat(20)}` },
    TX_HASH,
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failure, "READER_NOT_TRUSTED");
  assert.equal(server.calls.length, 0);
});
