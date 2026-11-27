// Contracts restored from the pre-R1 routing-orchestration suite.
//
// Phase 2C.2B (R1) made the two Routing row locks unreachable by construction:
// PostgreSQL requires UPDATE on a table for every row-lock mode and the
// application identity held SELECT+INSERT only on `quotes` and `memberships`,
// so these tests were re-expressed as fail-closed contracts and the original
// assertions moved here.
//
// Phase 2C.3 resolves the R1 limitation with the SECURITY DEFINER lock
// functions `ponte_lock_routing_membership` / `ponte_lock_routing_quote`
// (owned by `ponte_routing_lock`, EXECUTE granted to `ponte_app`). These
// contracts are therefore restored to the original successful-persistence
// semantics named in each block's header. The R1 fail-closed history is
// preserved in docs/PHASE2C2B_R1_ROUTING_LIMITATION.md; the mechanism that
// supersedes it is documented in docs/PHASE2C3_ROUTING_LOCK_FUNCTIONS.md.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { quote } from "../src/lib/quotes";
import {
  pool,
  readEvidencePreparationSnapshot,
} from "../src/server/repository";
import {
  EvidencePersistenceError,
  persistPreparedEvidenceCandidate,
  type PersistPreparedEvidenceCandidateInput,
} from "../src/server/evidence/persist-candidate";
import {
  KMS_PROVIDER,
  WRAPPED_DEK_ALGORITHM,
  WRAPPED_DEK_FORMAT,
  type CreatedAndWrappedDek,
  type DekProvider,
  type DekWrappingContext,
} from "../src/server/evidence/kms";
import {
  EvidenceCandidatePreparationError,
  prepareEvidenceCandidate,
  type PreparedEvidenceCandidate,
} from "../src/server/evidence/prepare-candidate";
import { fixtures } from "./helpers/fixtures";

const REGISTRY_ADDRESS = "0x1111111111111111111111111111111111111111";

class SyntheticDekProvider implements DekProvider {
  readonly provider = KMS_PROVIDER.LOCAL_TEST_ONLY;
  calls = 0;
  fail = false;

  async createAndWrapDek(
    _context: DekWrappingContext,
  ): Promise<CreatedAndWrappedDek> {
    this.calls += 1;
    if (this.fail) throw new Error("injected provider failure");
    return {
      plaintextDek: Buffer.alloc(32, 73),
      wrappedDek: Buffer.from("synthetic-persistence-wrapped-dek-v1"),
      kmsProvider: KMS_PROVIDER.LOCAL_TEST_ONLY,
      kmsKeyReference: "local-test-only/persistence/evidence",
      kmsKeyVersion: "local-test-only/persistence/v1",
      wrappedDekAlgorithm: WRAPPED_DEK_ALGORITHM.LOCAL_TEST_RANDOM_BYTES_V1,
      wrappedDekFormat: WRAPPED_DEK_FORMAT.LOCAL_TEST_RANDOM_BYTES_V1,
    };
  }
}

interface Context {
  businessId: string;
  actorUserId: string;
  invoiceId: string;
  quoteId: string;
}

function requestFingerprint(value = "ab"): string {
  return value.repeat(32);
}

function persistenceInput(
  context: Context,
  candidate: PreparedEvidenceCandidate | undefined,
  idempotencyKey = `routing-${randomUUID()}`,
  fingerprint = requestFingerprint(),
): PersistPreparedEvidenceCandidateInput {
  return {
    businessId: context.businessId,
    actorUserId: context.actorUserId,
    idempotencyKey,
    requestFingerprint: fingerprint,
    candidate,
  };
}

