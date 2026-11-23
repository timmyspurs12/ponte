import { Pool } from "pg";
import {
  adminDatabaseFailureText,
  adminDatabaseTransport,
} from "../src/server/admin-database";
import {
  bootstrapProductionBusiness,
  readProductionBusinessBootstrapCommand,
} from "./production-business-bootstrap";

async function main(): Promise<void> {
  let pool: Pool | undefined;
  try {
    const { input, connectionString } = readProductionBusinessBootstrapCommand(
      process.argv.slice(2),
      process.env,
    );
    // Phase 1.3.9: the one-time business bootstrap is an administrative
    // operation, so it uses the direct endpoint with verified TLS even when it
    // is invoked from a hosted runtime. It never runs as part of a deploy.
    const transport = adminDatabaseTransport(connectionString);
    if (!transport.ok) {
      console.error(
        `Production business bootstrap refused: ${adminDatabaseFailureText[transport.failure]}`,
      );
      process.exitCode = 1;
      return;
    }
    pool = new Pool(transport.transport);
    const result = await bootstrapProductionBusiness(pool, input);
    console.log(
      result.created
        ? "Production business bootstrap completed."
        : "Production business bootstrap already completed.",
    );
  } catch {
    // Do not print a connection string, database exception, business identity,
    // or command argument. The runbook supplies safe correction steps.
    console.error("Production business bootstrap refused or failed.");
    process.exitCode = 1;
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        // Keep the CLI's error boundary non-diagnostic even if shutdown itself
        // has a transport failure.
        if (process.exitCode === undefined) {
          console.error("Production business bootstrap refused or failed.");
          process.exitCode = 1;
        }
      }
    }
  }
}

void main();
