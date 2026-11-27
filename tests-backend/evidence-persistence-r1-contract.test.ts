// Contracts restored from the pre-R1 evidence-persistence suite.
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
import { pool } from "../src/server/repository";
import {
  EvidencePersistenceError,
  persistPreparedEvidenceCandidate,
  type EvidencePersistenceTestHooks,
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

/** Adds a second mutation-capable actor to the same business. */
async function createSecondMutationActor(context: Context): Promise<string> {
  const actorUserId = randomUUID();
  await fixtures("INSERT INTO users(id,email) VALUES($1,$2)", [
    actorUserId,
    `${actorUserId}@example.invalid`,
  ]);
  await fixtures(
    "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,'operator','active')",
    [context.businessId, actorUserId],
  );
  return actorUserId;
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

// ORIGINAL TEST: persists one frozen simulated evidence candidate, pending outbox, Routing invoice, event, and response
test("persists one frozen simulated evidence candidate, pending outbox, Routing invoice, event, and response", async () => {
  // Phase 2C.3 restored semantics: the membership and quote locks are carried
  // by the SECURITY DEFINER lock functions, so the full final persistence
  // runs and commits one frozen evidence record, one pending outbox row, the
  // Routing invoice state, and one event.
  const context = await createContext();
  const { candidate, provider } = await prepare(context);

  const result = await persistPreparedEvidenceCandidate(
    persistenceInput(context, candidate),
  );
  assert.equal(result.kind, "persisted");
  assert.deepEqual(await counts(context), FULL_PERSISTED_COUNTS);

  // The response is the persisted invoice JSON view, not candidate bytes.
  const response = result.response as { status: string; selectedRoute?: string };
  assert.equal(response.status, "Routing");
  assert.ok(response.selectedRoute);
  assert.equal(provider.calls, 1);
});

// ORIGINAL TEST: same-key races serialize into one persistence and an authorized candidate-free replay
test("same-key races serialize into one persistence and an authorized candidate-free replay", async () => {
  // Phase 2C.3 restored semantics: concurrent same-key attempts serialize on
  // the idempotency advisory lock; exactly one persists, the rest return the
  // durable candidate-free replay.
  const context = await createContext();
  const idempotencyKey = `same-key-race-${randomUUID()}`;
  const fingerprint = requestFingerprint();
  const { candidate } = await prepare(context, fingerprint);

  const attempts = await Promise.all([
    persistPreparedEvidenceCandidate(
      persistenceInput(context, candidate, idempotencyKey, fingerprint),
    ),
    persistPreparedEvidenceCandidate(
      persistenceInput(context, undefined, idempotencyKey, fingerprint),
    ),
    persistPreparedEvidenceCandidate(
      persistenceInput(context, undefined, idempotencyKey, fingerprint),
    ),
  ]);
  const persisted = attempts.filter((result) => result.kind === "persisted");
  const replays = attempts.filter((result) => result.kind === "replay");
  assert.equal(persisted.length, 1);
  assert.equal(replays.length, 2);
  for (const replay of replays)
    assert.deepEqual(replay.response, persisted[0].response);

  assert.deepEqual(await counts(context), FULL_PERSISTED_COUNTS);
});

// ORIGINAL TEST: different idempotency keys and actors racing the same invoice leave one routed persistence and no loser writes
test("different idempotency keys and actors racing the same invoice leave one routed persistence and no loser writes", {
  timeout: 5000,
}, async () => {
  // Phase 2C.3 restored semantics: cross-key invoice arbitration is decided
  // by the invoice row lock. The winner persists; the loser's locked rows
  // now show the winner's state and its candidate no longer matches, so the
  // loser fails with CANDIDATE_MISMATCH and writes nothing.
  const context = await createContext();
  const secondActor = await createSecondMutationActor(context);
  const winnerFingerprint = requestFingerprint("aa");
  const loserFingerprint = requestFingerprint("bb");
  const winner = await prepare(context, winnerFingerprint, new SyntheticDekProvider(), context.actorUserId);
  const loser = await prepare(
    context,
    loserFingerprint,
    new SyntheticDekProvider(),
    secondActor,
  );

  const attempts = await Promise.allSettled([
    persistPreparedEvidenceCandidate(
      persistenceInput(context, winner.candidate, `winner-${randomUUID()}`, winnerFingerprint),
    ),
    persistPreparedEvidenceCandidate(
      persistenceInput({ ...context, actorUserId: secondActor }, loser.candidate, `loser-${randomUUID()}`, loserFingerprint),
    ),
  ]);
  const fulfilled = attempts.filter((a) => a.status === "fulfilled");
  const rejected = attempts.filter((a) => a.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof EvidencePersistenceError);
  assert.equal(
    (rejected[0].reason as unknown as EvidencePersistenceError).code,
    "CANDIDATE_MISMATCH",
  );

  assert.deepEqual(await counts(context), FULL_PERSISTED_COUNTS);
});

// ORIGINAL TEST: final locked rows reject persisted invoice, quote, economics, and route drift before any write
test("final locked rows reject persisted invoice, quote, economics, and route drift before any write", async () => {
  // Phase 2C.3 restored semantics: the final locked-row validation compares
  // the frozen candidate against the rows locked through the lock functions.
  // Every drift class — invoice snapshot, quote data, funding economics, and
  // the locked route economics — is rejected with CANDIDATE_MISMATCH before
  // any write, and the transaction rolls back.
  const drifts: Array<{
    name: string;
    drift: (context: Context) => Promise<void>;
    restore?: (context: Context) => Promise<void>;
  }> = [
    {
      name: "invoice snapshot drift",
      drift: async (context) => {
        await pool.query(
          "UPDATE invoices SET status='Pending payment', data=jsonb_set(data, '{status}', '\"Pending payment\"') WHERE id=$1",
          [context.invoiceId],
        );
      },
      restore: async (context) => {
        await pool.query(
          "UPDATE invoices SET status='Funded', data=jsonb_set(data, '{status}', '\"Funded\"') WHERE id=$1",
          [context.invoiceId],
        );
      },
    },
    {
      name: "quote data drift",
      drift: async (context) => {
        await fixtures(
          "UPDATE quotes SET data = jsonb_set(data, '{fundingMinor}', '\"9999999\"') WHERE id=$1",
          [context.quoteId],
        );
      },
    },
    {
      name: "funding economics drift",
      drift: async (context) => {
        await pool.query(
          "UPDATE invoices SET funding_minor = '9999999', data = jsonb_set(jsonb_set(data, '{fundingMinor}', '\"9999999\"'), '{amount}', '99999.99'::jsonb) WHERE id=$1",
          [context.invoiceId],
        );
      },
    },
    {
      name: "route economics drift",
      drift: async (context) => {
        await fixtures(
          "UPDATE quotes SET data = jsonb_set(data, '{routes,1,outputMinor}', '\"1\"') WHERE id=$1",
          [context.quoteId],
        );
      },
    },
  ];;

  for (const { name, drift, restore } of drifts) {
    const context = await createContext();
    const { candidate } = await prepare(context);
    await drift(context);
    await assert.rejects(
      persistPreparedEvidenceCandidate(persistenceInput(context, candidate)),
      isPersistenceError("CANDIDATE_MISMATCH"),
      `expected CANDIDATE_MISMATCH for ${name}`,
    );
    if (restore) await restore(context);
    assert.deepEqual(await counts(context), NO_WRITES, `expected no writes for ${name}`);
  }
});

// ORIGINAL TEST: PostgreSQL-time quote expiry rejects the candidate before any write
test("PostgreSQL-time quote expiry rejects the candidate before any write", async () => {
  // Phase 2C.3 restored semantics: the quote lock function applies the
  // database-time expiry predicate at lock time. An expired quote returns
  // zero rows from `ponte_lock_routing_quote`, so persistence fails with
  // INVOICE_OR_QUOTE_UNAVAILABLE before any write.
  const context = await createContext();
  const { candidate } = await prepare(context);

  await fixtures(
    "UPDATE quotes SET expires_at = date_trunc('milliseconds', now()) - interval '1 hour' WHERE id=$1",
    [context.quoteId],
  );

  await assert.rejects(
    persistPreparedEvidenceCandidate(persistenceInput(context, candidate)),
    isPersistenceError("INVOICE_OR_QUOTE_UNAVAILABLE"),
  );
  assert.deepEqual(await counts(context), NO_WRITES);
});

// ORIGINAL TEST: revoked or viewer memberships cannot persist or disclose a durable replay
test("revoked or viewer memberships cannot persist or disclose a durable replay", async () => {
  // Phase 2C.3 semantics: authorization is re-checked against the membership
  // row locked by `ponte_lock_routing_membership` on EVERY path. A revoked or
  // viewer membership fails with FORBIDDEN for both a new persistence and a
  // durable replay — including when the replay fingerprint matches, which
  // proves membership is checked before the fingerprint is compared.
  const context = await createContext();
  const idempotencyKey = `revoked-replay-${randomUUID()}`;
  const fingerprint = requestFingerprint();
  const { candidate } = await prepare(context, fingerprint);

  // The admin persists successfully first, creating the durable record.
  const first = await persistPreparedEvidenceCandidate(
    persistenceInput(context, candidate, idempotencyKey, fingerprint),
  );
  assert.equal(first.kind, "persisted");

  // A member whose membership is disabled replays the same key and
  // fingerprint: FORBIDDEN, not a durable disclosure.
  const revokedActor = await createSecondMutationActor(context);
  await fixtures(
    "UPDATE memberships SET status='disabled' WHERE business_id=$1 AND user_id=$2",
    [context.businessId, revokedActor],
  );
  await assert.rejects(
    persistPreparedEvidenceCandidate(
      persistenceInput(
        { ...context, actorUserId: revokedActor },
        undefined,
        idempotencyKey,
        fingerprint,
      ),
    ),
    isPersistenceError("FORBIDDEN"),
  );

  // A disabled member retrying the same key with a MISMATCHED fingerprint is
  // still FORBIDDEN, never IDEMPOTENCY_CONFLICT: the membership check runs
  // before the fingerprint comparison, so the disabled status short-circuits
  // the replay before the conflict is ever evaluated.
  await assert.rejects(
    persistPreparedEvidenceCandidate(
      persistenceInput(
        { ...context, actorUserId: revokedActor },
        undefined,
        idempotencyKey,
        requestFingerprint("ef"),
      ),
    ),
    isPersistenceError("FORBIDDEN"),
  );

  // A viewer member replaying with a CONFLICTING fingerprint is also FORBIDDEN,
  // not IDEMPOTENCY_CONFLICT: authorization precedes fingerprint comparison.
  const viewerActor = await createSecondMutationActor(context);
  await fixtures(
    "UPDATE memberships SET role='viewer' WHERE business_id=$1 AND user_id=$2",
    [context.businessId, viewerActor],
  );
  await assert.rejects(
    persistPreparedEvidenceCandidate(
      persistenceInput(
        { ...context, actorUserId: viewerActor },
        undefined,
        idempotencyKey,
        requestFingerprint("ef"),
      ),
    ),
    isPersistenceError("FORBIDDEN"),
  );

  assert.deepEqual(await counts(context), FULL_PERSISTED_COUNTS);
});

// ORIGINAL TEST: final membership authorization locks the active membership row
test("final membership authorization locks the active membership row", {
  timeout: 5000,
}, async () => {
  // Phase 2C.3 semantics: the final authorization takes the membership row
  // lock through `ponte_lock_routing_membership`. While the lock is held, a
  // concurrent transaction that tries to mutate the membership row blocks.
  const context = await createContext();

  // Session A (application identity): take the membership row lock through
  // the lock function inside an open transaction.
  const clientA = await pool.connect();
  try {
    await clientA.query("BEGIN");
    const locked = await clientA.query<{ role: string | null }>(
      "SELECT public.ponte_lock_routing_membership($1,$2) AS role",
      [context.businessId, context.actorUserId],
    );
    assert.equal(locked.rows[0].role, "admin");

    // Session B (administrative identity): a concurrent mutation of the
    // locked row must block until session A ends. The mutation is started
    // while session A still holds the lock; it must not settle during that
    // window, and it applies once the lock is released.
    let settled = false;
    const mutation = fixtures(
      "UPDATE memberships SET status='disabled' WHERE business_id=$1 AND user_id=$2",
      [context.businessId, context.actorUserId],
    ).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      settled,
      false,
      "the membership row mutation must block while the lock is held",
    );
    await clientA.query("ROLLBACK");
    await mutation;
    assert.equal(settled, true, "the mutation must complete once the lock is released");

    // After the lock is released, the mutation applies and the row is no
    // longer active.
    const after = await pool.query(
      "SELECT status FROM memberships WHERE business_id=$1 AND user_id=$2",
      [context.businessId, context.actorUserId],
    );
    assert.equal(after.rows[0].status, "disabled");
  } finally {
    clientA.release();
  }
});

// ORIGINAL TEST: every post-write failure boundary rolls back all final-persistence effects
test("every post-write failure boundary rolls back all final-persistence effects", async () => {
  // Phase 2C.3 restored semantics: a failure injected after each write step
  // (settlement, evidence, outbox, invoice, event, idempotency) aborts the
  // transaction and rolls back every earlier write.
  const steps: Array<
    Parameters<NonNullable<EvidencePersistenceTestHooks["afterWrite"]>>[0]
  > = ["settlement", "evidence", "outbox", "invoice", "event", "idempotency"];

  for (const step of steps) {
    const context = await createContext();
    const { candidate } = await prepare(context);
    const hooks: EvidencePersistenceTestHooks = {
      afterWrite: async (writtenStep) => {
        if (writtenStep === step) throw new Error(`injected ${step} failure`);
      },
    };
    await assert.rejects(
      persistPreparedEvidenceCandidate(persistenceInput(context, candidate), hooks),
      isPersistenceError("PERSISTENCE_FAILED"),
      `expected the injected ${step} failure to abort persistence`,
    );
    assert.deepEqual(await counts(context), NO_WRITES, `expected full rollback after ${step}`);
  }
});

// ORIGINAL TEST: candidate mutation is rejected without exposing candidate bytes or leaving a write
test("candidate mutation is rejected without exposing candidate bytes or leaving a write", async () => {
  // Phase 2C.3 restored semantics: a candidate whose ciphertext is mutated
  // after preparation fails integrity verification with CANDIDATE_INVALID,
  // the error carries no candidate bytes, and nothing is written.
  const context = await createContext();
  const { candidate } = await prepare(context);
  candidate.ciphertext[0] ^= 0xff;

  let thrown: unknown;
  try {
    await persistPreparedEvidenceCandidate(persistenceInput(context, candidate));
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof EvidencePersistenceError);
  assert.equal(thrown.code, "CANDIDATE_INVALID");
  const message = String((thrown as Error).message);
  assert.ok(!message.includes(candidate.ciphertext.toString("hex")));
  assert.deepEqual(await counts(context), NO_WRITES);
});

// ORIGINAL TEST: lost COMMIT acknowledgement destroys certainty and only same-key replay recovers the durable result
test("lost COMMIT acknowledgement destroys certainty and only same-key replay recovers the durable result", async () => {
  // Phase 2C.3 restored semantics: an unacknowledged COMMIT destroys
  // certainty — the caller receives COMMIT_OUTCOME_UNKNOWN and the client is
  // destroyed, so the caller cannot know whether the write landed. The only
  // recovery is a same-key replay once the commit is actually durable.
  //
  // The lost-acknowledgement path cannot be triggered deterministically
  // against a real PostgreSQL server, so the contract is asserted through
  // the two properties that encode it: the transaction wrapper converts an
  // ambiguous COMMIT failure into CommitOutcomeUnknownError and destroys the
  // client, and the persistence boundary maps that error to
  // COMMIT_OUTCOME_UNKNOWN instead of a success or a plain failure.
  const [persistenceSource, repositorySource] = await Promise.all([
    readFile("src/server/evidence/persist-candidate.ts", "utf8"),
    readFile("src/server/repository.ts", "utf8"),
  ]);
  assert.match(repositorySource, /class CommitOutcomeUnknownError/);
  assert.match(repositorySource, /db\.release\(destroyClient\)/);
  assert.match(persistenceSource, /CommitOutcomeUnknownError[\s\S]*fail\("COMMIT_OUTCOME_UNKNOWN"\)/);

  // On a real database, the durable path succeeds and a same-key replay
  // recovers the committed response without a second write or provider call.
  const context = await createContext();
  const idempotencyKey = `lost-commit-${randomUUID()}`;
  const fingerprint = requestFingerprint();
  const { candidate, provider } = await prepare(context, fingerprint);

  const first = await persistPreparedEvidenceCandidate(
    persistenceInput(context, candidate, idempotencyKey, fingerprint),
  );
  assert.equal(first.kind, "persisted");
  const recovery = await persistPreparedEvidenceCandidate(
    persistenceInput(context, undefined, idempotencyKey, fingerprint),
  );
  assert.equal(recovery.kind, "replay");
  assert.deepEqual(recovery.response, first.response);
  assert.equal(provider.calls, 1, "the replay must not call a provider");
  assert.deepEqual(await counts(context), FULL_PERSISTED_COUNTS);
});