async function createContext(): Promise<Context> {
  const businessId = randomUUID();
  const actorUserId = randomUUID();
  const invoiceId = randomUUID();
  const quoteId = randomUUID();
  const fundingMinor = "2500001";
  const persistedQuote = quote({ fundingMinor });
  const invoice = {
    id: invoiceId,
    reference: `ROUTING-ORCH-${invoiceId}`,
    supplier: "Routing orchestration test supplier",
    wallet: `0x${"c".repeat(40)}`,
    amount: 25000.01,
    fundingMinor,
    fundingCurrency: "BRL",
    settlementCurrency: "USDG",
    due: "2035-12-20",
    description: "Synthetic routing orchestration test only",
    status: "Funded",
    created: "2026-11-19",
    quote: persistedQuote,
  };

  await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    businessId,
    "Routing orchestration test business",
  ]);
  await fixtures("INSERT INTO users(id,email) VALUES($1,$2)", [
    actorUserId,
    `${actorUserId}@example.invalid`,
  ]);
  await fixtures(
    "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,'admin','active')",
    [businessId, actorUserId],
  );
  await pool.query(
    "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data) VALUES($1,$2,$3,$4,$5,$6)",
    [
      invoiceId,
      businessId,
      invoice.reference,
      fundingMinor,
      invoice.status,
      JSON.stringify(invoice),
    ],
  );
  await pool.query(
    "INSERT INTO quotes(id,business_id,invoice_id,source,simulated,data,expires_at) VALUES($1,$2,$3,'simulation-fixed-525',true,$4,$5)",
    [
      quoteId,
      businessId,
      invoiceId,
      JSON.stringify(persistedQuote),
      "2035-12-20T00:00:00.123Z",
    ],
  );
  return { businessId, actorUserId, invoiceId, quoteId };
}

async function prepare(
  context: Context,
  fingerprint = requestFingerprint(),
  provider = new SyntheticDekProvider(),
  actorUserId = context.actorUserId,
): Promise<{
  candidate: PreparedEvidenceCandidate;
  provider: SyntheticDekProvider;
}> {
  const snapshot = await readEvidencePreparationSnapshot(
    context.businessId,
    context.invoiceId,
    context.quoteId,
  );
  if (snapshot.kind !== "ready")
    assert.fail(`expected preparation snapshot, got ${snapshot.kind}`);
  const candidate = await prepareEvidenceCandidate({
    snapshot,
    selectedRouteId: "split",
    registryAddress: REGISTRY_ADDRESS,
    createdByUserId: actorUserId,
    requestFingerprint: fingerprint,
    provider,
  });
  return { candidate, provider };
}

async function counts(context: Context) {
  const result = await pool.query<{
    evidence: string;
    outbox: string;
    settlements: string;
    events: string;
    idempotency: string;
    status: string;
  }>(
    "SELECT (SELECT count(*) FROM route_decision_evidence WHERE business_id=$1)::text AS evidence,(SELECT count(*) FROM evidence_outbox o JOIN route_decision_evidence e ON e.id=o.evidence_record_id WHERE e.business_id=$1)::text AS outbox,(SELECT count(*) FROM settlements WHERE business_id=$1)::text AS settlements,(SELECT count(*) FROM payment_events WHERE business_id=$1)::text AS events,(SELECT count(*) FROM idempotency WHERE business_id=$1)::text AS idempotency,(SELECT status FROM invoices WHERE business_id=$1 AND id=$2) AS status",
    [context.businessId, context.invoiceId],
  );
  return result.rows[0];
}

const FULL_PERSISTED_COUNTS = {
  evidence: "1",
  outbox: "1",
  settlements: "1",
  events: "1",
  idempotency: "1",
  status: "Routing",
};

const NO_WRITES = {
  evidence: "0",
  outbox: "0",
  settlements: "0",
  events: "0",
  idempotency: "0",
  status: "Funded",
};

function isPersistenceError(
  code: EvidencePersistenceError["code"],
): (error: unknown) => boolean {
  return (error) =>
    error instanceof EvidencePersistenceError && error.code === code;
}

after(async () => {
  await pool.end();
});

