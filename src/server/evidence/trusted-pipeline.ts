/**
 * The trusted verification pipeline (Phase 2C.2A).
 *
 * This module is the seam between "a reader obtained something" and "a
 * confirmation-authorizing result exists". It is the **only** caller of
 * `sealTrustedObservation`, and therefore the only way a seal can come into
 * existence.
 *
 * The pipeline is deliberately tiny and synchronous in shape:
 *
 *   reader (network, identity, finality)
 *     -> evaluateTrustedObservation (pure checks)
 *       -> sealTrustedObservation (marks provenance)
 *         -> TrustedAnchorVerification
 *
 * Separation of concerns, restated because it is the point of the phase:
 *
 * - **Evaluation** answers "does this observation match this commitment?" It is
 *   pure and testable with synthetic data. On its own it proves only that.
 * - **Acquisition** answers "did a configured server-side reader actually observe
 *   this chain state, at finalized finality, from a verified Registry?" It needs
 *   the network and is therefore the untrusted-input-consuming half.
 * - **Issuance** of a confirmation-authorizing result requires both. A caller that
 *   can construct observations can at most obtain an evaluation; it cannot obtain a
 *   `TrustedAnchorVerification`, so it cannot confirm.
 */

import "server-only";

import {
  isAnchorEvaluationProof,
  type AnchorNotVerified,
  type ExpectedAnchorCommitment,
} from "./anchor-verification";
import {
  createTrustedAnchorVerification,
  sealTrustedObservation,
  type TrustedAnchorVerification,
} from "./trusted-seal";
import {
  evaluateTrustedObservation,
  type TrustedEvidenceChainReader,
  type TrustedReaderFailure,
} from "./trusted-reader";

export type TrustedPipelineFailure =
  TrustedReaderFailure | "EVALUATION_REJECTED";

export type TrustedPipelineOutcome =
  | { readonly ok: true; readonly result: TrustedAnchorVerification }
  | {
      readonly ok: false;
      readonly failure: TrustedPipelineFailure;
      /** Present when the reader succeeded but the pure evaluator refused. */
      readonly evaluationFailure?: AnchorNotVerified["failure"];
    };

/**
 * Runs the full trusted pipeline.
 *
 * The `reader` parameter is typed as `TrustedEvidenceChainReader` — a class whose
 * constructor requires a validated `TrustedReaderConfig`. Callers cannot pass an
 * arbitrary `EvidenceChainReader` object literal: the pipeline needs the class's
 * private fields to be present, and a structural imitation will fail at the first
 * `#rpc` access. Application code never supplies one anyway; it obtains it from
 * `resolveTrustedEvidenceReader()`.
 */
export async function runTrustedVerification(
  reader: TrustedEvidenceChainReader,
  expected: ExpectedAnchorCommitment,
  transactionHash: string,
): Promise<TrustedPipelineOutcome> {
  let acquired;
  try {
    acquired = await reader.readAnchorObservation({
      transactionHash,
      registryAddress: expected.registryAddress,
    });
  } catch {
    // A reader that throws — rather than returning a typed failure — is treated as
    // unavailable, never as success.
    return { ok: false, failure: "RPC_UNAVAILABLE" };
  }
  if (!acquired.ok) return { ok: false, failure: acquired.failure };

  const evaluated = evaluateTrustedObservation(expected, acquired);
  if (!isAnchorEvaluationProof(evaluated)) {
    return {
      ok: false,
      failure: "EVALUATION_REJECTED",
      evaluationFailure: (evaluated as AnchorNotVerified).failure,
    };
  }

  // Provenance is attached only now, after both halves succeeded. If the seal
  // throws (an inconsistent reader result), the outcome is unverified.
  let seal;
  try {
    seal = sealTrustedObservation({
      observation: acquired.observation,
      finality: acquired.finality,
      // The hash the reader measured against the pinned value, carried on the
      // reader's own result so the seal records measured identity, not a parameter.
      runtimeBytecodeHash: acquired.runtimeBytecodeHash,
      registryAddress: evaluated.facts.registryAddress,
      transactionHash: evaluated.facts.transactionHash,
    });
  } catch {
    return { ok: false, failure: "EVALUATION_REJECTED" };
  }

  return { ok: true, result: createTrustedAnchorVerification(evaluated, seal) };
}
