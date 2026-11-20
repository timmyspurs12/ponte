import { ApiError } from "../errors";
import {
  EvidenceCandidatePreparationError,
  EvidencePersistenceError,
  type EvidenceCandidatePreparationErrorCode,
  type EvidencePersistenceErrorCode,
} from "./errors";

/**
 * Maps evidence-only internal errors to stable, non-sensitive API errors.
 * This boundary deliberately contains neither an original cause nor candidate,
 * envelope, provider, KMS, or SQL values. It is inert until a future caller
 * chooses to invoke evidence preparation/persistence.
 */
const preparationMappings: Readonly<
  Record<EvidenceCandidatePreparationErrorCode, readonly [number, string]>
> = Object.freeze({
  INVALID_INPUT: [409, "EVIDENCE_PREPARATION_STALE"],
  PROVIDER_FAILURE: [503, "EVIDENCE_PROVIDER_UNAVAILABLE"],
  PROVIDER_RESULT_INVALID: [500, "EVIDENCE_PROVIDER_RESULT_INVALID"],
  ENCRYPTION_FAILED: [500, "EVIDENCE_ENCRYPTION_FAILED"],
  PREPARATION_FAILED: [500, "EVIDENCE_PREPARATION_FAILED"],
});

const persistenceMappings: Readonly<
  Record<EvidencePersistenceErrorCode, readonly [number, string]>
> = Object.freeze({
  INVALID_CONTEXT: [500, "EVIDENCE_INTERNAL_CONTEXT_INVALID"],
  IDEMPOTENCY_CONFLICT: [409, "IDEMPOTENCY_CONFLICT"],
  FORBIDDEN: [403, "FORBIDDEN"],
  CANDIDATE_REQUIRED: [500, "EVIDENCE_INTERNAL_CONTEXT_INVALID"],
  CANDIDATE_INVALID: [500, "EVIDENCE_INTERNAL_CANDIDATE_INVALID"],
  CANDIDATE_MISMATCH: [409, "EVIDENCE_PREPARATION_STALE"],
  INVOICE_OR_QUOTE_UNAVAILABLE: [409, "QUOTE_EXPIRED_OR_MISSING"],
  COMMIT_OUTCOME_UNKNOWN: [503, "COMMIT_OUTCOME_UNKNOWN"],
  PERSISTENCE_FAILED: [500, "EVIDENCE_PERSISTENCE_FAILED"],
});

export function mapEvidenceError(error: unknown): ApiError | undefined {
  if (error instanceof EvidenceCandidatePreparationError) {
    const [status, code] = preparationMappings[error.code];
    return new ApiError(status, code);
  }
  if (error instanceof EvidencePersistenceError) {
    const [status, code] = persistenceMappings[error.code];
    return new ApiError(status, code);
  }
  return undefined;
}