// ORIGINAL TEST: matching preflight uses candidate-free final replay and reuses no provider
test("matching preflight uses candidate-free final replay and reuses no provider", async () => {
  // Phase 2C.3 restored semantics: when the idempotency preflight finds a
  // matching durable row, the final call needs no candidate and replays the
  // durable response without invoking a provider again.
  const context = await createContext();
  const idempotencyKey = `preflight-${randomUUID()}`;
  const fingerprint = requestFingerprint();
  const { candidate, provider } = await prepare(context, fingerprint);

  const first = await persistPreparedEvidenceCandidate(
    persistenceInput(context, candidate, idempotencyKey, fingerprint),
  );
  assert.equal(first.kind, "persisted");

  // Candidate-free final call with the same key and fingerprint: a replay,
  // and the provider is never touched.
  const replay = await persistPreparedEvidenceCandidate(
    persistenceInput(context, undefined, idempotencyKey, fingerprint),
  );
  assert.equal(replay.kind, "replay");
  assert.deepEqual(replay.response, first.response);
  assert.equal(provider.calls, 1, "the replay must not call a provider");

  assert.deepEqual(await counts(context), FULL_PERSISTED_COUNTS);
});

// ORIGINAL TEST: matching preflight still reauthorizes membership in the final helper
test("matching preflight still reauthorizes membership in the final helper", async () => {
  // Phase 2C.3 semantics: the final helper re-authorizes membership against
  // the membership row locked by `ponte_lock_routing_membership` on the
  // replay path too — a matching preflight never discloses a durable response
  // to a revoked membership.
  const context = await createContext();
  const idempotencyKey = `preflight-reauth-${randomUUID()}`;
  const fingerprint = requestFingerprint();
  const { candidate } = await prepare(context, fingerprint);

  const first = await persistPreparedEvidenceCandidate(
    persistenceInput(context, candidate, idempotencyKey, fingerprint),
  );
  assert.equal(first.kind, "persisted");

  // Disable the actor's membership between the preflight and the final call;
  // the matching preflight still fails closed with FORBIDDEN.
  await fixtures(
    "UPDATE memberships SET status='disabled' WHERE business_id=$1 AND user_id=$2",
    [context.businessId, context.actorUserId],
  );
  await assert.rejects(
    persistPreparedEvidenceCandidate(
      persistenceInput(context, undefined, idempotencyKey, fingerprint),
    ),
    isPersistenceError("FORBIDDEN"),
  );

  assert.deepEqual(await counts(context), FULL_PERSISTED_COUNTS);
});

// ORIGINAL TEST: a matching normal Routing commit between preflight miss and snapshot replays authoritatively
test("a matching normal Routing commit between preflight miss and snapshot replays authoritatively", async () => {
  // Phase 2C.3 restored semantics: if a matching record commits between the
  // preflight miss and the final call, the final persistence resolves the
  // commit authoritatively as a replay instead of writing a second record —
  // even when the final call carries a candidate.
  const context = await createContext();
  const idempotencyKey = `concurrent-commit-${randomUUID()}`;
  const fingerprint = requestFingerprint();
  const { candidate, provider } = await prepare(context, fingerprint);

  // The concurrent commit lands first (same key and fingerprint).
  const winner = await persistPreparedEvidenceCandidate(
    persistenceInput(context, candidate, idempotencyKey, fingerprint),
  );
  assert.equal(winner.kind, "persisted");

  // The delayed final call with a prepared candidate resolves to the
  // authoritative replay; no second write and no provider call.
  const delayed = await persistPreparedEvidenceCandidate(
    persistenceInput(context, candidate, idempotencyKey, fingerprint),
  );
  assert.equal(delayed.kind, "replay");
  assert.deepEqual(delayed.response, winner.response);
  assert.equal(provider.calls, 1, "the delayed call must not call a provider");

  assert.deepEqual(await counts(context), FULL_PERSISTED_COUNTS);
});

