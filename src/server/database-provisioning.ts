/**
 * Phase 2C.2B database provisioning.
 *
 * Creates the four roles, applies the exact application privilege matrix, and
 * is safe to run repeatedly: every statement either no-ops or *corrects* a
 * value left by an earlier run.
 *
 * Why this is a single module rather than a `.sql` file:
 *
 * - Role attributes must be *corrected*, and `CREATE ROLE` is skipped when the
 *   role already exists. An operator who ran an earlier, broader grant set
 *   (for example table-level `UPDATE`) needs that grant removed, not merely
 *   not-added. `GRANT` is additive; only an explicit `REVOKE` repairs it.
 * - Membership options (`WITH INHERIT ... SET ...`) are PostgreSQL 16+ syntax.
 *   The version has to be checked before the statement is parsed, which means
 *   a catalogue query first.
 * - Object ownership matters: the revokes that repair drift must not run as
 *   the table owner in a way that strips the owner's own privileges.
 *
 * Everything here is idempotent and destructive only to *privileges*, never to
 * rows. It is deliberately inert on import.
 */

import { Pool } from "pg";

/** Marks the provisioning contract; bump only alongside a design change. */
export const PROVISIONING_VERSION = "phase2c2b-r1";

/** The only schema this design touches. */
export const PONTE_SCHEMA = "public";

export const APP_ROLE = "ponte_app";
export const APP_LOGIN_ROLE = "ponte_app_login";
export const OWNER_ROLE = "ponte_owner";
export const MIGRATOR_ROLE = "ponte_migrator";

/**
 * Trigger functions whose default `PUBLIC EXECUTE` is revoked.
 *
 * `PUBLIC` holds `EXECUTE` on every new function, and a trigger function can
 * never be invoked directly (`0A000`), so the privilege is pure surface. It is
 * also not required for the trigger to fire: a trigger is invoked by the
 * system, and `EXECUTE` is checked when a routine is called *as a function*.
 *
 * The one case that does need `EXECUTE` is an ordinary function called from a
 * trigger body. None of these four calls anything, so revoking is safe today.
 * If one later grows a call to a helper, grant that helper to `ponte_app` —
 * never restore `PUBLIC`.
 */
export const TRIGGER_FUNCTIONS = [
  "touch_updated_at()",
  "deny_event_mutation()",
  "deny_route_decision_evidence_mutation()",
  "deny_external_identity_remap()",
] as const;

/**
 * Columns the application may UPDATE, per table.
 *
 * Every entry is derived from the SQL the application actually issues. Tables
 * absent from this map get no `UPDATE` at all — including `quotes` and
 * `memberships`, which the application only ever reads and inserts. Their two
 * `FOR UPDATE` row locks therefore fail closed with `42501` under the
 * application identity (R1); see `docs/PHASE2C2B_PRIVILEGE_MODEL.md`.
 */
export const UPDATABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  invoices: ["status", "data", "reference", "funding_minor"],
  settlements: ["status", "actual_minor", "settled_at"],
  rate_limits: ["hits", "window_start"],
};

/**
 * Tables granted table-level `SELECT, INSERT` (and never `UPDATE`).
 *
 * Table-level `SELECT` is required, not a convenience: the application issues
 * `SELECT *` against `idempotency`, `quotes`, `payments`, `settlements` and
 * `payment_events`.
 */
export const APPEND_ONLY_TABLES = [
  "users",
  "memberships",
  "external_identities",
  "payments",
  "quotes",
  "payment_events",
  "idempotency",
] as const;

/** Tables granted `SELECT` only. */
export const READ_ONLY_TABLES = ["businesses"] as const;

/**
 * The public-commitment projection of `route_decision_evidence`.
 *
 * Sensitive envelope and KMS columns are deliberately absent: the application
 * writes those on INSERT and must never read them back. `wrapped_dek` and the
 * KMS reference columns are only ever read by the private metadata query, which
 * runs on the administrative connection.
 */
