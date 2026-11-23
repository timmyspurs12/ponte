import { Pool } from "pg";
import {
  adminDatabaseFailureText,
  adminDatabaseTransport,
} from "../src/server/admin-database";
import { verifyMigrations } from "./migrate";
import { runDatabaseOperation } from "./database-operation-runner";
import { guardFailureText, guardOperation } from "./deployment-workflow-guards";

/**
 * Manual database operations entry point for the zero-cost deployment.
 *
 * Render's Free plan provides no shell, no SSH, and no one-off jobs, so there
 * is no way to run a migration or a one-time bootstrap from the platform. This
 * command is the operator-facing surface of
 * `.github/workflows/manual-database-operations.yml`, and it is designed for
 * that single caller:
 *
 * - All dispatch policy is re-applied here (`guardOperation`), not only in the
 *   workflow, so the rules hold even if the YAML is edited carelessly.
 * - The administrative URL is read from the environment by the caller and
 *   validated by `adminDatabaseTransport` before a pool exists.
 * - Output contains operation results and reason codes only. No URL, host,
 *   role, database error text, or business name is printed.
 *
 * Locally this command refuses to run unless `PONTE_DB_OPS_FORCE_LOCAL=1` is
 * set, which the tests do. That flag exists so the guard logic can be exercised
 * on a disposable database; it does not relax any hosted rule.
 */

function readInputs(environment: Record<string, string | undefined>) {
  return {
    eventName: environment.PONTE_DB_OPS_EVENT_NAME ?? "",
    ref: environment.PONTE_DB_OPS_REF ?? "",
    actor: environment.PONTE_DB_OPS_ACTOR ?? "",
    operatorAllowlist: environment.PONTE_DB_OPERATORS,
    operation: environment.PONTE_DB_OPS_OPERATION ?? "",
    businessId: environment.PONTE_DB_OPS_BUSINESS_ID ?? "",
    businessName: environment.PONTE_DB_OPS_BUSINESS_NAME ?? "",
    confirmation: environment.PONTE_DB_OPS_CONFIRMATION ?? "",
    administratorBusinessId: environment.PONTE_AUTH_BUSINESS_ID,
  };
}

async function main(): Promise<void> {
  const forcedLocal = process.env.PONTE_DB_OPS_FORCE_LOCAL === "1";

  // The workflow always sets these two values from `github.*` context. A
  // missing value means this command was invoked some other way.
  if (!forcedLocal && !process.env.GITHUB_ACTIONS) {
    console.error(
      "Refused: this command is only supported from its GitHub Actions workflow.",
    );
    process.exitCode = 1;
    return;
  }

  const guarded = guardOperation(readInputs(process.env));
  if (!guarded.ok) {
    console.error(`Refused: ${guardFailureText[guarded.failure]}`);
    process.exitCode = 1;
    return;
  }
  const { operation, businessId, businessName, readOnly } = guarded.operation;
  console.log(
    `Operation accepted: ${operation} (${readOnly ? "read-only" : "mutating"}).`,
  );

  const transport = adminDatabaseTransport(process.env.DATABASE_URL);
  if (!transport.ok) {
    console.error(`Refused: ${adminDatabaseFailureText[transport.failure]}`);
    process.exitCode = 1;
    return;
  }

  const pool = new Pool(transport.transport);
  try {
    const result = await runDatabaseOperation(
      pool,
      { operation, businessId, businessName },
      { verifyMigrations },
    );
    for (const line of result.lines) console.log(line);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    // Never echo a driver error: it can contain the server host and role.
    const code =
      typeof (error as { code?: unknown })?.code === "string"
        ? ` [${(error as { code: string }).code}]`
        : "";
    console.error(`Database operation failed${code}.`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
