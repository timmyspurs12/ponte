// Final persistence is deliberately server-only and receives an already
// prepared candidate. It has no provider, preparation, Routing, or network API.
import "server-only";

import { randomUUID } from "node:crypto";
import { isHexString, keccak256 } from "ethers";
import type { Invoice, PaymentQuote, RouteCandidate } from "../../lib/models";
import {
  CommitOutcomeUnknownError,
  findIdempotency,
  findInvoice,
  insertPendingEvidenceOutbox,
  insertRouteDecisionEvidence,
  insertSettlement,
  lockIdempotencyKey,
  lockInvoiceForEvidence,
  lockValidQuoteForEvidence,
  saveIdempotency,
  saveInvoiceState,
  transactionWithCommitOutcome,
  appendEvent,
  type LockedEvidenceInvoiceRow,
  type LockedEvidenceQuoteRow,
  type RouteDecisionEvidenceInsert,
} from "../repository";
import {
  buildCanonicalPrivateEvidenceAad,
  buildKmsWrappingContext,
  canonicalizeEvidenceUuid,
  canonicalizePrivateEvidenceAad,
  PRIVATE_EVIDENCE_AAD_VERSION,
} from "./aad";
import {
  ARBITRUM_SEPOLIA_CHAIN_ID,
  CANONICAL_ROUTE_IDS,
  EVIDENCE_SCHEMA_VERSION,
  quoteSnapshotCommitment,
  QUOTE_SCHEMA_VERSION,
  SIMULATED_ROUTE_DECISION_KIND,
  type CanonicalRouteId,
} from "./commitment";
import {
  EVIDENCE_CONTENT_ALGORITHM,
  EVIDENCE_ENVELOPE_VERSION,
} from "./envelope";
import {
  EvidencePersistenceError,
  type EvidencePersistenceErrorCode,
} from "./errors";
import { assertDekWrappingMetadata } from "./kms";
import {
  verifyPreparedEvidenceCandidateIntegrity,
  type CandidateQuoteData,
  type CandidateRouteData,
  type PreparedEvidenceCandidate,
} from "./prepare-candidate";

const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const IDEMPOTENCY_KEY = /^[\w-]{8,128}$/;
const REQUEST_FINGERPRINT = /^[0-9a-f]{64}$/;

export {
  EvidencePersistenceError,
  type EvidencePersistenceErrorCode,
} from "./errors";

export interface PersistPreparedEvidenceCandidateInput {
  /** Trusted request context, never derived only from candidate fields. */
  businessId: string;
  actorUserId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  /** Optional solely so a durable replay need not supply or trust a candidate. */
  candidate?: PreparedEvidenceCandidate;
}

export interface PersistPreparedEvidenceCandidateResult {
  readonly kind: "persisted" | "replay";
  /** Existing mutation response contract: the persisted invoice JSON view. */
  readonly response: unknown;
}

/** Test-only fault injection; it receives no secret/candidate values. */
export interface EvidencePersistenceTestHooks {
  afterWrite?: (
    step:
      | "settlement"
      | "evidence"
      | "outbox"
      | "invoice"
      | "event"
      | "idempotency",
  ) => void | Promise<void>;
}

interface TrustedPersistenceContext {
  businessId: string;
  actorUserId: string;
  idempotencyKey: string;
  requestFingerprint: string;
}

function fail(code: EvidencePersistenceErrorCode): never {
  throw new EvidencePersistenceError(code);
}

function clearBufferBestEffort(value: Buffer | undefined): void {
  try {
    value?.fill(0);
  } catch {
    // Cleanup never masks a validation or transaction outcome.
  }
}

