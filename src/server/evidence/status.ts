// Deliberately public-commitment-only evidence status projection. This module
// never reads encrypted payload bytes, DEKs, nonces, AAD, or private evidence.
import "server-only";

import type {
  EvidenceAnchoringStatus,
  EvidenceOutboxSubmissionState,
  EvidenceProvenance,
  EvidenceProvider,
  InvoiceEvidenceStatus,
} from "../../lib/models";
import { fail } from "../errors";
import type { InvoiceEvidenceStatusRow } from "../repository";

/** Shared immutable default so no caller can render a mutable claim. */
const NOT_VERIFIED: EvidenceAnchoringStatus = Object.freeze({
  verified: false,
  status: "not_verified",
} as const);

const OUTBOX_STATES = new Set<EvidenceOutboxSubmissionState>([
  "pending",
  "submitted",
  "confirmed",
  "retryable",
  "failed",
  "reconciliation_required",
]);

function internalFailure(): never {
  return fail(500, "INTERNAL_ERROR");
}

function fixedHex(value: unknown, bytes: number): string {
  if (!Buffer.isBuffer(value) || value.length !== bytes)
    return internalFailure();
  return `0x${value.toString("hex")}`;
}

function positiveDecimal(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value))
    return internalFailure();
  return value;
}

function supportedProvider(value: unknown): EvidenceProvider {
  if (
    value === "local-test-only" ||
    value === "gcp-cloud-kms" ||
    value === "aws-kms"
  )
    return value;
  return internalFailure();
}

/**
 * Provider provenance is never treated as an anchoring assertion. In
 * particular, genuine GCP metadata can establish neither an RPC nor a registry
 * transaction, while local-test-only identifies synthetic non-KMS bytes.
 */
export function evidenceProvenance(value: unknown): EvidenceProvenance {
  switch (supportedProvider(value)) {
    case "local-test-only":
      return {
        provider: "local-test-only",
        category: "synthetic-local-test",
        disclosure:
          "Synthetic local-test bytes were used. No real cloud KMS operation occurred.",
      };
    case "gcp-cloud-kms":
      return {
        provider: "gcp-cloud-kms",
        category: "genuine-gcp-metadata",
        disclosure:
          "Genuine Google Cloud KMS provider metadata is recorded. It is not proof of registry anchoring.",
      };
    case "aws-kms":
      return {
        provider: "aws-kms",
        category: "genuine-aws-metadata",
        disclosure:
          "Genuine AWS KMS provider metadata is recorded. It is not proof of registry anchoring.",
      };
  }
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return internalFailure();
  return value;
}

function createdAt(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    return internalFailure();
  return value.toISOString();
}

function outboxState(value: unknown): EvidenceOutboxSubmissionState | null {
  if (value === null) return null;
  if (typeof value !== "string") return internalFailure();
  const state = value as EvidenceOutboxSubmissionState;
  if (!OUTBOX_STATES.has(state)) return internalFailure();
  return state;
}

/**
 * Converts one deliberately narrow SQL projection into the documented response.
 *
 * The anchoring claim is supplied by the caller and defaults to "not verified".
 * An operational outbox state, including `confirmed`, is never consulted here:
 * a row can only render as anchored when a caller passes the result of
 * `verifyAnchorObservation`, which requires a real receipt and a matching
 * Registry event. This keeps local preparation and on-chain anchoring distinct.
 */
export function invoiceEvidenceStatus(
  invoiceId: string,
  row: InvoiceEvidenceStatusRow | undefined,
  anchoring: EvidenceAnchoringStatus = NOT_VERIFIED,
): InvoiceEvidenceStatus {
  if (!row)
    return {
      state: "missing",
      invoiceId,
      evidence: null,
    };

  return {
    state: "persisted",
    invoiceId,
    evidence: {
      publicEvidenceId: fixedHex(row.public_evidence_id, 32),
      evidenceKind: integer(row.evidence_kind),
      evidenceSchemaVersion: integer(row.evidence_schema_version),
      chainId: positiveDecimal(row.chain_id),
      registryAddress: fixedHex(row.registry_address, 20),
      sequence: positiveDecimal(row.sequence),
      previousPayloadHash: fixedHex(row.previous_payload_hash, 32),
      payloadHash: fixedHex(row.payload_hash, 32),
      provenance: evidenceProvenance(row.kms_provider),
      createdAt: createdAt(row.created_at),
      outboxSubmissionState: outboxState(row.submission_state),
    },
    anchoring,
  };
}
