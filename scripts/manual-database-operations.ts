import { Pool } from "pg";
import {
  adminDatabaseFailureText,
  adminDatabaseTransport,
} from "../src/server/admin-database";
import { verifyMigrations } from "./migrate";
import { runDatabaseOperation } from "./database-operation-runner";
import { readOptionalUuid } from "./optional-environment";
import { readConfiguredAdministratorBusinessId } from "./production-business-bootstrap";
import {
  guardFailureText,
  guardOperation,
  type GuardedOperation,
} from "./deployment-workflow-guards";

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
 * - The provisioning modules' own production preflights
 *   (`assertProductionBusinessBootstrapEnvironment`,
 *   `assertPublicDemoBootstrapEnvironment`) are applied **before** a pool is
 *   created, so the GitHub Actions path enforces the same rules as the
 *   one-off CLIs. Running a bootstrap from the workflow used to skip them.
 * - The administrative URL is read from the environment by the caller and
 *   validated by `adminDatabaseTransport` before a pool exists.
 * - Output contains operation results and reason codes only. No URL, host,
 *   role, database error text, or business name is printed.
 *
 * Locally this command refuses to run unless `PONTE_DB_OPS_FORCE_LOCAL=1` is
 * set, which the tests do. That flag exists so the guard logic can be exercised
 * on a disposable database. It bypasses only the loopback/TLS *host* checks,
 * which a disposable local database can never satisfy; every other preflight
 * still runs, so a test cannot silently skip the rules the hosted path needs.
 */

/**
 * Reads the job environment into guard input.
 *
 * The three optional values are passed through untouched on purpose: the guard
 * applies the shared normalisation, so a unit test that calls `guardOperation`
 * directly exercises the same rule as a dispatch. A workflow maps an unset
 * `vars.*` to `""`, and that is exactly what arrives here.
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
    demoBusinessId: environment.PONTE_PUBLIC_DEMO_BUSINESS_ID,
  };
}

const demoFailureText: Record<string, string> = {
  INVALID_INPUT: "Invalid business inputs.",
  NOT_PRODUCTION: "The operation requires NODE_ENV=production.",
  LOCAL_PROVIDER:
    "Refused: local development or local evidence settings are present.",
  LOCAL_DATABASE: "Refused: a non-loopback PostgreSQL URL is required.",
  ADMIN_BUSINESS_UNCONFIGURED:
    "Refused: PONTE_AUTH_BUSINESS_ID is missing or is not a UUID.",
  ADMIN_BUSINESS_MISMATCH:
    "Refused: the demo business UUID must differ from PONTE_AUTH_BUSINESS_ID.",
  DEMO_CONFIG_MISMATCH:
    "Refused: PONTE_PUBLIC_DEMO_BUSINESS_ID / PONTE_PUBLIC_DEMO_READ_ONLY is inconsistent.",
  DEMO_ALREADY_ENABLED:
    "Refused: PONTE_PUBLIC_DEMO_READ_ONLY=1. Provision content before enabling the demo.",
  CONFLICT:
    "Refused: an existing record does not match the expected synthetic content.",
  CONTENT_MISSING:
    "Verification failed: expected synthetic demo content is not present.",
  FAILED: "The synthetic demo provisioning or verification failed.",
};

const businessFailureText: Record<string, string> = {
  INVALID_INPUT: "Invalid business inputs.",
  NOT_PRODUCTION: "This operation requires NODE_ENV=production.",
  LOCAL_PROVIDER: "Local development or local evidence settings are present.",
  LOCAL_DATABASE: "A non-loopback PostgreSQL URL is required.",
  REFUSED: "The production bootstrap preflight did not pass.",
  CONFLICT: "That business UUID already exists with a different name.",
  FAILED: "The production business bootstrap failed.",
};

/**
 * Applies the provisioning module's own preflight before a pool exists.
 *
 * The loopback host and verified-TLS requirements cannot be satisfied by the
 * disposable local database the tests use, so `PONTE_DB_OPS_FORCE_LOCAL=1`
 * substitutes a placeholder hosted URL *for the preflight only*. The real
 * connection string is still handed to `adminDatabaseTransport` afterwards, so
 * nothing about the hosted path is relaxed.
 */
