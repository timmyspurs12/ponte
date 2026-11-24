/**
 * Test-only bridge to the (test-scoped) configuration brand.
 *
 * Review pass 3 removed operator issuance from production `src/` entirely. There is no
 * longer any function anywhere — production or test — that produces a configuration the
 * trusted pipeline will accept. This bridge therefore mints **test-scoped** brands only,
 * which `runTrustedVerification` refuses by definition.
 *
 * ## What this means for the suite
 *
 * Readers built here can perform real RPC parsing against a loopback mock server: they
 * exercise transport, decoding, finality ordering and every rejection path. What they
 * cannot do is produce a `TrustedAnchorVerification`, because the provenance gate runs
 * before any observation is read.
 *
 * That is the intended consequence, not a gap to work around. The end-to-end positive
 * confirmation path requires a genuinely operator-pinned reader, which requires a real
 * reviewed deployment manifest, which does not exist yet. Those tests are recorded as
 * unexercised rather than faked — see `docs/PHASE2C2A_TRUSTED_ARBITRUM_READER.md`.
 */

import {
  __issueTestConfigForHarness,
  isNumericLoopbackHttpUrl,
  type TrustedReaderConfigResult,
} from "../../../src/server/evidence/trusted-reader-config";

/** A test-scoped configuration. Cannot authorize anything. */
export function issueTestConfig(input: unknown): TrustedReaderConfigResult {
  return __issueTestConfigForHarness(input);
}

/** Re-exported so loopback tests can exercise the real predicate. */
export { isNumericLoopbackHttpUrl };
