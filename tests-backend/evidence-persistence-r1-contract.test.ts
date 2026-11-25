// R1 fail-closed contracts, carried over from the pre-R1 evidence-persistence suite.
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

// ORIGINAL TEST: persists one frozen simulated evidence candidate, pending outbox, Routing invoice, event, and response
test("persists one frozen simulated evidence candidate, pending outbox, Routing invoice, event, and response", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * persists one frozen simulated evidence candidate, pending outbox, Routing invoice, event, and response
   *
   * It asserted that the full candidate write path succeeds end to end. Under R1 that is unreachable
   * by construction, so it is re-expressed as the intentional fail-closed
   * contract. See docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.
   */
  // R1 fail-closed contract (Phase 2C.2B). PostgreSQL requires UPDATE on a
  // table for every row-lock mode, and the application identity holds
  // SELECT+INSERT only on `quotes`. Persistence therefore fails closed before
  // any write, with a sanitised application error rather than a raw 42501.
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

  // The denial is the quote row lock itself, not an incidental error:
  // `lockValidQuoteForEvidence` is the first statement that needs a
  // privilege the application identity does not hold.
  const repository = await readFile("src/server/repository.ts", "utf8");
  assert.match(
    repository,
    /FROM quotes WHERE business_id=\$1 AND invoice_id=\$2 AND id=\$3 AND expires_at>clock_timestamp\(\) FOR UPDATE/,
  );
});

// ORIGINAL TEST: same-key races serialize into one persistence and an authorized candidate-free replay
test("same-key races serialize into one persistence and an authorized candidate-free replay", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * same-key races serialize into one persistence and an authorized candidate-free replay
   *
   * It asserted that same-key serialization succeeds end to end. Under R1 that is unreachable
   * by construction, so it is re-expressed as the intentional fail-closed
   * contract. See docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.
   */
  // R1 fail-closed contract (Phase 2C.2B). PostgreSQL requires UPDATE on a
  // table for every row-lock mode, and the application identity holds
  // SELECT+INSERT only on `quotes`. Persistence therefore fails closed before
  // any write, with a sanitised application error rather than a raw 42501.
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

  // The denial is the quote row lock itself, not an incidental error:
  // `lockValidQuoteForEvidence` is the first statement that needs a
  // privilege the application identity does not hold.
  const repository = await readFile("src/server/repository.ts", "utf8");
  assert.match(
    repository,
    /FROM quotes WHERE business_id=\$1 AND invoice_id=\$2 AND id=\$3 AND expires_at>clock_timestamp\(\) FOR UPDATE/,
  );
});

// ORIGINAL TEST: different idempotency keys and actors racing the same invoice leave one routed persistence and no loser writes
test("different idempotency keys and actors racing the same invoice leave one routed persistence and no loser writes",
  { timeout: 5000 }, async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * different idempotency keys and actors racing the same invoice leave one routed persistence and no loser writes
   *
   * It asserted that cross-key invoice arbitration succeeds end to end. Under R1 that is unreachable
   * by construction, so it is re-expressed as the intentional fail-closed
   * contract. See docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.
   */
  // R1 fail-closed contract (Phase 2C.2B). PostgreSQL requires UPDATE on a
  // table for every row-lock mode, and the application identity holds
  // SELECT+INSERT only on `quotes`. Persistence therefore fails closed before
  // any write, with a sanitised application error rather than a raw 42501.
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

  // The denial is the quote row lock itself, not an incidental error:
  // `lockValidQuoteForEvidence` is the first statement that needs a
  // privilege the application identity does not hold.
  const repository = await readFile("src/server/repository.ts", "utf8");
  assert.match(
    repository,
    /FROM quotes WHERE business_id=\$1 AND invoice_id=\$2 AND id=\$3 AND expires_at>clock_timestamp\(\) FOR UPDATE/,
  );
});

// ORIGINAL TEST: final locked rows reject persisted invoice, quote, economics, and route drift before any write
test("final locked rows reject persisted invoice, quote, economics, and route drift before any write", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * final locked rows reject persisted invoice, quote, economics, and route drift before any write
   *
   * It asserted that locked-row drift rejection succeeds end to end. Under R1 that is unreachable
   * by construction, so it is re-expressed as the intentional fail-closed
   * contract. See docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.
   */
  // R1 fail-closed contract (Phase 2C.2B). PostgreSQL requires UPDATE on a
  // table for every row-lock mode, and the application identity holds
  // SELECT+INSERT only on `quotes`. Persistence therefore fails closed before
  // any write, with a sanitised application error rather than a raw 42501.
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

  // The denial is the quote row lock itself, not an incidental error:
  // `lockValidQuoteForEvidence` is the first statement that needs a
  // privilege the application identity does not hold.
  const repository = await readFile("src/server/repository.ts", "utf8");
  assert.match(
    repository,
    /FROM quotes WHERE business_id=\$1 AND invoice_id=\$2 AND id=\$3 AND expires_at>clock_timestamp\(\) FOR UPDATE/,
  );
});

