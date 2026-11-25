import { execFileSync } from "node:child_process";
import { adminWrite } from "../tests-backend/helpers/admin-database";
import { adminPool } from "../tests-backend/helpers/database-identities";

/**
 * Playwright database setup.
 *
 * The destructive work here (`TRUNCATE`, `DELETE FROM rate_limits`) is
 * administrative: the application identity holds only column-scoped UPDATE on
 * `rate_limits` and no privilege on most fixture tables, so it cannot perform
 * either statement. Both operations therefore run through the administrative
 * helper, which elevates to `ponte_owner` inside a transaction-local scope and
 * never leaks the elevation back to the pool.
 *
 * The seed step that follows `resetFixtures` stays on the application identity
 * on purpose: `scripts/seed-fixtures.ts` exercises the real `execute()` service
 * path, which is the behaviour the UI tests are checking.
 */

export async function clearDevelopmentRateLimit() {
  const business = process.env.PONTE_DEV_BUSINESS_ID;
  const user = process.env.PONTE_DEV_USER_ID;
  if (!process.env.DATABASE_URL || !business || !user)
    throw new Error("Test database required");
  await adminWrite(adminPool(), async ({ db }) => {
    await db.query("DELETE FROM rate_limits WHERE identity=$1", [
      `${business}:${user}`,
    ]);
  });
}

export async function resetFixtures() {
  if (!process.env.DATABASE_URL || !process.env.PONTE_DEV_AUTH)
    throw new Error("Test database required");
  await adminWrite(adminPool(), async ({ db }) => {
    await db.query(
      "TRUNCATE idempotency,payment_events,evidence_outbox,route_decision_evidence,settlements,quotes,payments,invoices,rate_limits",
    );
  });
  execFileSync(
    process.execPath,
    [
      "--import",
      "./scripts/test-server-only-stub.mjs",
      "--import",
      "tsx",
      "scripts/seed-fixtures.ts",
    ],
    { env: process.env, stdio: "pipe" },
  );
}
