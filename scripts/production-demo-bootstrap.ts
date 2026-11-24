import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { readDemoFlag, readOptionalUuid } from "./optional-environment";
import {
  PUBLIC_DEMO_INVOICES,
  hasSimulatedSettlement,
  isFundedStatus,
  publicDemoInvoiceData,
  publicDemoInvoiceId,
  publicDemoPaymentId,
  publicDemoQuote,
  publicDemoQuoteExpiry,
  publicDemoQuoteId,
  publicDemoSelectedRoute,
  publicDemoSettlementId,
  publicDemoSettledAt,
  type PublicDemoInvoiceSpec,
} from "../src/server/public-demo-data";

const demoBootstrapInput = z.object({
  businessId: z.uuid(),
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

export type PublicDemoBootstrapInput = z.infer<typeof demoBootstrapInput>;

/**
 * Short, non-secret reason codes. The CLI prints only one of these; it never
 * prints an environment value, connection string, row content, or database
 * exception.
 */
export type PublicDemoBootstrapFailure =
  | "INVALID_INPUT"
  | "NOT_PRODUCTION"
  | "LOCAL_PROVIDER"
  | "LOCAL_DATABASE"
  | "ADMIN_BUSINESS_UNCONFIGURED"
  | "ADMIN_BUSINESS_MISMATCH"
  | "DEMO_CONFIG_MISMATCH"
  | "DEMO_ALREADY_ENABLED"
  | "CONFLICT"
  | "CONTENT_MISSING"
  | "FAILED";

export class PublicDemoBootstrapError extends Error {
  constructor(public readonly reason: PublicDemoBootstrapFailure) {
    super(reason);
    this.name = "PublicDemoBootstrapError";
  }
}

function stop(reason: PublicDemoBootstrapFailure): never {
  throw new PublicDemoBootstrapError(reason);
}

export function parsePublicDemoBootstrapInput(
  input: unknown,
): PublicDemoBootstrapInput {
  const parsed = demoBootstrapInput.safeParse(input);
  if (!parsed.success) return stop("INVALID_INPUT");
  return parsed.data;
}

export type PublicDemoBootstrapArguments = {
  input: PublicDemoBootstrapInput;
  /** Verification performs read-only comparisons and never writes. */
  verifyOnly: boolean;
};

/** Strict grammar: no implicit confirmation, no extra flags, no duplicates. */
export function parsePublicDemoBootstrapArguments(
  args: readonly string[],
): PublicDemoBootstrapArguments {
  let confirmed = false;
  let verifyOnly = false;
  let businessId: string | undefined;
  let businessName: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--confirm-production") {
      if (confirmed) return stop("INVALID_INPUT");
      confirmed = true;
      continue;
    }
    if (argument === "--verify") {
      if (verifyOnly) return stop("INVALID_INPUT");
      verifyOnly = true;
      continue;
    }
    if (argument === "--business-id" || argument === "--business-name") {
      const value = args[++index];
      if (!value) return stop("INVALID_INPUT");
      if (argument === "--business-id") {
        if (businessId !== undefined) return stop("INVALID_INPUT");
        businessId = value;
      } else {
        if (businessName !== undefined) return stop("INVALID_INPUT");
        businessName = value;
      }
      continue;
    }
    return stop("INVALID_INPUT");
  }

  if (!confirmed || businessId === undefined || businessName === undefined)
    return stop("INVALID_INPUT");
  return {
    input: parsePublicDemoBootstrapInput({ businessId, businessName }),
    verifyOnly,
  };
}

export type PublicDemoEnvironment = {
  connectionString: string;
  administratorBusinessId: string;
};

/**
 * Refuses the accidental paths before a Pool exists. This command targets an
 * approved hosted production shell only: it is not a seed command and it
 * refuses a loopback database, a local provider opt-in, or a non-production
 * runtime.
 *
 * It also enforces the documented ordering: provisioning must happen while the
 * public demo flag is still disabled, and a pre-set demo business identifier
 * must name the same tenant this command populates.
 */