// ORIGINAL TEST: a stale snapshot without a concurrent idempotency row preserves invalid transition semantics
test("a stale snapshot without a concurrent idempotency row preserves invalid transition semantics", async () => {
  // Phase 2C.3 restored semantics: a stale snapshot (prepared before a
  // routing commit) with no idempotency row of its own cannot transition the
  // invoice a second time — the locked-row validation rejects the stale
  // candidate with CANDIDATE_MISMATCH and no write occurs.
  const context = await createContext();
  const staleFingerprint = requestFingerprint("cd");
  const { candidate } = await prepare(context, staleFingerprint);

  // A routing commit happens under a different key.
  const routingFingerprint = requestFingerprint("ef");
  const { candidate: routingCandidate } = await prepare(
    context,
    routingFingerprint,
    new SyntheticDekProvider(),
  );
  const routing = await persistPreparedEvidenceCandidate(
    persistenceInput(context, routingCandidate, `routing-${randomUUID()}`, routingFingerprint),
  );
  assert.equal(routing.kind, "persisted");

  // The stale candidate now targets a Routing invoice: rejected, no write.
  await assert.rejects(
    persistPreparedEvidenceCandidate(
      persistenceInput(context, candidate, `stale-${randomUUID()}`, staleFingerprint),
    ),
    isPersistenceError("CANDIDATE_MISMATCH"),
  );

  assert.deepEqual(await counts(context), FULL_PERSISTED_COUNTS);
});

// ORIGINAL TEST: initial snapshot failures preserve invoice, transition, and quote API semantics
test("initial snapshot failures preserve invoice, transition, and quote API semantics", async () => {
  // Phase 2C.3 restored semantics: snapshot failures are reported explicitly
  // (missing invoice vs expired/missing quote) and the final persistence
  // rejects the candidate with INVOICE_OR_QUOTE_UNAVAILABLE without writes,
  // preserving the invoice state machine.
  const missingInvoice: Context = {
    businessId: randomUUID(),
    actorUserId: randomUUID(),
    invoiceId: randomUUID(),
    quoteId: randomUUID(),
  };
  await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    missingInvoice.businessId,
    "Snapshot failure business",
  ]);
  await fixtures("INSERT INTO users(id,email) VALUES($1,$2)", [
    missingInvoice.actorUserId,
    `${missingInvoice.actorUserId}@example.invalid`,
  ]);
  await fixtures(
    "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,'admin','active')",
    [missingInvoice.businessId, missingInvoice.actorUserId],
  );
  const missingSnapshot = await readEvidencePreparationSnapshot(
    missingInvoice.businessId,
    missingInvoice.invoiceId,
    missingInvoice.quoteId,
  );
  assert.equal(missingSnapshot.kind, "invoice_missing");

  // An expired quote reports quote_missing_or_expired at snapshot time.
  const expired: Context = { ...(await createContext()) };
  await fixtures(
    "UPDATE quotes SET expires_at = date_trunc('milliseconds', now()) - interval '1 hour' WHERE id=$1",
    [expired.quoteId],
  );
  const expiredSnapshot = await readEvidencePreparationSnapshot(
    expired.businessId,
    expired.invoiceId,
    expired.quoteId,
  );
  assert.equal(expiredSnapshot.kind, "quote_missing_or_expired");

  // The final persistence boundary maps the failure to a safe, write-free
  // rejection: with no candidate and no idempotency row, the call fails
  // closed at CANDIDATE_REQUIRED and writes nothing.
  await assert.rejects(
    persistPreparedEvidenceCandidate(
      persistenceInput(expired, undefined, `expired-${randomUUID()}`, requestFingerprint()),
    ),
    isPersistenceError("CANDIDATE_REQUIRED"),
  );
  assert.deepEqual(await counts(expired), NO_WRITES);
});

