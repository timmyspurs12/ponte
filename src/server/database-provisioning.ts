/**
 * Phase 2C.2B database provisioning — explicit two-phase.
 *
 * Provisioning is split into two ordered phases so that role/bootstrap work can
 * run on a **fresh** database *before* migrations, and object-level privileges
 * run *after* migrations create the tables and trigger functions they target.
 *
 * - **Phase 1 — pre-migration bootstrap** (`provisioningPlanPhase1`): the version
 *   guard, role creation and attribute correction, explicit membership options,
 *   database ACL/CONNECT grants, owner schema privileges, the test-only database
 *   `CREATE`, and default-function hardening. None of these statements reference
 *   application tables or functions, so Phase 1 is valid on an empty database.
 *
 * - **Phase 2 — post-migration object privileges** (`provisioningPlanPhase2`):
 *   the application drift revocations, the exact approved privilege matrix, and
 *   the four trigger-function `EXECUTE` revocations. Phase 2 **verifies** that
 *   every expected table and trigger function exists first and **fails
 *   explicitly** if anything is missing — it never silently skips a missing
 *   object.
 *
 * Why two phases rather than one plan:
 *
 * - `db:migrate` elevates with `SET LOCAL ROLE ponte_owner`, which requires the
 *   roles Phase 1 creates. Phase 1 must run first.
 * - Phase 2's `GRANT`/`REVOKE` statements name specific tables and functions; on
 *   a database where migrations have not run they raise `42P01`. Phase 2 must
 *   run after `db:migrate`.
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
 * The dedicated NOLOGIN owner of the Phase 2C.3 SECURITY DEFINER row-lock
 * functions (`ponte_lock_routing_membership`, `ponte_lock_routing_quote`).
 *
 * The functions run as this role, which holds exactly the minimum
 * column-level SELECT and UPDATE privileges the locks need (granted by
 * migration 008). `ponte_owner` is a member of it WITH INHERIT FALSE, SET
 * TRUE — the SET option is what allows the migration's ownership transfer;
 * INHERIT FALSE keeps the owner's own privileges from flowing into the lock
 * role (and is irrelevant to the transfer itself).
 */
export const ROUTING_LOCK_ROLE = "ponte_routing_lock";

/** The exact identity arguments of the membership lock function. */
export const ROUTING_LOCK_MEMBERSHIP_ARGS = "p_business_id uuid, p_user_id uuid";
/** The exact identity arguments of the quote lock function. */
export const ROUTING_LOCK_QUOTE_ARGS =
  "p_business_id uuid, p_invoice_id uuid, p_quote_id uuid";
/** The exact return type of the membership lock function. */
export const ROUTING_LOCK_MEMBERSHIP_RESULT = "text";
/** The exact return type of the quote lock function. */
export const ROUTING_LOCK_QUOTE_RESULT =
  "TABLE(id uuid, business_id uuid, invoice_id uuid, source text, simulated boolean, data jsonb, expires_at timestamp with time zone)";
/** The `SET` configuration both lock functions must carry. */
export const ROUTING_LOCK_SEARCH_PATH = "search_path=pg_catalog, public, pg_temp";

/**
 * The two Phase 2C.3 lock functions, with their exact signatures. Phase 2
 * verifies every field of these (existence, identity arguments, return type,
 * owner, SECURITY DEFINER, search_path, ACLs) and fails explicitly on any
 * mismatch — a name-only check would miss a wrong signature or a lost
 * SECURITY DEFINER attribute.
 */
export const ROUTING_LOCK_FUNCTIONS = [
  {
    name: "ponte_lock_routing_membership",
    args: ROUTING_LOCK_MEMBERSHIP_ARGS,
    result: ROUTING_LOCK_MEMBERSHIP_RESULT,
  },
  {
    name: "ponte_lock_routing_quote",
    args: ROUTING_LOCK_QUOTE_ARGS,
    result: ROUTING_LOCK_QUOTE_RESULT,
  },
] as const;

/**
 * Attribute hardening applied to every managed role on creation and on every
 * subsequent provisioning run. No managed role is a superuser, may create
 * databases, may create roles, may replicate, or may bypass row-level security.
 * The approved `LOGIN`/`NOLOGIN` and membership settings are preserved; these
 * attributes only strip privileges that no managed role should ever hold.
 */
export const ROLE_HARDENING_ATTRIBUTES =
  "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";

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
 * row locks are carried by the SECURITY DEFINER functions
 * `ponte_lock_routing_membership` / `ponte_lock_routing_quote` (Phase 2C.3),
 * owned by `ponte_routing_lock`, so the application never needs UPDATE on
 * them; see `docs/PHASE2C3_ROUTING_LOCK_FUNCTIONS.md`.
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
 * Every table the privilege matrix grants on. Phase 2 verifies each exists
 * before applying grants; a missing table is an explicit failure, never a skip.
 *
 * This is the union of the read-only list, the append-only list, the
 * updatable-column tables, and the specially-projected tables
 * (`invoices`, `rate_limits`, `route_decision_evidence`, `evidence_outbox`).
 */
export const EXPECTED_TABLES = [
  ...READ_ONLY_TABLES,
  ...APPEND_ONLY_TABLES,
  "invoices",
  "settlements",
  "rate_limits",
  "route_decision_evidence",
  "evidence_outbox",
] as const;

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