export function assertPublicDemoBootstrapEnvironment(
  environment: Record<string, string | undefined>,
  options: { verifyOnly: boolean },
): PublicDemoEnvironment {
  if (environment.NODE_ENV !== "production") return stop("NOT_PRODUCTION");
  if (localOnlyEnvironmentNames.some((name) => environment[name] !== undefined))
    return stop("LOCAL_PROVIDER");

  const connectionString = environment.DATABASE_URL;
  if (!connectionString) return stop("LOCAL_DATABASE");
  try {
    const databaseUrl = new URL(connectionString);
    if (
      !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
      !databaseUrl.hostname ||
      localDatabaseHosts.has(databaseUrl.hostname)
    )
      return stop("LOCAL_DATABASE");
  } catch {
    return stop("LOCAL_DATABASE");
  }

  /*
   * All three optional values arrive from a GitHub Actions job environment,
   * where an unset repository variable is the empty string rather than absent.
   * `optional-environment.ts` owns the distinction: absent and `""` are unset,
   * whitespace-only is malformed, and anything non-empty must validate.
   */
  const administrator = readOptionalUuid(environment.PONTE_AUTH_BUSINESS_ID);
  if (administrator.state !== "configured")
    return stop("ADMIN_BUSINESS_UNCONFIGURED");
  const administratorBusinessId = administrator.value;

  const configuredDemo = readOptionalUuid(
    environment.PONTE_PUBLIC_DEMO_BUSINESS_ID,
  );
  if (configuredDemo.state === "invalid") return stop("DEMO_CONFIG_MISMATCH");

  const demoSetting = readDemoFlag(environment.PONTE_PUBLIC_DEMO_READ_ONLY);
  if (demoSetting.state === "invalid") return stop("DEMO_CONFIG_MISMATCH");
  if (demoSetting.state === "enabled" && !options.verifyOnly)
    return stop("DEMO_ALREADY_ENABLED");

  return { connectionString, administratorBusinessId };
}

/**
 * Applies every static guard before the caller can create a database
 * connection. The demo UUID must differ from the private administrator
 * business and from any already-configured demo identifier.
 */
export function readPublicDemoBootstrapCommand(
  args: readonly string[],
  environment: Record<string, string | undefined>,
): {
  input: PublicDemoBootstrapInput;
  verifyOnly: boolean;
  connectionString: string;
} {
  const { input, verifyOnly } = parsePublicDemoBootstrapArguments(args);
  const { connectionString, administratorBusinessId } =
    assertPublicDemoBootstrapEnvironment(environment, { verifyOnly });
  if (input.businessId === administratorBusinessId)
    return stop("ADMIN_BUSINESS_MISMATCH");
  const configuredDemo = readOptionalUuid(
    environment.PONTE_PUBLIC_DEMO_BUSINESS_ID,
  );
  if (configuredDemo.state === "invalid") return stop("DEMO_CONFIG_MISMATCH");
  if (
    configuredDemo.state === "configured" &&
    configuredDemo.value !== input.businessId.trim().toLowerCase()
  )
    return stop("DEMO_CONFIG_MISMATCH");
  return { input, verifyOnly, connectionString };
}

export type PublicDemoBootstrapResult = {
  created: boolean;
  verified: true;
  invoices: number;
  quotes: number;
  payments: number;
  settlements: number;
};

const EXPECTED_INVOICES = PUBLIC_DEMO_INVOICES.length;
const EXPECTED_QUOTES = PUBLIC_DEMO_INVOICES.filter((invoice) =>
  hasSimulatedSettlement(invoice.status),
).length;
const EXPECTED_PAYMENTS = PUBLIC_DEMO_INVOICES.filter((invoice) =>
  isFundedStatus(invoice.status),
).length;
const EXPECTED_SETTLEMENTS = EXPECTED_QUOTES;

/**
 * The exact shape of the synthetic payload, derived from the fixture module.
 *
 * Exported so that an independent verifier (the `demo-verify` database
 * operation) compares against the same numbers the provisioner writes instead
 * of restating them. A second hard-coded copy is how a verification command
 * quietly stops verifying anything.
 */
export const PUBLIC_DEMO_EXPECTED_COUNTS = Object.freeze({
  invoices: EXPECTED_INVOICES,
  quotes: EXPECTED_QUOTES,
  payments: EXPECTED_PAYMENTS,
  settlements: EXPECTED_SETTLEMENTS,
});

/**
 * Inserts one row only when it is absent; otherwise proves that the existing
 * row is exactly the expected synthetic record. A mismatch is a conflict — this
 * command never updates, deletes, or repairs existing data.
 */
