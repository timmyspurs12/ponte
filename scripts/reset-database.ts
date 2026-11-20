import { Pool } from "pg";
import { execFileSync } from "node:child_process";
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (
    process.env.NODE_ENV === "production" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !process.argv.includes("--confirm-local-reset")
  )
    throw new Error(
      "Reset requires a loopback database and --confirm-local-reset. This deletes all simulation records.",
    );
  const pool = new Pool({ connectionString: url.toString() });
  try {
    await pool.query(
      "TRUNCATE idempotency,payment_events,evidence_outbox,route_decision_evidence,settlements,quotes,payments,invoices,rate_limits,memberships,users,businesses",
    );
  } finally {
    await pool.end();
  }
  const commands = [["scripts/database.ts", "--seed"]];
  // Routing fixtures require the same explicit local evidence opt-in as the
  // application. A default reset still leaves a usable clean local seed.
  if (process.env.PONTE_LOCAL_EVIDENCE_TEST_PROVIDER === "1")
    commands.push(["--conditions=react-server", "scripts/seed-fixtures.ts"]);
  for (const args of commands)
    execFileSync(process.execPath, ["--import", "tsx", ...args], {
      stdio: "inherit",
      env: process.env,
    });
}
void main();
