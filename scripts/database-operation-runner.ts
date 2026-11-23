import type { Pool } from "pg";
import type { DatabaseOperation } from "./deployment-workflow-guards";

/**
 * Executes exactly one approved database operation against a schema that has
 * already been migrated. Importing this module has no side effects.
 *
 * Design rules, all enforced here rather than in YAML:
 *
 * - `migrate` is forward-only. It never calls `db:reset`, `db:seed`,
 *   `db:fixtures`, `DROP`, or `TRUNCATE`.
 * - `business-bootstrap` creates exactly one business row. It creates no user,
 *   no membership, and no credentials; administrator access is bound later by
 *   the first GitHub OAuth sign-in against `PONTE_AUTH_ADMIN_GITHUB_IDS`.
 * - `demo-bootstrap` reuses the Phase 1.3.8 provisioning module, including its
 *   insert-or-verify semantics and its refusal to run while
 *   `PONTE_PUBLIC_DEMO_READ_ONLY=1`.
 * - `demo-verify` is the read-only counterpart: it names the synthetic tenant,
 *   calls the same module with `verifyOnly: true` (a `READ ONLY` transaction),
 *   and adds the invariants that must hold after the public demo is enabled.
 *   It works while the flag is `0` *and* while it is `1`.
 * - `verify` is read-only too, but it asserts nothing about a tenant it was not
 *   told about: a first-time viewer legitimately creates a membership in the
 *   demo tenant, so a global "zero memberships" claim would be both wrong and
 *   alarming.
 */

export type DatabaseOperationResult = {
  ok: boolean;
  lines: string[];
};

type MigrationVerification = {
  recorded: string[];
  pending: string[];
  ledgerPresent: boolean;
};

type Migrator = {
  verifyMigrations: (
    pool: Pool,
    directory?: string,
  ) => Promise<MigrationVerification>;
};

type Bootstrap = (
  pool: Pool,
  input: { businessId: string; businessName: string },
) => Promise<{ created: boolean }>;

type DemoBootstrap = (
  pool: Pool,
  input: { businessId: string; businessName: string },
  options: { verifyOnly: boolean },
) => Promise<{
  created: boolean;
  verified: true;
  invoices: number;
  quotes: number;
  payments: number;
  settlements: number;
}>;

export type RunnerDependencies = {
  verifyMigrations: Migrator["verifyMigrations"];
  /** Injected so the runner is testable without importing the CLI module. */
  applyMigrations?: (
    pool: Pool,
    directory?: string,
  ) => Promise<{ applied: string[]; alreadyApplied: string[] }>;
  bootstrapBusiness?: Bootstrap;
  bootstrapDemo?: DemoBootstrap;
};

/**
 * The provisioning modules are imported lazily: importing them at module scope
 * would load the full demo fixture graph into every process that merely wants
 * to validate inputs.
 */
async function defaultApplyMigrations(pool: Pool, directory?: string) {
  const migrations = await import("./migrate");
  return migrations.applyMigrations(pool, directory);
}

async function defaultBootstrapBusiness(
  pool: Pool,
  input: { businessId: string; businessName: string },
) {
  const business = await import("./production-business-bootstrap");
  return business.bootstrapProductionBusiness(pool, input);
}

async function defaultBootstrapDemo(
  pool: Pool,
  input: { businessId: string; businessName: string },
  options: { verifyOnly: boolean },
) {
  const demo = await import("./production-demo-bootstrap");
  return demo.bootstrapPublicDemo(pool, input, options);
}

/** Confirms the core tables exist before a tenant-writing operation runs. */
async function schemaIsMigrated(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>(
    "SELECT to_regclass('public.businesses') IS NOT NULL AND to_regclass('public.schema_migrations') IS NOT NULL AS present",
  );
  return result.rows[0]?.present === true;
}

export type RunOperationInput = {
  operation: DatabaseOperation;
  businessId?: string;
  businessName?: string;
  /**
   * `PONTE_PUBLIC_DEMO_BUSINESS_ID` as seen by the caller. Validated against
   * the operation's `businessId` before any query runs.
   */
  configuredDemoBusinessId?: string;
};

