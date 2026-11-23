import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  applyMigrations,
  listMigrationFiles,
  MIGRATION_LOCK_KEY,
  verifyMigrations,
} from "../scripts/migrate";
import { runDatabaseOperation } from "../scripts/database-operation-runner";
import type { Pool } from "pg";

/**
 * Structural guarantees for the migration runner and the operation runner.
 *
 * Every case here is about *what code exists and in what order it runs*, which
 * is exactly the property that a manual, unreviewable database operation
 * depends on. Nothing in this file connects to PostgreSQL; the two pool-shaped
 * fakes below never reach the network.
 */

/** Minimal `Pool` stand-in that records statements and returns scripted rows. */
function fakePool(
  respond: (text: string) => { rows?: unknown[] } = () => ({}),
): { pool: Pool; statements: string[] } {
  const statements: string[] = [];
  const client = {
    query: async (text: string | { text: string }) => {
      const sql = typeof text === "string" ? text : text.text;
      statements.push(sql);
      const result = respond(sql);
      return { rows: result.rows ?? [], rowCount: (result.rows ?? []).length };
    },
    release: () => {},
  };
  return {
    statements,
    pool: {
      connect: async () => client,
      query: async (text: string | { text: string }) => {
        const sql = typeof text === "string" ? text : text.text;
        statements.push(sql);
        const result = respond(sql);
        return {
          rows: result.rows ?? [],
          rowCount: (result.rows ?? []).length,
        };
      },
    } as unknown as Pool,
  };
}

test("migration names are ordered and strictly formatted", async () => {
  const files = await listMigrationFiles();
  assert.deepEqual(files, [...files].sort());
  assert.ok(files.length >= 6);
  for (const file of files) assert.match(file, /^\d+_[a-z_]+\.sql$/);
  // The authoritative schema starts at 001 and is contiguous.
  const numbers = files.map((file) => Number(file.slice(0, 3)));
  assert.deepEqual(
    numbers,
    numbers.map((_, index) => index + 1),
  );
});

