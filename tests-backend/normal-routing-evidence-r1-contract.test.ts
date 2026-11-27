// Contracts restored from the pre-R1 normal-routing-evidence suite.
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
import { after, test } from "node:test";
import { quote } from "../src/lib/quotes";
import { pool } from "../src/server/repository";
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
  prepareEvidenceCandidate,
  type PreparedEvidenceCandidate,
} from "../src/server/evidence/prepare-candidate";
import { readEvidencePreparationSnapshot } from "../src/server/repository";
import { fixtures } from "./helpers/fixtures";

const REGISTRY_ADDRESS = "0x1111111111111111111111111111111111111111";

class SyntheticDekProvider implements DekProvider {
  readonly provider = KMS_PROVIDER.LOCAL_TEST_ONLY;
  calls = 0;

  async createAndWrapDek(
    _context: DekWrappingContext,
  ): Promise<CreatedAndWrappedDek> {
    this.calls += 1;
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
  idempotencyKey = `evidence-${randomUUID()}`,
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
    reference: `EVIDENCE-PERSIST-${invoiceId}`,
    supplier: "Final evidence persistence test supplier",
    wallet: `0x${"c".repeat(40)}`,
    amount: 25000.01,
    fundingMinor,
    fundingCurrency: "BRL",
    settlementCurrency: "USDG",
    due: "2035-12-20",
    description: "Synthetic final evidence persistence test only",
    status: "Funded",
    created: "2026-11-19",
    quote: persistedQuote,
  };

  await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    businessId,
    "Evidence persistence test business",
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

function isPersistenceError(
  code: EvidencePersistenceError["code"],
): (error: unknown) => boolean {
  return (error) =>
    error instanceof EvidencePersistenceError && error.code === code;
}

after(async () => {
  await pool.end();
});

// ORIGINAL TEST: normal Routing endpoint atomically persists simulated settlement, encrypted evidence, pending outbox, event, and replay
test("normal Routing endpoint atomically persists simulated settlement, encrypted evidence, pending outbox, event, and replay", async () => {
  // Phase 2C.3 restored semantics: the membership and quote locks are carried
  // by the SECURITY DEFINER lock functions, so the persistence path runs to
  // completion and commits one full final-persistence effect set.
  const context = await createContext();
  const idempotencyKey = `normal-routing-${randomUUID()}`;
  const fingerprint = requestFingerprint();
  const { candidate, provider } = await prepare(context, fingerprint);

  const first = await persistPreparedEvidenceCandidate(
    persistenceInput(context, candidate, idempotencyKey, fingerprint),
  );
  assert.equal(first.kind, "persisted");
  assert.deepEqual(await counts(context), {
    evidence: "1",
    outbox: "1",
    settlements: "1",
    events: "1",
    idempotency: "1",
    status: "Routing",
  });

  // The same key and fingerprint replays the durable response without a
  // second write or a provider call.
  const replay = await persistPreparedEvidenceCandidate(
    persistenceInput(context, undefined, idempotencyKey, fingerprint),
  );
  assert.equal(replay.kind, "replay");
  assert.deepEqual(replay.response, first.response);
  assert.equal(provider.calls, 1, "a replay must not call a provider");
  assert.deepEqual(await counts(context), {
    evidence: "1",
    outbox: "1",
    settlements: "1",
    events: "1",
    idempotency: "1",
    status: "Routing",
  });
});

// ORIGINAL TEST: final locked-row validation failure rolls back all normal Routing writes
test("final locked-row validation failure rolls back all normal Routing writes", async () => {
  // Phase 2C.3 restored semantics: the final locked-row validation compares
  // the candidate against the rows locked by the two lock functions, so a
  // drifted quote row fails with CANDIDATE_MISMATCH and the transaction
  // rolls back every write.
  const context = await createContext();
  const fingerprint = requestFingerprint();
  const { candidate } = await prepare(context, fingerprint);

  // Mutate the quote row after preparation; the locked row no longer matches
  // the frozen candidate (a hypothetical stale quote row). The quote UPDATE
  // runs as the administrative identity: the application holds no UPDATE on
  // `quotes`.
  await fixtures(
    "UPDATE quotes SET data = jsonb_set(data, '{fundingMinor}', '\"9999999\"') WHERE id=$1",
    [context.quoteId],
  );

  await assert.rejects(
    persistPreparedEvidenceCandidate(persistenceInput(context, candidate, undefined, fingerprint)),
    isPersistenceError("CANDIDATE_MISMATCH"),
  );

  assert.deepEqual(await counts(context), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "0",
    status: "Funded",
  });
});

// ORIGINAL TEST: concurrent identical normal Routing requests commit one operation and return a durable replay
test("concurrent identical normal Routing requests commit one operation and return a durable replay", async () => {
  // Phase 2C.3 restored semantics: concurrent duplicates serialize on the
  // idempotency advisory lock, one persists, the rest replay the durable
  // response, and exactly one effect set survives.
  const context = await createContext();
  const idempotencyKey = `normal-routing-concurrent-${randomUUID()}`;
  const fingerprint = requestFingerprint();
  const { candidate } = await prepare(context, fingerprint);

  const attempts = await Promise.all(
    Array.from({ length: 4 }, () =>
      persistPreparedEvidenceCandidate(
        persistenceInput(context, candidate, idempotencyKey, fingerprint),
      ),
    ),
  );
  const persisted = attempts.filter((result) => result.kind === "persisted");
  const replays = attempts.filter((result) => result.kind === "replay");
  assert.equal(persisted.length, 1);
  assert.equal(replays.length, 3);
  for (const replay of replays)
    assert.deepEqual(replay.response, persisted[0].response);

  assert.deepEqual(await counts(context), {
    evidence: "1",
    outbox: "1",
    settlements: "1",
    events: "1",
    idempotency: "1",
    status: "Routing",
  });
});

// ORIGINAL TEST: normal Routing rejects a same-key conflicting payload without a second write
test("normal Routing rejects a same-key conflicting payload without a second write", async () => {
  // Phase 2C.3 restored semantics: a second persist with the same idempotency
  // key but a different fingerprint is an authoritative conflict, and no
  // second write or state change occurs.
  const context = await createContext();
  const idempotencyKey = `normal-routing-conflict-${randomUUID()}`;
  const { candidate } = await prepare(context, requestFingerprint("cd"));

  const first = await persistPreparedEvidenceCandidate(
    persistenceInput(context, candidate, idempotencyKey, requestFingerprint("cd")),
  );
  assert.equal(first.kind, "persisted");

  await assert.rejects(
    persistPreparedEvidenceCandidate(
      persistenceInput(context, candidate, idempotencyKey, requestFingerprint("ef")),
    ),
    isPersistenceError("IDEMPOTENCY_CONFLICT"),
  );

  assert.deepEqual(await counts(context), {
    evidence: "1",
    outbox: "1",
    settlements: "1",
    events: "1",
    idempotency: "1",
    status: "Routing",
  });
});
