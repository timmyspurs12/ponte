import { Pool } from "pg";
import {
  adminDatabaseFailureText,
  adminDatabaseTransport,
} from "../src/server/admin-database";
import { applyMigrations, verifyMigrations } from "./migrate";

/**
 * Convenience CLI preserved for local development (`npm run db:migrate`,
 * `npm run db:seed -- --seed` and CI).
 *
 * Phase 1.3.9 adds three things and changes nothing about local behaviour:
 *
 * 1. `--verify` reports recorded and pending migrations without writing, so a
 *    GitHub Actions operator can inspect state after a forward-only run.
 * 2. On a hosted runtime (`RENDER=true`) the administrative transport policy
 *    applies: direct endpoint, verified TLS, never the pooler.
 * 3. On a hosted runtime the local seeding branch is **refused**, not run. The
 *    seed inserts a fixed local business, a local user, and an administrator
 *    membership for that user. That shape must never be creatable in a
 *    deployed database by a migration command, and the deployment workflow
 *    must not have a reachable "migrate and seed" switch.
 *
 * Migration SQL itself now lives in `./migrate` so the test suite can assert
 * the advisory-lock and single-transaction guarantees without a database.
 */
async function main(): Promise<void> {
  const hosted = process.env.RENDER === "true";
  const seed = process.argv.includes("--seed");
  const verifyOnly = process.argv.includes("--verify");

  if (hosted && seed) {
    console.error(
      "Seeding refused: local seed data must never be written to a hosted database.",
    );
    process.exitCode = 1;
    return;
  }

  let connectionString = process.env.DATABASE_URL;
  let poolOptions: ConstructorParameters<typeof Pool>[0] = {
    connectionString,
  };

  if (hosted) {
    const resolved = adminDatabaseTransport(connectionString);
    if (!resolved.ok) {
      console.error(
        `Migration refused: ${adminDatabaseFailureText[resolved.failure]}`,
      );
      process.exitCode = 1;
      return;
    }
    connectionString = resolved.transport.connectionString;
    poolOptions = resolved.transport;
  }

  const pool = new Pool(poolOptions);
  try {
    if (verifyOnly) {
      const result = await verifyMigrations(pool);
      const pending = result.pending.length
        ? `Pending migrations: ${result.pending.join(", ")}.`
        : "No pending migrations.";
      console.log(`${result.recorded.length} migrations recorded. ${pending}`);
      if (result.pending.length) process.exitCode = 1;
      return;
    }

    const result = await applyMigrations(pool);

    if (seed) {
      // Local and CI only: this branch is unreachable when RENDER=true.
      await pool.query(
        "INSERT INTO businesses(id,name) VALUES('00000000-0000-4000-8000-000000000001','PONTE local simulation') ON CONFLICT DO NOTHING",
      );
      await pool.query(
        "INSERT INTO users(id,email) VALUES('00000000-0000-4000-8000-000000000002','local@example.invalid') ON CONFLICT DO NOTHING",
      );
      await pool.query(
        "INSERT INTO memberships(business_id,user_id,role,status) VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','admin','active') ON CONFLICT DO NOTHING",
      );
    }

    console.log(
      "Database migrated" +
        (seed ? " and seeded" : "") +
        (result.applied.length ? ` (${result.applied.join(", ")})` : ""),
    );
  } catch (error) {
    // Never echo a driver error: it can contain the server host and role.
    const code =
      typeof (error as { code?: unknown })?.code === "string"
        ? ` [${(error as { code: string }).code}]`
        : "";
    console.error(`Database migration failed${code}.`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
