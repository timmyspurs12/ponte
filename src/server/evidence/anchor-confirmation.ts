import "server-only";

import type { PoolClient } from "pg";
import {
  ARBITRUM_SEPOLIA_CHAIN_ID,
  commitmentDigest,
  isAnchorVerificationProof,
  verifyAnchorObservation,
} from "./anchor-verification";
import type {
  AnchorVerificationFailure,
  AnchorVerificationProof,
  AnchorVerificationResult,
  EvidenceChainReader,
  ExpectedAnchorCommitment,
} from "./anchor-verification";

/**
 * The confirmed-state boundary for `evidence_outbox`.
 *
 * `submission_state = 'confirmed'` may only be written after a receipt has been
 * independently verified. That rule is enforced in three places, deliberately:
 *
 * 1. This module offers exactly one confirmation entry point, and it takes a
 *    verification *result* that the caller obtained from a chain reader — not a
 *    transaction hash, and not a caller-supplied receipt.
 * 2. The SQL update carries `submission_state = 'submitted'` in its own WHERE
 *    clause, so a row can only transition submitted -> confirmed, never
 *    pending -> confirmed, and a repeated attempt matches zero rows.
 * 3. The update also requires the persisted commitment to still equal the
 *    commitment that was verified, so an evidence row cannot be confirmed
 *    against a receipt that proves something else.
 */

export type AnchorConfirmationFailure =
  | AnchorVerificationFailure
  | "CHAIN_READ_FAILED"
  | "OUTBOX_NOT_CONFIRMABLE"
  | "PROOF_REQUIRED"
  | "COMMITMENT_MISMATCH"
  | "CONFIRMATION_METADATA_INCONSISTENT";

export type AnchorConfirmationOutcome =
  | {
      readonly confirmed: true;
      readonly transactionHash: string;
      /** Digest binding this confirmation to one exact evidence commitment. */
      readonly commitmentDigest: string;
    }
  | { readonly confirmed: false; readonly failure: AnchorConfirmationFailure };

export interface ConfirmableOutboxRow {
  readonly outboxId: string;
  readonly evidenceRecordId: string;
  readonly submissionState: string;
  readonly chainId: string;
  readonly registryAddress: string;
  readonly evidenceId: string;
  readonly payloadHash: string;
  readonly evidenceKind: number;
  readonly sequence: string;
  readonly previousPayloadHash: string;
}

