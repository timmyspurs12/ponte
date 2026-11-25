/**
 * Phase 2C.2B privilege regression suite.
 *
 * These tests assert the *database* enforces the design. Every assertion runs
 * on a connection authenticated as `ponte_app_login` (the application identity)
 * or `ponte_migrator` (the administrative identity) — never on the bootstrap
 * superuser, which would bypass the checks being tested.
 *
 * Design notes that shaped the assertions:
 *
 * - The two row-lock statements are probed as **SQL**, not through the
 *   application wrapper. `persistPreparedEvidenceCandidate` maps failures
 *   through `mapEvidenceError`, which replaces the driver error with a
 *   sanitised `EVIDENCE_PERSISTENCE_FAILED`; asserting `42501` through it is
 *   impossible by design. `lockValidQuoteForEvidence` is exported, so L1 uses
 *   the real function; `assertActiveMutationMembership` is module-private and is
 *   deliberately *not* exported just to be tested, so L2 reproduces its exact
 *   statement text (source of truth: `src/server/evidence/persist-candidate.ts`,
 *   `assertActiveMutationMembership`) and flags the duplication here.
 * - `confirmVerifiedAnchor()` is never invoked to prove a negative. Manufacturing
 *   a `TrustedAnchorVerification` is forbidden by Decision A, and a successful
 *   confirmation is impossible for the application identity. The privilege is
 *   asserted directly, which is the stronger claim: the function *cannot*
 *   succeed because it cannot write.
 *
 * Skip policy: the eight `NEEDS_OPERATOR_READER` skips in
 * `evidence-anchor-confirmation.test.ts` are untouched. This file adds no skip;
 * if the administrative identity is unavailable the tests fail loudly rather
 * than passing vacuously.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { lockValidQuoteForEvidence } from "../src/server/repository";
import { fixtureScopeAvailable, fixtures, fixturesRead } from "./helpers/fixtures";

/**
 * Only run when the harness has provisioned both identities. A superuser-only
 * run would make every `42501` assertion pass for the wrong reason, so the
 * absence of the markers is reported as a failure, not a skip.
 */
const provisioned =
  fixtureScopeAvailable() && process.env.PONTE_TEST_APP_IDENTITY === "1";

/** Application-identity pool. `DATABASE_URL` points at `ponte_app_login`. */
let app: Pool;

before(() => {
  if (!provisioned) return;
  app = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
});

after(async () => {
  await app?.end().catch(() => {});
});

/**
 * Runs one statement on a freshly acquired connection and returns its SQLSTATE.
 *
 * A denied statement aborts the current transaction, and reusing that client
 * afterwards surfaces `08P01` (protocol violation) instead of the SQLSTATE
 * under test. One connection per probe keeps each assertion about privilege
 * rather than about connection state.
 */
async function freshSqlstate(sql: string, values: unknown[] = []) {
  /**
   * A brand-new connection per probe, not a pooled one.
   *
   * Two hazards this avoids, both observed while building this suite:
   *
   * 1. Reusing a client after a denied statement can surface `08P01` (protocol
   *    violation) instead of the SQLSTATE under test.
   * 2. `pg` binds positional parameters to the *values array*, not to the
   *    placeholders in the text. A statement that names only `$1` but is given
   *    two values fails with `08P01` as well, which looks like a privilege
   *    problem and is not.
   */
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    statement_timeout: 5000,
  });
  await client.connect();
  try {
    await client.query(sql, values as never[]);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  } finally {
    await client.end().catch(() => {});
  }
}

/** A constraint or privilege failure, asserted by SQLSTATE only. */
async function sqlstateOf(
  run: () => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}


/**
 * A complete invoice `data` snapshot.
 *
 * The generated columns (`supplier_name`, `funding_currency`, `due_date`, ...)
 * are derived from `data` and are NOT NULL, so an empty object fails at the
 * generated-column constraint rather than at the privilege under test.
 */
function invoiceData(id: string, reference: string, status: string) {
  return JSON.stringify({
    id,
    reference,
    status,
    supplier: "Privilege boundary supplier",
    wallet: `0x${"a".repeat(40)}`,
    fundingCurrency: "BRL",
    settlementCurrency: "USDG",
    fundingMinor: "1000",
    amount: 10,
    due: "2027-12-20",
    description: "privilege boundary fixture",
  });
}