/**
 * The expected synthetic payload, read from the same fixture module the
 * provisioner uses. Hard-coding the numbers in a second place is how a
 * verification command silently stops verifying anything.
 */
async function expectedDemoCounts() {
  const demo = await import("./production-demo-bootstrap");
  return demo.PUBLIC_DEMO_EXPECTED_COUNTS;
}

export async function runDatabaseOperation(
  pool: Pool,
  operation: RunOperationInput,
  dependencies: RunnerDependencies,
): Promise<DatabaseOperationResult> {
  const applyMigrations =
    dependencies.applyMigrations ?? defaultApplyMigrations;

  if (operation.operation === "migrate") {
    const result = await applyMigrations(pool);
    const lines = [
      result.applied.length
        ? `Applied ${result.applied.length} migration(s): ${result.applied.join(", ")}.`
        : "No pending migrations; schema already current.",
      `${result.alreadyApplied.length} migration(s) were already recorded.`,
    ];
    return { ok: true, lines };
  }

  const verification = await dependencies.verifyMigrations(pool);

  if (operation.operation === "verify") {
    /*
     * Read-only, and deliberately tenant-agnostic. It reports the migration
     * ledger and two facts that do not depend on knowing a tenant UUID:
     *
     * 1. No settlement claims a blockchain transaction. `transaction_hash` is
     *    constrained to NULL by the schema; a non-zero count would mean the
     *    constraint was dropped.
     * 2. No demo evidence/outbox record implies KMS or blockchain activity.
     *    The synthetic demo never writes those tables at all.
     *
     * It does **not** count demo memberships: the first GitHub sign-in by a
     * viewer legitimately creates one, so "zero memberships" is only meaningful
     * when the operator has named the demo tenant, which is what `demo-verify`
     * is for.
     *
     * The invariant query itself is gated on the tables existing. A fresh Neon
     * project has none of them, so running it unconditionally would replace the
     * fix for the missing ledger with an identical `42P01` one query later.
     */
    const presence = await pool.query<{ present: boolean }>(
      `SELECT
         to_regclass('public.settlements') IS NOT NULL
         AND to_regclass('public.route_decision_evidence') IS NOT NULL
         AND to_regclass('public.evidence_outbox') IS NOT NULL AS present`,
    );
    const tablesPresent = presence.rows[0]?.present === true;

    let invariantLine: string;
    if (tablesPresent) {
      const invariants = await pool.query<{
        chain_hashes: string;
        evidence_records: string;
        outbox_records: string;
      }>(
        `SELECT
           (SELECT count(*) FROM settlements WHERE transaction_hash IS NOT NULL)::text AS chain_hashes,
           (SELECT count(*) FROM route_decision_evidence)::text AS evidence_records,
           (SELECT count(*) FROM evidence_outbox)::text AS outbox_records`,
      );
      const row = invariants.rows[0];
      invariantLine = `Chain transactions: ${row?.chain_hashes ?? "unknown"} (expected 0); evidence records: ${row?.evidence_records ?? "unknown"}; outbox records: ${row?.outbox_records ?? "unknown"}.`;
    } else {
      invariantLine =
        "Chain and evidence invariants: not applicable yet — settlements, route_decision_evidence and evidence_outbox do not exist. There is nothing to misreport on an empty database.";
    }

    if (!verification.ledgerPresent) {
      return {
        ok: true,
        lines: [
          "No schema_migrations table yet: this database has never been migrated.",
          `Not yet applied: all ${verification.pending.length} migration(s) on disk are pending (${verification.pending.join(", ")}).`,
          "Nothing was written; verify only reads. Run the migrate operation next.",
          invariantLine,
          "The application's own /api/health/ready endpoint is the authoritative runtime check.",
        ],
      };
    }

    return {
      ok: true,
      lines: [
        verification.pending.length
          ? `${verification.recorded.length} migration(s) recorded; ${verification.pending.length} pending (${verification.pending.join(", ")}). Run the migrate operation.`
          : `Schema current: ${verification.recorded.length} migration(s) recorded, none pending.`,
        invariantLine,
        "The application's own /api/health/ready endpoint is the authoritative runtime check.",
      ],
    };
  }

  if (operation.operation === "demo-verify") {
    return runDemoVerify(pool, operation, verification, dependencies);
  }

  if (verification.pending.length) {
    return {
      ok: false,
      lines: [
        `Refused: ${verification.pending.length} migration(s) are pending (${verification.pending.join(", ")}). Run the migrate operation first.`,
      ],
    };
  }

  if (!(await schemaIsMigrated(pool))) {
    return {
      ok: false,
      lines: [
        "Refused: core tables are missing. Run the migrate operation first.",
      ],
    };
  }

  if (
    operation.operation === "business-bootstrap" ||
    operation.operation === "demo-bootstrap"
  ) {
    if (!operation.businessId || !operation.businessName) {
      return {
        ok: false,
        lines: ["Refused: business_id and business_name are required."],
      };
    }
  }

  if (operation.operation === "business-bootstrap") {
    const bootstrapBusiness =
      dependencies.bootstrapBusiness ?? defaultBootstrapBusiness;
    const result = await bootstrapBusiness(pool, {
      businessId: operation.businessId!,
      businessName: operation.businessName!,
    });
    return {
      ok: true,
      lines: [
        result.created
          ? "Private business created. Grant administrator access by signing in with an allow-listed GitHub account; no user or membership row is created here."
          : "Private business already exists with the same name; nothing was changed.",
      ],
    };
  }

  // demo-bootstrap
  const bootstrapDemo = dependencies.bootstrapDemo ?? defaultBootstrapDemo;
  const result = await bootstrapDemo(
    pool,
    {
      businessId: operation.businessId!,
      businessName: operation.businessName!,
    },
    { verifyOnly: false },
  );
  const counts = `${result.invoices} invoices, ${result.quotes} quotes, ${result.payments} payments, ${result.settlements} settlements`;
  return {
    ok: true,
    lines: [
      result.created
        ? `Synthetic demo content provisioned (${counts}).`
        : `Synthetic demo content already present and unchanged (${counts}).`,
      "Enable PONTE_PUBLIC_DEMO_READ_ONLY=1 and PONTE_PUBLIC_DEMO_BUSINESS_ID only after this step succeeds, then redeploy. Then run demo-verify.",
    ],
  };
}