async function insertOrVerify(
  db: PoolClient,
  insert: { text: string; values: unknown[] },
  verify: { text: string; values: unknown[] },
): Promise<boolean> {
  const inserted = await db.query(insert.text, insert.values);
  if (inserted.rowCount === 1) return true;
  const existing = await db.query(verify.text, verify.values);
  if (existing.rowCount !== 1) return stop("CONFLICT");
  return false;
}

/**
 * Read-only verification that the synthetic tenant and every example row are
 * exactly the expected contents. Backs `--verify` and the post-provisioning
 * authorization check in the runbook.
 */
export async function verifyPublicDemoContent(
  db: PoolClient,
  input: PublicDemoBootstrapInput,
): Promise<PublicDemoBootstrapResult> {
  const business = await db.query(
    "SELECT 1 FROM businesses WHERE id=$1 AND name=$2",
    [input.businessId, input.businessName],
  );
  if (business.rowCount !== 1) return stop("CONTENT_MISSING");

  let invoices = 0;
  let quotes = 0;
  let payments = 0;
  let settlements = 0;

  for (const spec of PUBLIC_DEMO_INVOICES) {
    const invoiceId = publicDemoInvoiceId(spec.slug);
    const invoice = await db.query(
      "SELECT 1 FROM invoices WHERE id=$1 AND business_id=$2 AND reference=$3 AND funding_minor=$4 AND status=$5 AND data=$6::jsonb AND created_at=$7::timestamptz",
      [
        invoiceId,
        input.businessId,
        spec.reference,
        spec.fundingMinor,
        spec.status,
        JSON.stringify(publicDemoInvoiceData(spec)),
        spec.createdAt,
      ],
    );
    if (invoice.rowCount !== 1) return stop("CONFLICT");
    invoices++;

    if (isFundedStatus(spec.status)) {
      const paymentId = publicDemoPaymentId(spec.slug);
      const payment = await db.query(
        "SELECT 1 FROM payments WHERE id=$1 AND business_id=$2 AND invoice_id=$3 AND provider='simulation' AND provider_reference=$4 AND funding_minor=$5 AND funding_currency='BRL' AND status='Confirmed' AND received_at=$6::timestamptz",
        [
          paymentId,
          input.businessId,
          invoiceId,
          `SIM-${paymentId}`,
          spec.fundingMinor,
          spec.createdAt,
        ],
      );
      if (payment.rowCount !== 1) return stop("CONFLICT");
      payments++;
    }

    if (hasSimulatedSettlement(spec.status)) {
      const quote = await db.query(
        "SELECT 1 FROM quotes WHERE id=$1 AND business_id=$2 AND invoice_id=$3 AND source='simulation-fixed-525' AND simulated AND data=$4::jsonb AND expires_at=$5::timestamptz",
        [
          publicDemoQuoteId(spec.slug),
          input.businessId,
          invoiceId,
          JSON.stringify(publicDemoQuote(spec)),
          publicDemoQuoteExpiry(spec).toISOString(),
        ],
      );
      if (quote.rowCount !== 1) return stop("CONFLICT");
      quotes++;

      const route = publicDemoSelectedRoute(spec);
      const settled = spec.status === "Settled";
      const settlement = await db.query(
        settled
          ? "SELECT 1 FROM settlements WHERE id=$1 AND business_id=$2 AND invoice_id=$3 AND quote_id=$4 AND route_id=$5 AND status='Settled' AND expected_minor=$6 AND minimum_minor=$7 AND actual_minor=$6 AND transaction_hash IS NULL AND settled_at=$8::timestamptz"
          : "SELECT 1 FROM settlements WHERE id=$1 AND business_id=$2 AND invoice_id=$3 AND quote_id=$4 AND route_id=$5 AND status='Routing' AND expected_minor=$6 AND minimum_minor=$7 AND actual_minor IS NULL AND transaction_hash IS NULL AND settled_at IS NULL",
        settled
          ? [
              publicDemoSettlementId(spec.slug),
              input.businessId,
              invoiceId,
              publicDemoQuoteId(spec.slug),
              spec.selectedRoute ?? "direct",
              route.outputMinor,
              route.minimumOutputMinor,
              publicDemoSettledAt(spec).toISOString(),
            ]
          : [
              publicDemoSettlementId(spec.slug),
              input.businessId,
              invoiceId,
              publicDemoQuoteId(spec.slug),
              spec.selectedRoute ?? "direct",
              route.outputMinor,
              route.minimumOutputMinor,
            ],
      );
      if (settlement.rowCount !== 1) return stop("CONFLICT");
      settlements++;
    }
  }

  return {
    created: false,
    verified: true,
    invoices,
    quotes,
    payments,
    settlements,
  };
}

