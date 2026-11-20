// This module is an explicit future-orchestration seam. It is intentionally not
// imported by the normal Routing service, does not choose a provider/registry,
// and has no normal API activation path.
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
  EvidencePersistenceError,
  persistPreparedEvidenceCandidate,
  type PersistPreparedEvidenceCandidateResult,
} from "./persist-candidate";
import type { CanonicalRouteId } from "./commitment";
import type { DekProvider } from "./kms";

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
  /** Explicit injection only; normal runtime has no provider default. */
  provider: DekProvider;
  /** Explicit injection only; this module does not imply any deployment exists. */
  registryAddress: string;
}

export interface RoutingOrchestrationTestHooks {
  /** Called only after the snapshot read has completed and released its client. */
  beforePreparation?: () => void | Promise<void>;
}

export interface RoutingOrchestrationResult extends PersistPreparedEvidenceCandidateResult {
  /** Internal observability only; never a substitute for the final transaction. */
  preflight: RoutingIdempotencyPreflight["kind"];
}

function persistenceFailure(
  code: ConstructorParameters<typeof EvidencePersistenceError>[0],
): never {
  throw new EvidencePersistenceError(code);
}

/**
 * Controlled seam for future integration tests and a separately approved
 * integration phase. The only final state authority is
 * persistPreparedEvidenceCandidate(), which takes its own final transaction.
 *
 * A matching/conflicting preflight deliberately invokes the final helper with
 * no candidate. Thus no provider is called for durable replay/conflict, while
 * final advisory-lock arbitration and membership reauthorization still occur.
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

  const snapshot = await readEvidencePreparationSnapshot(
    input.businessId,
    input.invoiceId,
    input.quoteId,
  );
  if (snapshot.kind === "invoice_missing")
    return persistenceFailure("INVOICE_OR_QUOTE_UNAVAILABLE");
  if (snapshot.kind === "quote_missing_or_expired")
    return persistenceFailure("INVOICE_OR_QUOTE_UNAVAILABLE");
  if (snapshot.invoice.status !== "Funded")
    return persistenceFailure("CANDIDATE_MISMATCH");

  // Snapshot's own READ ONLY transaction has committed and its client has been
  // released. No advisory, invoice, or quote lock is acquired before provider
  // preparation; the final helper owns all authoritative locks and writes.
  await hooks?.beforePreparation?.();
  const candidate: PreparedEvidenceCandidate = await prepareEvidenceCandidate({
    snapshot,
    selectedRouteId: input.selectedRouteId,
    registryAddress: input.registryAddress,
    createdByUserId: input.actorUserId,
    requestFingerprint: input.requestFingerprint,
    provider: input.provider,
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
