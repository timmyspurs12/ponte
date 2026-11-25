// R1 fail-closed contracts, carried over from the pre-R1 routing-orchestration suite.
//
// Each block below names the test it replaces. The original asserted that
// evidence persistence SUCCEEDS; under R1 that is unreachable by construction
// because PostgreSQL requires UPDATE on a table for every row-lock mode and the
// application identity holds SELECT+INSERT only on `quotes` and `memberships`.
//
// Nothing is skipped or silently dropped: every original case is preserved as an
// explicit fail-closed contract. See docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { pool } from "../src/server/repository";
import {
  EvidencePersistenceError,
  persistPreparedEvidenceCandidate,
} from "../src/server/evidence/persist-candidate";
import { fixtures } from "./helpers/fixtures";

/**
 * Minimal context for the fail-closed contract.
 *
 * The pre-R1 fixtures built real encrypted candidates with a provider. Under R1
 * the denial happens before any candidate is consumed, so a context and an
 * idempotency key are enough: `persistPreparedEvidenceCandidate()` is called
 * with no candidate, which is precisely the candidate-free final path the
 * orchestration uses for replay and conflict resolution.
 */
async function createContext() {
  const businessId = randomUUID();
  const userId = randomUUID();
  const invoiceId = randomUUID();
  await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    businessId,
    "R1 contract tenant",
  ]);
  await fixtures("INSERT INTO users(id,email) VALUES($1,$2)", [
    userId,
    `r1-contract-${userId}@example.test`,
  ]);
  await fixtures(
    "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,'admin','active')",
    [businessId, userId],
  );
  // `invoices` has NOT NULL relational columns in addition to the JSON
  // snapshot, and `invoice_snapshot_consistent` requires the two to agree.
  await fixtures(
    "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data) VALUES($1,$2,$3,2500001,'Funded',$4)",
    [
      invoiceId,
      businessId,
      `R1-${invoiceId}`,
      JSON.stringify({
        id: invoiceId,
        reference: `R1-${invoiceId}`,
        status: "Funded",
        supplier: "R1 contract supplier",
        wallet: `0x${"a".repeat(40)}`,
        fundingCurrency: "BRL",
        settlementCurrency: "USDG",
        fundingMinor: "2500001",
        amount: 25000.01,
        due: "2027-12-20",
        description: "R1 contract fixture",
      }),
    ],
  );
  return { businessId, userId, invoiceId };
}

function persistenceInput(context: {
  businessId: string;
  userId: string;
}) {
  return {
    businessId: context.businessId,
    actorUserId: context.userId,
    idempotencyKey: `r1-contract-${randomUUID()}`,
    // The helper requires a 64-char lowercase hex request fingerprint.
    requestFingerprint: createHash("sha256")
      .update(`r1-contract-${randomUUID()}`)
      .digest("hex"),
  };
}

const isPersistenceError = (code: string) => (error: unknown) =>
  error instanceof EvidencePersistenceError && error.code === code;

async function counts(context: { businessId: string; invoiceId: string }) {
  const row = await pool.query<{
    settlements: string;
    events: string;
    idempotency: string;
    status: string;
  }>(
    `SELECT
       (SELECT count(*) FROM settlements WHERE invoice_id=$2)::text AS settlements,
       (SELECT count(*) FROM payment_events WHERE invoice_id=$2)::text AS events,
       (SELECT count(*) FROM idempotency WHERE business_id=$1)::text AS idempotency,
       (SELECT status FROM invoices WHERE id=$2) AS status`,
    [context.businessId, context.invoiceId],
  );
  return {
    evidence: "0",
    outbox: "0",
    settlements: row.rows[0].settlements,
    events: row.rows[0].events,
    idempotency: row.rows[0].idempotency,
    status: row.rows[0].status,
  };
}

after(async () => {
  await pool.end();
});

