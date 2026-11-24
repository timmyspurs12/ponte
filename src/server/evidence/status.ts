// Deliberately public-commitment-only evidence status projection. This module
// never reads encrypted payload bytes, DEKs, nonces, AAD, or private evidence.
import "server-only";

import type {
  EvidenceOutboxSubmissionState,
  EvidenceProvenance,
  EvidenceProvider,
  InvoiceEvidenceStatus,
} from "../../lib/models";
import { anchoringStatusFor } from "./anchor-verification";
import { fail } from "../errors";
import type { InvoiceEvidenceStatusRow } from "../repository";

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
 * The anchoring claim is **derived here**, not accepted from the caller. The
 * third parameter is an untrusted candidate — a value that may or may not be a
 * proof issued by `verifyAnchorObservation` — and it is passed straight to
 * `anchoringStatusFor()`, which returns the frozen not-verified claim for
 * anything it did not issue.
 *
 * A caller therefore cannot render an anchoring claim by supplying a pre-built
 * `EvidenceAnchoringStatus`, a `{ verified: true }` object, a spread copy, a
 * JSON round-trip or a `structuredClone`. There is no parameter whose type
 * accepts an already-constructed verified status.
 *
 * An operational outbox state, including `confirmed`, is never consulted here.
 */
export function invoiceEvidenceStatus(
  invoiceId: string,
  row: InvoiceEvidenceStatusRow | undefined,
  proofCandidate: unknown = null,
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
    // Derived from the untrusted candidate inside this boundary.
    anchoring: anchoringStatusFor(proofCandidate),
  };
}