export const EVIDENCE_READ_COLUMNS = [
  "id",
  "business_id",
  "invoice_id",
  "public_evidence_id",
  "evidence_schema_version",
  "chain_id",
  "registry_address",
  "sequence",
  "evidence_kind",
  "previous_payload_hash",
  "payload_hash",
  "kms_provider",
  "created_at",
] as const;

/**
 * Every column the application writes when inserting an evidence record.
 *
 * This list is the full envelope. `INSERT` on a sensitive column conveys no
 * read ability, so granting these does not widen the read projection above.
 */
export const EVIDENCE_INSERT_COLUMNS = [
  "id",
  "business_id",
  "invoice_id",
  "quote_id",
  "created_by_user_id",
  "routing_correlation_id",
  "public_evidence_id",
  "evidence_schema_version",
  "quote_schema_version",
  "chain_id",
  "registry_address",
  "sequence",
  "evidence_kind",
  "selected_route_code",
  "quote_snapshot_hash",
  "previous_payload_hash",
  "payload_hash",
  "envelope_version",
  "content_algorithm",
  "ciphertext",
  "nonce",
  "authentication_tag",
  "wrapped_dek",
  "kms_provider",
  "wrapped_dek_algorithm",
  "wrapped_dek_format",
  "kms_key_reference",
  "kms_key_version",
  "aad_version",
] as const;

/**
 * The outbox read projection: three columns.
 *
 * The eight confirmation columns (`transaction_hash`, `confirmed_at`,
 * `confirmed_block_number`, `confirmed_block_hash`, `attestor_address`,
 * `last_failure_class`, `last_failure_at`) and `attempt_count` are absent, so
 * the application cannot observe or forge confirmation state.
 */
export const OUTBOX_READ_COLUMNS = [
  "id",
  "evidence_record_id",
  "submission_state",
] as const;

/**
 * The outbox write projection: two columns.
 *
 * `submission_state` is omitted on purpose. Migration 007 supplies the
 * `'pending'` default, so the application never names the column and its
 * column-level `INSERT` grant makes `'submitted'` / `'confirmed'` unreachable.
 */
export const OUTBOX_INSERT_COLUMNS = ["id", "evidence_record_id"] as const;

/** `rate_limits` is small enough that every column is app-owned and app-read. */
export const RATE_LIMIT_COLUMNS = [
  "identity",
  "window_start",
  "hits",
] as const;

export type ProvisioningStep = {
  /** Stable identifier, safe to print in a CI log. */
  id: string;
  /** Statement text. Never contains a credential. */
  sql: string;
};

/**
 * Structural outcome of a provisioning run, used by tests and operators.
 *
 * Every field is read back from the catalogue after the run, so a caller never
 * has to trust that a statement had the effect it claimed.
 */
export type ProvisioningReport = {
  serverVersionNum: number;
  roles: Record<string, { exists: boolean; canLogin: boolean }>;
  memberships: Record<string, { inheritOption: boolean; setOption: boolean }>;
  databaseAcl: string | null;
  appUpdateColumns: Record<string, string[]>;
  appReadOnlyTables: string[];
  /** Columns the application may INSERT on `evidence_outbox` (exactly two). */
  appInsertDeniedColumns: string[];
  triggerFunctionPublicExecute: Record<string, boolean>;
  stepsApplied: string[];
};

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** `DO` block that creates the role only when it is absent. */
export function createRoleStatement(
  role: string,
  attributes: string,
): ProvisioningStep {
  return {
    id: `create-role:${role}`,
    sql: `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    CREATE ROLE ${role} ${attributes};
  END IF;
END $$;`,
  };
}

/**
 * The full ordered plan.
 *
 * Ordering is load-bearing in three places:
 *
 * 1. The version guard runs first, because the membership `GRANT` below is
 *    PostgreSQL 16+ syntax and must not be parsed on an older server.
 * 2. The drift `REVOKE`s run before the grants. `GRANT` is additive; without
 *    the revokes a database provisioned by an earlier, broader design keeps
 *    every extra privilege.
 * 3. The trigger-function revokes run after the drift revokes, and target
 *    `PUBLIC` rather than `ponte_app`. Revoking `ALL` from the owner would
 *    remove the owner's own `EXECUTE` and break trigger firing.
 */
