import { execFileSync } from "node:child_process";
import { Pool } from "pg";
export async function clearDevelopmentRateLimit() {
  const business = process.env.PONTE_DEV_BUSINESS_ID;
  const user = process.env.PONTE_DEV_USER_ID;
  if (!process.env.DATABASE_URL || !business || !user)
    throw new Error("Test database required");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM rate_limits WHERE identity=$1", [
      `${business}:${user}`,
    ]);
  } finally {
    await pool.end();
  }
}

export async function resetFixtures() {
  if (!process.env.DATABASE_URL || !process.env.PONTE_DEV_AUTH)
    throw new Error("Test database required");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      "TRUNCATE idempotency,payment_events,evidence_outbox,route_decision_evidence,settlements,quotes,payments,invoices,rate_limits",
    );
  } finally {
    await pool.end();
  }
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
