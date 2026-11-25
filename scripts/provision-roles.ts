/**
 * Applies the Phase 2C.2B role and privilege provisioning.
 *
 * Run with the **bootstrap superuser** connection. It is additive to the
 * existing `db:migrate` / `db:seed` commands and touches no rows: only roles,
 * memberships and privileges.
 *
 *   npm run db:provision            # local / production profile
 *   npm run db:provision -- --test  # also grants CREATE ON DATABASE
 *
 * The `--test` flag exists because `scripts/test-migrations.ts` creates four
 * temporary schemas, which requires `CREATE` on the database. Production omits
 * it: no migration creates a schema, and granting it would let the owner create
 * arbitrary schemas that a `search_path`-confused migration could resolve into.
 *
 * Safe to run repeatedly. Every statement no-ops or corrects; see
 * `src/server/database-provisioning.ts` for why the ordering is load-bearing.
 */

import { Pool } from "pg";
import {
  provisionDatabase,
  PROVISIONING_VERSION,
} from "../src/server/database-provisioning";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(
      "Provisioning refused: DATABASE_URL is not set. Run this with the bootstrap superuser connection.",
    );
    process.exitCode = 1;
    return;
  }

  const allowScratchSchemaCreates = process.argv.includes("--test");
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const report = await provisionDatabase(pool, {
      allowScratchSchemaCreates,
    });

    /**
     * The log is deliberately structural. It prints no host, no role password
     * and no connection string: the same rule the runtime configuration
     * modules follow.
     */
    console.log(`Provisioning ${PROVISIONING_VERSION} applied.`);
    console.log(`  server_version_num: ${report.serverVersionNum}`);
    for (const [role, state] of Object.entries(report.roles)) {
      console.log(
        `  role ${role}: ${state.exists ? "present" : "MISSING"}${state.canLogin ? " (LOGIN)" : " (NOLOGIN)"}`,
      );
    }
    for (const [grant, options] of Object.entries(report.memberships)) {
      console.log(
        `  membership ${grant}: INHERIT=${options.inheritOption} SET=${options.setOption}`,
      );
    }
    const publicAcl = report.databaseAcl ?? "";
    console.log(
      `  database ACL contains PUBLIC: ${/(^|,)=[A-Za-z]*\//.test(publicAcl) ? "YES (unexpected)" : "no"}`,
    );
    for (const [table, columns] of Object.entries(report.appUpdateColumns)) {
      console.log(`  ${table} UPDATE columns: ${columns.join(", ")}`);
    }
    const stillPublic = Object.entries(report.triggerFunctionPublicExecute)
      .filter(([, can]) => can)
      .map(([name]) => name);
    console.log(
      `  trigger functions with PUBLIC EXECUTE: ${stillPublic.length ? stillPublic.join(", ") : "none"}`,
    );
    console.log(
      `  evidence_outbox INSERT columns: ${report.appInsertDeniedColumns.join(", ")}`,
    );
    console.log(`  statements applied: ${report.stepsApplied.length}`);
  } finally {
    await pool.end();
  }
}

void main();
