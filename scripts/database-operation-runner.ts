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
 * - `verify` is read-only: recorded migrations, tenant row presence, and
 *   absence of unexpected users/memberships in the demo tenant.
 * - A missing prerequisite produces a `false` result and a closed message; it
 *   never throws a database exception at the operator.
 */

export type DatabaseOperationResult = {
  ok: boolean;
  lines: string[];
};

type Migrator = {
  verifyMigrations: (
    pool: Pool,
    directory?: string,
  ) => Promise<{ recorded: string[]; pending: string[] }>;
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

export async function runDatabaseOperation(
  pool: Pool,
  operation: {
    operation: DatabaseOperation;
    businessId?: string;
    businessName?: string;
  },
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
  if (verification.pending.length) {
    return {
      ok: false,
      lines: [
        `Refused: ${verification.pending.length} migration(s) are pending (${verification.pending.join(", ")}). Run the migrate operation first.`,
      ],
    };
  }

  if (operation.operation === "verify") {
    /*
     * Two invariants an operator can act on, both read-only:
     *
     * 1. A synthetic demo tenant never owns a user or a membership. The demo
     *    payload is data-only; any membership pointing at it would mean access
     *    was granted to fabricated content.
     * 2. Nothing in the database is linked to a real KMS key or a chain
     *    transaction. `settlements.transaction_hash` is constrained to NULL
     *    and `route_decision_evidence` is absent for a data-only demo.
     */
    const invariants = await pool.query<{
      demo_memberships: string;
      chain_hashes: string;
      evidence_records: string;
    }>(
      `SELECT
         (SELECT count(*) FROM memberships WHERE business_id = $1)::text AS demo_memberships,
         (SELECT count(*) FROM settlements WHERE transaction_hash IS NOT NULL)::text AS chain_hashes,
         (SELECT count(*) FROM route_decision_evidence)::text AS evidence_records`,
      [process.env.PONTE_PUBLIC_DEMO_BUSINESS_ID ?? null],
    );
    const row = invariants.rows[0];
    return {
      ok: true,
      lines: [
        `Schema current: ${verification.recorded.length} migration(s) recorded, none pending.`,
        `Synthetic demo memberships: ${row?.demo_memberships ?? "unknown"} (expected 0).`,
        `Chain transactions: ${row?.chain_hashes ?? "unknown"} (expected 0); evidence records: ${row?.evidence_records ?? "unknown"}.`,
        "The application's own /api/health/ready endpoint is the authoritative runtime check.",
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
      "Enable PONTE_PUBLIC_DEMO_READ_ONLY=1 and PONTE_PUBLIC_DEMO_BUSINESS_ID only after this step succeeds, then redeploy.",
    ],
  };
}
