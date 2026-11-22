import { z } from "zod";
import type { Pool, PoolClient } from "pg";

const businessBootstrapInput = z.object({
  businessId: z.uuid(),
  // The database schema permits text. This operational command uses a bounded,
  // trimmed display name so an accidental shell invocation cannot create a
  // blank or unbounded record.
  businessName: z.string().trim().min(1).max(200),
});

const localDatabaseHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const localOnlyEnvironmentNames = [
  "PONTE_DEV_AUTH",
  "PONTE_DEV_TOKEN",
  "PONTE_DEV_BUSINESS_ID",
  "PONTE_DEV_USER_ID",
  "PONTE_LOCAL_EVIDENCE_TEST_PROVIDER",
  "PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS",
] as const;

export type ProductionBusinessBootstrapInput = z.infer<
  typeof businessBootstrapInput
>;

export class ProductionBusinessBootstrapError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "REFUSED" | "CONFLICT" | "FAILED",
  ) {
    super(code);
    this.name = "ProductionBusinessBootstrapError";
  }
}

function invalidInput(): never {
  throw new ProductionBusinessBootstrapError("INVALID_INPUT");
}

function refused(): never {
  throw new ProductionBusinessBootstrapError("REFUSED");
}

function failed(): never {
  throw new ProductionBusinessBootstrapError("FAILED");
}

export function parseProductionBusinessBootstrapInput(
  input: unknown,
): ProductionBusinessBootstrapInput {
  const parsed = businessBootstrapInput.safeParse(input);
  if (!parsed.success) return invalidInput();
  return parsed.data;
}

/**
 * Strict, intentionally small CLI grammar. There is no implicit confirmation,
 * no environment-sourced business identity, and no support for extra flags.
 */
export function parseProductionBusinessBootstrapArguments(
  args: readonly string[],
): ProductionBusinessBootstrapInput {
  let confirmed = false;
  let businessId: string | undefined;
  let businessName: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--confirm-production") {
      if (confirmed) return invalidInput();
      confirmed = true;
      continue;
    }
    if (argument === "--business-id" || argument === "--business-name") {
      const value = args[++index];
      if (!value) return invalidInput();
      if (argument === "--business-id") {
        if (businessId !== undefined) return invalidInput();
        businessId = value;
      } else {
        if (businessName !== undefined) return invalidInput();
        businessName = value;
      }
      continue;
    }
    return invalidInput();
  }

  if (!confirmed || businessId === undefined || businessName === undefined)
    return invalidInput();
  return parseProductionBusinessBootstrapInput({ businessId, businessName });
}

/**
 * Refuses the common accidental paths before a Pool is created. This command is
 * for an approved hosted production shell only, not a shortcut for local seed
 * data or integration tests.
 */
export function assertProductionBusinessBootstrapEnvironment(
  environment: Record<string, string | undefined>,
): string {
  if (environment.NODE_ENV !== "production") return refused();
  if (localOnlyEnvironmentNames.some((name) => environment[name] !== undefined))
    return refused();

  const connectionString = environment.DATABASE_URL;
  if (!connectionString) return refused();
  try {
    const databaseUrl = new URL(connectionString);
    if (
      !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
      !databaseUrl.hostname ||
      localDatabaseHosts.has(databaseUrl.hostname)
    ) {
      return refused();
    }
  } catch {
    return refused();
  }
  return connectionString;
}

/**
 * Parses all command inputs and validates the runtime guard before the caller
 * can create a database connection.
 */
export function readProductionBusinessBootstrapCommand(
  args: readonly string[],
  environment: Record<string, string | undefined>,
): { input: ProductionBusinessBootstrapInput; connectionString: string } {
  const input = parseProductionBusinessBootstrapArguments(args);
  const connectionString =
    assertProductionBusinessBootstrapEnvironment(environment);
  return { input, connectionString };
}

/**
 * Creates exactly one business row. Repeating the exact same request returns
 * the existing row without an UPDATE; a reused UUID with any other name fails
 * without altering the record. It deliberately has no users, memberships,
 * fixtures, OAuth configuration, or evidence side effects.
 */
export async function bootstrapProductionBusiness(
  pool: Pool,
  untrustedInput: unknown,
): Promise<{ created: boolean }> {
  const input = parseProductionBusinessBootstrapInput(untrustedInput);
  let database: PoolClient | undefined;
  let transactionOpen = false;
  try {
    database = await pool.connect();
    await database.query("BEGIN");
    transactionOpen = true;

    const inserted = await database.query<{ id: string; name: string }>(
      "INSERT INTO businesses(id,name) VALUES($1,$2) ON CONFLICT (id) DO NOTHING RETURNING id,name",
      [input.businessId, input.businessName],
    );
    if (inserted.rowCount === 1) {
      await database.query("COMMIT");
      transactionOpen = false;
      return { created: true };
    }

    const existing = await database.query<{ id: string; name: string }>(
      "SELECT id,name FROM businesses WHERE id=$1",
      [input.businessId],
    );
    if (existing.rowCount !== 1) return failed();
    if (existing.rows[0].name !== input.businessName)
      throw new ProductionBusinessBootstrapError("CONFLICT");

    await database.query("COMMIT");
    transactionOpen = false;
    return { created: false };
  } catch (error) {
    if (transactionOpen && database) {
      try {
        await database.query("ROLLBACK");
      } catch {
        // The command exposes no database diagnostics. Preserve the original
        // outcome and still release the client below.
      }
    }
    if (error instanceof ProductionBusinessBootstrapError) throw error;
    return failed();
  } finally {
    database?.release();
  }
}
