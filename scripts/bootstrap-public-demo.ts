import { Pool } from "pg";
import {
  adminDatabaseFailureText,
  adminDatabaseTransport,
} from "../src/server/admin-database";
import {
  PublicDemoBootstrapError,
  bootstrapPublicDemo,
  readPublicDemoBootstrapCommand,
} from "./production-demo-bootstrap";

/**
 * Narrow reason codes only. They are useful to an operator and reveal no
 * environment value, connection string, row content, or database exception.
 */
const failureText: Record<string, string> = {
  INVALID_INPUT:
    "Invalid arguments. Supply --confirm-production, --business-id and --business-name.",
  NOT_PRODUCTION: "This command runs only with NODE_ENV=production.",
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

async function main(): Promise<void> {
  let pool: Pool | undefined;
  try {
    // `readPublicDemoBootstrapCommand` already applies the typed readers to
    // every optional value, so `PONTE_PUBLIC_DEMO_READ_ONLY=""` from an unset
    // Actions variable is understood as "disabled" instead of a config error.
    const { input, verifyOnly, connectionString } =
      readPublicDemoBootstrapCommand(process.argv.slice(2), process.env);
    // Phase 1.3.9: synthetic-demo provisioning is administrative, so it uses
    // the direct endpoint with verified TLS. `max: 1` keeps the operator's
    // footprint to a single slot on the smallest Neon compute.
    const transport = adminDatabaseTransport(connectionString);
    if (!transport.ok) {
      console.error(
        `Synthetic public demo provisioning refused: ${adminDatabaseFailureText[transport.failure]}`,
      );
      process.exitCode = 1;
      return;
    }
    pool = new Pool(transport.transport);
    const result = await bootstrapPublicDemo(pool, input, { verifyOnly });
    const counts = `${result.invoices} invoices, ${result.quotes} quotes, ${result.payments} payments, ${result.settlements} settlements`;
    if (verifyOnly) console.log(`Synthetic public demo verified: ${counts}.`);
    else if (result.created)
      console.log(
        `Synthetic public demo provisioned (${counts}). Enable the public demo environment variables only after this step.`,
      );
    else
      console.log(
        `Synthetic public demo already provisioned and unchanged (${counts}).`,
      );
  } catch (error) {
    const reason =
      error instanceof PublicDemoBootstrapError ? error.reason : "FAILED";
    console.error(
      `Synthetic public demo provisioning refused or failed: ${failureText[reason] ?? failureText.FAILED}`,
    );
    process.exitCode = 1;
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        // Keep the CLI's boundary non-diagnostic if shutdown itself fails.
        if (process.exitCode === undefined) {
          console.error(failureText.FAILED);
          process.exitCode = 1;
        }
      }
    }
  }
}

void main();