function canonicalContext(
  input: PersistPreparedEvidenceCandidateInput,
): TrustedPersistenceContext {
  try {
    if (
      typeof input?.idempotencyKey !== "string" ||
      !IDEMPOTENCY_KEY.test(input.idempotencyKey)
    ) {
      fail("INVALID_CONTEXT");
    }
    if (
      typeof input?.requestFingerprint !== "string" ||
      !REQUEST_FINGERPRINT.test(input.requestFingerprint)
    ) {
      fail("INVALID_CONTEXT");
    }
    const businessId = canonicalizeEvidenceUuid(input.businessId, "businessId");
    const actorUserId = canonicalizeEvidenceUuid(
      input.actorUserId,
      "actorUserId",
    );
    if (businessId !== input.businessId || actorUserId !== input.actorUserId)
      fail("INVALID_CONTEXT");
    return {
      businessId,
      actorUserId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
    };
  } catch (error) {
    if (error instanceof EvidencePersistenceError) throw error;
    return fail("INVALID_CONTEXT");
  }
}

function assertBuffer(value: unknown): asserts value is Buffer {
  if (!Buffer.isBuffer(value)) fail("CANDIDATE_INVALID");
}

/**
 * Creates persistence-owned mutable-buffer and quote-data copies before any
 * digest verification. All later work uses this private copy only.
 */
function copyCandidate(value: unknown): PreparedEvidenceCandidate {
  if (!value || typeof value !== "object") fail("CANDIDATE_INVALID");
  try {
    const candidate = value as PreparedEvidenceCandidate;
    assertBuffer(candidate.publicEvidenceId);
    assertBuffer(candidate.ciphertext);
    assertBuffer(candidate.nonce);
    assertBuffer(candidate.authenticationTag);
    assertBuffer(candidate.wrappedDek);
    const quote = candidate.canonicalQuoteData;
    if (!quote || typeof quote !== "object" || !Array.isArray(quote.routes))
      fail("CANDIDATE_INVALID");

    const routes = quote.routes.map((route) => ({
      id: route.id,
      feeBps: route.feeBps,
      slippageBps: route.slippageBps,
      toleranceBps: route.toleranceBps,
      feeMinor: route.feeMinor,
      outputMinor: route.outputMinor,
      minimumOutputMinor: route.minimumOutputMinor,
    })) as CandidateRouteData[];
    const copiedQuote: CandidateQuoteData = {
      simulated: quote.simulated,
      asset: quote.asset,
      demoAssetDecimals: quote.demoAssetDecimals,
      fundingMinor: quote.fundingMinor,
      rate: {
        numerator: quote.rate?.numerator,
        denominator: quote.rate?.denominator,
      },
      executionCostMinor: quote.executionCostMinor,
      routes,
    };

    return {
      ...candidate,
      publicEvidenceId: Buffer.from(candidate.publicEvidenceId),
      canonicalQuoteData: copiedQuote,
      routeHashes: { ...candidate.routeHashes },
      ciphertext: Buffer.from(candidate.ciphertext),
      nonce: Buffer.from(candidate.nonce),
      authenticationTag: Buffer.from(candidate.authenticationTag),
      wrappedDek: Buffer.from(candidate.wrappedDek),
    };
  } catch (error) {
    if (error instanceof EvidencePersistenceError) throw error;
    return fail("CANDIDATE_INVALID");
  }
}

function assertBytes32(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !isHexString(value, 32) ||
    value !== value.toLowerCase()
  ) {
    fail("CANDIDATE_MISMATCH");
  }
}

function assertNonZeroBytes32(value: unknown): asserts value is string {
  assertBytes32(value);
  if (value === ZERO_BYTES32) fail("CANDIDATE_MISMATCH");
}

function exactRouteCode(routeId: CanonicalRouteId): number {
  switch (routeId) {
    case "direct":
      return 1;
    case "split":
      return 2;
    case "multi":
      return 3;
  }
}

function assertCanonicalCandidateRoute(
  candidateRoute: CandidateRouteData,
  lockedRoute: RouteCandidate,
  expectedId: CanonicalRouteId,
): void {
  if (
    !candidateRoute ||
    !lockedRoute ||
    candidateRoute.id !== expectedId ||
    lockedRoute.id !== expectedId ||
    candidateRoute.feeBps !== lockedRoute.feeBps ||
    candidateRoute.slippageBps !== lockedRoute.slippageBps ||
    candidateRoute.toleranceBps !== lockedRoute.toleranceBps ||
    candidateRoute.feeMinor !== lockedRoute.feeMinor ||
    candidateRoute.outputMinor !== lockedRoute.outputMinor ||
    candidateRoute.minimumOutputMinor !== lockedRoute.minimumOutputMinor
  ) {
    fail("CANDIDATE_MISMATCH");
  }
}