/** Reads the persisted outbox row plus its evidence commitment, without locking. */
export async function readConfirmableOutboxRow(
  db: PoolClient,
  outboxId: string,
): Promise<ConfirmableOutboxRow | null> {
  const result = await db.query<{
    outbox_id: string;
    evidence_record_id: string;
    submission_state: string;
    chain_id: string;
    registry_address: Buffer;
    public_evidence_id: Buffer;
    payload_hash: Buffer;
    evidence_kind: number;
    sequence: string;
    previous_payload_hash: Buffer;
  }>(
    `SELECT o.id AS outbox_id,
            o.evidence_record_id,
            o.submission_state,
            e.chain_id,
            e.registry_address,
            e.public_evidence_id,
            e.payload_hash,
            e.evidence_kind,
            e.sequence,
            e.previous_payload_hash
       FROM evidence_outbox o
       JOIN route_decision_evidence e ON e.id = o.evidence_record_id
      WHERE o.id = $1`,
    [outboxId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    outboxId: row.outbox_id,
    evidenceRecordId: row.evidence_record_id,
    submissionState: row.submission_state,
    chainId: row.chain_id,
    registryAddress: `0x${row.registry_address.toString("hex")}`,
    evidenceId: `0x${row.public_evidence_id.toString("hex")}`,
    payloadHash: `0x${row.payload_hash.toString("hex")}`,
    evidenceKind: row.evidence_kind,
    sequence: row.sequence,
    previousPayloadHash: `0x${row.previous_payload_hash.toString("hex")}`,
  };
}

export function commitmentFromRow(
  row: ConfirmableOutboxRow,
): ExpectedAnchorCommitment {
  return {
    chainId: row.chainId,
    registryAddress: row.registryAddress,
    evidenceId: row.evidenceId,
    payloadHash: row.payloadHash,
    evidenceKind: row.evidenceKind,
    sequence: row.sequence,
    previousPayloadHash: row.previousPayloadHash,
  };
}

/**
 * Reads the chain through the supplied reader and verifies the observation.
 *
 * The reader is not authenticated here: a caller can pass any implementation, and
 * in this offline phase a fabricated observation yields a proof of the check, not
 * of the chain. Phase 2C.2 replaces this with a single reviewed reader that derives
 * `registryIdentity` from independently pinned bytecode.
 *
 * A reader failure is mapped to a non-confirming outcome rather than an
 * exception, so a transient RPC error can never be mistaken for success.
 */
export async function verifyOutboxAgainstChain(
  reader: EvidenceChainReader,
  row: ConfirmableOutboxRow,
  transactionHash: string,
): Promise<AnchorVerificationResult> {
  const expected = commitmentFromRow(row);
  let observation;
  try {
    observation = await reader.readAnchorObservation({
      transactionHash,
      registryAddress: expected.registryAddress,
    });
  } catch {
    return {
      verified: false,
      status: "not_verified",
      failure: "NO_OBSERVATION",
    };
  }
  // A reader must not be able to answer with a different — even individually
  // valid — transaction and have it represented as verification of the one we
  // asked about. `verifyAnchorObservation` also compares the receipt hash, but
  // the check is asserted here so the request itself is pinned.
  if (
    typeof observation?.transactionHash !== "string" ||
    observation.transactionHash.toLowerCase() !== transactionHash.toLowerCase()
  )
    return {
      verified: false,
      status: "not_verified",
      failure: "RECEIPT_TRANSACTION_MISMATCH",
    };
  return verifyAnchorObservation(expected, observation);
}

/**
 * Confirms an outbox row, but only from an issued verification proof.
 *
 * The parameter type is the proof class, and it is checked again at runtime, so a
 * caller cannot pass a hand-built `{ verified: true }` object, a spread copy, a
 * JSON round-trip, or a prototype imitation. Only `verifyAnchorObservation` can
 * mint a proof.
 *
 * The commitment comparisons are also pushed into the authoritative `UPDATE`, so
 * the write itself is bound to the exact transaction hash, chain, registry,
 * evidence id, payload hash, evidence kind, sequence and previous payload hash.
 * A proof obtained for a different evidence record therefore cannot confirm this
 * row, even if an earlier in-memory read were stale or wrong.
 */
export async function confirmVerifiedAnchor(
  db: PoolClient,
  row: ConfirmableOutboxRow,
  proof: AnchorVerificationProof,
  now: Date,
): Promise<AnchorConfirmationOutcome> {
  if (!isAnchorVerificationProof(proof))
    return { confirmed: false, failure: "PROOF_REQUIRED" };

  const facts = proof.facts;
  const committed = facts.commitment;

  // Compare the proof's OWN commitment — captured inside the verification
  // pipeline — against the persisted row. Nothing the caller passes can widen or
  // redirect this binding, so a proof minted for another evidence record cannot
  // be married to this one.
  if (
    committed.chainId !== row.chainId ||
    committed.registryAddress !== row.registryAddress.toLowerCase() ||
    committed.evidenceId !== row.evidenceId.toLowerCase() ||
    committed.payloadHash !== row.payloadHash.toLowerCase() ||
    committed.evidenceKind !== row.evidenceKind ||
    committed.sequence !== row.sequence ||
    committed.previousPayloadHash !== row.previousPayloadHash.toLowerCase()
  )
    return { confirmed: false, failure: "COMMITMENT_MISMATCH" };

  if (row.submissionState !== "submitted")
    return { confirmed: false, failure: "OUTBOX_NOT_CONFIRMABLE" };
  if (row.chainId !== ARBITRUM_SEPOLIA_CHAIN_ID.toString())
    return { confirmed: false, failure: "COMMITMENT_MISMATCH" };
  if (
    facts.chainId !== row.chainId ||
    facts.registryAddress !== row.registryAddress.toLowerCase()
  )
    return { confirmed: false, failure: "COMMITMENT_MISMATCH" };
  if (!now || !Number.isFinite(now.getTime()))
    return { confirmed: false, failure: "CONFIRMATION_METADATA_INCONSISTENT" };

  // Every commitment field is compared against the persisted evidence row inside
  // the write itself. The `WHERE` cannot succeed unless the proof's transaction,
  // chain and registry, and the committed evidence id, payload hash, kind,
  // sequence and previous hash all agree with what is stored.
  const result = await db.query(
    `UPDATE evidence_outbox o
        SET submission_state = 'confirmed',
            transaction_hash = $2,
            confirmed_at = $3,
            confirmed_block_number = $4,
            confirmed_block_hash = $5,
            attestor_address = $6,
            last_failure_class = NULL,
            last_failure_at = NULL
       FROM route_decision_evidence e
      WHERE o.id = $1
        AND e.id = o.evidence_record_id
        AND o.submission_state = 'submitted'
        AND o.transaction_hash = $2
        AND e.chain_id = $7
        AND e.registry_address = $8
        AND e.public_evidence_id = $9
        AND e.payload_hash = $10
        AND e.evidence_kind = $11
        AND e.sequence = $12
        AND e.previous_payload_hash = $13`,
    [
      row.outboxId,
      Buffer.from(facts.transactionHash.slice(2), "hex"),
      now,
      facts.blockNumber,
      Buffer.from(facts.blockHash.slice(2), "hex"),
      Buffer.from(facts.attestor.slice(2), "hex"),
      committed.chainId,
      Buffer.from(committed.registryAddress.slice(2), "hex"),
      Buffer.from(committed.evidenceId.slice(2), "hex"),
      Buffer.from(committed.payloadHash.slice(2), "hex"),
      committed.evidenceKind,
      committed.sequence,
      Buffer.from(committed.previousPayloadHash.slice(2), "hex"),
    ],
  );
  if (result.rowCount !== 1)
    return { confirmed: false, failure: "OUTBOX_NOT_CONFIRMABLE" };
  const digest = commitmentDigest(facts);
  return {
    confirmed: true,
    transactionHash: facts.transactionHash,
    commitmentDigest: digest,
  };
}
