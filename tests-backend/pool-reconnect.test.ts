import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

/**
 * Reconnect-after-disconnect behaviour of the *application's* pool options.
 *
 * On the free stack this is the failure that matters most: Render restarts a
 * free service at any time, and a Neon compute suspends after five idle
 * minutes, so an idle client sitting in `pg`'s pool *will* have its backend
 * closed underneath the process. Node's EventEmitter throws on an unhandled
 * `error` event, so without a listener the web process dies instead of
 * reconnecting.
 *
 * This test reproduces the condition locally by terminating the pooled backend
 * from a second connection. It runs only when `PONTE_RECONNECT_TEST=1` and a
 * database URL are present, because it deliberately kills a backend and must
 * never touch a database it did not create.
 */

const enabled =
  process.env.PONTE_RECONNECT_TEST === "1" && Boolean(process.env.DATABASE_URL);

const pool = enabled
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      idle_in_transaction_session_timeout: 10000,
    })
  : undefined;

let poolErrors = 0;

before(() => {
  // Mirrors the listener `src/server/database.ts` attaches in production.
  pool?.on("error", () => {
    poolErrors += 1;
  });
});

after(async () => {
  await pool?.end();
});

test(
  "an idle pooled connection survives a backend termination",
  {
    skip: enabled
      ? false
      : "set PONTE_RECONNECT_TEST=1 with a disposable database",
  },
  async () => {
    assert.ok(pool);
    const warm = await pool.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const backendPid = warm.rows[0].pid;

    const admin = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    });
    try {
      await admin.query("SELECT pg_terminate_backend($1)", [backendPid]);
    } finally {
      await admin.end();
    }

    // The pool emits `error` for the dead idle client and discards it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(poolErrors, 1, "the pool must report exactly one error event");

    // The next query transparently opens a new connection. This is the
    // behaviour that turns a Neon wake-up into a slow request, not a crash.
    const revived = await pool.query<{ revived: number; pid: number }>(
      "SELECT 1 AS revived, pg_backend_pid() AS pid",
    );
    assert.equal(revived.rows[0].revived, 1);
    assert.notEqual(revived.rows[0].pid, backendPid);
  },
);

test(
  "a transaction still rolls back after a reconnect",
  {
    skip: enabled
      ? false
      : "set PONTE_RECONNECT_TEST=1 with a disposable database",
  },
  async () => {
    assert.ok(pool);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1");
      await client.query("ROLLBACK");
      // The connection is reusable and not left in a failed transaction.
      const result = await client.query<{ ok: number }>("SELECT 2 AS ok");
      assert.equal(result.rows[0].ok, 2);
    } finally {
      client.release();
    }
  },
);