export function provisioningPlan(options: {
  /** Grants `CREATE ON DATABASE`, needed only by the scratch-schema suite. */
  allowScratchSchemaCreates: boolean;
  database: string;
}): ProvisioningStep[] {
  const { allowScratchSchemaCreates, database } = options;
  const app = APP_ROLE;

  const steps: ProvisioningStep[] = [];

  // (1) Version guard. `GRANT ... WITH INHERIT/SET` needs PostgreSQL 16+.
  steps.push({
    id: "guard:server-version",
    sql: `
DO $$ BEGIN
  IF current_setting('server_version_num')::int < 160000 THEN
    RAISE EXCEPTION
      'PostgreSQL 16+ required: GRANT ... WITH INHERIT/SET (found %)',
      current_setting('server_version');
  END IF;
END $$;`,
  });

  // (2) Roles. `CREATE ROLE` is not idempotent, so each is guarded.
  steps.push(createRoleStatement(OWNER_ROLE, "NOLOGIN"));
  steps.push(createRoleStatement(APP_ROLE, "NOLOGIN"));
  steps.push(createRoleStatement(MIGRATOR_ROLE, "LOGIN NOINHERIT"));
  steps.push(createRoleStatement(APP_LOGIN_ROLE, "LOGIN"));

  // (3) Correct existing role attributes. A guarded `CREATE ROLE` never
  //     repairs a role created by an earlier run with different attributes.
  steps.push({ id: "alter-role:owner", sql: `ALTER ROLE ${OWNER_ROLE} NOLOGIN;` });
  steps.push({ id: "alter-role:app", sql: `ALTER ROLE ${APP_ROLE} NOLOGIN;` });
  steps.push({
    id: "alter-role:migrator",
    sql: `ALTER ROLE ${MIGRATOR_ROLE} LOGIN NOINHERIT;`,
  });
  steps.push({
    id: "alter-role:app-login",
    sql: `ALTER ROLE ${APP_LOGIN_ROLE} LOGIN;`,
  });
  // Defence in depth: an earlier design attached a session-level default
  // elevation to the migrator. Elevation must be transaction-local only.
  steps.push({
    id: "alter-role:migrator-reset-role",
    sql: `ALTER ROLE ${MIGRATOR_ROLE} RESET ROLE;`,
  });

  // (4) Membership options, stated on every run. A bare `GRANT` leaves stored
  //     options untouched, and an explicit `GRANT` *corrects* drifted ones.
  steps.push({
    id: "membership:app-login",
    sql: `GRANT ${APP_ROLE} TO ${APP_LOGIN_ROLE} WITH INHERIT TRUE, SET FALSE;`,
  });
  steps.push({
    id: "membership:migrator",
    sql: `GRANT ${OWNER_ROLE} TO ${MIGRATOR_ROLE} WITH INHERIT FALSE, SET TRUE;`,
  });

  // (5) Database ACL. `REVOKE ALL` first so that a database which still grants
  //     PUBLIC is closed, then grant CONNECT explicitly.
  steps.push({
    id: "database:revoke-public",
    sql: `REVOKE ALL ON DATABASE ${quoteIdent(database)} FROM PUBLIC;`,
  });
  steps.push({
    id: "database:grant-app-login",
    sql: `GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${APP_LOGIN_ROLE};`,
  });
  steps.push({
    id: "database:grant-migrator",
    sql: `GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${MIGRATOR_ROLE};`,
  });

  // (6) Owner schema privileges. `ponte_owner` owns the objects; it is NOLOGIN
  //     and reaches the database only through `ponte_migrator`.
  steps.push({
    id: "schema:owner",
    sql: `GRANT USAGE, CREATE ON SCHEMA ${PONTE_SCHEMA} TO ${OWNER_ROLE};`,
  });

  // (7) Scratch-schema capability. `scripts/test-migrations.ts` creates four
  //     temporary schemas, which needs `CREATE` on the *database*. Production
  //     omits this: no migration creates a schema.
  if (allowScratchSchemaCreates) {
    steps.push({
      id: "database:owner-create",
      sql: `GRANT CREATE ON DATABASE ${quoteIdent(database)} TO ${OWNER_ROLE};`,
    });
  } else {
    steps.push({
      id: "database:owner-create-absent",
      sql: `REVOKE CREATE ON DATABASE ${quoteIdent(database)} FROM ${OWNER_ROLE};`,
    });
  }

  // (8) Drift repair. `GRANT` is additive, so an earlier design's table-level
  //     `UPDATE` would survive every grant below. Revoke everything from the
  //     application first, then re-apply exactly the approved matrix.
  //     Only `ponte_app` is touched: `ponte_owner` owns these objects and must
  //     keep its own privileges, or its `BEFORE UPDATE` triggers stop firing.
  steps.push({
    id: "drift:tables",
    sql: `REVOKE ALL ON ALL TABLES IN SCHEMA ${PONTE_SCHEMA} FROM ${app};`,
  });
  steps.push({
    id: "drift:sequences",
    sql: `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${PONTE_SCHEMA} FROM ${app};`,
  });
  steps.push({
    id: "drift:functions",
    sql: `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${PONTE_SCHEMA} FROM ${app};`,
  });

  // (9) Application schema reachability.
  steps.push({
    id: "schema:app",
    sql: `GRANT USAGE ON SCHEMA ${PONTE_SCHEMA} TO ${app};`,
  });

  // (10) Read-only table.
  for (const table of READ_ONLY_TABLES) {
    steps.push({
      id: `read-only:${table}`,
      sql: `GRANT SELECT ON ${PONTE_SCHEMA}.${table} TO ${app};`,
    });
  }

  // (11) Append-only tables: SELECT + INSERT, never UPDATE.
  for (const table of APPEND_ONLY_TABLES) {
    steps.push({
      id: `append-only:${table}`,
      sql: `GRANT SELECT, INSERT ON ${PONTE_SCHEMA}.${table} TO ${app};`,
    });
  }

  // (12) invoices: append plus four mutable columns. `INSERT` is granted at
  //      table level; only `UPDATE` is column-scoped. Splitting `INSERT` into
  //      its six written columns would also break `RETURNING`, which needs
  //      `SELECT` on the returned columns (already held) and would make the
  //      grant brittle as the writer evolves.
  steps.push({
    id: "invoices:select-insert",
    sql: `GRANT SELECT, INSERT ON ${PONTE_SCHEMA}.invoices TO ${app};`,
  });

  // (13) Column-scoped UPDATE for every table that has one.
  for (const [table, columns] of Object.entries(UPDATABLE_COLUMNS)) {
    // `invoices` already received SELECT+INSERT above.
    if (table !== "invoices") {
      steps.push({
        id: `${table}:select-insert`,
        sql: `GRANT SELECT, INSERT ON ${PONTE_SCHEMA}.${table} TO ${app};`,
      });
    }
    steps.push({
      id: `${table}:update-columns`,
      sql: `GRANT UPDATE (${columns.join(", ")}) ON ${PONTE_SCHEMA}.${table} TO ${app};`,
    });
  }

  // `invoices` needs its UPDATE separately because it is not in the loop's
  // "select-insert only" branch above.
  steps.push({
    id: "invoices:update-columns",
    sql: `GRANT UPDATE (${UPDATABLE_COLUMNS.invoices.join(", ")}) ON ${PONTE_SCHEMA}.invoices TO ${app};`,
  });

  // (14) rate_limits: column-scoped SELECT and INSERT as well. All three
  //      columns are app-owned, so this is narrow by construction rather than
  //      by omission.
  steps.push({
    id: "rate_limits:select-columns",
    sql: `GRANT SELECT (${RATE_LIMIT_COLUMNS.join(", ")}) ON ${PONTE_SCHEMA}.rate_limits TO ${app};`,
  });
  steps.push({
    id: "rate_limits:insert-columns",
    sql: `GRANT INSERT (${RATE_LIMIT_COLUMNS.join(", ")}) ON ${PONTE_SCHEMA}.rate_limits TO ${app};`,
  });

  // (15) route_decision_evidence: narrow read projection, full write envelope.
  steps.push({
    id: "route_decision_evidence:select-columns",
    sql: `GRANT SELECT (${EVIDENCE_READ_COLUMNS.join(", ")})
  ON ${PONTE_SCHEMA}.route_decision_evidence TO ${app};`,
  });
  steps.push({
    id: "route_decision_evidence:insert-columns",
    sql: `GRANT INSERT (${EVIDENCE_INSERT_COLUMNS.join(", ")})
  ON ${PONTE_SCHEMA}.route_decision_evidence TO ${app};`,
  });

  // (16) evidence_outbox: three read, two write, never update.
  steps.push({
    id: "evidence_outbox:select-columns",
    sql: `GRANT SELECT (${OUTBOX_READ_COLUMNS.join(", ")})
  ON ${PONTE_SCHEMA}.evidence_outbox TO ${app};`,
  });
  steps.push({
    id: "evidence_outbox:insert-columns",
    sql: `GRANT INSERT (${OUTBOX_INSERT_COLUMNS.join(", ")})
  ON ${PONTE_SCHEMA}.evidence_outbox TO ${app};`,
  });

  // (17) Default-function hardening. Existing functions were revoked below;
  //      this stops the *next* function from regaining PUBLIC EXECUTE.
  //      Scope: this database only, and only for routines created by
  //      `ponte_owner`. `FOR ROLE` names the target explicitly rather than
  //      relying on which role happens to be current.
  steps.push({
    id: "default-privileges:revoke-public-execute",
    sql: `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`,
  });

  // (18) Existing trigger functions: remove the unused PUBLIC surface.
  for (const fn of TRIGGER_FUNCTIONS) {
    steps.push({
      id: `trigger-function:${fn}`,
      sql: `REVOKE EXECUTE ON FUNCTION ${PONTE_SCHEMA}.${fn} FROM PUBLIC;`,
    });
  }

  return steps;
}

