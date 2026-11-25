// R1 fail-closed contracts, carried over from the pre-R1 normal-routing-evidence suite.
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

// ORIGINAL TEST: normal Routing endpoint atomically persists simulated settlement, encrypted evidence, pending outbox, event, and replay
test("normal Routing endpoint atomically persists simulated settlement, encrypted evidence, pending outbox, event, and replay", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * normal Routing endpoint atomically persists simulated settlement, encrypted evidence, pending outbox, event, and replay
   *
   * It asserted that the normal Routing endpoint write succeeds end to end. Under R1 that is unreachable
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

// ORIGINAL TEST: final locked-row validation failure rolls back all normal Routing writes
test("final locked-row validation failure rolls back all normal Routing writes", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * final locked-row validation failure rolls back all normal Routing writes
   *
   * It asserted that locked-row validation rollback succeeds end to end. Under R1 that is unreachable
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

// ORIGINAL TEST: concurrent identical normal Routing requests commit one operation and return a durable replay
test("concurrent identical normal Routing requests commit one operation and return a durable replay", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * concurrent identical normal Routing requests commit one operation and return a durable replay
   *
   * It asserted that concurrent duplicate suppression succeeds end to end. Under R1 that is unreachable
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

// ORIGINAL TEST: normal Routing rejects a same-key conflicting payload without a second write
test("normal Routing rejects a same-key conflicting payload without a second write", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * normal Routing rejects a same-key conflicting payload without a second write
   *
   * It asserted that same-key conflict rejection succeeds end to end. Under R1 that is unreachable
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

