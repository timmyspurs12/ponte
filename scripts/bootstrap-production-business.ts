import { Pool } from "pg";
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
    pool = new Pool({ connectionString });
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
