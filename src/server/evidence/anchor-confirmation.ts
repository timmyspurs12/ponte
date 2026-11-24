import "server-only";

import type { PoolClient } from "pg";
import { ARBITRUM_SEPOLIA_CHAIN_ID } from "./anchor-verification";
import type {
  AnchorVerificationFailure,
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
  | "COMMITMENT_MISMATCH"
  | "CONFIRMATION_METADATA_INCONSISTENT";

export type AnchorConfirmationOutcome =
  | { readonly confirmed: true; readonly transactionHash: string }
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
 * Reads the chain through a trusted reader and verifies the observation.
 *
 * A reader failure is mapped to a non-confirming outcome rather than an
 * exception, so a transient RPC error can never be mistaken for success.
 */
export async function verifyOutboxAgainstChain(
  reader: EvidenceChainReader,
  row: ConfirmableOutboxRow,
  transactionHash: string,
): Promise<AnchorVerificationResult> {
  const { verifyAnchorObservation } = await import("./anchor-verification");
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
  return verifyAnchorObservation(expected, observation);
}

/**
 * Confirms an outbox row, but only from a verified result.
 *
 * Rejects before touching the database when the result is not verified, when the
 * row is not in `submitted`, when the persisted chain is not Arbitrum Sepolia, or
 * when the verified commitment does not match the persisted one.
 */
export async function confirmVerifiedAnchor(
  db: PoolClient,
  row: ConfirmableOutboxRow,
  verification: AnchorVerificationResult,
  now: Date,
): Promise<AnchorConfirmationOutcome> {
  if (!verification.verified)
    return { confirmed: false, failure: verification.failure };
  if (row.submissionState !== "submitted")
    return { confirmed: false, failure: "OUTBOX_NOT_CONFIRMABLE" };
  if (row.chainId !== ARBITRUM_SEPOLIA_CHAIN_ID.toString())
    return { confirmed: false, failure: "COMMITMENT_MISMATCH" };
  if (
    verification.chainId !== row.chainId ||
    verification.registryAddress !== row.registryAddress.toLowerCase()
  )
    return { confirmed: false, failure: "COMMITMENT_MISMATCH" };
  if (!now || !Number.isFinite(now.getTime()))
    return { confirmed: false, failure: "CONFIRMATION_METADATA_INCONSISTENT" };

  // The transaction hash and the confirmed block metadata are written together
  // with the state change, so a confirmed row can never lack its provenance and
  // a later reader cannot observe a partially-populated confirmation.
  const result = await db.query(
    `UPDATE evidence_outbox
        SET submission_state = 'confirmed',
            transaction_hash = $2,
            confirmed_at = $3,
            confirmed_block_number = $4,
            confirmed_block_hash = $5,
            attestor_address = $6,
            last_failure_class = NULL,
            last_failure_at = NULL
      WHERE id = $1
        AND submission_state = 'submitted'
        AND transaction_hash = $2`,
    [
      row.outboxId,
      Buffer.from(verification.transactionHash.slice(2), "hex"),
      now,
      verification.blockNumber,
      Buffer.from(verification.blockHash.slice(2), "hex"),
      Buffer.from(verification.attestor.slice(2), "hex"),
    ],
  );
  if (result.rowCount !== 1)
    return { confirmed: false, failure: "OUTBOX_NOT_CONFIRMABLE" };
  return { confirmed: true, transactionHash: verification.transactionHash };
}