function assertCandidateQuoteMatchesLocked(
  candidate: PreparedEvidenceCandidate,
  invoice: LockedEvidenceInvoiceRow,
  quote: LockedEvidenceQuoteRow,
): RouteCandidate {
  const candidateQuote = candidate.canonicalQuoteData;
  if (
    candidate.quoteSource !== quote.source ||
    candidate.quoteSimulated !== quote.simulated ||
    candidate.quoteExpiresAtUnixMs !== quote.expires_at.getTime().toString() ||
    candidateQuote.simulated !== quote.data.simulated ||
    candidateQuote.asset !== quote.data.asset ||
    candidateQuote.demoAssetDecimals !== quote.data.demoAssetDecimals ||
    candidateQuote.fundingMinor !== quote.data.fundingMinor ||
    candidateQuote.rate.numerator !== quote.data.rate?.numerator ||
    candidateQuote.rate.denominator !== quote.data.rate?.denominator ||
    candidateQuote.executionCostMinor !== quote.data.executionCostMinor ||
    candidateQuote.routes.length !== CANONICAL_ROUTE_IDS.length ||
    quote.data.routes.length !== CANONICAL_ROUTE_IDS.length
  ) {
    fail("CANDIDATE_MISMATCH");
  }

  for (const [index, routeId] of CANONICAL_ROUTE_IDS.entries())
    assertCanonicalCandidateRoute(
      candidateQuote.routes[index],
      quote.data.routes[index],
      routeId,
    );

  if (
    !(CANONICAL_ROUTE_IDS as readonly string[]).includes(
      candidate.selectedRouteId,
    ) ||
    candidate.selectedRouteCode !== exactRouteCode(candidate.selectedRouteId)
  ) {
    fail("CANDIDATE_MISMATCH");
  }
  const selectedIndex = CANONICAL_ROUTE_IDS.indexOf(candidate.selectedRouteId);
  const selectedRoute = quote.data.routes[selectedIndex];
  if (!selectedRoute || selectedRoute.id !== candidate.selectedRouteId)
    fail("CANDIDATE_MISMATCH");

  let commitment;
  try {
    commitment = quoteSnapshotCommitment(
      {
        fundingCurrency: invoice.data.fundingCurrency,
        fundingMinor: invoice.funding_minor,
      },
      quote,
    );
  } catch {
    return fail("CANDIDATE_MISMATCH");
  }
  if (
    candidate.routeHashes.direct !== commitment.routeHashes.direct ||
    candidate.routeHashes.split !== commitment.routeHashes.split ||
    candidate.routeHashes.multi !== commitment.routeHashes.multi ||
    candidate.routesHash !== commitment.routesHash ||
    candidate.quoteSnapshotHash !== commitment.quoteSnapshotHash
  ) {
    fail("CANDIDATE_MISMATCH");
  }
  return selectedRoute;
}