/**
 * A complete `route_decision_evidence` row.
 *
 * Every envelope column is NOT NULL, so the fixture supplies the whole
 * 29-column shape rather than a partial one. The envelope bytes are synthetic
 * and deliberately meaningless: nothing here asserts anything about KMS or
 * anchoring.
 */
function evidenceInsert(
  businessId: string,
  invoiceId: string,
  evidenceId: string,
  foreign: { quoteId: string; userId: string },
) {
  /**
   * Every one of the 29 columns is NOT NULL with no default, so the fixture
   * supplies the whole envelope. The values are synthetic and meaningless:
   * nothing here asserts anything about KMS or on-chain anchoring.
   *
   * `selected_route_code` is `smallint` in this schema, not text — an earlier
   * draft passed 'direct' and failed with a type error rather than a privilege
   * error.
   */
  return {
    sql: `INSERT INTO route_decision_evidence(id,business_id,invoice_id,quote_id,created_by_user_id,routing_correlation_id,public_evidence_id,evidence_schema_version,quote_schema_version,chain_id,registry_address,sequence,evidence_kind,selected_route_code,quote_snapshot_hash,previous_payload_hash,payload_hash,envelope_version,content_algorithm,ciphertext,nonce,authentication_tag,wrapped_dek,kms_key_reference,kms_key_version,aad_version,kms_provider,wrapped_dek_algorithm,wrapped_dek_format)
          VALUES($1, $2, $3, $4, $5, $6, $7, 1, 1, 421614, $8, 1, 1, 1, $9, $10, $11, 1, 'AES-256-GCM', $12, $13, $14, $15, 'local-test-only/ephemeral/evidence', 'local-test-only/ephemeral/v1', 1, 'local-test-only', 'LOCAL_TEST_RANDOM_BYTES_V1', 'local-test-random-bytes-v1')`,
    values: [
      evidenceId,
      businessId,
      invoiceId,
      foreign.quoteId,
      foreign.userId,
      randomUUID(),
      randomBytes(32),              // public_evidence_id: UNIQUE across rows
      Buffer.alloc(20, 2),          // registry_address (20 bytes)
      Buffer.alloc(32, 3),          // quote_snapshot_hash (32 bytes)
      Buffer.alloc(32, 0),          // previous_payload_hash: MUST be all zero
      Buffer.alloc(32, 4),          // payload_hash: MUST be non-zero
      Buffer.alloc(32, 5),          // ciphertext (>0 bytes)
      Buffer.alloc(12, 6),          // nonce (12 bytes)
      Buffer.alloc(16, 7),          // authentication_tag
      Buffer.alloc(48, 8),          // wrapped_dek (48 bytes)
    ],
  };
}