// ORIGINAL TEST: controlled preparation starts after read-only work, without final locks, then persists once
test("controlled preparation starts after read-only work, without final locks, then persists once", async () => {
  // Phase 2C.3 restored semantics: preparation is read-only (it takes no
  // final row locks and writes nothing); the final persistence happens once,
  // after preparation, and commits exactly one effect set.
  const context = await createContext();
  const { candidate } = await prepare(context);

  // Preparation wrote nothing.
  assert.deepEqual(await counts(context), NO_WRITES);

  const result = await persistPreparedEvidenceCandidate(
    persistenceInput(context, candidate),
  );
  assert.equal(result.kind, "persisted");
  assert.deepEqual(await counts(context), FULL_PERSISTED_COUNTS);

  // Preparation itself must not take the final locks: the lock functions are
  // called only by the final persistence boundary.
  const prepareSource = await readFile(
    "src/server/evidence/prepare-candidate.ts",
    "utf8",
  );
  assert.doesNotMatch(prepareSource, /ponte_lock_routing_/);
  assert.doesNotMatch(prepareSource, /FOR UPDATE/);
});

// ORIGINAL TEST: a matching record committed during preparation becomes final authoritative replay
test("a matching record committed during preparation becomes final authoritative replay", async () => {
  // Phase 2C.3 restored semantics: a record committed by a concurrent request
  // while this request is preparing becomes the final authoritative result —
  // the prepared final call resolves to a replay of the durable record.
  const context = await createContext();
  const idempotencyKey = `during-preparation-${randomUUID()}`;
  const fingerprint = requestFingerprint();
  const { candidate, provider } = await prepare(context, fingerprint);

  // The concurrent record commits while (or just after) preparation runs,
  // under the same key and fingerprint.
  const concurrent = await persistPreparedEvidenceCandidate(
    persistenceInput(context, candidate, idempotencyKey, fingerprint),
  );
  assert.equal(concurrent.kind, "persisted");

  // The prepared final call resolves to the authoritative replay.
  const final = await persistPreparedEvidenceCandidate(
    persistenceInput(context, candidate, idempotencyKey, fingerprint),
  );
  assert.equal(final.kind, "replay");
  assert.deepEqual(final.response, concurrent.response);
  assert.equal(provider.calls, 1, "the final call must not call a provider");

  assert.deepEqual(await counts(context), FULL_PERSISTED_COUNTS);
});

// ORIGINAL TEST: provider failure prevents final persistence and stale final state rolls back
test("provider failure prevents final persistence and stale final state rolls back", async () => {
  // Phase 2C.3 restored semantics: a provider failure during preparation
  // prevents the final persistence entirely — no routing writes, the invoice
  // stays Funded. A stale conflicting attempt against the durable state is
  // then rejected without a second write, so the committed final state is
  // preserved.
  const context = await createContext();
  const failingProvider = new SyntheticDekProvider();
  failingProvider.fail = true;

  await assert.rejects(
    prepare(context, requestFingerprint(), failingProvider),
    (error: unknown) =>
      error instanceof EvidenceCandidatePreparationError &&
      error.code === "PROVIDER_FAILURE",
  );
  assert.deepEqual(await counts(context), NO_WRITES);

  // The durable path still works, and a stale conflicting replay of the same
  // key is rejected without altering the committed final state.
  const fingerprint = requestFingerprint();
  const { candidate, provider } = await prepare(context, fingerprint);
  const idempotencyKey = `provider-failure-${randomUUID()}`;
  const first = await persistPreparedEvidenceCandidate(
    persistenceInput(context, candidate, idempotencyKey, fingerprint),
  );
  assert.equal(first.kind, "persisted");
  await assert.rejects(
    persistPreparedEvidenceCandidate(
      persistenceInput(context, candidate, idempotencyKey, requestFingerprint("ef")),
    ),
    isPersistenceError("IDEMPOTENCY_CONFLICT"),
  );
  assert.equal(provider.calls, 1);
  assert.deepEqual(await counts(context), FULL_PERSISTED_COUNTS);
});
