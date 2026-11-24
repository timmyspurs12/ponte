/**
 * Test-only bridge to the reader-configuration brand.
 *
 * Review pass 2 requires that test-only machinery not sit on the production
 * authorization surface. Production exposes one resolver, which takes no arguments and
 * always reports unavailable. This bridge is the only importer of the harness issuance
 * function, and it lives under `tests/`, so it is never bundled into the application.
 *
 * Two flavours, deliberately distinct:
 *
 * - `issueTestConfig`  → test-scoped reader. The pipeline refuses it outright.
 * - `issueHarnessOperatorConfig` → operator-scoped reader, used only by the backend
 *   suite to exercise `confirmVerifiedAnchor`'s positive path. Confined to tests by
 *   construction; `reader-capability.test.ts` asserts no `src/` module reaches it.
 */

import {
  __issueConfigForHarness,
  type TrustedReaderConfigResult,
} from "../../../src/server/evidence/trusted-reader-config";

/** A test-scoped configuration: cannot authorize. */
export function issueTestConfig(input: unknown): TrustedReaderConfigResult {
  return __issueConfigForHarness(input, false);
}

/**
 * An operator-scoped configuration for the confirmation-boundary tests.
 *
 * This is a deliberate, documented exception: the only way to test that a genuine
 * result confirms is to obtain one, and minting it requires an operator-scoped reader.
 * It is safe because nothing in `src/` can import this file.
 */
export function issueHarnessOperatorConfig(
  input: unknown,
): TrustedReaderConfigResult {
  return __issueConfigForHarness(input, true);
}
