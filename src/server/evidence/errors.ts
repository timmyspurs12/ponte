/**
 * Fixed, non-sensitive evidence error types shared by preparation, final
 * persistence, and the HTTP error boundary. Keeping these types separate
 * prevents the ordinary API route from importing candidate/persistence logic.
 */
export type EvidenceCandidatePreparationErrorCode =
  | "INVALID_INPUT"
  | "PROVIDER_FAILURE"
  | "PROVIDER_RESULT_INVALID"
  | "ENCRYPTION_FAILED"
  | "PREPARATION_FAILED";

const PREPARATION_ERROR_MESSAGES: Readonly<
  Record<EvidenceCandidatePreparationErrorCode, string>
> = Object.freeze({
  INVALID_INPUT: "evidence candidate input is invalid",
  PROVIDER_FAILURE: "evidence candidate provider operation failed",
  PROVIDER_RESULT_INVALID: "evidence candidate provider result is invalid",
  ENCRYPTION_FAILED: "evidence candidate encryption failed",
  PREPARATION_FAILED: "evidence candidate preparation failed",
});

export class EvidenceCandidatePreparationError extends Error {
  readonly code: EvidenceCandidatePreparationErrorCode;

  constructor(code: EvidenceCandidatePreparationErrorCode) {
    super(PREPARATION_ERROR_MESSAGES[code]);
    this.name = "EvidenceCandidatePreparationError";
    this.code = code;
  }
}

export type EvidencePersistenceErrorCode =
  | "INVALID_CONTEXT"
  | "IDEMPOTENCY_CONFLICT"
  | "FORBIDDEN"
  | "CANDIDATE_REQUIRED"
  | "CANDIDATE_INVALID"
  | "CANDIDATE_MISMATCH"
  | "INVOICE_OR_QUOTE_UNAVAILABLE"
  | "COMMIT_OUTCOME_UNKNOWN"
  | "PERSISTENCE_FAILED";

const PERSISTENCE_ERROR_MESSAGES: Readonly<
  Record<EvidencePersistenceErrorCode, string>
> = Object.freeze({
  INVALID_CONTEXT: "evidence persistence context is invalid",
  IDEMPOTENCY_CONFLICT: "idempotency key conflicts with an existing request",
  FORBIDDEN: "evidence persistence is not authorized",
  CANDIDATE_REQUIRED: "prepared evidence candidate is required",
  CANDIDATE_INVALID: "prepared evidence candidate is invalid",
  CANDIDATE_MISMATCH:
    "prepared evidence candidate no longer matches persisted state",
  INVOICE_OR_QUOTE_UNAVAILABLE:
    "invoice or quote is unavailable for evidence persistence",
  COMMIT_OUTCOME_UNKNOWN: "evidence persistence commit outcome is unknown",
  PERSISTENCE_FAILED: "evidence persistence failed",
});

export class EvidencePersistenceError extends Error {
  readonly code: EvidencePersistenceErrorCode;

  constructor(code: EvidencePersistenceErrorCode) {
    super(PERSISTENCE_ERROR_MESSAGES[code]);
    this.name = "EvidencePersistenceError";
    this.code = code;
  }
}