/**
 * Applies the plan on an already-connected client.
 *
 * Runs as the bootstrap superuser. There is deliberately no `SET ROLE` here:
 * `ALTER DEFAULT PRIVILEGES FOR ROLE ponte_owner` names its target, and the
 * drift revokes must *not* execute as the object owner.
 *
 * Every statement is applied in its own implicit transaction. Provisioning is
 * a catalogue-only operation, so partial application is recoverable by simply
 * running it again — which is the property that makes idempotency worth
 * having.
 */
type Queryable = { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> };

export async function applyProvisioning(
  client: Queryable,
  options: { allowScratchSchemaCreates: boolean; database: string },
): Promise<ProvisioningReport> {
  const steps = provisioningPlan(options);
  const stepsApplied: string[] = [];
  for (const step of steps) {
    await client.query(step.sql);
    stepsApplied.push(step.id);
  }
  return readProvisioningReport(client, stepsApplied);
}

/**
 * Reads the resulting state back from the catalogue.
 *
 * Nothing here trusts that a statement had its intended effect: each field is
 * an independent query, which is what makes the report useful as a CI gate.
 */
export async function readProvisioningReport(
  client: Queryable,
  stepsApplied: string[] = [],
): Promise<ProvisioningReport> {
  const version = (await client.query(
    "SELECT current_setting('server_version_num')::int AS n",
  )) as { rows: { n: number }[] };

  const roles = (await client.query(
    `SELECT rolname, rolcanlogin FROM pg_roles
      WHERE rolname = ANY(${arrayLiteral([
        OWNER_ROLE,
        APP_ROLE,
        MIGRATOR_ROLE,
        APP_LOGIN_ROLE,
      ])})`,
  )) as { rows: { rolname: string; rolcanlogin: boolean }[] };

  const memberships = (await client.query(
    `SELECT m.rolname AS member, g.rolname AS granted,
            am.inherit_option, am.set_option
       FROM pg_auth_members am
       JOIN pg_roles m ON m.oid = am.member
       JOIN pg_roles g ON g.oid = am.roleid
      WHERE (m.rolname = '${APP_LOGIN_ROLE}' AND g.rolname = '${APP_ROLE}')
         OR (m.rolname = '${MIGRATOR_ROLE}' AND g.rolname = '${OWNER_ROLE}')`,
  )) as {
    rows: {
      member: string;
      granted: string;
      inherit_option: boolean;
      set_option: boolean;
    }[];
  };

  const acl = (await client.query(
    `SELECT datacl::text AS datacl FROM pg_database WHERE datname = current_database()`,
  )) as { rows: { datacl: string | null }[] };

  const appUpdate = (await client.query(
    `SELECT table_name, column_name
       FROM information_schema.column_privileges
      WHERE grantee = '${APP_ROLE}'
        AND privilege_type = 'UPDATE'
        AND table_schema = '${PONTE_SCHEMA}'
      ORDER BY table_name, column_name`,
  )) as { rows: { table_name: string; column_name: string }[] };

  const insertDenied = (await client.query(
    `SELECT table_name, column_name
       FROM information_schema.column_privileges
      WHERE grantee = '${APP_ROLE}'
        AND privilege_type = 'INSERT'
        AND table_schema = '${PONTE_SCHEMA}'
        AND table_name = 'evidence_outbox'
      ORDER BY column_name`,
  )) as { rows: { table_name: string; column_name: string }[] };

  const publicExecute = (await client.query(
    `SELECT p.proname, has_function_privilege('public', p.oid, 'EXECUTE') AS can
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = '${PONTE_SCHEMA}'
        AND (p.proname || '()') = ANY(${arrayLiteral([...TRIGGER_FUNCTIONS])})`,
  )) as { rows: { proname: string; can: boolean }[] };

  const appUpdateColumns: Record<string, string[]> = {};
  for (const row of appUpdate.rows) {
    (appUpdateColumns[row.table_name] ??= []).push(row.column_name);
  }

  return {
    serverVersionNum: version.rows[0].n,
    roles: Object.fromEntries(
      [OWNER_ROLE, APP_ROLE, MIGRATOR_ROLE, APP_LOGIN_ROLE].map((name) => {
        const found = roles.rows.find((row) => row.rolname === name);
        return [name, { exists: Boolean(found), canLogin: found?.rolcanlogin ?? false }];
      }),
    ),
    memberships: Object.fromEntries(
      memberships.rows.map((row) => [
        `${row.member}<-${row.granted}`,
        { inheritOption: row.inherit_option, setOption: row.set_option },
      ]),
    ),
    databaseAcl: acl.rows[0]?.datacl ?? null,
    appUpdateColumns,
    appReadOnlyTables: [...READ_ONLY_TABLES],
    appInsertDeniedColumns: insertDenied.rows.map((row) => row.column_name),
    triggerFunctionPublicExecute: Object.fromEntries(
      publicExecute.rows.map((row) => [row.proname, row.can]),
    ),
    stepsApplied,
  };
}

/** Render a JS string array as a PostgreSQL array literal. */
function arrayLiteral(values: readonly string[]): string {
  return `ARRAY[${values.map((v) => `'${v.replaceAll("'", "''")}'`).join(", ")}]::text[]`;
}

/** Convenience wrapper used by the CLI and the test-provisioning script. */
export async function provisionDatabase(
  pool: Pool,
  options: { allowScratchSchemaCreates: boolean; database?: string },
): Promise<ProvisioningReport> {
  const db = await pool.connect();
  try {
    const database =
      options.database ??
      (
        (await db.query(
          "SELECT current_database() AS name",
        )) as { rows: { name: string }[] }
      ).rows[0].name;
    return await applyProvisioning(db, {
      allowScratchSchemaCreates: options.allowScratchSchemaCreates,
      database,
    });
  } finally {
    db.release();
  }
}
