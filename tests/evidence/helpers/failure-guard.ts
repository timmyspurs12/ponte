/**
 * A tiny namespace check for confirmation failure codes.
 *
 * It exists so a test can assert that a string is a *known* failure code rather
 * than a typo, without importing the runtime module (which is `server-only`).
 */
export const ANCHOR_CONFIRMATION_FAILURES = Object.freeze([
  "TRUSTED_PROVENANCE_REQUIRED",
  "PROOF_REQUIRED",
  "COMMITMENT_MISMATCH",
  "OUTBOX_NOT_CONFIRMABLE",
  "CONFIRMATION_METADATA_INCONSISTENT",
  "CHAIN_READ_FAILED",
] as const);

export function isAnchorConfirmationFailure(value: string): boolean {
  return (ANCHOR_CONFIRMATION_FAILURES as readonly string[]).includes(value);
}