/**
 * Creates the distinct synthetic demo tenant and its small deterministic
 * collection of example invoices inside ONE transaction.
 *
 * It writes only `businesses`, `invoices`, `payments`, `quotes` and
 * `settlements`. It deliberately creates no users, memberships, external
 * identities, payment events (those record a human actor), evidence records,
 * outbox jobs, KMS metadata, or registry data. It never deletes or resets.
 */
export async function bootstrapPublicDemo(
  pool: Pool,
  untrustedInput: unknown,
  options: { verifyOnly?: boolean } = {},
): Promise<PublicDemoBootstrapResult> {
  const input = parsePublicDemoBootstrapInput(untrustedInput);
  const verifyOnly = options.verifyOnly === true;
  let database: PoolClient | undefined;
  let transactionOpen = false;
  try {
    database = await pool.connect();
    await database.query(verifyOnly ? "BEGIN READ ONLY" : "BEGIN");
    transactionOpen = true;

    if (verifyOnly) {
      const result = await verifyPublicDemoContent(database, input);
      await database.query("COMMIT");
      transactionOpen = false;
      return result;
    }

    const businessCreated = await insertOrVerify(
      database,
      {
        text: "INSERT INTO businesses(id,name) VALUES($1,$2) ON CONFLICT (id) DO NOTHING RETURNING id",
        values: [input.businessId, input.businessName],
      },
      {
        text: "SELECT 1 FROM businesses WHERE id=$1 AND name=$2",
        values: [input.businessId, input.businessName],
      },
    );

    let invoiceCount = 0;
    let quoteCount = 0;
    let paymentCount = 0;
    let settlementCount = 0;

    for (const spec of PUBLIC_DEMO_INVOICES) {
      const invoiceId = publicDemoInvoiceId(spec.slug);
      if (
        await insertOrVerify(
          database,
          {
            text: "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz) ON CONFLICT (id) DO NOTHING RETURNING id",
            values: [
              invoiceId,
              input.businessId,
              spec.reference,
              spec.fundingMinor,
              spec.status,
              JSON.stringify(publicDemoInvoiceData(spec)),
              spec.createdAt,
            ],
          },
          {
            text: "SELECT 1 FROM invoices WHERE id=$1 AND business_id=$2 AND reference=$3 AND funding_minor=$4 AND status=$5 AND data=$6::jsonb AND created_at=$7::timestamptz",
            values: [
              invoiceId,
              input.businessId,
              spec.reference,
              spec.fundingMinor,
              spec.status,
              JSON.stringify(publicDemoInvoiceData(spec)),
              spec.createdAt,
            ],
          },
        )
      )
        invoiceCount++;

      if (isFundedStatus(spec.status)) {
        const paymentId = publicDemoPaymentId(spec.slug);
        if (
          await insertOrVerify(
            database,
            {
              text: "INSERT INTO payments(id,business_id,invoice_id,provider,provider_reference,funding_minor,received_at) VALUES($1,$2,$3,'simulation',$4,$5,$6::timestamptz) ON CONFLICT (id) DO NOTHING RETURNING id",
              values: [
                paymentId,
                input.businessId,
                invoiceId,
                `SIM-${paymentId}`,
                spec.fundingMinor,
                spec.createdAt,
              ],
            },
            {
              text: "SELECT 1 FROM payments WHERE id=$1 AND business_id=$2 AND invoice_id=$3 AND provider='simulation' AND provider_reference=$4 AND funding_minor=$5 AND received_at=$6::timestamptz",
              values: [
                paymentId,
                input.businessId,
                invoiceId,
                `SIM-${paymentId}`,
                spec.fundingMinor,
                spec.createdAt,
              ],
            },
          )
        )
          paymentCount++;
      }

      if (hasSimulatedSettlement(spec.status)) {
        const quoteId = publicDemoQuoteId(spec.slug);
        if (
          await insertOrVerify(
            database,
            {
              text: "INSERT INTO quotes(id,business_id,invoice_id,source,simulated,data,expires_at,created_at) VALUES($1,$2,$3,'simulation-fixed-525',true,$4::jsonb,$5::timestamptz,$6::timestamptz) ON CONFLICT (id) DO NOTHING RETURNING id",
              values: [
                quoteId,
                input.businessId,
                invoiceId,
                JSON.stringify(publicDemoQuote(spec)),
                publicDemoQuoteExpiry(spec).toISOString(),
                spec.createdAt,
              ],
            },
            {
              text: "SELECT 1 FROM quotes WHERE id=$1 AND business_id=$2 AND invoice_id=$3 AND source='simulation-fixed-525' AND simulated AND data=$4::jsonb AND expires_at=$5::timestamptz",
              values: [
                quoteId,
                input.businessId,
                invoiceId,
                JSON.stringify(publicDemoQuote(spec)),
                publicDemoQuoteExpiry(spec).toISOString(),
              ],
            },
          )
        )
          quoteCount++;

        const route = publicDemoSelectedRoute(spec);
        const settled = spec.status === "Settled";
        // `settlements.transaction_hash` is constrained to NULL, so a simulated
        // settlement can never claim a blockchain transaction.
        const settlementInsert = settled
          ? {
              text: "INSERT INTO settlements(id,business_id,invoice_id,quote_id,route_id,expected_minor,minimum_minor,actual_minor,status,settled_at,created_at,transaction_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$6,'Settled',$8::timestamptz,$9::timestamptz,NULL) ON CONFLICT (id) DO NOTHING RETURNING id",
              values: [
                publicDemoSettlementId(spec.slug),
                input.businessId,
                invoiceId,
                quoteId,
                spec.selectedRoute ?? "direct",
                route.outputMinor,
                route.minimumOutputMinor,
                publicDemoSettledAt(spec).toISOString(),
                spec.createdAt,
              ],
            }
          : {
              text: "INSERT INTO settlements(id,business_id,invoice_id,quote_id,route_id,expected_minor,minimum_minor,status,created_at,transaction_hash) VALUES($1,$2,$3,$4,$5,$6,$7,'Routing',$8::timestamptz,NULL) ON CONFLICT (id) DO NOTHING RETURNING id",
              values: [
                publicDemoSettlementId(spec.slug),
                input.businessId,
                invoiceId,
                quoteId,
                spec.selectedRoute ?? "direct",
                route.outputMinor,
                route.minimumOutputMinor,
                spec.createdAt,
              ],
            };
        if (
          await insertOrVerify(database, settlementInsert, {
            text: settled
              ? "SELECT 1 FROM settlements WHERE id=$1 AND business_id=$2 AND invoice_id=$3 AND quote_id=$4 AND route_id=$5 AND status='Settled' AND expected_minor=$6 AND minimum_minor=$7 AND actual_minor=$6 AND transaction_hash IS NULL AND settled_at IS NOT NULL"
              : "SELECT 1 FROM settlements WHERE id=$1 AND business_id=$2 AND invoice_id=$3 AND quote_id=$4 AND route_id=$5 AND status='Routing' AND expected_minor=$6 AND minimum_minor=$7 AND actual_minor IS NULL AND transaction_hash IS NULL AND settled_at IS NULL",
            values: [
              publicDemoSettlementId(spec.slug),
              input.businessId,
              invoiceId,
              quoteId,
              spec.selectedRoute ?? "direct",
              route.outputMinor,
              route.minimumOutputMinor,
            ],
          })
        )
          settlementCount++;
      }
    }

    // Prove the transaction's own writes before committing: a mismatch rolls
    // back the whole provisioning attempt instead of leaving a partial tenant.
    const verified = await verifyPublicDemoContent(database, input);
    await database.query("COMMIT");
    transactionOpen = false;

    return {
      created:
        businessCreated ||
        invoiceCount > 0 ||
        quoteCount > 0 ||
        paymentCount > 0 ||
        settlementCount > 0,
      verified: verified.verified,
      invoices: verified.invoices,
      quotes: verified.quotes,
      payments: verified.payments,
      settlements: verified.settlements,
    };
  } catch (error) {
    if (transactionOpen && database) {
      try {
        await database.query("ROLLBACK");
      } catch {
        // Never expose database diagnostics; still release the client below.
      }
    }
    if (error instanceof PublicDemoBootstrapError) throw error;
    if ((error as { code?: string })?.code === "23505") return stop("CONFLICT");
    return stop("FAILED");
  } finally {
    database?.release();
  }
}