function assertCandidateContextAndEnvelope(
  candidate: PreparedEvidenceCandidate,
): { registryAddress: Buffer } {
  if (
    candidate.evidenceSchemaVersion !== EVIDENCE_SCHEMA_VERSION ||
    candidate.quoteSchemaVersion !== QUOTE_SCHEMA_VERSION ||
    candidate.aadVersion !== PRIVATE_EVIDENCE_AAD_VERSION ||
    candidate.chainId !== ARBITRUM_SEPOLIA_CHAIN_ID.toString() ||
    candidate.sequence !== "1" ||
    candidate.evidenceKind !== SIMULATED_ROUTE_DECISION_KIND ||
    candidate.previousPayloadHash !== ZERO_BYTES32 ||
    candidate.envelopeVersion !== EVIDENCE_ENVELOPE_VERSION ||
    candidate.contentAlgorithm !== EVIDENCE_CONTENT_ALGORITHM ||
    !Buffer.isBuffer(candidate.publicEvidenceId) ||
    candidate.publicEvidenceId.length !== 32 ||
    candidate.publicEvidenceId.equals(Buffer.alloc(32)) ||
    !Buffer.isBuffer(candidate.ciphertext) ||
    candidate.ciphertext.length < 1 ||
    !Buffer.isBuffer(candidate.nonce) ||
    candidate.nonce.length !== 12 ||
    !Buffer.isBuffer(candidate.authenticationTag) ||
    candidate.authenticationTag.length !== 16 ||
    !Buffer.isBuffer(candidate.wrappedDek) ||
    candidate.wrappedDek.length < 1
  ) {
    fail("CANDIDATE_MISMATCH");
  }
  assertNonZeroBytes32(candidate.payloadHash);
  assertBytes32(candidate.quoteSnapshotHash);
  assertBytes32(candidate.routesHash);
  assertBytes32(candidate.routeHashes.direct);
  assertBytes32(candidate.routeHashes.split);
  assertBytes32(candidate.routeHashes.multi);
  assertBytes32(candidate.canonicalAadDigest);
  assertBytes32(candidate.wrappingContextDigest);

  let canonical;
  let canonicalAad: Buffer | undefined;
  let wrappingContext: Buffer | undefined;
  try {
    canonical = canonicalizePrivateEvidenceAad({
      aadVersion: candidate.aadVersion,
      evidenceRecordId: candidate.evidenceRecordId,
      businessId: candidate.businessId,
      invoiceId: candidate.invoiceId,
      quoteId: candidate.quoteId,
      publicEvidenceId: `0x${candidate.publicEvidenceId.toString("hex")}`,
      evidenceSchemaVersion: candidate.evidenceSchemaVersion,
      chainId: BigInt(candidate.chainId),
      registryAddress: candidate.registryAddress,
    });
    if (
      canonical.evidenceRecordId !== candidate.evidenceRecordId ||
      canonical.businessId !== candidate.businessId ||
      canonical.invoiceId !== candidate.invoiceId ||
      canonical.quoteId !== candidate.quoteId ||
      canonical.registryAddress !== candidate.registryAddress ||
      canonicalizeEvidenceUuid(
        candidate.routingCorrelationId,
        "routingCorrelationId",
      ) !== candidate.routingCorrelationId ||
      canonicalizeEvidenceUuid(candidate.outboxId, "outboxId") !==
        candidate.outboxId
    ) {
      return fail("CANDIDATE_MISMATCH");
    }
    canonicalAad = buildCanonicalPrivateEvidenceAad(canonical);
    wrappingContext = buildKmsWrappingContext(canonicalAad);
    if (
      keccak256(canonicalAad) !== candidate.canonicalAadDigest ||
      keccak256(wrappingContext) !== candidate.wrappingContextDigest
    ) {
      return fail("CANDIDATE_MISMATCH");
    }
    assertDekWrappingMetadata({
      kmsProvider: candidate.kmsProvider,
      wrappedDekAlgorithm: candidate.wrappedDekAlgorithm,
      wrappedDekFormat: candidate.wrappedDekFormat,
      kmsKeyReference: candidate.kmsKeyReference,
      kmsKeyVersion: candidate.kmsKeyVersion,
    });
    return {
      registryAddress: Buffer.from(canonical.registryAddress.slice(2), "hex"),
    };
  } catch (error) {
    if (error instanceof EvidencePersistenceError) throw error;
    return fail("CANDIDATE_MISMATCH");
  } finally {
    clearBufferBestEffort(canonicalAad);
    clearBufferBestEffort(wrappingContext);
  }
}

/**
 * Pure final comparison. The private salt/payload/DEK are intentionally absent:
 * payloadHash is carried unchanged and protected by prepared-candidate integrity
 * rather than recomputed in this transaction.
 */
