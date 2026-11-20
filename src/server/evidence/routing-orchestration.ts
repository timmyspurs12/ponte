// This server-only orchestration deliberately does not choose a production KMS
// provider or registry. The normal Routing service supplies an explicit,
// local-only preparation dependency resolver after all read-only preflight work.
import "server-only";

import {
  readEvidencePreparationSnapshot,
  readRoutingIdempotencyPreflight,
  type RoutingIdempotencyPreflight,
} from "../repository";
import {
  prepareEvidenceCandidate,
  type PreparedEvidenceCandidate,
} from "./prepare-candidate";
import {
  persistPreparedEvidenceCandidate,
  type PersistPreparedEvidenceCandidateResult,
} from "./persist-candidate";
import {
  EvidencePersistenceError,
  RoutingEligibilityError,
  type RoutingEligibilityErrorCode,
} from "./errors";
import type { CanonicalRouteId } from "./commitment";
import type { DekProvider } from "./kms";

export interface RoutingPreparationDependencies {
  /** Explicit provider injection; this orchestration never chooses one. */
  provider: DekProvider;
  /** Explicit address injection; this does not imply a deployment exists. */
  registryAddress: string;
}

export interface RoutingOrchestrationInput {
  /** Trusted authenticated values; callers must not source these from the body. */
  businessId: string;
  actorUserId: string;
  invoiceId: string;
  quoteId: string;
  idempotencyKey: string;
  /** Exact normal HTTP method:path:raw-text SHA-256 fingerprint. */
  requestFingerprint: string;
  selectedRouteId: CanonicalRouteId;
  /**
   * Resolved only after preflight and the read-only snapshot have completed.
   * This preserves replay/conflict arbitration without making a provider a
   * requirement for an already durable response.
   */
  resolvePreparationDependencies: () =>
    RoutingPreparationDependencies | Promise<RoutingPreparationDependencies>;
}

export interface RoutingOrchestrationTestHooks {
  /**
   * Test-only deterministic boundary after a preflight miss and before the
   * snapshot read. It has no normal-runtime caller or configuration fallback.
   */
  afterPreflightMissBeforeSnapshot?: () => void | Promise<void>;
  /** Called only after the snapshot read has completed and released its client. */
  beforePreparation?: () => void | Promise<void>;
}

export interface RoutingOrchestrationResult extends PersistPreparedEvidenceCandidateResult {
  /** Internal observability only; never a substitute for the final transaction. */
  preflight: RoutingIdempotencyPreflight["kind"];
}

function eligibilityFailure(code: RoutingEligibilityErrorCode): never {
  throw new RoutingEligibilityError(code);
}

/**
 * After a preflight miss, an ineligible snapshot can be a race with a durable
 * matching request. The final helper is asked candidate-free so its advisory
 * lock, fingerprint decision, and locked membership reauthorization remain the
 * only replay/conflict authority. Its CANDIDATE_REQUIRED result means no row
 * exists and the original known snapshot outcome is safe to return.
 */
async function recheckBeforeSnapshotRejection(
  input: RoutingOrchestrationInput,
  original: RoutingEligibilityError,
): Promise<RoutingOrchestrationResult> {
  try {
    const result = await persistPreparedEvidenceCandidate({
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
    });
    return { ...result, preflight: "miss" };
  } catch (error) {
    if (
      error instanceof EvidencePersistenceError &&
      error.code === "CANDIDATE_REQUIRED"
    ) {
      throw original;
    }
    throw error;
  }
}

/**
 * The only final state authority is persistPreparedEvidenceCandidate(), which
 * takes its own final transaction. Matching/conflicting preflight deliberately
 * invokes that helper with no candidate. Thus no provider is resolved or called
 * for durable replay/conflict, while final advisory-lock arbitration and
 * membership reauthorization still occur.
 */
export async function orchestratePreparedRoutingCandidate(
  input: RoutingOrchestrationInput,
  hooks?: RoutingOrchestrationTestHooks,
): Promise<RoutingOrchestrationResult> {
  const preflight = await readRoutingIdempotencyPreflight(
    input.businessId,
    input.idempotencyKey,
    input.requestFingerprint,
  );

  if (preflight.kind !== "miss") {
    const result = await persistPreparedEvidenceCandidate({
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
    });
    return { ...result, preflight: preflight.kind };
  }

  await hooks?.afterPreflightMissBeforeSnapshot?.();
  const snapshot = await readEvidencePreparationSnapshot(
    input.businessId,
    input.invoiceId,
    input.quoteId,
  );
  if (snapshot.kind === "invoice_missing")
    return recheckBeforeSnapshotRejection(
      input,
      new RoutingEligibilityError("INVOICE_NOT_FOUND"),
    );

  // Preserve ordinary Routing validation order: invoice transition eligibility
  // precedes quote availability, even when the snapshot's quote is missing.
  if (snapshot.invoice.status !== "Funded")
    return recheckBeforeSnapshotRejection(
      input,
      new RoutingEligibilityError("INVALID_TRANSITION"),
    );
  if (snapshot.kind === "quote_missing_or_expired")
    return recheckBeforeSnapshotRejection(
      input,
      new RoutingEligibilityError("QUOTE_EXPIRED_OR_MISSING"),
    );

  // Snapshot's own READ ONLY transaction has committed and its client has been
  // released. No advisory, invoice, or quote lock is acquired before provider
  // preparation; the final helper owns all authoritative locks and writes.
  await hooks?.beforePreparation?.();
  const dependencies = await input.resolvePreparationDependencies();
  const candidate: PreparedEvidenceCandidate = await prepareEvidenceCandidate({
    snapshot,
    selectedRouteId: input.selectedRouteId,
    registryAddress: dependencies.registryAddress,
    createdByUserId: input.actorUserId,
    requestFingerprint: input.requestFingerprint,
    provider: dependencies.provider,
  });

  const result = await persistPreparedEvidenceCandidate({
    businessId: input.businessId,
    actorUserId: input.actorUserId,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: input.requestFingerprint,
    candidate,
  });
  return { ...result, preflight: preflight.kind };
}