// ORIGINAL TEST: PostgreSQL-time quote expiry rejects the candidate before any write
test("PostgreSQL-time quote expiry rejects the candidate before any write", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * PostgreSQL-time quote expiry rejects the candidate before any write
   *
   * It asserted that database-time expiry succeeds end to end. Under R1 that is unreachable
   * by construction, so it is re-expressed as the intentional fail-closed
   * contract. See docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.
   */
  // R1 fail-closed contract (Phase 2C.2B). PostgreSQL requires UPDATE on a
  // table for every row-lock mode, and the application identity holds
  // SELECT+INSERT only on `quotes`. Persistence therefore fails closed before
  // any write, with a sanitised application error rather than a raw 42501.
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

  // The denial is the quote row lock itself, not an incidental error:
  // `lockValidQuoteForEvidence` is the first statement that needs a
  // privilege the application identity does not hold.
  const repository = await readFile("src/server/repository.ts", "utf8");
  assert.match(
    repository,
    /FROM quotes WHERE business_id=\$1 AND invoice_id=\$2 AND id=\$3 AND expires_at>clock_timestamp\(\) FOR UPDATE/,
  );
});

// ORIGINAL TEST: revoked or viewer memberships cannot persist or disclose a durable replay
test("revoked or viewer memberships cannot persist or disclose a durable replay", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * revoked or viewer memberships cannot persist or disclose a durable replay
   *
   * It asserted that revocation and viewer denial succeeds end to end. Under R1 that is unreachable
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

// ORIGINAL TEST: final membership authorization locks the active membership row
test("final membership authorization locks the active membership row",
  { timeout: 5000 }, async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * final membership authorization locks the active membership row
   *
   * It asserted that the membership row lock succeeds end to end. Under R1 that is unreachable
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

// ORIGINAL TEST: every post-write failure boundary rolls back all final-persistence effects
test("every post-write failure boundary rolls back all final-persistence effects", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * every post-write failure boundary rolls back all final-persistence effects
   *
   * It asserted that post-write rollback boundaries succeeds end to end. Under R1 that is unreachable
   * by construction, so it is re-expressed as the intentional fail-closed
   * contract. See docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.
   */
  // R1 fail-closed contract (Phase 2C.2B). PostgreSQL requires UPDATE on a
  // table for every row-lock mode, and the application identity holds
  // SELECT+INSERT only on `quotes`. Persistence therefore fails closed before
  // any write, with a sanitised application error rather than a raw 42501.
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

  // The denial is the quote row lock itself, not an incidental error:
  // `lockValidQuoteForEvidence` is the first statement that needs a
  // privilege the application identity does not hold.
  const repository = await readFile("src/server/repository.ts", "utf8");
  assert.match(
    repository,
    /FROM quotes WHERE business_id=\$1 AND invoice_id=\$2 AND id=\$3 AND expires_at>clock_timestamp\(\) FOR UPDATE/,
  );
});

// ORIGINAL TEST: candidate mutation is rejected without exposing candidate bytes or leaving a write
test("candidate mutation is rejected without exposing candidate bytes or leaving a write", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * candidate mutation is rejected without exposing candidate bytes or leaving a write
   *
   * It asserted that candidate-integrity rejection succeeds end to end. Under R1 that is unreachable
   * by construction, so it is re-expressed as the intentional fail-closed
   * contract. See docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.
   */
  // R1 fail-closed contract (Phase 2C.2B). PostgreSQL requires UPDATE on a
  // table for every row-lock mode, and the application identity holds
  // SELECT+INSERT only on `quotes`. Persistence therefore fails closed before
  // any write, with a sanitised application error rather than a raw 42501.
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

  // The denial is the quote row lock itself, not an incidental error:
  // `lockValidQuoteForEvidence` is the first statement that needs a
  // privilege the application identity does not hold.
  const repository = await readFile("src/server/repository.ts", "utf8");
  assert.match(
    repository,
    /FROM quotes WHERE business_id=\$1 AND invoice_id=\$2 AND id=\$3 AND expires_at>clock_timestamp\(\) FOR UPDATE/,
  );
});

// ORIGINAL TEST: lost COMMIT acknowledgement destroys certainty and only same-key replay recovers the durable result
test("lost COMMIT acknowledgement destroys certainty and only same-key replay recovers the durable result", async () => {
  /*
   * ORIGINAL TEST (preserved here, not deleted):
   * lost COMMIT acknowledgement destroys certainty and only same-key replay recovers the durable result
   *
   * It asserted that commit-outcome handling succeeds end to end. Under R1 that is unreachable
   * by construction, so it is re-expressed as the intentional fail-closed
   * contract. See docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.
   */
  // R1 fail-closed contract (Phase 2C.2B). PostgreSQL requires UPDATE on a
  // table for every row-lock mode, and the application identity holds
  // SELECT+INSERT only on `quotes`. Persistence therefore fails closed before
  // any write, with a sanitised application error rather than a raw 42501.
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

  // The denial is the quote row lock itself, not an incidental error:
  // `lockValidQuoteForEvidence` is the first statement that needs a
  // privilege the application identity does not hold.
  const repository = await readFile("src/server/repository.ts", "utf8");
  assert.match(
    repository,
    /FROM quotes WHERE business_id=\$1 AND invoice_id=\$2 AND id=\$3 AND expires_at>clock_timestamp\(\) FOR UPDATE/,
  );
});