export function assertPreparedCandidateMatchesLockedRows(
  candidate: PreparedEvidenceCandidate,
  context: Pick<
    TrustedPersistenceContext,
    "businessId" | "actorUserId" | "requestFingerprint"
  >,
  invoice: LockedEvidenceInvoiceRow,
  quote: LockedEvidenceQuoteRow,
): RouteCandidate {
  try {
    if (
      candidate.businessId !== context.businessId ||
      candidate.createdByUserId !== context.actorUserId ||
      candidate.requestFingerprint !== context.requestFingerprint ||
      candidate.businessId !== invoice.business_id ||
      candidate.invoiceId !== invoice.id ||
      candidate.quoteId !== quote.id ||
      quote.business_id !== invoice.business_id ||
      quote.invoice_id !== invoice.id ||
      invoice.status !== "Funded" ||
      invoice.funding_currency !== "BRL" ||
      invoice.data.fundingCurrency !== "BRL" ||
      (invoice.data.fundingMinor !== undefined &&
        invoice.data.fundingMinor !== invoice.funding_minor) ||
      candidate.invoiceFundingMinor !== invoice.funding_minor ||
      candidate.invoiceFundingCurrency !== invoice.funding_currency ||
      candidate.invoiceStatusAtSnapshot !== invoice.status ||
      quote.source !== "simulation-fixed-525" ||
      quote.simulated !== true ||
      quote.data.simulated !== true ||
      quote.data.fundingMinor !== invoice.funding_minor
    ) {
      return fail("CANDIDATE_MISMATCH");
    }

    canonicalizeEvidenceUuid(candidate.createdByUserId, "createdByUserId");
    assertCandidateContextAndEnvelope(candidate);
    return assertCandidateQuoteMatchesLocked(candidate, invoice, quote);
  } catch (error) {
    if (error instanceof EvidencePersistenceError) throw error;
    return fail("CANDIDATE_MISMATCH");
  }
}

/**
 * Re-authorizes the actor's membership against the locked row and takes the
 * membership row lock.
 *
 * Phase 2C.3: the lock is carried by the SECURITY DEFINER function
 * `ponte_lock_routing_membership`, owned by `ponte_routing_lock`. The
 * application identity holds no UPDATE on `memberships`, so the previous
 * direct `SELECT ... FOR UPDATE` failed with 42501 (the R1 dormancy); the
 * function locks the active membership row with its own column-level
 * privileges and returns the role.
 *
 * The caller must run this before comparing an existing idempotency key's
 * fingerprint: authorization is re-checked against the locked row on every
 * path, replay or new persistence.
 */
async function assertActiveMutationMembership(
  db: Parameters<typeof lockInvoiceForEvidence>[0],
  context: TrustedPersistenceContext,
): Promise<void> {
  const membership = await db.query<{ role: string | null }>(
    "SELECT public.ponte_lock_routing_membership($1,$2) AS role",
    [context.businessId, context.actorUserId],
  );
  const role = membership.rows[0]?.role ?? null;
  if (role === null || role === "viewer") fail("FORBIDDEN");
}

async function afterWrite(
  hooks: EvidencePersistenceTestHooks | undefined,
  step: Parameters<NonNullable<EvidencePersistenceTestHooks["afterWrite"]>>[0],
): Promise<void> {
  await hooks?.afterWrite?.(step);
}

function bytes32Buffer(value: string): Buffer {
  return Buffer.from(value.slice(2), "hex");
}

