import { Pool } from "pg";
import { readFile } from "node:fs/promises";
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(5832041)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    if (
      !(
        await db.query(
          "SELECT 1 FROM schema_migrations WHERE name='001_foundation'",
        )
      ).rowCount
    ) {
      await db.query(await readFile("migrations/001_foundation.sql", "utf8"));
      await db.query(
        "INSERT INTO schema_migrations(name) VALUES('001_foundation')",
      );
    }
    if (process.argv.includes("--seed")) {
      await db.query(
        "INSERT INTO businesses VALUES('00000000-0000-4000-8000-000000000001','PONTE local simulation') ON CONFLICT DO NOTHING",
      );
      await db.query(
        "INSERT INTO users VALUES('00000000-0000-4000-8000-000000000002','local@example.invalid') ON CONFLICT DO NOTHING",
      );
      await db.query(
        "INSERT INTO memberships VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','admin','active') ON CONFLICT DO NOTHING",
      );
    }
    await db.query("COMMIT");
    console.log(
      "Database migrated" +
        (process.argv.includes("--seed") ? " and seeded" : ""),
    );
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
    await pool.end();
  }
}
void main();