describe("application privilege boundary", { skip: !provisioned }, () => {
  test("L1: lockValidQuoteForEvidence fails closed with 42501", async () => {
    const businessId = randomUUID();
    const userId = randomUUID();
    const invoiceId = randomUUID();
    const quoteId = randomUUID();

    await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
      businessId,
      "R1 quote lock tenant",
    ]);
    await fixtures(
      "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data) VALUES($1,$2,$3,1000,'Funded',$4)",
      [invoiceId, businessId, `R1-${invoiceId}`, invoiceData(invoiceId, `R1-${invoiceId}`, "Funded")],
    );
    await fixtures(
      "INSERT INTO quotes(id,business_id,invoice_id,source,simulated,data,expires_at) VALUES($1,$2,$3,'simulation-fixed-525',true,$4,date_trunc('milliseconds',now())+interval '1 hour')",
      [quoteId, businessId, invoiceId, JSON.stringify({})],
    );

    const client = await app.connect();
    try {
      // The lock requires UPDATE on at least one column of `quotes`, which the
      // application does not have. This is R1.
      const code = await sqlstateOf(() =>
        lockValidQuoteForEvidence(client, businessId, invoiceId, quoteId),
      );
      assert.equal(code, "42501");

      // Control: the same row is readable without a lock, so the failure is the
      // lock and not table access.
      const control = await client.query(
        "SELECT id FROM quotes WHERE business_id=$1 AND invoice_id=$2 AND id=$3",
        [businessId, invoiceId, quoteId],
      );
      assert.equal(control.rowCount, 1);
    } finally {
      client.release();
    }

    void userId;
  });

  test("L2: the membership FOR UPDATE lock fails closed with 42501", async () => {
    const businessId = randomUUID();
    const userId = randomUUID();

    await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
      businessId,
      "R1 membership lock tenant",
    ]);
    await fixtures("INSERT INTO users(id,email) VALUES($1,$2)", [
      userId,
      `r1-${userId}@example.test`,
    ]);
    await fixtures(
      "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,'admin','active')",
      [businessId, userId],
    );

    const client = await app.connect();
    try {
      /**
       * Verbatim from `assertActiveMutationMembership` in
       * `src/server/evidence/persist-candidate.ts`. That function is private and
       * is not exported for the test's convenience; if this statement changes,
       * the comment above is the pointer to the source of truth.
       */
      const locked = await sqlstateOf(() =>
        client.query(
          "SELECT role FROM memberships WHERE business_id=$1 AND user_id=$2 AND status='active' FOR UPDATE",
          [businessId, userId],
        ),
      );
      assert.equal(locked, "42501");

      // Control: identical predicate, no lock clause.
      const control = await client.query(
        "SELECT role FROM memberships WHERE business_id=$1 AND user_id=$2 AND status='active'",
        [businessId, userId],
      );
      assert.equal(control.rowCount, 1);
      assert.equal(control.rows[0].role, "admin");
    } finally {
      client.release();
    }
  });

  test("the application cannot write confirmation state on the outbox", async () => {
    const businessId = randomUUID();
    const invoiceId = randomUUID();
    const evidenceId = randomUUID();
    const outboxId = randomUUID();

    await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
      businessId,
      "outbox privilege tenant",
    ]);
    await fixtures(
      "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data) VALUES($1,$2,$3,1000,'Funded',$4)",
      [invoiceId, businessId, `OB-${invoiceId}`, invoiceData(invoiceId, `OB-${invoiceId}`, "Funded")],
    );
    // The envelope has two foreign keys: `quote_id` must reference a real quote
    // and `created_by_user_id` a real user.
    const userId = randomUUID();
    const quoteId = randomUUID();
    await fixtures("INSERT INTO users(id,email) VALUES($1,$2)", [
      userId,
      `outbox-${userId}@example.test`,
    ]);
    await fixtures(
      "INSERT INTO quotes(id,business_id,invoice_id,source,simulated,data,expires_at) VALUES($1,$2,$3,'simulation-fixed-525',true,$4,date_trunc('milliseconds',now())+interval '1 hour')",
      [quoteId, businessId, invoiceId, JSON.stringify({})],
    );
    const evidence = evidenceInsert(businessId, invoiceId, evidenceId, {
      quoteId,
      userId,
    });
    await fixtures(evidence.sql, evidence.values);
    await fixtures(
      "INSERT INTO evidence_outbox(id,evidence_record_id) VALUES($1,$2)",
      [outboxId, evidenceId],
    );

    const client = await app.connect();
    try {
      // The two-column INSERT above is what the application may do. Naming a
      // state is not, because `submission_state` carries no INSERT grant.
      const named = await freshSqlstate(
        "INSERT INTO evidence_outbox(id,evidence_record_id,submission_state) VALUES($1,$2,'submitted')",
        [randomUUID(), evidenceId],
      );
      assert.equal(named, "42501");

      // No UPDATE on any column, so the confirmation columns are unwritable.
      for (const column of [
        "submission_state",
        "transaction_hash",
        "confirmed_at",
        "confirmed_block_number",
        "confirmed_block_hash",
        "attestor_address",
        "last_failure_class",
        "last_failure_at",
      ]) {
        assert.equal(
          await freshSqlstate(
                        `UPDATE evidence_outbox SET ${column}=NULL WHERE id=$1`,
            [outboxId],
          ),
          "42501",
          `UPDATE ${column} must be denied`,
        );
      }

      // Destruction is denied outright.
      assert.equal(
        await freshSqlstate("DELETE FROM evidence_outbox WHERE id=$1", [
          outboxId,
        ]),
        "42501",
      );
      assert.equal(
        await freshSqlstate("TRUNCATE evidence_outbox"),
        "42501",
      );
    } finally {
      client.release();
    }

    // The private metadata projection is unreadable for the application.
    const privateRead = await sqlstateOf(() =>
      app.query(
        `SELECT e.wrapped_dek, o.attempt_count
           FROM route_decision_evidence e
           JOIN evidence_outbox o ON o.evidence_record_id = e.id
          WHERE e.id = $1`,
        [evidenceId],
      ),
    );
    assert.equal(privateRead, "42501");

    // The confirmation columns are unreadable too.
    const confirmationRead = await sqlstateOf(() =>
      app.query(
        "SELECT transaction_hash, confirmed_at, confirmed_block_number, confirmed_block_hash, attestor_address, last_failure_class, last_failure_at FROM evidence_outbox WHERE id=$1",
        [outboxId],
      ),
    );
    assert.equal(confirmationRead, "42501");

    // ...but the administrative helper reads all nine B4 columns.
    const metadata = await fixturesRead(
      `SELECT e.public_evidence_id, e.wrapped_dek, e.kms_provider,
              e.wrapped_dek_algorithm, e.wrapped_dek_format,
              e.kms_key_reference, e.kms_key_version,
              o.submission_state, o.attempt_count
         FROM route_decision_evidence e
         JOIN evidence_outbox o ON o.evidence_record_id = e.id
        WHERE e.id = $1`,
      [evidenceId],
    );
    assert.equal(metadata.rows.length, 1);
    assert.equal(metadata.rows[0].submission_state, "pending");
    assert.equal(metadata.rows[0].attempt_count, 0);
  });

  test("settlements and invoices expose only their approved UPDATE columns", async () => {
    const businessId = randomUUID();
    const invoiceId = randomUUID();
    const quoteId = randomUUID();
    const settlementId = randomUUID();

    await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
      businessId,
      "column scope tenant",
    ]);
    await fixtures(
      "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data) VALUES($1,$2,$3,1000,'Funded',$4)",
      [invoiceId, businessId, `CS-${invoiceId}`, invoiceData(invoiceId, `CS-${invoiceId}`, "Funded")],
    );
    await fixtures(
      "INSERT INTO quotes(id,business_id,invoice_id,source,simulated,data,expires_at) VALUES($1,$2,$3,'simulation-fixed-525',true,$4,date_trunc('milliseconds',now())+interval '1 hour')",
      [quoteId, businessId, invoiceId, JSON.stringify({})],
    );
    await fixtures(
      "INSERT INTO settlements(id,business_id,invoice_id,quote_id,route_id,expected_minor,minimum_minor,status) VALUES($1,$2,$3,$4,'direct',100,99,'Routing')",
      [settlementId, businessId, invoiceId, quoteId],
    );

    const client = await app.connect();
    try {
      // Approved three columns, in one statement, succeeds.
      const ok = await client.query(
        "UPDATE settlements SET status='Settled',actual_minor=100,settled_at=now() WHERE id=$1",
        [settlementId],
      );
      assert.equal(ok.rowCount, 1);

      // Everything else on `settlements` is denied — including the two columns
      // an earlier design wrongly granted.
      for (const statement of [
        "UPDATE settlements SET transaction_hash='\\x00' WHERE id=$1",
        "UPDATE settlements SET settlement_asset='USDG' WHERE id=$1",
        "UPDATE settlements SET expected_minor=1 WHERE id=$1",
        "UPDATE settlements SET route_id='split' WHERE id=$1",
      ]) {
        assert.equal(
          await freshSqlstate(statement, [settlementId]),
          "42501",
          statement,
        );
      }

      /**
       * Approved four columns on `invoices`.
       *
       * The status must agree with `data->>'status'`, or the snapshot CHECK
       * rejects the row with `23514` before privilege is ever reached. An
       * earlier draft of this test used a mismatched value and failed for that
       * reason, which is a useful reminder that a check violation here means the
       * grant worked.
       */
      const current = await client.query(
        "SELECT data, status FROM invoices WHERE id=$1",
        [invoiceId],
      );
      const invoiceOk = await client.query(
        "UPDATE invoices SET status=$2, data=$3 WHERE id=$1",
        [invoiceId, current.rows[0].status, current.rows[0].data],
      );
      assert.equal(invoiceOk.rowCount, 1);
      for (const statement of [
        "UPDATE invoices SET business_id=$2 WHERE id=$1",
      ]) {
        assert.equal(
          await freshSqlstate(statement, [invoiceId, businessId]),
          "42501",
          statement,
        );
      }
      assert.equal(
        await freshSqlstate("UPDATE invoices SET created_at=now() WHERE id=$1", [
          invoiceId,
        ]),
        "42501",
      );

      /**
       * Generated columns are refused by the rewriter (`428C9`) *before* the
       * privilege check runs, so a generated column never reaches `42501`.
       * Asserting `42501` here would be asserting the wrong layer; the column is
       * still unwritable by the application, which is the property that matters.
       */
      assert.equal(
        await freshSqlstate("UPDATE invoices SET supplier_name='x' WHERE id=$1", [
          invoiceId,
        ]),
        "428C9",
      );
    } finally {
      client.release();
    }
  });
});