/** The two ordered provisioning phases. */
export type ProvisioningPhase = "phase1" | "phase2" | "all";

/**
 * Structural outcome of a provisioning run, used by tests and operators.
 *
 * Every field is read back from the catalogue after the run, so a caller never
 * has to trust that a statement had the effect it claimed. The `phase` field
 * records which phase produced the report.
 */
export type ProvisioningReport = {
  phase: ProvisioningPhase;
  serverVersionNum: number;
  roles: Record<
    string,
    {
      exists: boolean;
      canLogin: boolean;
      superuser: boolean;
      createdb: boolean;
      createrole: boolean;
      replication: boolean;
      bypassrls: boolean;
    }
  >;
  memberships: Record<string, { inheritOption: boolean; setOption: boolean; adminOption: boolean }>;
  /**
   * Phase 2C.3: the dedicated lock-owner role, read back from the catalogue.
   * Same shape as a single `roles` entry; `exists` is false only on a
   * database where Phase 1 has not run.
   */
  routingLock: {
    exists: boolean;
    canLogin: boolean;
    superuser: boolean;
    createdb: boolean;
    createrole: boolean;
    replication: boolean;
    bypassrls: boolean;
  };
  /**
   * Phase 2C.3: the two directions of the `ponte_routing_lock` membership
   * graph, read from `pg_auth_members`.
   *
   * - `membersOfRoutingLock`: roles that ARE members of `ponte_routing_lock`.
   *   Expected to be exactly `ponte_owner` with INHERIT FALSE, SET TRUE.
   * - `routingLockParents`: roles that `ponte_routing_lock` IS itself a
   *   member of. Expected to be empty — the lock role is a leaf and must not
   *   inherit anything.
   *
   * Any other entry is drift that Phase 1 must have failed on explicitly;
   * the report surfaces it so a CI gate can assert the exact expected set.
   */
  routingLockMemberships: {
    membersOfRoutingLock: {
      member: string;
      inheritOption: boolean;
      setOption: boolean;
      adminOption: boolean;
    }[];
    routingLockParents: string[];
  };
  /**
   * Phase 2C.3: the exact signature and security properties of the two lock
   * functions, read back from the catalogue. Every field is checked by the
   * Phase 2 verification step; the report re-reads it so a CI gate can assert
   * the approved state without trusting the step's exit status alone.
   */
  lockFunctions: {
    name: string;
    args: string;
    result: string;
    owner: string;
    securityDefiner: boolean;
    searchPath: string | null;
    /** True when PUBLIC still holds EXECUTE — must always be false. */
    publicExecute: boolean;
    /** True when `ponte_app` holds EXECUTE — must always be true. */
    appExecute: boolean;
  }[];
  databaseAcl: string | null;
  appUpdateColumns: Record<string, string[]>;
  appReadOnlyTables: string[];
  /** Columns the application may INSERT on `evidence_outbox` (exactly two). */
  appInsertDeniedColumns: string[];
  /**
   * Direct object privileges held by `ponte_app_login` in the application
   * schema — tables, sequences and functions, read from the catalogue ACLs.
   *
   * This must always be empty. `ponte_app_login` inherits every privilege it
   * needs from the `ponte_app` group (`INHERIT TRUE`); it holds no independent
   * object grants. A non-empty list is drift that Phase 2 failed to repair, or
   * a grant made directly to the login role, and the provisioning gate must
   * treat it as a failure rather than pass silently. Inherited privileges are
   * not stored in the object ACLs, so they never appear here.
   */
  appLoginDirectPrivileges: {
    objectType: string;
    objectName: string;
    privilegeType: string;
  }[];
  triggerFunctionPublicExecute: Record<string, boolean>;
  stepsApplied: string[];
};

/**
 * Raised when Phase 2 runs against a database where expected objects are
 * missing. The message lists every missing table and function so the operator
 * knows exactly what is absent; Phase 2 never silently skips a missing object.
 */
export class ProvisioningObjectsMissingError extends Error {
  constructor(
    readonly missingTables: string[],
    readonly missingFunctions: string[],
  ) {
    const parts: string[] = [];
    if (missingTables.length)
      parts.push(`tables: ${missingTables.join(", ")}`);
    if (missingFunctions.length)
      parts.push(`functions: ${missingFunctions.join(", ")}`);
    super(
      `Phase 2 object-privilege provisioning refused: expected objects are missing (${parts.join(
        "; ",
      )}). Run db:migrate before Phase 2.`,
    );
    this.name = "ProvisioningObjectsMissingError";
  }
}

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

export type ProvisioningOptions = {
  /** Grants `CREATE ON DATABASE`, needed only by the scratch-schema suite. */
  allowScratchSchemaCreates: boolean;
  database: string;
};

/**
 * Phase 1 plan — the pre-migration bootstrap.
 *
 * Ordering is load-bearing: the version guard runs first (the membership
 * `GRANT ... WITH INHERIT/SET` is PostgreSQL 16+ syntax and must not be parsed
 * on an older server). None of these statements reference application tables
 * or functions, so Phase 1 is valid on a fresh, empty database.
 */
