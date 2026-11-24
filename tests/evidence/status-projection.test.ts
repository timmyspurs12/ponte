import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, id as keccakId, toBeHex, zeroPadValue } from "ethers";
import type { InvoiceEvidenceStatusRow } from "../../src/server/repository";
import { invoiceEvidenceStatus } from "../../src/server/evidence/status";
import {
  NOT_VERIFIED_ANCHORING,
  isAnchorEvaluationProof,
  evaluateAnchorObservation,
  type ChainObservation,
  type ExpectedAnchorCommitment,
} from "../../src/server/evidence/anchor-verification";

/**
 * Boundary tests for the presentation projection itself.
 *
 * `invoiceEvidenceStatus` must not accept a pre-built anchoring claim. These
 * tests attack that boundary directly rather than the helper it delegates to.
 * Everything is synthetic: no RPC, no wallet, no transaction.
 */

const REGISTRY = "0x1111111111111111111111111111111111111111";
const ATTESTOR = "0x3333333333333333333333333333333333333333";
const EVIDENCE_ID = `0x${"aa".repeat(32)}`;
const PAYLOAD_HASH = `0x${"bb".repeat(32)}`;
const PREVIOUS_HASH = `0x${"00".repeat(32)}`;
const TX_HASH = `0x${"cc".repeat(32)}`;
const BLOCK_HASH = `0x${"dd".repeat(32)}`;
const TOPIC = keccakId(
  "EvidenceAnchored(bytes32,bytes32,address,uint64,uint8,bytes32)",
);

const EXPECTED: ExpectedAnchorCommitment = {
  chainId: "421614",
  registryAddress: REGISTRY,
  evidenceId: EVIDENCE_ID,
  payloadHash: PAYLOAD_HASH,
  evidenceKind: 1,
  sequence: "1",
  previousPayloadHash: PREVIOUS_HASH,
};

function observation(): ChainObservation {
  return {
    chainId: "421614",
    transactionHash: TX_HASH,
    transactionFrom: ATTESTOR,
    transactionTo: REGISTRY,
    registryIdentity: "verified",
    receipt: {
      transactionHash: TX_HASH,
      status: "success",
      from: ATTESTOR,
      to: REGISTRY,
      blockNumber: "12345678",
      blockHash: BLOCK_HASH,
      logs: [
        {
          address: REGISTRY,
          topics: [
            TOPIC,
            EVIDENCE_ID,
            PAYLOAD_HASH,
            zeroPadValue(getAddress(ATTESTOR), 32),
          ],
          data: `0x${toBeHex(1n, 32).slice(2)}${toBeHex(1, 32).slice(2)}${PREVIOUS_HASH.slice(2)}`,
        },
      ],
    },
  };
}

/** A realistic persisted row, enough to exercise the projection. */
function row(
  overrides: Partial<InvoiceEvidenceStatusRow> = {},
): InvoiceEvidenceStatusRow {
  return {
    public_evidence_id: Buffer.from(EVIDENCE_ID.slice(2), "hex"),
    evidence_schema_version: 1,
    chain_id: "421614",
    registry_address: Buffer.from(REGISTRY.slice(2), "hex"),
    sequence: "1",
    evidence_kind: 1,
    previous_payload_hash: Buffer.from(PREVIOUS_HASH.slice(2), "hex"),
    payload_hash: Buffer.from(PAYLOAD_HASH.slice(2), "hex"),
    kms_provider: "local-test-only",
    created_at: new Date("2026-11-24T00:00:00.000Z"),
    submission_state: "submitted",
    ...overrides,
  };
}

function genuineProof() {
  const proof = evaluateAnchorObservation(EXPECTED, observation());
  assert.ok(isAnchorEvaluationProof(proof), "fixture must be a real proof");
  return proof;
}

test("defaults to not-verified when no candidate is supplied", () => {
  const status = invoiceEvidenceStatus("inv-1", row());
  assert.equal(status.state, "persisted");
  if (status.state !== "persisted") return;
  assert.deepEqual(status.anchoring, NOT_VERIFIED_ANCHORING);
});

