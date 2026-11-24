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

export type EvidenceReadErrorCode =
  "PREFLIGHT_READ_FAILED" | "SNAPSHOT_READ_FAILED";

const READ_ERROR_MESSAGES: Readonly<Record<EvidenceReadErrorCode, string>> =
  Object.freeze({
    PREFLIGHT_READ_FAILED: "routing idempotency preflight failed",
    SNAPSHOT_READ_FAILED: "evidence preparation snapshot read failed",
  });

/** Fixed error boundary for short read-only orchestration database work. */
export class EvidenceReadError extends Error {
  readonly code: EvidenceReadErrorCode;

  constructor(code: EvidenceReadErrorCode) {
    super(READ_ERROR_MESSAGES[code]);
    this.name = "EvidenceReadError";
    this.code = code;
  }
}

/**
 * These describe known initial request state before preparation. They are not
 * final-candidate failures and therefore preserve the ordinary Routing API
 * semantics rather than reusing an evidence-staleness result.
 */
export type RoutingEligibilityErrorCode =
  "INVOICE_NOT_FOUND" | "INVALID_TRANSITION" | "QUOTE_EXPIRED_OR_MISSING";

const ELIGIBILITY_ERROR_MESSAGES: Readonly<
  Record<RoutingEligibilityErrorCode, string>
> = Object.freeze({
  INVOICE_NOT_FOUND: "routing invoice was not found",
  INVALID_TRANSITION: "routing invoice is not eligible for transition",
  QUOTE_EXPIRED_OR_MISSING: "routing quote is unavailable or expired",
});

export class RoutingEligibilityError extends Error {
  readonly code: RoutingEligibilityErrorCode;

  constructor(code: RoutingEligibilityErrorCode) {
    super(ELIGIBILITY_ERROR_MESSAGES[code]);
    this.name = "RoutingEligibilityError";
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