export function provisioningPlanPhase1(
  options: ProvisioningOptions,
): ProvisioningStep[] {
  const { allowScratchSchemaCreates, database } = options;

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

  // (2) Roles. `CREATE ROLE` is not idempotent, so each is guarded. Every
  //     role is created with the hardening attributes so a fresh role is
  //     never a superuser or otherwise privileged.
  steps.push(createRoleStatement(OWNER_ROLE, `NOLOGIN ${ROLE_HARDENING_ATTRIBUTES}`));
  steps.push(createRoleStatement(APP_ROLE, `NOLOGIN ${ROLE_HARDENING_ATTRIBUTES}`));
  steps.push(
    createRoleStatement(
      MIGRATOR_ROLE,
      `LOGIN NOINHERIT ${ROLE_HARDENING_ATTRIBUTES}`,
    ),
  );
  steps.push(
    createRoleStatement(APP_LOGIN_ROLE, `LOGIN ${ROLE_HARDENING_ATTRIBUTES}`),
  );

  // (3) Correct existing role attributes. A guarded `CREATE ROLE` never
  //     repairs a role created by an earlier run with different attributes,
  //     so every run re-asserts both the LOGIN setting and the hardening
  //     attributes to repair drift.
  steps.push({
    id: "alter-role:owner",
    sql: `ALTER ROLE ${OWNER_ROLE} NOLOGIN ${ROLE_HARDENING_ATTRIBUTES};`,
  });
  steps.push({
    id: "alter-role:app",
    sql: `ALTER ROLE ${APP_ROLE} NOLOGIN ${ROLE_HARDENING_ATTRIBUTES};`,
  });
  steps.push({
    id: "alter-role:migrator",
    sql: `ALTER ROLE ${MIGRATOR_ROLE} LOGIN NOINHERIT ${ROLE_HARDENING_ATTRIBUTES};`,
  });
  steps.push({
    id: "alter-role:app-login",
    sql: `ALTER ROLE ${APP_LOGIN_ROLE} LOGIN ${ROLE_HARDENING_ATTRIBUTES};`,
  });
  // Defence in depth: an earlier design attached a session-level default
  // elevation to the migrator. Elevation must be transaction-local only.
  steps.push({
    id: "alter-role:migrator-reset-role",
    sql: `ALTER ROLE ${MIGRATOR_ROLE} RESET ROLE;`,
  });

  // (3b) Phase 2C.3: the dedicated lock-owner role. Created NOLOGIN and
  //      hardened like every other managed role.
  steps.push(
    createRoleStatement(
      ROUTING_LOCK_ROLE,
      `NOLOGIN ${ROLE_HARDENING_ATTRIBUTES}`,
    ),
  );

  // (3c) Phase 2C.3: existing-role reconciliation. Unlike the other managed
  //      roles — whose attribute drift is repaired in place — an existing
  //      `ponte_routing_lock` is never silently altered, dropped, or
  //      recreated. A role with LOGIN or any superuser-class attribute, an
  //      unexpected member, or a parent membership is a security-relevant
  //      drift that must fail explicitly so an operator reconciles it by
  //      hand. The expected `ponte_owner` membership is not checked here:
  //      its options are re-stated by the grant below, which corrects drift
  //      without failing.
  steps.push({
    id: "reconcile-role:routing-lock",
    sql: `
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROUTING_LOCK_ROLE}') THEN
    IF EXISTS (
      SELECT 1 FROM pg_roles r
      WHERE r.rolname = '${ROUTING_LOCK_ROLE}'
        AND (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb
             OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
    ) THEN
      RAISE EXCEPTION
        'ponte_routing_lock exists with dangerous attributes (LOGIN/superuser/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS); reconcile the role manually';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_auth_members am
      WHERE am.roleid = '${ROUTING_LOCK_ROLE}'::regrole
        AND am.member <> '${OWNER_ROLE}'::regrole
    ) THEN
      RAISE EXCEPTION
        'ponte_routing_lock has unexpected members; reconcile the role manually';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_auth_members am
      WHERE am.member = '${ROUTING_LOCK_ROLE}'::regrole
    ) THEN
      RAISE EXCEPTION
        'ponte_routing_lock must be a leaf role with no parent memberships; reconcile the role manually';
    END IF;
  END IF;
END $$;`,
  });

  // (3d) Defence in depth: never leave a session-level role on the lock
  //      owner either.
  steps.push({
    id: "alter-role:routing-lock-reset-role",
    sql: `ALTER ROLE ${ROUTING_LOCK_ROLE} RESET ROLE;`,
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
  // Phase 2C.3: `ponte_owner` is a member of the lock-owner role. INHERIT
  // FALSE keeps the owner's privileges out of the lock role; SET TRUE is
  // what allows the migration's `ALTER FUNCTION ... OWNER TO` transfer.
  steps.push({
    id: "membership:routing-lock",
    sql: `GRANT ${ROUTING_LOCK_ROLE} TO ${OWNER_ROLE} WITH INHERIT FALSE, SET TRUE;`,
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

  // (8) Default-function hardening. This is a *default-privileges* setting: it
  //     stops the *next* function created by `ponte_owner` from regaining
  //     PUBLIC EXECUTE. It names no existing function, so it is valid before
  //     migrations create any. `FOR ROLE` names the target explicitly rather
  //     than relying on which role happens to be current.
  steps.push({
    id: "default-privileges:revoke-public-execute",
    sql: `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`,
  });

  return steps;
}

/**
 * Phase 2 plan — the post-migration object privileges.
 *
 * Ordering is load-bearing: the drift `REVOKE`s run before the grants.
 * `GRANT` is additive; without the revokes a database provisioned by an earlier,
 * broader design keeps every extra privilege. The trigger-function revokes run
 * after the drift revokes, and target `PUBLIC` rather than `ponte_app`.
 * Revoking `ALL` from the owner would remove the owner's own `EXECUTE` and
 * break trigger firing.
 *
 * The caller must run `verifyExpectedObjects` before applying this plan; the
 * plan itself assumes the objects exist.
 */
export function provisioningPlanPhase2(
  options: ProvisioningOptions,
): ProvisioningStep[] {
  const { database } = options;
  const app = APP_ROLE;

  const steps: ProvisioningStep[] = [];

  // (1) Drift repair. `GRANT` is additive, so an earlier design's table-level
  //     `UPDATE` would survive every grant below. Revoke everything from the
  //     application first, then re-apply exactly the approved matrix.
  //     `ponte_owner` is never touched: it owns these objects and must keep its
  //     own privileges, or its `BEFORE UPDATE` triggers stop firing.
  //
  //     Both application identities are revoked, but for different reasons.
  //     `ponte_app` is the group that holds every approved object grant, so its
  //     drift must be cleared before re-applying the matrix. `ponte_app_login`
  //     holds no object grants of its own: it inherits all of them from
  //     `ponte_app` via `INHERIT TRUE`. Any privilege stored directly on
  //     `ponte_app_login` is therefore drift — a grant that bypasses the group
  //     and the approved matrix — and must be removed too. `REVOKE` only
  //     removes privileges stored directly on the named role; it does not
  //     touch privileges inherited through role membership, so the login role's
  //     inherited access from `ponte_app` is unaffected.
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
  steps.push({
    id: "drift:app-login:tables",
    sql: `REVOKE ALL ON ALL TABLES IN SCHEMA ${PONTE_SCHEMA} FROM ${APP_LOGIN_ROLE};`,
  });
  steps.push({
    id: "drift:app-login:sequences",
    sql: `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${PONTE_SCHEMA} FROM ${APP_LOGIN_ROLE};`,
  });
  steps.push({
    id: "drift:app-login:functions",
    sql: `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${PONTE_SCHEMA} FROM ${APP_LOGIN_ROLE};`,
  });

  // (2) Application schema reachability.
  steps.push({
    id: "schema:app",
    sql: `GRANT USAGE ON SCHEMA ${PONTE_SCHEMA} TO ${app};`,
  });

  // (3) Read-only table.
  for (const table of READ_ONLY_TABLES) {
    steps.push({
      id: `read-only:${table}`,
      sql: `GRANT SELECT ON ${PONTE_SCHEMA}.${table} TO ${app};`,
    });
  }

  // (4) Append-only tables: SELECT + INSERT, never UPDATE.
  for (const table of APPEND_ONLY_TABLES) {
    steps.push({
      id: `append-only:${table}`,
      sql: `GRANT SELECT, INSERT ON ${PONTE_SCHEMA}.${table} TO ${app};`,
    });
  }

  // (5) invoices: append plus four mutable columns. `INSERT` is granted at
  //     table level; only `UPDATE` is column-scoped. Splitting `INSERT` into
  //     its six written columns would also break `RETURNING`, which needs
  //     `SELECT` on the returned columns (already held) and would make the
  //     grant brittle as the writer evolves.
  steps.push({
    id: "invoices:select-insert",
    sql: `GRANT SELECT, INSERT ON ${PONTE_SCHEMA}.invoices TO ${app};`,
  });

  // (6) Column-scoped UPDATE for every table that has one.
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

  // (7) rate_limits: column-scoped SELECT and INSERT as well. All three
  //     columns are app-owned, so this is narrow by construction rather than
  //     by omission.
  steps.push({
    id: "rate_limits:select-columns",
    sql: `GRANT SELECT (${RATE_LIMIT_COLUMNS.join(", ")}) ON ${PONTE_SCHEMA}.rate_limits TO ${app};`,
  });
  steps.push({
    id: "rate_limits:insert-columns",
    sql: `GRANT INSERT (${RATE_LIMIT_COLUMNS.join(", ")}) ON ${PONTE_SCHEMA}.rate_limits TO ${app};`,
  });

  // (8) route_decision_evidence: narrow read projection, full write envelope.
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

  // (9) evidence_outbox: three read, two write, never update.
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

  // (10) Existing trigger functions: remove the unused PUBLIC surface.
  for (const fn of TRIGGER_FUNCTIONS) {
    steps.push({
      id: `trigger-function:${fn}`,
      sql: `REVOKE EXECUTE ON FUNCTION ${PONTE_SCHEMA}.${fn} FROM PUBLIC;`,
    });
  }

  // (11) Phase 2C.3: restore the allowlisted EXECUTE on the two SECURITY
  //     DEFINER lock functions. The drift revocations above removed every
  //     function privilege from the application, including any grant on the
  //     lock functions, so the approved call surface is re-applied here —
  //     exactly these two functions, to the `ponte_app` group only.
  for (const fn of ROUTING_LOCK_FUNCTIONS) {
    steps.push({
      id: `lock-function:${fn.name}`,
      sql: `GRANT EXECUTE ON FUNCTION ${PONTE_SCHEMA}.${fn.name}(${fn.args}) TO ${app};`,
    });
  }

  // (12) Phase 2C.3: exact-signature and security-property verification.
  //     The grants above assume the migration created the functions with the
  //     approved shape; this step proves it from the catalogue and fails
  //     explicitly on any deviation — a name-only check would miss a wrong
  //     signature, a lost SECURITY DEFINER, a wrong owner, or a drifted
  //     search_path. Membership is checked in both directions as well: the
  //     lock role must have exactly `ponte_owner` as its member and no
  //     parent memberships.
  const lockVerification = ROUTING_LOCK_FUNCTIONS.map(
    (fn) => `
      SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
             pg_get_function_result(p.oid) AS result,
             p.proowner::regrole::text AS owner, p.prosecdef, p.proconfig,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
             has_function_privilege('${APP_ROLE}', p.oid, 'EXECUTE') AS app_exec
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = '${PONTE_SCHEMA}' AND p.proname = '${fn.name}'`,
  ).join("\n    UNION ALL\n");
  steps.push({
    id: "verify:routing-lock-functions",
    sql: `
DO $$
DECLARE
  rec record;
  expected_owner text := '${ROUTING_LOCK_ROLE}';
  expected_path text := '${ROUTING_LOCK_SEARCH_PATH}';
  found int := 0;
BEGIN
  FOR rec IN
    ${lockVerification}
  LOOP
    found := found + 1;
    IF rec.args <> '${ROUTING_LOCK_MEMBERSHIP_ARGS}' AND
       rec.args <> '${ROUTING_LOCK_QUOTE_ARGS}' THEN
      RAISE EXCEPTION 'lock function % has unexpected identity arguments: %',
        rec.proname, rec.args;
    END IF;
    IF rec.result <> '${ROUTING_LOCK_MEMBERSHIP_RESULT}' AND
       rec.result <> '${ROUTING_LOCK_QUOTE_RESULT}' THEN
      RAISE EXCEPTION 'lock function % has unexpected return type: %',
        rec.proname, rec.result;
    END IF;
    IF rec.owner <> expected_owner THEN
      RAISE EXCEPTION 'lock function % is owned by %, expected %',
        rec.proname, rec.owner, expected_owner;
    END IF;
    IF NOT rec.prosecdef THEN
      RAISE EXCEPTION 'lock function % is not SECURITY DEFINER', rec.proname;
    END IF;
    IF NOT (rec.proconfig IS NOT NULL AND rec.proconfig @> ARRAY[expected_path]::text[]) THEN
      RAISE EXCEPTION 'lock function % is missing the approved search_path setting', rec.proname;
    END IF;
    IF rec.public_exec THEN
      RAISE EXCEPTION 'lock function % still grants PUBLIC EXECUTE', rec.proname;
    END IF;
    IF NOT rec.app_exec THEN
      RAISE EXCEPTION 'lock function % does not grant EXECUTE to ${APP_ROLE}', rec.proname;
    END IF;
  END LOOP;
  IF found <> 2 THEN
    RAISE EXCEPTION 'expected 2 routing lock functions, found %', found;
  END IF;

  -- Membership, both directions.
  IF EXISTS (
    SELECT 1 FROM pg_auth_members am
    WHERE am.roleid = '${ROUTING_LOCK_ROLE}'::regrole
      AND am.member <> '${OWNER_ROLE}'::regrole
  ) THEN
    RAISE EXCEPTION 'ponte_routing_lock has unexpected members';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members am
    WHERE am.roleid = '${ROUTING_LOCK_ROLE}'::regrole
      AND am.member = '${OWNER_ROLE}'::regrole
  ) THEN
    RAISE EXCEPTION 'ponte_owner is not a member of ponte_routing_lock';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members am
    WHERE am.member = '${ROUTING_LOCK_ROLE}'::regrole
  ) THEN
    RAISE EXCEPTION 'ponte_routing_lock must be a leaf role with no parent memberships';
  END IF;
END $$;`,
  });

  // `database` is unused in Phase 2 but kept in the signature so both phases
  // share one options type.
  void database;

  return steps;
}

/**
 * Verifies that every expected table and trigger function exists.
 *
 * Returns the lists of missing objects. Phase 2 applies this **before** its
 * grant plan and throws `ProvisioningObjectsMissingError` if either list is
 * non-empty — a missing object is an explicit failure, never a silent skip.
 *
 * Runs as the bootstrap superuser (no `SET ROLE`): `to_regclass` /
 * `to_regproc` are catalogue lookups that do not depend on the caller's
 * privileges on the objects themselves.
 */
export async function verifyExpectedObjects(
  client: { query: (sql: string) => Promise<{ rows: unknown[] }> },
): Promise<{ missingTables: string[]; missingFunctions: string[] }> {
  const missingTables: string[] = [];
  const missingFunctions: string[] = [];

  for (const table of EXPECTED_TABLES) {
    const result = (await client.query(
      `SELECT to_regclass('${PONTE_SCHEMA}.${table}') AS rel`,
    )) as { rows: { rel: string | null }[] };
    if (!result.rows[0]?.rel) missingTables.push(table);
  }

  // Trigger functions are matched by name via `pg_proc`, not `to_regproc`:
  // `to_regproc('public.fn()')` is signature-strict and returns null even for
  // an existing no-argument trigger function, which would falsely report a
  // present function as missing. The `proname || '()'` comparison is the same
  // one `readProvisioningReport` uses, so existence is checked consistently.
  const present = new Set(
    ((
      await client.query(
        `SELECT p.proname
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = '${PONTE_SCHEMA}'
            AND (p.proname || '()') = ANY(${arrayLiteral([...TRIGGER_FUNCTIONS])})`,
      )
    ) as { rows: { proname: string }[] }).rows.map((row) => row.proname),
  );
  for (const fn of TRIGGER_FUNCTIONS) {
    if (!present.has(fn.replace("()", ""))) missingFunctions.push(fn);
  }

  // Phase 2C.3: the two SECURITY DEFINER lock functions are matched by exact
  // signature (identity arguments and return type), not by name. A function
  // with the right name but the wrong signature would pass a name-only check
  // and then fail the call site; reporting it as missing here is the
  // explicit, early failure the two-phase design promises.
  const lockFunctions = ((
    await client.query(
      `SELECT p.proname,
              pg_get_function_identity_arguments(p.oid) AS args,
              pg_get_function_result(p.oid) AS result
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = '${PONTE_SCHEMA}'
          AND p.proname = ANY(${arrayLiteral([
            ...ROUTING_LOCK_FUNCTIONS.map((fn) => fn.name),
          ])})`,
    )
  ) as { rows: { proname: string; args: string; result: string }[] }).rows;
  for (const expected of ROUTING_LOCK_FUNCTIONS) {
    const found = lockFunctions.find((row) => row.proname === expected.name);
    if (
      !found ||
      found.args !== expected.args ||
      found.result !== expected.result
    ) {
      missingFunctions.push(
        `${expected.name}(${expected.args}) returns ${expected.result}`,
      );
    }
  }

  return { missingTables, missingFunctions };
}

type Queryable = { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> };

/**
 * Applies the Phase 1 plan on an already-connected client.
 *
 * Runs as the bootstrap superuser. There is deliberately no `SET ROLE` here:
 * `ALTER DEFAULT PRIVILEGES FOR ROLE ponte_owner` names its target, and the
 * role/ACL statements must run as the superuser.
 *
 * Every statement is applied in its own implicit transaction. Provisioning is
 * a catalogue-only operation, so partial application is recoverable by simply
 * running it again — which is the property that makes idempotency worth
 * having.
 */
export async function applyProvisioningPhase1(
  client: Queryable,
  options: ProvisioningOptions,
): Promise<ProvisioningReport> {
  const steps = provisioningPlanPhase1(options);
  const stepsApplied: string[] = [];
  for (const step of steps) {
    await client.query(step.sql);
    stepsApplied.push(step.id);
  }
  return readProvisioningReport(client, { stepsApplied, phase: "phase1" });
}

/**
 * Applies the Phase 2 plan on an already-connected client.
 *
 * First verifies every expected table and trigger function exists, failing
 * explicitly (`ProvisioningObjectsMissingError`) if any are absent. Then
 * applies the drift revocations and the approved privilege matrix. Runs as the
 * bootstrap superuser; the drift revokes must *not* execute as the object
 * owner.
 */
export async function applyProvisioningPhase2(
  client: Queryable,
  options: ProvisioningOptions,
): Promise<ProvisioningReport> {
  const { missingTables, missingFunctions } = await verifyExpectedObjects(
    client,
  );
  if (missingTables.length || missingFunctions.length) {
    throw new ProvisioningObjectsMissingError(
      missingTables,
      missingFunctions,
    );
  }

  const steps = provisioningPlanPhase2(options);
  const stepsApplied: string[] = [];
  for (const step of steps) {
    await client.query(step.sql);
    stepsApplied.push(step.id);
  }
  return readProvisioningReport(client, { stepsApplied, phase: "phase2" });
}

/**
 * Reads the resulting state back from the catalogue.
 *
 * Nothing here trusts that a statement had its intended effect: each field is
 * an independent query, which is what makes the report useful as a CI gate.
 */
export async function readProvisioningReport(
  client: Queryable,
  options: { stepsApplied: string[]; phase: ProvisioningPhase },
): Promise<ProvisioningReport> {
  const version = (await client.query(
    "SELECT current_setting('server_version_num')::int AS n",
  )) as { rows: { n: number }[] };

  const roles = (await client.query(
    `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
            rolreplication, rolbypassrls
       FROM pg_roles
      WHERE rolname = ANY(${arrayLiteral([
        OWNER_ROLE,
        APP_ROLE,
        MIGRATOR_ROLE,
        APP_LOGIN_ROLE,
        ROUTING_LOCK_ROLE,
      ])})`,
  )) as {
    rows: {
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }[];
  };

  const memberships = (await client.query(
    `SELECT m.rolname AS member, g.rolname AS granted,
            am.inherit_option, am.set_option, am.admin_option
       FROM pg_auth_members am
       JOIN pg_roles m ON m.oid = am.member
       JOIN pg_roles g ON g.oid = am.roleid
      WHERE (m.rolname = '${APP_LOGIN_ROLE}' AND g.rolname = '${APP_ROLE}')
         OR (m.rolname = '${MIGRATOR_ROLE}' AND g.rolname = '${OWNER_ROLE}')
         OR (m.rolname = '${OWNER_ROLE}' AND g.rolname = '${ROUTING_LOCK_ROLE}')
      ORDER BY member, granted`,
  )) as {
    rows: {
      member: string;
      granted: string;
      inherit_option: boolean;
      set_option: boolean;
      admin_option: boolean;
    }[];
  };

  const acl = (await client.query(
    `SELECT datacl::text AS datacl FROM pg_database WHERE datname = current_database()`,
  )) as { rows: { datacl: string | null }[] };

  /**
   * Phase 2C.3: the two directions of the `ponte_routing_lock` membership
   * graph, read from `pg_auth_members` directly.
   *
   * - members of the lock role (expected: exactly `ponte_owner`, INHERIT
   *   FALSE, SET TRUE)
   * - roles the lock role is itself a member of (expected: none — it is a
   *   leaf and inherits nothing)
   */
  const routingLockMembers = (await client.query(
    `SELECT m.rolname AS member, am.inherit_option, am.set_option, am.admin_option
       FROM pg_auth_members am
       JOIN pg_roles m ON m.oid = am.member
       JOIN pg_roles g ON g.oid = am.roleid
      WHERE g.rolname = '${ROUTING_LOCK_ROLE}'
      ORDER BY m.rolname`,
  )) as {
    rows: {
      member: string;
      inherit_option: boolean;
      set_option: boolean;
      admin_option: boolean;
    }[];
  };
  const routingLockParents = (await client.query(
    `SELECT r.rolname AS parent
       FROM pg_auth_members am
       JOIN pg_roles r ON r.oid = am.roleid
      WHERE am.member = '${ROUTING_LOCK_ROLE}'::regrole
      ORDER BY r.rolname`,
  )) as { rows: { parent: string }[] };

  /**
   * Phase 2C.3: the exact signature and security properties of the two lock
   * functions, read back from the catalogue. `proconfig` is the function's
   * `SET` list; `pg_get_function_identity_arguments` / `pg_get_function_result`
   * give the canonical signature text the verification step compares against.
   */
  const lockFunctions = (await client.query(
    `SELECT p.proname,
            pg_get_function_identity_arguments(p.oid) AS args,
            pg_get_function_result(p.oid) AS result,
            p.proowner::regrole::text AS owner,
            p.prosecdef,
            p.proconfig,
            has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
            has_function_privilege('${APP_ROLE}', p.oid, 'EXECUTE') AS app_exec
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = '${PONTE_SCHEMA}'
        AND p.proname = ANY(${arrayLiteral([
          ...ROUTING_LOCK_FUNCTIONS.map((fn) => fn.name),
        ])})
      ORDER BY p.proname`,
  )) as {
    rows: {
      proname: string;
      args: string;
      result: string;
      owner: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      public_exec: boolean;
      app_exec: boolean;
    }[];
  };

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

  /**
   * Direct object privileges held by `ponte_app_login`, read from the
   * catalogue ACLs via `aclexplode`.
   *
   * `aclexplode` returns only privileges stored directly on the object's ACL.
   * Inherited privileges (resolved through role membership at check time) are
   * not stored there, so they never appear — which is exactly the property
   * needed: the login role's inherited access from `ponte_app` is invisible,
   * and only an independent direct grant is reported as drift. `information_schema`
   * would work for tables and sequences, but it has no function-privilege view,
   * and `has_function_privilege` would falsely report inherited EXECUTE, so the
   * ACL is read directly for all three object types. `aclexplode(NULL)` yields a
   * single all-NULL row, filtered out by `grantee IS NOT NULL`.
   */
  const appLoginDirect = (await client.query(
    `SELECT object_type, object_name, privilege_type
       FROM (
             SELECT 'table' AS object_type, c.relname AS object_name, a.privilege_type
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               JOIN aclexplode(c.relacl) a ON a.grantee IS NOT NULL
               JOIN pg_roles r ON r.oid = a.grantee
              WHERE n.nspname = '${PONTE_SCHEMA}'
                AND r.rolname = '${APP_LOGIN_ROLE}'
                AND c.relkind IN ('r','v','p','m','f')
             UNION ALL
             SELECT 'sequence', c.relname, a.privilege_type
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               JOIN aclexplode(c.relacl) a ON a.grantee IS NOT NULL
               JOIN pg_roles r ON r.oid = a.grantee
              WHERE n.nspname = '${PONTE_SCHEMA}'
                AND r.rolname = '${APP_LOGIN_ROLE}'
                AND c.relkind = 'S'
             UNION ALL
             SELECT 'function', p.proname || '()', a.privilege_type
               FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
               JOIN aclexplode(p.proacl) a ON a.grantee IS NOT NULL
               JOIN pg_roles r ON r.oid = a.grantee
              WHERE n.nspname = '${PONTE_SCHEMA}'
                AND r.rolname = '${APP_LOGIN_ROLE}'
          ) sub
       ORDER BY object_type, object_name, privilege_type`,
  )) as {
    rows: { object_type: string; object_name: string; privilege_type: string }[];
  };

  const appUpdateColumns: Record<string, string[]> = {};
  for (const row of appUpdate.rows) {
    (appUpdateColumns[row.table_name] ??= []).push(row.column_name);
  }

  return {
    phase: options.phase,
    serverVersionNum: version.rows[0].n,
    roles: Object.fromEntries(
      [OWNER_ROLE, APP_ROLE, MIGRATOR_ROLE, APP_LOGIN_ROLE].map((name) => {
        const found = roles.rows.find((row) => row.rolname === name);
        return [
          name,
          {
            exists: Boolean(found),
            canLogin: found?.rolcanlogin ?? false,
            superuser: found?.rolsuper ?? false,
            createdb: found?.rolcreatedb ?? false,
            createrole: found?.rolcreaterole ?? false,
            replication: found?.rolreplication ?? false,
            bypassrls: found?.rolbypassrls ?? false,
          },
        ];
      }),
    ),
    memberships: Object.fromEntries(
      memberships.rows.map((row) => [
        `${row.member}<-${row.granted}`,
        {
          inheritOption: row.inherit_option,
          setOption: row.set_option,
          adminOption: row.admin_option,
        },
      ]),
    ),
    routingLock: (() => {
      const found = roles.rows.find((row) => row.rolname === ROUTING_LOCK_ROLE);
      return {
        exists: Boolean(found),
        canLogin: found?.rolcanlogin ?? false,
        superuser: found?.rolsuper ?? false,
        createdb: found?.rolcreatedb ?? false,
        createrole: found?.rolcreaterole ?? false,
        replication: found?.rolreplication ?? false,
        bypassrls: found?.rolbypassrls ?? false,
      };
    })(),
    routingLockMemberships: {
      membersOfRoutingLock: routingLockMembers.rows.map((row) => ({
        member: row.member,
        inheritOption: row.inherit_option,
        setOption: row.set_option,
        adminOption: row.admin_option,
      })),
      routingLockParents: routingLockParents.rows.map((row) => row.parent),
    },
    lockFunctions: lockFunctions.rows.map((row) => ({
      name: row.proname,
      args: row.args,
      result: row.result,
      owner: row.owner,
      securityDefiner: row.prosecdef,
      searchPath:
        row.proconfig?.find((entry) => entry.startsWith("search_path=")) ??
        null,
      publicExecute: row.public_exec,
      appExecute: row.app_exec,
    })),
    databaseAcl: acl.rows[0]?.datacl ?? null,
    appUpdateColumns,
    appReadOnlyTables: [...READ_ONLY_TABLES],
    appInsertDeniedColumns: insertDenied.rows.map((row) => row.column_name),
    appLoginDirectPrivileges: appLoginDirect.rows.map((row) => ({
      objectType: row.object_type,
      objectName: row.object_name,
      privilegeType: row.privilege_type,
    })),
    triggerFunctionPublicExecute: Object.fromEntries(
      publicExecute.rows.map((row) => [row.proname, row.can]),
    ),
    stepsApplied: options.stepsApplied,
  };
}

/** Render a JS string array as a PostgreSQL array literal. */
function arrayLiteral(values: readonly string[]): string {
  return `ARRAY[${values.map((v) => `'${v.replaceAll("'", "''")}'`).join(", ")}]::text[]`;
}

/**
 * Convenience wrapper used by the CLI.
 *
 * `phase` selects the phase to run:
 * - `"phase1"` — pre-migration bootstrap only.
 * - `"phase2"` — post-migration object privileges only (verifies objects first).
 * - `"all"` — Phase 1 then Phase 2, in order. Valid only when the objects
 *   already exist (i.e. after `db:migrate`); Phase 2 will fail explicitly on a
 *   database where they do not.
 */
export async function provisionDatabasePhase1(
  pool: Pool,
  options: { allowScratchSchemaCreates: boolean; database?: string },
): Promise<ProvisioningReport> {
  const db = await pool.connect();
  try {
    const database = await resolveDatabase(db, options.database);
    return await applyProvisioningPhase1(db, {
      allowScratchSchemaCreates: options.allowScratchSchemaCreates,
      database,
    });
  } finally {
    db.release();
  }
}

export async function provisionDatabasePhase2(
  pool: Pool,
  options: { allowScratchSchemaCreates: boolean; database?: string },
): Promise<ProvisioningReport> {
  const db = await pool.connect();
  try {
    const database = await resolveDatabase(db, options.database);
    return await applyProvisioningPhase2(db, {
      allowScratchSchemaCreates: options.allowScratchSchemaCreates,
      database,
    });
  } finally {
    db.release();
  }
}

async function resolveDatabase(
  db: { query: (sql: string) => Promise<{ rows: { name: string }[] }> },
  database?: string,
): Promise<string> {
  if (database) return database;
  const result = await db.query("SELECT current_database() AS name");
  return result.rows[0].name;
}

/** Convenience wrapper: runs Phase 1 then Phase 2, in order. */
export async function provisionDatabase(
  pool: Pool,
  options: {
    allowScratchSchemaCreates: boolean;
    database?: string;
    phase?: ProvisioningPhase;
  },
): Promise<ProvisioningReport> {
  const phase = options.phase ?? "all";
  if (phase === "phase1") return provisionDatabasePhase1(pool, options);
  if (phase === "phase2") return provisionDatabasePhase2(pool, options);

  const phase1 = await provisionDatabasePhase1(pool, options);
  const phase2 = await provisionDatabasePhase2(pool, options);
  // The combined report reflects the final (Phase 2) object state, while the
  // applied-step lists from both phases are preserved for the log.
  return { ...phase2, stepsApplied: [...phase1.stepsApplied, ...phase2.stepsApplied] };
}