/**
 * Read-only verification of the synthetic public demo.
 *
 * The content check is delegated to `bootstrapPublicDemo(..., {verifyOnly:
 * true})`, which opens a `READ ONLY` transaction and compares every expected
 * row exactly. On top of that this function asserts the properties that make
 * the demo safe to show publicly:
 *
 * - the tenant and the six example invoices exist with the expected shape;
 * - no simulated settlement carries a transaction hash;
 * - no evidence or outbox record is attached to the demo tenant, so nothing
 *   implies KMS use or a blockchain transaction.
 *
 * It works identically before and after `PONTE_PUBLIC_DEMO_READ_ONLY` is set
 * to `1`: this command never flips that flag and never needs it to be off.
 * Membership counts are reported **only** for the tenant the operator named.
 */
async function runDemoVerify(
  pool: Pool,
  operation: RunOperationInput,
  verification: MigrationVerification,
  dependencies: RunnerDependencies,
): Promise<DatabaseOperationResult> {
  if (!operation.businessId || !operation.businessName) {
    return {
      ok: false,
      lines: ["Refused: business_id and business_name are required."],
    };
  }

  // The configured demo identifier is authoritative when present. Re-check it
  // here so the rule holds even if a caller bypassed the dispatch guard.
  const configured = operation.configuredDemoBusinessId?.trim().toLowerCase();
  if (configured && configured !== operation.businessId.toLowerCase()) {
    return {
      ok: false,
      lines: [
        "Refused: business_id does not match PONTE_PUBLIC_DEMO_BUSINESS_ID. Verify the tenant the service is configured to show.",
      ],
    };
  }

  if (!verification.ledgerPresent || verification.pending.length) {
    return {
      ok: false,
      lines: [
        "Refused: the schema is not current, so the synthetic demo cannot be verified. Run migrate first.",
      ],
    };
  }

  const bootstrapDemo = dependencies.bootstrapDemo ?? defaultBootstrapDemo;
  let content: Awaited<ReturnType<DemoBootstrap>>;
  try {
    content = await bootstrapDemo(
      pool,
      {
        businessId: operation.businessId,
        businessName: operation.businessName,
      },
      { verifyOnly: true },
    );
  } catch (error) {
    const reason =
      typeof (error as { reason?: unknown })?.reason === "string"
        ? ` [${(error as { reason: string }).reason}]`
        : "";
    return {
      ok: false,
      lines: [
        `Refused: the synthetic demo tenant does not match the expected content${reason}. Nothing was written.`,
      ],
    };
  }

  const expected = await expectedDemoCounts();
  const countsMatch =
    content.invoices === expected.invoices &&
    content.quotes === expected.quotes &&
    content.payments === expected.payments &&
    content.settlements === expected.settlements;

  if (!countsMatch) {
    return {
      ok: false,
      lines: [
        `Refused: expected ${expected.invoices} invoices, ${expected.quotes} quotes, ${expected.payments} payments and ${expected.settlements} settlements for the synthetic demo; found ${content.invoices}, ${content.quotes}, ${content.payments}, ${content.settlements}. Nothing was written.`,
      ],
    };
  }

  // Scoped to the demo tenant the operator named. Nothing here is a global
  // assertion, so a real viewer's membership is neither counted nor judged.
  const scoped = await pool.query<{
    demo_memberships: string;
    business_rows: string;
    chain_hashes: string;
    evidence_records: string;
    outbox_records: string;
    transaction_hashes: string;
  }>(
    `SELECT
       (SELECT count(*) FROM memberships WHERE business_id = $1)::text AS demo_memberships,
       (SELECT count(*) FROM businesses WHERE id = $1)::text AS business_rows,
       (SELECT count(*) FROM settlements WHERE business_id = $1 AND transaction_hash IS NOT NULL)::text AS chain_hashes,
       (SELECT count(*) FROM route_decision_evidence WHERE business_id = $1)::text AS evidence_records,
       (SELECT count(*) FROM evidence_outbox o
          JOIN route_decision_evidence e ON e.id = o.evidence_record_id
         WHERE e.business_id = $1)::text AS outbox_records,
       (SELECT count(*) FROM settlements WHERE transaction_hash IS NOT NULL)::text AS transaction_hashes`,
    [operation.businessId],
  );
  const row = scoped.rows[0];

  const failures: string[] = [];
  if (row?.business_rows !== "1")
    failures.push("the demo business row is missing");
  if (row?.chain_hashes !== "0")
    failures.push("a simulated settlement carries a transaction hash");
  if (row?.evidence_records !== "0")
    failures.push("an evidence record is attached to the demo tenant");
  if (row?.outbox_records !== "0")
    failures.push("an evidence outbox record is attached to the demo tenant");
  if (failures.length) {
    return {
      ok: false,
      lines: [
        `Refused: ${failures.join("; ")}. Nothing was written.`,
        `Chain transactions anywhere in this database: ${row?.transaction_hashes ?? "unknown"} (informational).`,
      ],
    };
  }

  const counts = `${content.invoices} invoices, ${content.quotes} quotes, ${content.payments} payments, ${content.settlements} settlements`;
  return {
    ok: true,
    lines: [
      `Synthetic demo verified against the named tenant: ${counts}.`,
      `Demo memberships for this tenant: ${row?.demo_memberships ?? "unknown"} (reported for this tenant only; real viewers may legitimately hold one).`,
      `No simulated settlement carries a transaction hash; no demo evidence or outbox record exists (checked for this tenant). Chain transactions anywhere in this database: ${row?.transaction_hashes ?? "unknown"}.`,
      "Read-only: this operation wrote nothing and did not change PONTE_PUBLIC_DEMO_READ_ONLY.",
      "If the public demo is not enabled yet, the remaining step is a manual environment change on the host, never an automatic one.",
    ],
  };
}
