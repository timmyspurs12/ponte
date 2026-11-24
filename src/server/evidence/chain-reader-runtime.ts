import "server-only";

import { TrustedEvidenceChainReader } from "./trusted-reader";
import {
  resolveTrustedReaderConfig,
  type TrustedReaderConfigResult,
} from "./trusted-reader-config";

/**
 * Runtime resolution of the evidence chain reader (Phase 2C.2A).
 *
 * ## This returns `null` in the current repository, on purpose
 *
 * No real Registry deployment manifest exists yet. Without one there is no pinned
 * Registry address and no pinned runtime bytecode hash, so a reader could only be
 * built from placeholders — and a reader built from placeholders would silently
 * "verify" whatever an operator pointed it at. The resolver therefore returns `null`
 * and every anchoring claim stays unverified.
 *
 * ## No switch, no bypass
 *
 * There is deliberately no `PONTE_*` environment variable, feature flag, or test
 * hook that can enable a reader here. A test constructs `TrustedEvidenceChainReader`
 * directly against an in-process mock server; nothing in `src/` constructs a fake,
 * and no request field can reach this function. That is what makes "no production
 * reader" a property of the code rather than of configuration hygiene.
 *
 * When a reviewed manifest exists, it is supplied to `resolveTrustedReaderConfig`
 * in exactly one place — here — and the rest of the system needs no change.
 */
export function resolveEvidenceChainReader(): TrustedEvidenceChainReader | null {
  return resolveTrustedEvidenceReader();
}

/**
 * Resolves the trusted reader, or `null` when no pinned deployment exists.
 *
 * `pinnedConfig` exists so a future phase (or a test) can supply an operator-pinned
 * manifest object. In production the argument is omitted and comes from server-side
 * configuration only.
 */
export function resolveTrustedEvidenceReader(
  pinnedConfig?: unknown,
): TrustedEvidenceChainReader | null {
  const resolved: TrustedReaderConfigResult =
    resolveTrustedReaderConfig(pinnedConfig);
  if (!resolved.ok) return null;
  return new TrustedEvidenceChainReader(resolved.config);
}

/**
 * Describes why anchoring cannot be verified in this runtime, for operational logs
 * and documentation. Never surfaced to an API client as a claim.
 */
export function evidenceChainReaderUnavailableReason(): string {
  return "no pinned Registry deployment manifest is configured; no reader is enabled and anchoring is not verified";
}