async function persistNewCandidate(
  db: Parameters<typeof lockInvoiceForEvidence>[0],
  context: TrustedPersistenceContext,
  candidate: PreparedEvidenceCandidate,
  hooks: EvidencePersistenceTestHooks | undefined,
): Promise<PersistPreparedEvidenceCandidateResult> {
  const lockedInvoice = await lockInvoiceForEvidence(
    db,
    context.businessId,
    candidate.invoiceId,
  );
  if (lockedInvoice.rowCount !== 1) fail("INVOICE_OR_QUOTE_UNAVAILABLE");
  const invoice = lockedInvoice.rows[0];

  const lockedQuote = await lockValidQuoteForEvidence(
    db,
    context.businessId,
    candidate.invoiceId,
    candidate.quoteId,
  );
  if (lockedQuote.rowCount !== 1) fail("INVOICE_OR_QUOTE_UNAVAILABLE");
  const quote = lockedQuote.rows[0];

  // Post-lock quote-expiry re-assertion. The lock function locks the quote
  // row first and evaluates expiry only after the lock is acquired: a
  // missing quote locks nothing and returns zero rows; a valid quote is
  // locked and returned; an expired quote is locked first, rejected by the
  // post-lock expiry check, and returns zero rows. This call-site check
  // re-asserts that invariant against the locked row's own timestamp so it
  // is explicit here rather than only implied by the function.
  if (quote.expires_at.getTime() <= Date.now())
    fail("INVOICE_OR_QUOTE_UNAVAILABLE");

  if (!verifyPreparedEvidenceCandidateIntegrity(candidate))
    fail("CANDIDATE_INVALID");
  const selectedRoute = assertPreparedCandidateMatchesLockedRows(
    candidate,
    context,
    invoice,
    quote,
  );
  const { registryAddress } = assertCandidateContextAndEnvelope(candidate);

  // The only Buffer references below are owned copies created before digest
  // verification. Recheck immediately before their first persistence use.
  if (!verifyPreparedEvidenceCandidateIntegrity(candidate))
    fail("CANDIDATE_INVALID");

  await insertSettlement(db, [
    randomUUID(),
    context.businessId,
    invoice.id,
    quote.id,
    candidate.selectedRouteId,
    selectedRoute.outputMinor,
    selectedRoute.minimumOutputMinor,
  ]);
  await afterWrite(hooks, "settlement");

  const evidence: RouteDecisionEvidenceInsert = {
    id: candidate.evidenceRecordId,
    businessId: context.businessId,
    invoiceId: invoice.id,
    quoteId: quote.id,
    createdByUserId: context.actorUserId,
    routingCorrelationId: candidate.routingCorrelationId,
    publicEvidenceId: candidate.publicEvidenceId,
    evidenceSchemaVersion: candidate.evidenceSchemaVersion,
    quoteSchemaVersion: candidate.quoteSchemaVersion,
    chainId: candidate.chainId,
    registryAddress,
    sequence: candidate.sequence,
    evidenceKind: candidate.evidenceKind,
    selectedRouteCode: candidate.selectedRouteCode,
    quoteSnapshotHash: bytes32Buffer(candidate.quoteSnapshotHash),
    previousPayloadHash: bytes32Buffer(candidate.previousPayloadHash),
    payloadHash: bytes32Buffer(candidate.payloadHash),
    envelopeVersion: candidate.envelopeVersion,
    contentAlgorithm: candidate.contentAlgorithm,
    ciphertext: candidate.ciphertext,
    nonce: candidate.nonce,
    authenticationTag: candidate.authenticationTag,
    wrappedDek: candidate.wrappedDek,
    kmsProvider: candidate.kmsProvider,
    wrappedDekAlgorithm: candidate.wrappedDekAlgorithm,
    wrappedDekFormat: candidate.wrappedDekFormat,
    kmsKeyReference: candidate.kmsKeyReference,
    kmsKeyVersion: candidate.kmsKeyVersion,
    aadVersion: candidate.aadVersion,
  };
  await insertRouteDecisionEvidence(db, evidence);
  await afterWrite(hooks, "evidence");

  await insertPendingEvidenceOutbox(db, {
    id: candidate.outboxId,
    evidenceRecordId: candidate.evidenceRecordId,
  });
  await afterWrite(hooks, "outbox");

  const updatedInvoice: Invoice = {
    ...(invoice.data as Invoice),
    status: "Routing",
    selectedRoute: candidate.selectedRouteId,
    quote: quote.data as PaymentQuote,
  };
  await saveInvoiceState(db, [
    context.businessId,
    invoice.id,
    "Routing",
    JSON.stringify(updatedInvoice),
  ]);
  await afterWrite(hooks, "invoice");

  await appendEvent(db, [
    randomUUID(),
    context.businessId,
    invoice.id,
    context.actorUserId,
    candidate.routingCorrelationId,
    "invoice.Routing",
    JSON.stringify({
      status: updatedInvoice.status,
      selectedRoute: updatedInvoice.selectedRoute,
      fundingMinor: updatedInvoice.fundingMinor,
      simulated: true,
    }),
    "Funded",
    "Routing",
  ]);
  await afterWrite(hooks, "event");

  const responseResult = await findInvoice(
    db,
    context.businessId,
    invoice.id,
    false,
  );
  if (responseResult.rowCount !== 1) fail("PERSISTENCE_FAILED");
  const response = responseResult.rows[0].data;
  await saveIdempotency(db, [
    context.businessId,
    context.idempotencyKey,
    context.requestFingerprint,
    JSON.stringify(response),
  ]);
  await afterWrite(hooks, "idempotency");
  return { kind: "persisted", response };
}

