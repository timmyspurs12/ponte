import { Pool } from "pg";
import { readFile, readdir } from "node:fs/promises";

/**
 * Forward-only migration runner.
 *
 * Importing this module has no side effects; `main` runs only when the file is
 * executed directly. That separation lets the test suite assert the ordering
 * guarantees without touching a database.
 */

/** One advisory-lock key for the whole schema; identical across all callers. */
export const MIGRATION_LOCK_KEY = 5832041;

export type MigrationResult = {
  /** Migration file names applied by this invocation, in order. */
  applied: string[];
  /** Migration file names already recorded before this invocation. */
  alreadyApplied: string[];
};

/**
 * Reads and validates the migration set. Names must be `NNN_snake_case.sql`
 * and are applied in lexical order, which is also numeric order for the
 * zero-padded prefix used by this repository.
 */
export async function listMigrationFiles(
  directory = "migrations",
): Promise<string[]> {
  return (await readdir(directory))
    .filter((name) => /^\d+_[a-z_]+\.sql$/.test(name))
    .sort();
}

/**
 * Applies every pending migration inside **one** transaction guarded by a
 * transaction-scoped advisory lock.
 *
 * Properties that matter for the GitHub Actions path:
 *
 * - `pg_advisory_xact_lock` is released automatically at COMMIT/ROLLBACK, so
 *   it is compatible with PgBouncer transaction mode. No session-level lock or
 *   session `SET` is used anywhere in this function.
 * - The lock is taken *before* `schema_migrations` is created, so two
 *   concurrent operators serialize instead of racing.
 * - A failure rolls back the whole batch: the database never records a
 *   partially applied migration file.
 * - Only `INSERT`s into `schema_migrations` and the migration SQL itself are
 *   executed. This function never seeds, resets, or deletes anything.
 */
export async function applyMigrations(
  pool: Pool,
  directory = "migrations",
): Promise<MigrationResult> {
  const migrations = await listMigrationFiles(directory);
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const file of migrations) {
      const name = file.slice(0, -4);
      const recorded = await db.query(
        "SELECT 1 FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (recorded.rowCount) {
        alreadyApplied.push(name);
        continue;
      }
      await db.query(await readFile(`${directory}/${file}`, "utf8"));
      await db.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
      applied.push(name);
    }
    await db.query("COMMIT");
    return { applied, alreadyApplied };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

/**
 * Read-only reporting for operators: which migrations are recorded, and
 * whether any file on disk is missing from the database. Takes no lock and
 * writes nothing, so it is safe to run at any time.
 */
export async function verifyMigrations(
  pool: Pool,
  directory = "migrations",
): Promise<{ recorded: string[]; pending: string[] }> {
  const migrations = (await listMigrationFiles(directory)).map((file) =>
    file.slice(0, -4),
  );
  const result = await pool.query<{ name: string }>(
    "SELECT name FROM schema_migrations ORDER BY name",
  );
  const recorded = result.rows.map((row) => row.name);
  return {
    recorded,
    pending: migrations.filter((name) => !recorded.includes(name)),
  };
}