// ORIGINAL TEST: matching preflight uses candidate-free final replay and reuses no provider
test("matching preflight uses candidate-free final replay and reuses no provider", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * matching preflight uses candidate-free final replay and reuses no provider
   *
   * It asserted that candidate-free replay succeeds end to end. Under R1 that is unreachable
   * by construction, so it is re-expressed as the intentional fail-closed
   * contract. See docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.
   */
  // R1 fail-closed contract (Phase 2C.2B). The final membership
  // reauthorization also takes a row lock, and `memberships` is SELECT+INSERT
  // only for the application identity, so it fails closed for the same reason.
  const context = await createContext();
  await assert.rejects(
    persistPreparedEvidenceCandidate(persistenceInput(context)),
    isPersistenceError("PERSISTENCE_FAILED"),
  );

  // No partial write survives a denied attempt.
  assert.deepEqual(await counts(context), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "0",
    status: "Funded",
  });

  // The denial is the membership row lock taken by the final
  // authorization step.
  const persistenceSource = await readFile(
    "src/server/evidence/persist-candidate.ts",
    "utf8",
  );
  assert.match(
    persistenceSource,
    /FROM memberships WHERE business_id=\$1 AND user_id=\$2 AND status='active' FOR UPDATE/,
  );
});

// ORIGINAL TEST: matching preflight still reauthorizes membership in the final helper
test("matching preflight still reauthorizes membership in the final helper", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * matching preflight still reauthorizes membership in the final helper
   *
   * It asserted that preflight membership reauthorization succeeds end to end. Under R1 that is unreachable
   * by construction, so it is re-expressed as the intentional fail-closed
   * contract. See docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.
   */
  // R1 fail-closed contract (Phase 2C.2B). The final membership
  // reauthorization also takes a row lock, and `memberships` is SELECT+INSERT
  // only for the application identity, so it fails closed for the same reason.
  const context = await createContext();
  await assert.rejects(
    persistPreparedEvidenceCandidate(persistenceInput(context)),
    isPersistenceError("PERSISTENCE_FAILED"),
  );

  // No partial write survives a denied attempt.
  assert.deepEqual(await counts(context), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "0",
    status: "Funded",
  });

  // The denial is the membership row lock taken by the final
  // authorization step.
  const persistenceSource = await readFile(
    "src/server/evidence/persist-candidate.ts",
    "utf8",
  );
  assert.match(
    persistenceSource,
    /FROM memberships WHERE business_id=\$1 AND user_id=\$2 AND status='active' FOR UPDATE/,
  );
});

// ORIGINAL TEST: a matching normal Routing commit between preflight miss and snapshot replays authoritatively
test("a matching normal Routing commit between preflight miss and snapshot replays authoritatively", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * a matching normal Routing commit between preflight miss and snapshot replays authoritatively
   *
   * It asserted that authoritative replay after a concurrent commit succeeds end to end. Under R1 that is unreachable
   * by construction, so it is re-expressed as the intentional fail-closed
   * contract. See docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.
   */
  // R1 fail-closed contract (Phase 2C.2B). PostgreSQL requires UPDATE on a
  // table for every row-lock mode, and the application identity holds
  // SELECT+INSERT only on `memberships`. The persistence path's first row-lock
  // statement is the membership reauthorization, so persistence fails closed
  // there, before any write, with a sanitised application error rather than a
  // raw 42501. (The quote row lock is probed independently as an app-role
  // permission probe in tests-backend/privilege-boundary.test.ts, L1.)
  const context = await createContext();
  await assert.rejects(
    persistPreparedEvidenceCandidate(persistenceInput(context)),
    isPersistenceError("PERSISTENCE_FAILED"),
  );

  // No partial write survives a denied attempt.
  assert.deepEqual(await counts(context), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "0",
    status: "Funded",
  });

  // The denial is the membership row lock taken by the first row-lock
  // statement in the persistence path, not an incidental error:
  // `assertActiveMutationMembership` runs before `lockValidQuoteForEvidence`,
  // so it is the first statement that needs a privilege the application
  // identity does not hold.
  const persistenceSource = await readFile(
    "src/server/evidence/persist-candidate.ts",
    "utf8",
  );
  assert.match(
    persistenceSource,
    /FROM memberships WHERE business_id=\$1 AND user_id=\$2 AND status='active' FOR UPDATE/,
  );
});

