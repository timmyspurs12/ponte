/**
 * Phase 2C.3 routing-lock provisioning and migration suite.
 *
 * Covers the required verification surface for the SECURITY DEFINER row-lock
 * functions and their provisioning lifecycle:
 *
 * - **Migration 008 through the real runner** — `applyMigrations()` against a
 *   fresh database applies `008_routing_lock_functions.sql` and the resulting
 *   catalogue state is asserted field by field (owner, SECURITY DEFINER,
 *   search_path, PUBLIC EXECUTE revoked, column-level grants).
 * - **Rollback after a forced failure** — a conflicting object makes migration
 *   008 fail mid-file; the whole batch must roll back with no ledger entry and
 *   no partial function definitions.
 * - **Role provisioning + repeated provisioning** — Phase 1 is idempotent and
 *   the `ponte_owner` → `ponte_routing_lock` membership reads back with all
 *   three options (INHERIT FALSE, SET TRUE, ADMIN FALSE).
 * - **Existing-role reconciliation** — a pre-existing `ponte_routing_lock`
 *   with dangerous attributes, an unexpected member, or a parent membership
 *   makes Phase 1 fail explicitly; the drift is restored afterwards.
 * - **Function ownership/ACL verification** — the Phase 2 report's
 *   `lockFunctions` field and the direct catalogue agree on the approved
 *   security properties.
 * - **App-login EXECUTE + denial of direct table privileges** — the
 *   application identity can EXECUTE both lock functions and still cannot
 *   take a raw row lock or UPDATE either locked table.
 * - **Membership cases** — the membership lock returns the role for
 *   active admin/viewer rows and NULL for missing/disabled rows.
 * - **Quote expiry after a concurrent lock wait** — a quote that expires
 *   while a second session waits for the row lock yields zero rows when the
 *   lock is finally taken (the expiry predicate is evaluated at lock time).
 *
 * Cluster-wide role mutations (reconciliation cases) run on the disposable
 * test database only, and every drift is restored in a `finally` block. The
 * suite requires `PONTE_BOOTSTRAP_DATABASE_URL` and skips with an explicit
 * reason when it is absent.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { applyMigrations } from "../scripts/migrate";
import {
  APP_ROLE,
  OWNER_ROLE,
  PONTE_SCHEMA,
  ROUTING_LOCK_FUNCTIONS,
  ROUTING_LOCK_ROLE,
  ROUTING_LOCK_SEARCH_PATH,
  provisionDatabasePhase1,
  provisionDatabasePhase2,
} from "../src/server/database-provisioning";
import {
  fixtureScopeAvailable,
  fixtures,
} from "./helpers/fixtures";

const bootstrapUrl = process.env.PONTE_BOOTSTRAP_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;

const provisioned = Boolean(bootstrapUrl) && fixtureScopeAvailable();

let bootstrap: Pool;
let app: Pool;

before(() => {
  if (!provisioned) return;
  bootstrap = new Pool({ connectionString: bootstrapUrl, max: 1 });
  if (appUrl) app = new Pool({ connectionString: appUrl, max: 2 });
});

after(async () => {
  await bootstrap?.end().catch(() => {});
  await app?.end().catch(() => {});
});

/** Creates a fresh disposable database and returns its connection pool. */
async function freshDatabase(prefix: string): Promise<{ name: string; pool: Pool }> {
  const name = `ponte_rl_${prefix}_${randomUUID().slice(0, 8)}`;
  const admin = await bootstrap!.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    admin.release();
  }
  const url = bootstrapUrl!.replace(/\/[^/]*$/, `/${name}`);
  return { name, pool: new Pool({ connectionString: url, max: 1 }) };
}

async function dropDatabase(name: string): Promise<void> {
  // A dedicated client, not the shared bootstrap pool: `DROP DATABASE ...
  // WITH (FORCE)` terminates lingering connections to the dropped database,
  // and running it on the shared pool can surface that termination as an
  // error on a pooled connection that another test is using.
  const admin = new Client({ connectionString: bootstrapUrl });
  try {
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end().catch(() => {});
  }
}

