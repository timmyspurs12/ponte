/**
 * Applies the Phase 2C.2B role and privilege provisioning in two explicit
 * phases. Run with the **bootstrap superuser** connection. It is additive to
 * the existing `db:migrate` / `db:seed` commands and touches no rows: only
 * roles, memberships and privileges.
 *
 *   npm run db:provision -- --phase 1 --test   # pre-migration bootstrap
 *   npm run db:migrate                         # creates tables + trigger functions
 *   npm run db:seed                            # approved bootstrap seed
 *   npm run db:provision -- --phase 2 --test   # post-migration object privileges
 *
 * `--phase 1` is the pre-migration bootstrap: version guard, roles, memberships,
 * database ACL/CONNECT, owner schema privileges, test-only database CREATE, and
 * default-function hardening. It is valid on a fresh, empty database.
 *
 * `--phase 2` is the post-migration object-privilege phase: it verifies every
 * expected table and trigger function exists (failing explicitly if any are
 * missing), then applies the drift revocations, the approved privilege matrix,
 * and the four trigger-function EXECUTE revocations.
 *
 * `--phase all` (the default) runs Phase 1 then Phase 2 in order; it is valid
 * only after migrations, because Phase 2 requires the objects to exist.
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
  type ProvisioningPhase,
} from "../src/server/database-provisioning";

function parsePhase(argv: string[]): ProvisioningPhase {
  const index = argv.indexOf("--phase");
  if (index === -1) return "all";
  const value = argv[index + 1];
  if (value === "1" || value === "phase1") return "phase1";
  if (value === "2" || value === "phase2") return "phase2";
  if (value === "all") return "all";
  console.error(
    `Provisioning refused: --phase must be 1, 2 or all (got ${value ?? "(none)"}).`,
  );
  process.exitCode = 1;
  throw new Error("invalid phase");
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(
      "Provisioning refused: DATABASE_URL is not set. Run this with the bootstrap superuser connection.",
    );
    process.exitCode = 1;
    return;
  }

  const argv = process.argv.slice(2);
  let phase: ProvisioningPhase;
  try {
    phase = parsePhase(argv);
  } catch {
    return;
  }
  const allowScratchSchemaCreates = argv.includes("--test");
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const report = await provisionDatabase(pool, {
      allowScratchSchemaCreates,
      phase,
    });

    /**
     * The log is deliberately structural. It prints no host, no role password
     * and no connection string: the same rule the runtime configuration
     * modules follow.
     */
    console.log(`Provisioning ${PROVISIONING_VERSION} phase ${report.phase} applied.`);
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