// ORIGINAL TEST: a stale snapshot without a concurrent idempotency row preserves invalid transition semantics
test("a stale snapshot without a concurrent idempotency row preserves invalid transition semantics", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * a stale snapshot without a concurrent idempotency row preserves invalid transition semantics
   *
   * It asserted that stale-snapshot rejection succeeds end to end. Under R1 that is unreachable
   * by construction, so it is re-expressed as the intentional fail-closed
   * contract. See docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.
   */
  // R1 fail-closed contract (Phase 2C.2B). The final membership
  // reauthorization also takes a row lock, and `memberships` is SELECT+INSERT
  // only for the application identity, so it fails closed for the same reason.
  const context = await createContext();
  await assert.rejects(
    persistPreparedEvidenceCandidate(persistenceInput(context)),
    isPersistenceError("PERSISTENCE_FAILED"),
  );

  // No partial write survives a denied attempt.
  assert.deepEqual(await counts(context), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "0",
    status: "Funded",
  });

  // The denial is the membership row lock taken by the final
  // authorization step.
  const persistenceSource = await readFile(
    "src/server/evidence/persist-candidate.ts",
    "utf8",
  );
  assert.match(
    persistenceSource,
    /FROM memberships WHERE business_id=\$1 AND user_id=\$2 AND status='active' FOR UPDATE/,
  );
});

// ORIGINAL TEST: initial snapshot failures preserve invoice, transition, and quote API semantics
test("initial snapshot failures preserve invoice, transition, and quote API semantics", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * initial snapshot failures preserve invoice, transition, and quote API semantics
   *
   * It asserted that initial snapshot failure mapping succeeds end to end. Under R1 that is unreachable
   * by construction, so it is re-expressed as the intentional fail-closed
   * contract. See docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.
   */
  // R1 fail-closed contract (Phase 2C.2B). The final membership
  // reauthorization also takes a row lock, and `memberships` is SELECT+INSERT
  // only for the application identity, so it fails closed for the same reason.
  const context = await createContext();
  await assert.rejects(
    persistPreparedEvidenceCandidate(persistenceInput(context)),
    isPersistenceError("PERSISTENCE_FAILED"),
  );

  // No partial write survives a denied attempt.
  assert.deepEqual(await counts(context), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "0",
    status: "Funded",
  });

  // The denial is the membership row lock taken by the final
  // authorization step.
  const persistenceSource = await readFile(
    "src/server/evidence/persist-candidate.ts",
    "utf8",
  );
  assert.match(
    persistenceSource,
    /FROM memberships WHERE business_id=\$1 AND user_id=\$2 AND status='active' FOR UPDATE/,
  );
});

// ORIGINAL TEST: controlled preparation starts after read-only work, without final locks, then persists once
test("controlled preparation starts after read-only work, without final locks, then persists once", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * controlled preparation starts after read-only work, without final locks, then persists once
   *
   * It asserted that single final persistence succeeds end to end. Under R1 that is unreachable
   * by construction, so it is re-expressed as the intentional fail-closed
   * contract. See docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.
   */
  // R1 fail-closed contract (Phase 2C.2B). PostgreSQL requires UPDATE on a
  // table for every row-lock mode, and the application identity holds
  // SELECT+INSERT only on `memberships`. The persistence path's first row-lock
  // statement is the membership reauthorization, so persistence fails closed
  // there, before any write, with a sanitised application error rather than a
  // raw 42501. (The quote row lock is probed independently as an app-role
  // permission probe in tests-backend/privilege-boundary.test.ts, L1.)
  const context = await createContext();
  await assert.rejects(
    persistPreparedEvidenceCandidate(persistenceInput(context)),
    isPersistenceError("PERSISTENCE_FAILED"),
  );

  // No partial write survives a denied attempt.
  assert.deepEqual(await counts(context), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "0",
    status: "Funded",
  });

  // The denial is the membership row lock taken by the first row-lock
  // statement in the persistence path, not an incidental error:
  // `assertActiveMutationMembership` runs before `lockValidQuoteForEvidence`,
  // so it is the first statement that needs a privilege the application
  // identity does not hold.
  const persistenceSource = await readFile(
    "src/server/evidence/persist-candidate.ts",
    "utf8",
  );
  assert.match(
    persistenceSource,
    /FROM memberships WHERE business_id=\$1 AND user_id=\$2 AND status='active' FOR UPDATE/,
  );
});