/**
 * Persists an already-prepared candidate through one authoritative PostgreSQL
 * transaction. It is the final state authority for Routing persistence:
 * `orchestratePreparedRoutingCandidate()` — the normal Routing/API flow used
 * by the service entrypoint — delegates every successful Routing write here,
 * and `recheckBeforeSnapshotRejection()` uses it candidate-free for idempotent
 * replay/conflict decisions after a preflight miss. It does not call a
 * provider, preparation routine, or external network; candidates are prepared
 * by the caller and verified before this transaction begins.
 */
export async function persistPreparedEvidenceCandidate(
  input: PersistPreparedEvidenceCandidateInput,
  hooks?: EvidencePersistenceTestHooks,
): Promise<PersistPreparedEvidenceCandidateResult> {
  let context: TrustedPersistenceContext;
  try {
    context = canonicalContext(input);
  } catch (error) {
    if (error instanceof EvidencePersistenceError) throw error;
    return fail("INVALID_CONTEXT");
  }

  try {
    return await transactionWithCommitOutcome(async (db) => {
      await lockIdempotencyKey(db, [
        `${context.businessId}:${context.idempotencyKey}`,
      ]);
      const existing = await findIdempotency(db, [
        context.businessId,
        context.idempotencyKey,
      ]);
      if (existing.rowCount) {
        // Phase 2C.3: membership is re-authorized against the locked row
        // BEFORE the fingerprint is compared. A replay discloses a durable
        // response only to an actor whose membership is active at this
        // moment: a revoked or viewer membership fails with FORBIDDEN even
        // when the fingerprint matches, and before a mismatch can be
        // reported as a conflict.
        await assertActiveMutationMembership(db, context);
        if (existing.rows[0].fingerprint !== context.requestFingerprint)
          fail("IDEMPOTENCY_CONFLICT");
        return { kind: "replay", response: existing.rows[0].response };
      }

      await assertActiveMutationMembership(db, context);
      if (!input.candidate) fail("CANDIDATE_REQUIRED");
      const candidate = copyCandidate(input.candidate);
      if (!verifyPreparedEvidenceCandidateIntegrity(candidate))
        fail("CANDIDATE_INVALID");
      return persistNewCandidate(db, context, candidate, hooks);
    });
  } catch (error) {
    if (error instanceof EvidencePersistenceError) throw error;
    if (error instanceof CommitOutcomeUnknownError)
      return fail("COMMIT_OUTCOME_UNKNOWN");
    // An invalid UUID that reaches a lock function raises 22P02
    // (invalid_text_representation). That is a request-context defect, not an
    // internal persistence failure: map it explicitly instead of folding it
    // into PERSISTENCE_FAILED.
    if ((error as { code?: string }).code === "22P02")
      return fail("INVALID_CONTEXT");
    return fail("PERSISTENCE_FAILED");
  }
}