test("an explicit null candidate stays not-verified", () => {
  const status = invoiceEvidenceStatus("inv-1", row(), null);
  if (status.state !== "persisted") return assert.fail("expected persisted");
  assert.deepEqual(status.anchoring, {
    verified: false,
    status: "not_verified",
  });
});

test("a genuine issued proof produces the verified projection", () => {
  const status = invoiceEvidenceStatus("inv-1", row(), genuineProof());
  if (status.state !== "persisted") return assert.fail("expected persisted");
  assert.equal(status.anchoring.verified, true);
  if (!status.anchoring.verified) return;
  assert.equal(status.anchoring.transactionHash, TX_HASH);
  assert.equal(status.anchoring.chainId, "421614");
  assert.equal(status.anchoring.registryAddress, REGISTRY);
  assert.equal(status.anchoring.blockNumber, "12345678");
  assert.equal(status.anchoring.attestor, ATTESTOR.toLowerCase());
});

test("a fabricated verified status object cannot reach the projection", () => {
  // This is the shape the old signature accepted as its third argument.
  const fabricatedStatuses: unknown[] = [
    { verified: true, status: "verified" },
    {
      verified: true,
      status: "verified",
      chainId: "421614",
      registryAddress: REGISTRY,
      transactionHash: TX_HASH,
      blockNumber: "12345678",
      blockHash: BLOCK_HASH,
      attestor: ATTESTOR,
    },
    Object.freeze({ verified: true, status: "verified" }),
  ];

  for (const fabricated of fabricatedStatuses) {
    const status = invoiceEvidenceStatus("inv-1", row(), fabricated);
    if (status.state !== "persisted") return assert.fail("expected persisted");
    assert.deepEqual(
      status.anchoring,
      NOT_VERIFIED_ANCHORING,
      "a fabricated status must project as not-verified",
    );
  }
});

test("a forged proof-shaped object cannot reach the projection", () => {
  const real = genuineProof();
  const forgeries: unknown[] = [
    { verified: true, status: "verified", facts: real.facts },
    { ...real },
    structuredClone(real),
    JSON.parse(
      JSON.stringify({ verified: true, status: "verified", facts: real.facts }),
    ),
    Object.create(Object.getPrototypeOf(real)),
  ];

  for (const forged of forgeries) {
    const status = invoiceEvidenceStatus("inv-1", row(), forged);
    if (status.state !== "persisted") return assert.fail("expected persisted");
    assert.deepEqual(status.anchoring, NOT_VERIFIED_ANCHORING);
  }
});

test("a confirmed outbox row without a proof does not render as anchored", () => {
  // The strongest case: an operator may see `confirmed` in the database, but the
  // projection must still stay unverified when no issued proof is supplied.
  const status = invoiceEvidenceStatus(
    "inv-1",
    row({ submission_state: "confirmed" }),
  );
  if (status.state !== "persisted") return assert.fail("expected persisted");
  assert.equal(status.evidence.outboxSubmissionState, "confirmed");
  assert.deepEqual(status.anchoring, NOT_VERIFIED_ANCHORING);
});

test("the projection does not leak fields on a missing row regardless of candidate", () => {
  for (const candidate of [
    null,
    undefined,
    genuineProof(),
    { verified: true },
  ]) {
    const status = invoiceEvidenceStatus("inv-1", undefined, candidate);
    assert.deepEqual(status, {
      state: "missing",
      invoiceId: "inv-1",
      evidence: null,
    });
  }
});

test("the verified projection is frozen and cannot be mutated downstream", () => {
  const status = invoiceEvidenceStatus("inv-1", row(), genuineProof());
  if (status.state !== "persisted") return assert.fail("expected persisted");
  assert.equal(Object.isFrozen(status.anchoring), true);
  assert.throws(() => {
    (status.anchoring as { verified: boolean }).verified = false;
  }, /read only|Cannot assign/i);
});

test("every primitive and array candidate is refused", () => {
  for (const candidate of [
    "proof",
    1,
    true,
    [],
    Symbol("x"),
    () => {},
    new Map(),
  ]) {
    const status = invoiceEvidenceStatus("inv-1", row(), candidate);
    if (status.state !== "persisted") return assert.fail("expected persisted");
    assert.deepEqual(status.anchoring, NOT_VERIFIED_ANCHORING);
  }
});