describe("administrative identity", { skip: !provisioned }, () => {
  test("has no privileges until a transaction elevates it", async () => {
    const pool = new Pool({
      connectionString: process.env.PONTE_TEST_ADMIN_DATABASE_URL,
      max: 1,
    });
    const client = await pool.connect();
    try {
      const who = await client.query("SELECT current_user, session_user");
      assert.equal(who.rows[0].session_user, "ponte_migrator");
      assert.equal(who.rows[0].current_user, "ponte_migrator");

      // LOGIN NOINHERIT: the owner grant confers nothing until SET ROLE.
      assert.equal(
        await sqlstateOf(() => client.query("SELECT count(*) FROM quotes")),
        "42501",
      );

      // Transaction-local elevation works...
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE ponte_owner");
      const inside = await client.query("SELECT current_user");
      assert.equal(inside.rows[0].current_user, "ponte_owner");
      assert.equal(
        (await client.query("SELECT count(*)::int AS n FROM quotes")).rowCount,
        1,
      );
      await client.query("COMMIT");

      // ...and does not survive it.
      const afterCommit = await client.query("SELECT current_user");
      assert.equal(afterCommit.rows[0].current_user, "ponte_migrator");
      assert.equal(
        await sqlstateOf(() => client.query("SELECT count(*) FROM quotes")),
        "42501",
      );
    } finally {
      client.release();
      await pool.end();
    }
  });

  test("a read-only administrative transaction refuses writes", async () => {
    const pool = new Pool({
      connectionString: process.env.PONTE_TEST_ADMIN_DATABASE_URL,
      max: 1,
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION READ ONLY");
      await client.query("SET LOCAL ROLE ponte_owner");
      assert.equal(
        await sqlstateOf(() =>
          client.query("INSERT INTO rate_limits VALUES('probe',now(),1)"),
        ),
        "25006",
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await pool.end();
    }
  });

  test("cannot SET ROLE to the application group", async () => {
    const pool = new Pool({
      connectionString: process.env.PONTE_TEST_ADMIN_DATABASE_URL,
      max: 1,
    });
    const client = await pool.connect();
    try {
      // `ponte_migrator` was granted `ponte_owner` only; `ponte_app` is not
      // reachable from it, so the administrative identity cannot borrow the
      // application's group membership either.
      assert.equal(
        await sqlstateOf(() => client.query("SET LOCAL ROLE ponte_app")),
        "42501",
      );
    } finally {
      client.release();
      await pool.end();
    }
  });
});

describe("application cannot escalate", { skip: !provisioned }, () => {
  test("SET ROLE is denied (membership SET FALSE)", async () => {
    const client = await app.connect();
    try {
      assert.equal(
        await sqlstateOf(() => client.query("SET ROLE ponte_app")),
        "42501",
      );
      const who = await client.query("SELECT current_user");
      assert.equal(who.rows[0].current_user, "ponte_app_login");
    } finally {
      client.release();
    }
  });

  test("a bare SET ROLE to the owner is equally denied", async () => {
    const client = await app.connect();
    try {
      assert.equal(
        await sqlstateOf(() => client.query("SET ROLE ponte_owner")),
        "42501",
      );
    } finally {
      client.release();
    }
  });
});
