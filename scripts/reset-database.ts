import { execFileSync } from "node:child_process";
import { adminWrite } from "../tests-backend/helpers/admin-database";
import { adminPool } from "../tests-backend/helpers/database-identities";
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
  // The destructive TRUNCATE is administrative work: the application identity
  // holds no privilege on `businesses`, `users`, `memberships`, or most fixture
  // tables, so it cannot run this statement at all. It is performed through the
  // administrative helper, which elevates to `ponte_owner` transaction-locally.
  await adminWrite(adminPool(), async ({ db }) => {
    // Permit reset to recover a disposable database that predates the newest
    // migration; the following seed command will apply it before adding data.
    const hasExternalIdentities = await db.query<{ relation: string | null }>(
      "SELECT to_regclass('public.external_identities') AS relation",
    );
    const tables = [
      "idempotency",
      "payment_events",
      "evidence_outbox",
      "route_decision_evidence",
      "settlements",
      "quotes",
      "payments",
      "invoices",
      "rate_limits",
      "memberships",
      ...(hasExternalIdentities.rows[0].relation
        ? ["external_identities"]
        : []),
      "users",
      "businesses",
    ];
    await db.query(`TRUNCATE ${tables.join(",")}`);
  });
  const commands = [["scripts/database.ts", "--seed"]];
  // Routing fixtures require the same explicit local evidence opt-in as the
  // application. A default reset still leaves a usable clean local seed.
  if (process.env.PONTE_LOCAL_EVIDENCE_TEST_PROVIDER === "1")
    commands.push([
      "--import",
      "./scripts/test-server-only-stub.mjs",
      "scripts/seed-fixtures.ts",
    ]);
  for (const args of commands)
    execFileSync(process.execPath, ["--import", "tsx", ...args], {
      stdio: "inherit",
      env: process.env,
    });
}
void main();
