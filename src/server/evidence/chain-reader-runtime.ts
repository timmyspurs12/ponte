import "server-only";

import type { EvidenceChainReader } from "./anchor-verification";

/**
 * Runtime resolution of the evidence chain reader.
 *
 * This phase ships **no** implementation that performs network access, so the
 * resolver always returns `null` and the caller must treat every anchoring claim
 * as unverified. It exists now so the eventual production reader has exactly one
 * governed entry point, and so fakes cannot be selected by environment variable.
 *
 * There is deliberately no `PONTE_*` switch, feature flag, or test hook here.
 * A fake reader is constructed directly in a test and passed as an argument; it
 * can never be reached through the normal application runtime because nothing in
 * `src/` constructs one.
 */
export function resolveEvidenceChainReader(): EvidenceChainReader | null {
  return null;
}

/**
 * Describes why anchoring cannot be verified in this runtime, for operational
 * logs and documentation. Never surfaced to an API client as a claim.
 */
export function evidenceChainReaderUnavailableReason(): string {
  return "no on-chain reader is configured in this build; anchoring is not verified";
}