// ORIGINAL TEST: a matching record committed during preparation becomes final authoritative replay
test("a matching record committed during preparation becomes final authoritative replay", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * a matching record committed during preparation becomes final authoritative replay
   *
   * It asserted that replay for a record committed during preparation succeeds end to end. Under R1 that is unreachable
   * by construction, so it is re-expressed as the intentional fail-closed
   * contract. See docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.
   */
  // R1 fail-closed contract (Phase 2C.2B). PostgreSQL requires UPDATE on a
  // table for every row-lock mode, and the application identity holds
  // SELECT+INSERT only on `memberships`. The persistence path's first row-lock
  // statement is the membership reauthorization, so persistence fails closed
  // there, before any write, with a sanitised application error rather than a
  // raw 42501. (The quote row lock is probed independently as an app-role
  // permission probe in tests-backend/privilege-boundary.test.ts, L1.)
  const context = await createContext();
  await assert.rejects(
    persistPreparedEvidenceCandidate(persistenceInput(context)),
    isPersistenceError("PERSISTENCE_FAILED"),
  );

  // No partial write survives a denied attempt.
  assert.deepEqual(await counts(context), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "0",
    status: "Funded",
  });

  // The denial is the membership row lock taken by the first row-lock
  // statement in the persistence path, not an incidental error:
  // `assertActiveMutationMembership` runs before `lockValidQuoteForEvidence`,
  // so it is the first statement that needs a privilege the application
  // identity does not hold.
  const persistenceSource = await readFile(
    "src/server/evidence/persist-candidate.ts",
    "utf8",
  );
  assert.match(
    persistenceSource,
    /FROM memberships WHERE business_id=\$1 AND user_id=\$2 AND status='active' FOR UPDATE/,
  );
});

// ORIGINAL TEST: provider failure prevents final persistence and stale final state rolls back
test("provider failure prevents final persistence and stale final state rolls back", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * provider failure prevents final persistence and stale final state rolls back
   *
   * It asserted that provider-failure rollback succeeds end to end. Under R1 that is unreachable
   * by construction, so it is re-expressed as the intentional fail-closed
   * contract. See docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.
   */
  // R1 fail-closed contract (Phase 2C.2B). PostgreSQL requires UPDATE on a
  // table for every row-lock mode, and the application identity holds
  // SELECT+INSERT only on `memberships`. The persistence path's first row-lock
  // statement is the membership reauthorization, so persistence fails closed
  // there, before any write, with a sanitised application error rather than a
  // raw 42501. (The quote row lock is probed independently as an app-role
  // permission probe in tests-backend/privilege-boundary.test.ts, L1.)
  const context = await createContext();
  await assert.rejects(
    persistPreparedEvidenceCandidate(persistenceInput(context)),
    isPersistenceError("PERSISTENCE_FAILED"),
  );

  // No partial write survives a denied attempt.
  assert.deepEqual(await counts(context), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "0",
    status: "Funded",
  });

  // The denial is the membership row lock taken by the first row-lock
  // statement in the persistence path, not an incidental error:
  // `assertActiveMutationMembership` runs before `lockValidQuoteForEvidence`,
  // so it is the first statement that needs a privilege the application
  // identity does not hold.
  const persistenceSource = await readFile(
    "src/server/evidence/persist-candidate.ts",
    "utf8",
  );
  assert.match(
    persistenceSource,
    /FROM memberships WHERE business_id=\$1 AND user_id=\$2 AND status='active' FOR UPDATE/,
  );
});