/** Runs one statement as the bootstrap superuser. */
async function superuser(pool: Pool, sql: string, values: unknown[] = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, values as never[]);
  } finally {
    client.release();
  }
}

/** The catalogue row for one lock function, as the migration leaves it. */
type LockFunctionRow = {
  proname: string;
  owner: string;
  secdef: boolean;
  searchPath: string[] | null;
  publicExec: boolean;
  appExec: boolean;
  acl: string;
};

async function lockFunctionRows(pool: Pool): Promise<LockFunctionRow[]> {
  const result = await superuser(
    pool,
    `SELECT p.proname,
            pg_get_userbyid(p.proowner)::text AS owner,
            p.prosecdef AS secdef,
            p.proconfig AS "searchPath",
            has_function_privilege('public', p.oid, 'EXECUTE') AS "publicExec",
            has_function_privilege($1::regrole, p.oid, 'EXECUTE') AS "appExec",
            p.proacl::text AS acl
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $2
        AND p.proname = ANY($3::text[])
      ORDER BY p.proname`,
    [APP_ROLE, PONTE_SCHEMA, ROUTING_LOCK_FUNCTIONS.map((fn) => fn.name)],
  );
  return result.rows as LockFunctionRow[];
}

describe("routing lock migration and provisioning", {
  skip: !provisioned ? "PONTE_BOOTSTRAP_DATABASE_URL not set (superuser required)" : false,
}, () => {
  test("migration 008 applies through the real runner and leaves the approved catalogue", async () => {
    const { name, pool } = await freshDatabase("migrate");
    try {
      // Phase 1 first (roles must exist before the migration runs).
      const phase1 = await provisionDatabasePhase1(pool, {
        allowScratchSchemaCreates: true,
      });
      assert.equal(phase1.phase, "phase1");

      // The real migration runner applies every file, including 008.
      const result = await applyMigrations(pool);
      assert.deepEqual(result.applied, [
        "001_foundation",
        "002_audit_metadata",
        "003_route_decision_evidence",
        "004_kms_envelope_metadata",
        "005_local_test_provider_provenance",
        "006_github_external_identities",
        "007_evidence_outbox_pending_default",
        "008_routing_lock_functions",
      ]);

      // Both lock functions exist with the approved security properties.
      const rows = await lockFunctionRows(pool);
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.owner, ROUTING_LOCK_ROLE, `${row.proname} owner`);
        assert.equal(row.secdef, true, `${row.proname} must be SECURITY DEFINER`);
        assert.ok(
          row.searchPath?.includes(ROUTING_LOCK_SEARCH_PATH),
          `${row.proname} search_path must include ${ROUTING_LOCK_SEARCH_PATH}`,
        );
        assert.equal(
          row.publicExec,
          false,
          `${row.proname} must not grant PUBLIC EXECUTE`,
        );
        // Phase 2 has not run yet: the app group must not hold EXECUTE.
        assert.equal(
          row.appExec,
          false,
          `${row.proname} must not grant EXECUTE before Phase 2`,
        );
        assert.match(
          row.acl,
          /ponte_routing_lock=X\/ponte_routing_lock/,
          `${row.proname} ACL must contain the owner grant`,
        );
        assert.doesNotMatch(
          row.acl,
          /(^|,)=[A-Za-z]*\//,
          `${row.proname} ACL must not contain a PUBLIC grant`,
        );
      }

      // The ledger records 008 exactly once.
      const ledger = await superuser(pool, `SELECT name FROM schema_migrations ORDER BY name`);
      assert.deepEqual(
        ledger.rows.map((row) => (row as { name: string }).name),
        result.applied,
      );
    } finally {
      await pool.end().catch(() => {});
      await dropDatabase(name);
    }
  });

  test("a forced failure in migration 008 rolls back the whole batch", async () => {
    const { name, pool } = await freshDatabase("rollback");
    try {
      await provisionDatabasePhase1(pool, { allowScratchSchemaCreates: true });

      // Force a failure inside 008: a function with the same name and
      // signature makes the `CREATE FUNCTION` statement fail with 42723
      // ("already exists with same argument types"). (A table with the
      // function's name would NOT block it — PostgreSQL keeps relations
      // and functions in separate name spaces.)
      await superuser(
        pool,
        `CREATE FUNCTION ${PONTE_SCHEMA}.ponte_lock_routing_membership(uuid, uuid)
         RETURNS text LANGUAGE plpgsql AS $blocker$ BEGIN RETURN 'blocker'; END $blocker$`,
      );

      await assert.rejects(
        () => applyMigrations(pool),
        (error: unknown) => {
          assert.equal(
            (error as { code?: string }).code,
            "42723",
            `expected 42723 from the blocked CREATE FUNCTION, got ${String(error)}`,
          );
          return true;
        },
      );

      // No ledger entry for 008 (or any other file — the batch is one
      // transaction). The `schema_migrations` table itself was created
      // inside the rolled-back transaction, so it must not exist at all.
      const ledger = await superuser(
        pool,
        `SELECT to_regclass('schema_migrations') AS reg`,
      );
      assert.equal(
        (ledger.rows[0] as { reg: string | null }).reg,
        null,
        "the failed batch must not leave a schema_migrations table behind",
      );

      // The blocker function was created outside the transaction and survives
      // (owned by the bootstrap superuser, not SECURITY DEFINER). What must
      // NOT survive is any function the migration created and transferred to
      // ponte_routing_lock.
      const fns = await superuser(
        pool,
        `SELECT p.proname, pg_get_userbyid(p.proowner)::text AS owner, p.prosecdef AS secdef
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1
            AND p.proname = ANY($2::text[])
          ORDER BY p.proname`,
        [PONTE_SCHEMA, ROUTING_LOCK_FUNCTIONS.map((fn) => fn.name)],
      );
      const survivors = fns.rows as { proname: string; owner: string; secdef: boolean }[];
      assert.equal(
        survivors.length,
        1,
        "only the pre-existing blocker function may survive the rollback",
      );
      assert.equal(survivors[0].proname, "ponte_lock_routing_membership");
      assert.notEqual(
        survivors[0].owner,
        ROUTING_LOCK_ROLE,
        "no function transferred to ponte_routing_lock may survive",
      );
      assert.equal(
        survivors[0].secdef,
        false,
        "the surviving blocker must not be the SECURITY DEFINER lock function",
      );

      // The blocking function was created outside the migration transaction
      // and must be untouched — the rollback restored the pre-migration
      // state (its body is still the blocker, not the real lock function).
      const blocker = await superuser(
        pool,
        `SELECT p.proname, pg_get_function_result(p.oid) AS result
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 AND p.proname = 'ponte_lock_routing_membership'`,
        [PONTE_SCHEMA],
      );
      assert.equal(blocker.rowCount, 1, "the pre-existing blocker function must survive");
      assert.equal(
        (blocker.rows[0] as { result: string }).result,
        "text",
        "the surviving function must be the blocker, not the real lock function",
      );
    } finally {
      await pool.end().catch(() => {});
      await dropDatabase(name);
    }
  });

  test("Phase 1 is idempotent and the routing-lock membership reads back with all three options", async () => {
    const { name, pool } = await freshDatabase("membership");
    try {
      const first = await provisionDatabasePhase1(pool, {
        allowScratchSchemaCreates: true,
      });
      const entry = first.memberships[`${OWNER_ROLE}<-${ROUTING_LOCK_ROLE}`];
      assert.ok(entry, "report must include the ponte_owner -> ponte_routing_lock membership");
      assert.equal(entry.inheritOption, false, "INHERIT must be FALSE");
      assert.equal(entry.setOption, true, "SET must be TRUE");
      assert.equal(entry.adminOption, false, "ADMIN must be FALSE");

      // Repeated provisioning re-states the same options and stays idempotent.
      const second = await provisionDatabasePhase1(pool, {
        allowScratchSchemaCreates: true,
      });
      const entry2 = second.memberships[`${OWNER_ROLE}<-${ROUTING_LOCK_ROLE}`];
      assert.deepEqual(entry2, entry, "repeated Phase 1 must not change the membership");

      // The dedicated routing-lock membership field agrees with the summary.
      assert.deepEqual(
        second.routingLockMemberships.membersOfRoutingLock,
        [
          {
            member: OWNER_ROLE,
            inheritOption: false,
            setOption: true,
            adminOption: false,
          },
        ],
      );
      assert.deepEqual(second.routingLockMemberships.routingLockParents, []);

      // Phase 2 is idempotent as well, and its report keeps the membership.
      // (Phase 2 needs the migrated schema, so apply migrations first.)
      await applyMigrations(pool);
      const phase2a = await provisionDatabasePhase2(pool, {
        allowScratchSchemaCreates: true,
      });
      assert.equal(
        phase2a.memberships[`${OWNER_ROLE}<-${ROUTING_LOCK_ROLE}`].setOption,
        true,
      );
      const phase2b = await provisionDatabasePhase2(pool, {
        allowScratchSchemaCreates: true,
      });
      assert.deepEqual(
        phase2b.memberships,
        phase2a.memberships,
        "repeated Phase 2 must not change the membership summary",
      );
    } finally {
      await pool.end().catch(() => {});
      await dropDatabase(name);
    }
  });

  test("existing-role reconciliation fails explicitly on dangerous attributes, unexpected members and parent memberships", async () => {
    // The reconciliation cases mutate the cluster-wide role. Each drift is
    // restored in its own finally block so a failed assertion never leaves
    // the shared disposable database's role state broken for later runs.

    // (1) Dangerous attributes: LOGIN on the lock role.
    await superuser(bootstrap, `ALTER ROLE ${ROUTING_LOCK_ROLE} LOGIN`);
    try {
      await assert.rejects(
        () => provisionDatabasePhase1(bootstrap, { allowScratchSchemaCreates: true }),
        /ponte_routing_lock exists with dangerous attributes/,
      );
    } finally {
      await superuser(bootstrap, `ALTER ROLE ${ROUTING_LOCK_ROLE} NOLOGIN`);
    }

    // (2) Unexpected member: a role other than ponte_owner inside the lock
    // role. `GRANT A TO B` makes B a member of A, so granting the lock
    // role TO ponte_app puts ponte_app inside ponte_routing_lock.
    await superuser(bootstrap, `GRANT ${ROUTING_LOCK_ROLE} TO ${APP_ROLE}`);
    try {
      await assert.rejects(
        () => provisionDatabasePhase1(bootstrap, { allowScratchSchemaCreates: true }),
        /ponte_routing_lock has unexpected members/,
      );
    } finally {
      await superuser(bootstrap, `REVOKE ${ROUTING_LOCK_ROLE} FROM ${APP_ROLE}`);
    }

    // (3) Parent membership: the lock role itself a member of ponte_owner.
    // `GRANT ponte_owner TO ponte_routing_lock` makes ponte_routing_lock a
    // member of ponte_owner, which the leaf-role check rejects. The approved
    // membership (ponte_owner inside ponte_routing_lock) must be removed
    // first: granting the reverse direction while it exists would create a
    // membership cycle, which PostgreSQL refuses with 0LP01.
    await superuser(bootstrap, `REVOKE ${ROUTING_LOCK_ROLE} FROM ${OWNER_ROLE}`);
    try {
      await superuser(bootstrap, `GRANT ${OWNER_ROLE} TO ${ROUTING_LOCK_ROLE}`);
      await assert.rejects(
        () => provisionDatabasePhase1(bootstrap, { allowScratchSchemaCreates: true }),
        /ponte_routing_lock must be a leaf role/,
      );
    } finally {
      await superuser(bootstrap, `REVOKE ${OWNER_ROLE} FROM ${ROUTING_LOCK_ROLE}`);
      await superuser(
        bootstrap,
        `GRANT ${ROUTING_LOCK_ROLE} TO ${OWNER_ROLE} WITH INHERIT FALSE, SET TRUE`,
      );
    }

    // Restore the approved state and confirm Phase 1 succeeds again.
    const recovered = await provisionDatabasePhase1(bootstrap, {
      allowScratchSchemaCreates: true,
    });
    assert.equal(
      recovered.memberships[`${OWNER_ROLE}<-${ROUTING_LOCK_ROLE}`].setOption,
      true,
      "Phase 1 must succeed once the drift is reconciled",
    );
  });

  test("Phase 2 grants app EXECUTE and verifies the exact lock-function signature and security properties", async () => {
    const { name, pool } = await freshDatabase("phase2");
    try {
      await provisionDatabasePhase1(pool, { allowScratchSchemaCreates: true });
      await applyMigrations(pool);
      const report = await provisionDatabasePhase2(pool, {
        allowScratchSchemaCreates: true,
      });

      // The report re-reads the catalogue; every field must match the
      // approved contract.
      assert.equal(report.lockFunctions.length, 2);
      const byName = Object.fromEntries(
        report.lockFunctions.map((fn) => [fn.name, fn]),
      );
      for (const expected of ROUTING_LOCK_FUNCTIONS) {
        const fn = byName[expected.name];
        assert.ok(fn, `${expected.name} missing from the report`);
        assert.equal(fn.args, expected.args, `${expected.name} identity arguments`);
        assert.equal(fn.result, expected.result, `${expected.name} return type`);
        assert.equal(fn.owner, ROUTING_LOCK_ROLE, `${expected.name} owner`);
        assert.equal(fn.securityDefiner, true, `${expected.name} SECURITY DEFINER`);
        assert.equal(
          fn.searchPath,
          ROUTING_LOCK_SEARCH_PATH,
          `${expected.name} search_path`,
        );
        assert.equal(fn.publicExecute, false, `${expected.name} PUBLIC EXECUTE`);
        assert.equal(fn.appExecute, true, `${expected.name} app EXECUTE`);
      }

      // The direct catalogue agrees with the report.
      const rows = await lockFunctionRows(pool);
      for (const row of rows) {
        assert.equal(row.appExec, true, `${row.proname} app EXECUTE after Phase 2`);
      }

      // The lock role never holds a standing schema CREATE.
      const schemaCreate = await superuser(
        pool,
        `SELECT has_schema_privilege($1::regrole, $2, 'CREATE') AS can`,
        [ROUTING_LOCK_ROLE, PONTE_SCHEMA],
      );
      assert.equal(
        (schemaCreate.rows[0] as { can: boolean }).can,
        false,
        "ponte_routing_lock must not hold schema CREATE after provisioning",
      );
    } finally {
      await pool.end().catch(() => {});
      await dropDatabase(name);
    }
  });
});