async function preflight(
  operation: GuardedOperation,
  environment: Record<string, string | undefined>,
  forcedLocal: boolean,
): Promise<string | null> {
  if (
    operation.operation !== "business-bootstrap" &&
    operation.operation !== "demo-bootstrap" &&
    operation.operation !== "demo-verify"
  )
    return null;

  const preflightEnvironment: Record<string, string | undefined> = forcedLocal
    ? {
        ...environment,
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://operator@preflight.invalid/ponte",
      }
    : environment;

  // `demo-verify` must work *after* the demo is enabled, so it runs the demo
  // preflight with `verifyOnly: true`, the same relaxation the module itself
  // applies to a read-only pass.
  const verifyOnly = operation.operation === "demo-verify";

  try {
    if (operation.operation === "business-bootstrap") {
      const business = await import("./production-business-bootstrap");
      business.assertProductionBusinessBootstrapEnvironment(
        preflightEnvironment,
      );
    } else {
      const demo = await import("./production-demo-bootstrap");
      demo.assertPublicDemoBootstrapEnvironment(preflightEnvironment, {
        verifyOnly,
      });
    }
  } catch (error) {
    const text =
      operation.operation === "business-bootstrap"
        ? businessFailureText
        : demoFailureText;
    // The demo module reports `{ reason }`; the business module reports
    // `{ code, reason? }`. Both keys are read so one branch can serve both.
    const detail = error as { reason?: unknown; code?: unknown };
    const key =
      typeof detail.reason === "string"
        ? detail.reason
        : typeof detail.code === "string"
          ? detail.code
          : "FAILED";
    const explanation =
      text[key] ??
      (operation.operation === "business-bootstrap"
        ? businessFailureText.REFUSED
        : demoFailureText.FAILED);
    console.error(
      explanation.startsWith("Refused:")
        ? explanation
        : `Refused: ${explanation.charAt(0).toLowerCase()}${explanation.slice(1)}`,
    );
    return "preflight";
  }
  return null;
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
  const operation = guarded.operation;
  console.log(
    `Operation accepted: ${operation.operation} (${operation.readOnly ? "read-only" : "mutating"}).`,
  );
  if (operation.administratorUnconfigured)
    console.log(
      "Note: PONTE_AUTH_BUSINESS_ID is not set, so this run creates the row that the variable must name. Set the variable to this UUID before deploying.",
    );
  if (operation.demoBusinessIdUnconfigured)
    console.log(
      "Note: PONTE_PUBLIC_DEMO_BUSINESS_ID is not set; the tenant named on the dispatch is the only source of the demo UUID.",
    );

  /*
   * The guard can only check `business-bootstrap` against a private UUID that is
   * configured. This repeats the rule with the typed reader so the "unset",
   * "malformed" and "matching" cases are decided in one place — still before any
   * pool exists.
   */
  if (operation.operation === "business-bootstrap") {
    let configured: string | undefined;
    try {
      configured = readConfiguredAdministratorBusinessId(process.env);
    } catch {
      console.error(
        "Refused: PONTE_AUTH_BUSINESS_ID is set but is not a UUID; fix the repository variable before dispatching.",
      );
      process.exitCode = 1;
      return;
    }
    if (configured && configured !== operation.businessId) {
      console.error(
        "Refused: business-bootstrap must use exactly PONTE_AUTH_BUSINESS_ID; otherwise the deployed service would point at a tenant that was never created. Use demo-bootstrap for the synthetic demo tenant.",
      );
      process.exitCode = 1;
      return;
    }
  }

  const preflightFailure = await preflight(operation, process.env, forcedLocal);
  if (preflightFailure) {
    process.exitCode = 1;
    return;
  }

  const transport = adminDatabaseTransport(process.env.DATABASE_URL);
  if (!transport.ok) {
    console.error(`Refused: ${adminDatabaseFailureText[transport.failure]}`);
    process.exitCode = 1;
    return;
  }

  const pool = new Pool(transport.transport);
  try {
    const configuredDemo = readOptionalUuid(
      process.env.PONTE_PUBLIC_DEMO_BUSINESS_ID,
    );
    const result = await runDatabaseOperation(
      pool,
      {
        operation: operation.operation,
        businessId: operation.businessId,
        businessName: operation.businessName,
        configuredDemoBusinessId:
          configuredDemo.state === "configured"
            ? configuredDemo.value
            : undefined,
        demoReadOnlySetting: process.env.PONTE_PUBLIC_DEMO_READ_ONLY,
      },
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