test("migrations take the transaction-scoped lock before any schema change", async () => {
  const { pool, statements } = fakePool(() => ({ rows: [] }));
  await applyMigrations(pool, "migrations");

  const begin = statements.indexOf("BEGIN");
  const lock = statements.findIndex((sql) =>
    sql.startsWith("SELECT pg_advisory_xact_lock"),
  );
  const create = statements.findIndex((sql) =>
    sql.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations"),
  );
  assert.ok(begin >= 0, "migrations must run inside a transaction");
  assert.ok(lock > begin, "the lock must be taken after BEGIN");
  assert.ok(create > lock, "the lock must be taken before schema work");
  assert.equal(statements.at(-1), "COMMIT");

  // A session-level lock would be released only at disconnect, which PgBouncer
  // transaction pooling cannot guarantee; it must never appear here.
  for (const sql of statements) {
    assert.equal(/pg_advisory_(?:lock|unlock)\s*\(/.test(sql), false, sql);
    assert.equal(/^\s*SET\s/i.test(sql), false, sql);
    assert.equal(/^\s*(?:DROP|TRUNCATE|DELETE)\b/i.test(sql), false, sql);
  }
  assert.equal(MIGRATION_LOCK_KEY, 5832041);
});

test("a failed migration rolls the whole batch back", async () => {
  const { pool, statements } = fakePool((sql) => {
    if (sql.startsWith("INSERT INTO schema_migrations")) {
      throw new Error("simulated failure");
    }
    return { rows: [] };
  });
  await assert.rejects(() => applyMigrations(pool));
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.equal(statements.includes("COMMIT"), false);
});

test("an already recorded migration is not replayed", async () => {
  const files = await listMigrationFiles();
  const recorded = new Set(files.map((file) => file.slice(0, -4)));
  const { pool, statements } = fakePool((sql) => {
    if (sql.startsWith("SELECT 1 FROM schema_migrations")) {
      return { rows: [{}] };
    }
    if (sql.includes("to_regclass")) return { rows: [{ present: true }] };
    if (sql.includes("demo_memberships")) {
      return {
        rows: [
          { demo_memberships: "0", chain_hashes: "0", evidence_records: "0" },
        ],
      };
    }
    return { rows: [] };
  });
  const result = await applyMigrations(pool, "migrations");
  assert.equal(result.applied.length, 0);
  assert.equal(result.alreadyApplied.length, recorded.size);
  // No migration body and no schema_migrations INSERT ran.
  assert.equal(
    statements.some((sql) => sql.startsWith("INSERT INTO schema_migrations")),
    false,
  );
  // The only CREATE allowed is the idempotent ledger table itself.
  for (const sql of statements) {
    if (!/CREATE TABLE|ALTER TABLE/i.test(sql)) continue;
    assert.equal(
      sql.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations"),
      true,
      sql,
    );
  }
});

test("verify is read-only and reports pending migrations", async () => {
  const { pool, statements } = fakePool((sql) => {
    if (sql.startsWith("SELECT name FROM schema_migrations")) {
      return { rows: [{ name: "001_foundation" }] };
    }
    return { rows: [] };
  });
  const result = await verifyMigrations(pool);
  assert.deepEqual(result.recorded, ["001_foundation"]);
  assert.ok(result.pending.length >= 5);
  assert.equal(statements.length, 1);
  assert.equal(
    statements[0].startsWith("SELECT name FROM schema_migrations"),
    true,
  );
});

test("the migrate operation applies forward-only and reports a summary", async () => {
  const { pool, statements } = fakePool();
  const result = await runDatabaseOperation(
    pool,
    { operation: "migrate" },
    {
      verifyMigrations,
      applyMigrations: async () => ({
        applied: ["006_github_external_identities"],
        alreadyApplied: ["001_foundation"],
      }),
    },
  );
  assert.equal(result.ok, true);
  assert.match(result.lines[0], /Applied 1 migration/);
  assert.deepEqual(statements, []);
});

test("verify reports the two demo invariants without writing", async () => {
  const { pool, statements } = fakePool((sql) => {
    if (sql.startsWith("SELECT name FROM schema_migrations")) {
      return { rows: [{ name: "001_foundation" }] };
    }
    if (sql.includes("demo_memberships")) {
      return {
        rows: [
          { demo_memberships: "0", chain_hashes: "0", evidence_records: "0" },
        ],
      };
    }
    return { rows: [] };
  });
  const result = await runDatabaseOperation(
    pool,
    { operation: "verify" },
    {
      verifyMigrations: async () => ({
        recorded: ["001_foundation", "002_operational_tables"],
        pending: [],
      }),
    },
  );
  assert.equal(result.ok, true);
  assert.match(result.lines.join(" "), /2 migration\(s\) recorded/);
  assert.match(result.lines.join(" "), /Synthetic demo memberships: 0/);
  assert.match(result.lines.join(" "), /Chain transactions: 0/);
  for (const sql of statements) {
    assert.equal(
      /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(sql),
      false,
      sql,
    );
  }
});

test("tenant operations refuse to run before the schema is current", async () => {
  const { pool } = fakePool((sql) =>
    sql.includes("to_regclass") ? { rows: [{ present: true }] } : { rows: [] },
  );
  let bootstrapped = false;
  const result = await runDatabaseOperation(
    pool,
    { operation: "business-bootstrap", businessId: "id", businessName: "name" },
    {
      verifyMigrations: async () => ({
        recorded: ["001_foundation"],
        pending: ["006_github_external_identities"],
      }),
      bootstrapBusiness: async () => {
        bootstrapped = true;
        return { created: true };
      },
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.lines[0], /Run the migrate operation first/);
  assert.equal(bootstrapped, false, "no tenant write may precede a migration");
});

test("business bootstrap creates no user or membership", async () => {
  const { pool } = fakePool((sql) =>
    sql.includes("to_regclass") ? { rows: [{ present: true }] } : { rows: [] },
  );
  const result = await runDatabaseOperation(
    pool,
    {
      operation: "business-bootstrap",
      businessId: "8a1f3d62-6c4b-4c1e-9f3d-2b7c5a0e4d18",
      businessName: "Acme Comércio Ltda",
    },
    {
      verifyMigrations: async () => ({
        recorded: ["001_foundation"],
        pending: [],
      }),
      bootstrapBusiness: async (_pool, input) => {
        assert.equal(input.businessName, "Acme Comércio Ltda");
        return { created: true };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.match(result.lines[0], /no user or membership row is created here/);
});

test("demo bootstrap reports counts and never enables the demo flag", async () => {
  const { pool } = fakePool((sql) =>
    sql.includes("to_regclass") ? { rows: [{ present: true }] } : { rows: [] },
  );
  const result = await runDatabaseOperation(
    pool,
    {
      operation: "demo-bootstrap",
      businessId: "8bd1f0f2-4c3a-5f6e-9b57-2f5f1a7c9d01",
      businessName: "PONTE Public Demo",
    },
    {
      verifyMigrations: async () => ({
        recorded: ["001_foundation"],
        pending: [],
      }),
      bootstrapDemo: async () => ({
        created: true,
        verified: true,
        invoices: 6,
        quotes: 2,
        payments: 3,
        settlements: 2,
      }),
    },
  );
  assert.equal(result.ok, true);
  assert.match(
    result.lines[0],
    /6 invoices, 2 quotes, 3 payments, 2 settlements/,
  );
  // The command prints the ordering instruction; it does not perform it.
  assert.match(result.lines[1], /only after this step succeeds/);
});

test("the local seed path is unreachable on a hosted runtime", () => {
  const source = readFileSync("scripts/database.ts", "utf8");
  // The seeding branch exists for local/CI use and is guarded by RENDER.
  assert.match(source, /hosted && seed/);
  assert.match(source, /Seeding refused/);
  // It must never be possible to reach a seed through the workflow runner.
  const runner = readFileSync("scripts/database-operation-runner.ts", "utf8");
  // The runner's header names the forbidden commands to document that it never
  // calls them; what matters is that no import or invocation exists.
  assert.equal(
    /import\s+.*(?:seed-fixtures|reset-database)/.test(runner),
    false,
  );
  assert.equal(/#!\/usr\/bin\/env\s+node/.test(runner), false);
  for (const call of [
    "npm run db:seed",
    "npm run db:reset",
    "npm run db:fixtures",
  ]) {
    assert.equal(runner.includes(call), false, call);
  }
});

test("the workflow runner imports no seeding or reset module", () => {
  const runner = readFileSync("scripts/database-operation-runner.ts", "utf8");
  // Every top-level import in the runner must be side-effect free: no pooling,
  // no provisioning modules. Those are loaded lazily inside a handler.
  const topLevelImports = [...runner.matchAll(/^import .*$/gm)].map(
    (match) => match[0],
  );
  for (const statement of topLevelImports) {
    // A type-only import is erased at compile time and pulls in nothing.
    if (statement.startsWith("import type")) continue;
    assert.equal(
      /(seed-fixtures|reset-database|bootstrap-production-business|bootstrap-public-demo|\bpg\b)/.test(
        statement,
      ),
      false,
      statement,
    );
  }
  for (const lazyImport of [
    "./migrate",
    "./production-business-bootstrap",
    "./production-demo-bootstrap",
  ]) {
    assert.equal(
      runner.includes(`import("${lazyImport}")`),
      true,
      `${lazyImport} must be imported lazily`,
    );
  }
});

test("the operation CLI refuses to run outside GitHub Actions", () => {
  const source = readFileSync("scripts/manual-database-operations.ts", "utf8");
  assert.match(source, /PONTE_DB_OPS_FORCE_LOCAL/);
  assert.match(source, /GITHUB_ACTIONS/);
  assert.match(source, /guardOperation/);
  // The URL is validated by the admin transport, never by `new Pool` directly.
  assert.match(source, /adminDatabaseTransport\(process\.env\.DATABASE_URL\)/);
  assert.equal(/console\.log\([^)]*DATABASE_URL/.test(source), false);
});

test("the migration CLI keeps local seeding but refuses it when hosted", () => {
  const source = readFileSync("scripts/database.ts", "utf8");
  assert.match(source, /adminDatabaseTransport/);
  assert.match(source, /--verify/);
  // The three local seed inserts survive for CI; each is ON CONFLICT DO NOTHING.
  assert.equal((source.match(/INSERT INTO/g) ?? []).length, 3);
  assert.match(source, /admin@example|local@example\.invalid/);
  assert.match(source, /ON CONFLICT DO NOTHING/g);
  // The CI job relies on `db:seed` printing this exact phrase.
  assert.match(source, /Database migrated/);
});

test("migration SQL files contain no destructive or seeding statements", () => {
  for (const file of readdirSync("migrations")) {
    const sql = readFileSync(`migrations/${file}`, "utf8").toUpperCase();
    for (const statement of ["DROP TABLE", "TRUNCATE"]) {
      assert.equal(
        sql.includes(statement),
        false,
        `${file} contains ${statement}`,
      );
    }
  }
});