describe("routing lock function contracts", {
  skip: !provisioned ? "provisioning identities not configured" : false,
}, () => {
  test("the application identity can EXECUTE the lock functions but holds no direct table privileges", async () => {
    const businessId = randomUUID();
    const userId = randomUUID();
    const invoiceId = randomUUID();
    const quoteId = randomUUID();

    await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
      businessId,
      "lock contract tenant",
    ]);
    await fixtures("INSERT INTO users(id,email) VALUES($1,$2)", [
      userId,
      `lock-${userId}@example.test`,
    ]);
    await fixtures(
      "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,'admin','active')",
      [businessId, userId],
    );
    await fixtures(
      "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data) VALUES($1,$2,$3,1000,'Funded',$4)",
      [invoiceId, businessId, `LC-${invoiceId}`, invoiceData(invoiceId, `LC-${invoiceId}`, "Funded")],
    );
    await fixtures(
      "INSERT INTO quotes(id,business_id,invoice_id,source,simulated,data,expires_at) VALUES($1,$2,$3,'simulation-fixed-525',true,$4,date_trunc('milliseconds',now())+interval '1 hour')",
      [quoteId, businessId, invoiceId, JSON.stringify({})],
    );

    const client = await app!.connect();
    try {
      // EXECUTE works end-to-end for both functions (inherited from ponte_app).
      const membership = await client.query<{ role: string | null }>(
        `SELECT ${PONTE_SCHEMA}.ponte_lock_routing_membership($1,$2) AS role`,
        [businessId, userId],
      );
      assert.equal(membership.rows[0].role, "admin");

      const quote = await client.query(
        `SELECT * FROM ${PONTE_SCHEMA}.ponte_lock_routing_quote($1,$2,$3)`,
        [businessId, invoiceId, quoteId],
      );
      assert.equal(quote.rowCount, 1);

      // Denial of direct table privileges: no raw row lock, no UPDATE.
      const directLock = await sqlstateOf(() =>
        client.query(
          "SELECT role FROM memberships WHERE business_id=$1 AND user_id=$2 FOR UPDATE",
          [businessId, userId],
        ),
      );
      assert.equal(directLock, "42501");

      const directUpdate = await sqlstateOf(() =>
        client.query("UPDATE memberships SET status='disabled' WHERE business_id=$1", [businessId]),
      );
      assert.equal(directUpdate, "42501");

      const quoteLock = await sqlstateOf(() =>
        client.query(
          "SELECT id FROM quotes WHERE business_id=$1 AND id=$2 FOR UPDATE",
          [businessId, quoteId],
        ),
      );
      assert.equal(quoteLock, "42501");

      const quoteUpdate = await sqlstateOf(() =>
        client.query("UPDATE quotes SET expires_at = now() WHERE id=$1", [quoteId]),
      );
      assert.equal(quoteUpdate, "42501");
    } finally {
      client.release();
    }
  });

  test("the membership lock returns the role for active rows and NULL for missing or disabled rows", async () => {
    const cases: Array<{ status: string; role: string }> = [
      { status: "active", role: "admin" },
      { status: "active", role: "viewer" },
      { status: "disabled", role: "admin" },
    ];
    for (const testCase of cases) {
      const businessId = randomUUID();
      const userId = randomUUID();
      await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
        businessId,
        `membership-${testCase.status}-${testCase.role}`,
      ]);
      await fixtures("INSERT INTO users(id,email) VALUES($1,$2)", [
        userId,
        `ml-${userId}@example.test`,
      ]);
      await fixtures(
        "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,$3,$4)",
        [businessId, userId, testCase.role, testCase.status],
      );

      const client = await app!.connect();
      try {
        const result = await client.query<{ role: string | null }>(
          `SELECT ${PONTE_SCHEMA}.ponte_lock_routing_membership($1,$2) AS role`,
          [businessId, userId],
        );
        if (testCase.status === "active") {
          assert.equal(result.rows[0].role, testCase.role);
        } else {
          assert.equal(
            result.rows[0].role,
            null,
            "a disabled membership must lock nothing and return NULL",
          );
        }
      } finally {
        client.release();
      }
    }

    // Missing membership: no row at all → NULL.
    const businessId = randomUUID();
    const userId = randomUUID();
    const client = await app!.connect();
    try {
      const result = await client.query<{ role: string | null }>(
        `SELECT ${PONTE_SCHEMA}.ponte_lock_routing_membership($1,$2) AS role`,
        [businessId, userId],
      );
      assert.equal(result.rows[0].role, null, "a missing membership must return NULL");
    } finally {
      client.release();
    }
  });

  test("a quote that expires while a concurrent session blocks on the lock yields zero rows on resumption", async () => {
    const businessId = randomUUID();
    const invoiceId = randomUUID();
    const quoteId = randomUUID();

    await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
      businessId,
      "lock expiry tenant",
    ]);
    await fixtures(
      "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data) VALUES($1,$2,$3,1000,'Funded',$4)",
      [invoiceId, businessId, `QE-${invoiceId}`, invoiceData(invoiceId, `QE-${invoiceId}`, "Funded")],
    );
    // The quote expires on its own three seconds in. Expiring it by UPDATE
    // is impossible while session A holds the row lock (the UPDATE would
    // block on the same lock), so the natural deadline is the deterministic
    // way to make the row expire while it is still locked.
    await fixtures(
      "INSERT INTO quotes(id,business_id,invoice_id,source,simulated,data,expires_at) VALUES($1,$2,$3,'simulation-fixed-525',true,$4,date_trunc('milliseconds',now())+interval '3 seconds')",
      [quoteId, businessId, invoiceId, JSON.stringify({})],
    );

    // (1) Transaction A acquires the row lock on a valid quote and holds it.
    const sessionA = await app!.connect();
    await sessionA.query("BEGIN");
    const lockedA = await sessionA.query(
      `SELECT * FROM ${PONTE_SCHEMA}.ponte_lock_routing_quote($1,$2,$3)`,
      [businessId, invoiceId, quoteId],
    );
    assert.equal(lockedA.rowCount, 1, "session A must lock the valid quote");

    // (2) Transaction B calls the actual quote-lock function BEFORE expiry.
    // It blocks on A's row lock. The block is proven at the PostgreSQL level,
    // not only by a JavaScript promise remaining unsettled: `pg_locks` and
    // `pg_stat_activity` are queried to show B holds an ungranted lock
    // request while A holds the granted lock, and B's wait_event_type is
    // "Lock" — the server itself is reporting B is waiting on a lock.
    const sessionB = await app!.connect();
    const backendB = (
      await sessionB.query("SELECT pg_backend_pid() AS pid")
    ).rows[0] as { pid: number };
    const backendA = (
      await sessionA.query("SELECT pg_backend_pid() AS pid")
    ).rows[0] as { pid: number };
    let settledB = false;
    const lockB = sessionB
      .query(
        `SELECT * FROM ${PONTE_SCHEMA}.ponte_lock_routing_quote($1,$2,$3)`,
        [businessId, invoiceId, quoteId],
      )
      .then((result) => {
        settledB = true;
        return result;
      });

    // Bounded polling for the actual lock-wait state — not a fixed delay.
    // The loop waits until the database itself reports B blocked on A's
    // backend (pg_blocking_pids includes A's PID) while B's promise is
    // still unsettled, bounded at 4 s.
    let blocked = false;
    let lastBlockers: number[] = [];
    const pollDeadline = Date.now() + 4000;
    while (Date.now() < pollDeadline) {
      const blockerProbe = await superuser(
        bootstrap,
        `SELECT unnest(pg_blocking_pids($1)) AS pid`,
        [backendB.pid],
      );
      lastBlockers = (blockerProbe.rows as { pid: number }[])
        .map((row) => Number(row.pid));
      if (!settledB && lastBlockers.includes(backendA.pid)) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      blocked,
      `session B must be waiting on session A's row lock (pg_blocking_pids must include A's backend PID ${backendA.pid}); last probe: ${JSON.stringify(lastBlockers)}`,
    );

    // Prove B is genuinely waiting on a PostgreSQL lock held by A. The
    // `pg_locks` view shows B's ungranted lock request (the lock B is
    // waiting for), and `pg_stat_activity` reports B's wait_event_type as
    // "Lock". A holds the same lock type as granted, confirming the two
    // backends are contending for the same lock.
    const bLocks = await superuser(
      bootstrap,
      `SELECT granted, locktype
         FROM pg_locks
        WHERE pid = $1
        ORDER BY granted`,
      [backendB.pid],
    );
    const bLockRows = bLocks.rows as { granted: boolean; locktype: string }[];
    assert.ok(
      bLockRows.some((row) => row.granted === false),
      `session B must hold an ungranted (waiting) lock request; got ${JSON.stringify(bLockRows)}`,
    );

    const bActivity = await superuser(
      bootstrap,
      `SELECT wait_event_type, wait_event, state
         FROM pg_stat_activity
        WHERE pid = $1`,
      [backendB.pid],
    );
    const bActRow = bActivity.rows[0] as {
      wait_event_type: string | null;
      wait_event: string | null;
      state: string;
    };
    assert.equal(
      bActRow.wait_event_type,
      "Lock",
      `session B's wait_event_type must be "Lock" (waiting on a PostgreSQL lock), got ${bActRow.wait_event_type}`,
    );
    assert.equal(
      bActRow.state,
      "active",
      "session B must be in active state while waiting for the lock",
    );

    // A holds the granted lock that B is waiting on.
    const aLocks = await superuser(
      bootstrap,
      `SELECT granted, locktype
         FROM pg_locks
        WHERE pid = $1
        ORDER BY granted`,
      [backendA.pid],
    );
    const aLockRows = aLocks.rows as { granted: boolean; locktype: string }[];
    const waitingType = bLockRows.find((row) => row.granted === false)!.locktype;
    assert.ok(
      aLockRows.some(
        (row) => row.granted === true && row.locktype === waitingType,
      ),
      `session A must hold the granted ${waitingType} lock that B is waiting on; got ${JSON.stringify(aLockRows)}`,
    );

    assert.equal(
      settledB,
      false,
      "session B must still be blocked on session A's row lock before expiry",
    );

    // (3) The quote expires naturally while B is still waiting. Wait for
    // the natural deadline with bounded polling (no fixed sleep), then
    // Transaction A commits without modifying the quote, releasing the lock.
    let expired = false;
    const expiryDeadline = Date.now() + 6000;
    while (Date.now() < expiryDeadline) {
      const expiryProbe = await superuser(
        bootstrap,
        `SELECT expires_at <= clock_timestamp() AS expired
           FROM ${PONTE_SCHEMA}.quotes
          WHERE id = $1`,
        [quoteId],
      );
      if (expiryProbe.rows[0]?.expired) {
        expired = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(expired, "the quote must expire naturally while session B waits");
    await sessionA.query("COMMIT");

    // (4) Transaction B resumes. The post-lock expiry check (evaluated after
    // the lock is acquired, not at scan time) must reject the now-expired
    // quote: B returns zero rows, not the stale row it would have scanned
    // before the wait.
    const resultB = await lockB;
    assert.equal(
      settledB,
      true,
      "session B must resume after session A commits",
    );
    assert.equal(
      resultB.rowCount,
      0,
      "a quote that expired while B waited for the lock must yield zero rows on resumption",
    );

    await sessionB.release();
    await sessionA.release();
  });
});

/** Runs one statement and returns its SQLSTATE, or undefined on success. */
async function sqlstateOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/**
 * A complete invoice `data` snapshot. The generated columns
 * (`supplier_name`, `funding_currency`, `due_date`, ...) are derived from
 * `data` and are NOT NULL, so a partial object fails at the generated-column
 * constraint rather than at the privilege under test.
 */
function invoiceData(id: string, reference: string, status: string) {
  return JSON.stringify({
    id,
    reference,
    status,
    supplier: "lock provisioning supplier",
    wallet: `0x${"a".repeat(40)}`,
    fundingCurrency: "BRL",
    settlementCurrency: "USDG",
    fundingMinor: "1000",
    amount: 10,
    due: "2027-12-20",
    description: "lock provisioning fixture",
  });
}

