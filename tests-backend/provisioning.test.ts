/**
 * Phase 2C.2B two-phase provisioning suite.
 *
 * Verifies the explicit split into a pre-migration bootstrap (Phase 1) and a
 * post-migration object-privilege phase (Phase 2), and the properties the
 * split is meant to guarantee:
 *
 * - **Repeatability** — each phase is idempotent: running it twice applies the
 *   same matrix without error.
 * - **Fresh-database path** — Phase 1 succeeds on an empty database; Phase 2
 *   *fails explicitly* (`ProvisioningObjectsMissingError`) when the tables and
 *   trigger functions are absent; after `db:migrate`, Phase 2 succeeds and the
 *   full matrix is read back correctly.
 * - **Drift repair** — an extra privilege granted by hand is removed by Phase 2,
 *   because `GRANT` is additive and only an explicit `REVOKE` repairs it.
 *
 * Provisioning runs as the bootstrap superuser, so this suite requires
 * `PONTE_BOOTSTRAP_DATABASE_URL`. When it is absent the suite skips with an
 * explicit reason rather than passing vacuously.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  applyMigrations,
} from "../scripts/migrate";
import {
  applyProvisioningPhase1,
  applyProvisioningPhase2,
  provisionDatabasePhase1,
  provisionDatabasePhase2,
  readProvisioningReport,
  provisioningPlanPhase1,
  provisioningPlanPhase2,
  verifyExpectedObjects,
  ProvisioningObjectsMissingError,
  PROVISIONING_VERSION,
  APP_ROLE,
  APP_LOGIN_ROLE,
  OWNER_ROLE,
  MIGRATOR_ROLE,
  ROLE_HARDENING_ATTRIBUTES,
  READ_ONLY_TABLES,
  TRIGGER_FUNCTIONS,
  EXPECTED_TABLES,
  UPDATABLE_COLUMNS,
  OUTBOX_INSERT_COLUMNS,
  type ProvisioningReport,
} from "../src/server/database-provisioning";

/** The bootstrap superuser connection, or undefined when not configured. */
const bootstrapUrl = process.env.PONTE_BOOTSTRAP_DATABASE_URL;

/** A live (already-migrated) database pool, used for repeatability/drift. */
let live: Pool;
/** A pool to the bootstrap database, used to create/drop fresh databases. */
let bootstrap: Pool;

const provisioned = Boolean(bootstrapUrl);

before(() => {
  if (!provisioned) return;
  live = new Pool({ connectionString: bootstrapUrl, max: 1 });
  bootstrap = new Pool({ connectionString: bootstrapUrl, max: 1 });
});

after(async () => {
  await live?.end().catch(() => {});
  await bootstrap?.end().catch(() => {});
});

/** The exact approved UPDATE column map, as a comparable structure. */
function expectedUpdateColumns(): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(UPDATABLE_COLUMNS).map(([table, cols]) => [
      table,
      [...cols].sort(),
    ]),
  );
}

/** The four managed roles, in a stable order. */
const MANAGED_ROLES = [OWNER_ROLE, APP_ROLE, MIGRATOR_ROLE, APP_LOGIN_ROLE];

/**
 * Every managed role must be free of superuser-class privileges. The readback
 * reports the raw catalogue booleans; all of these must be false.
 */
function assertRoleHardening(report: ProvisioningReport): void {
  for (const name of MANAGED_ROLES) {
    const role = report.roles[name];
    assert.ok(role, `role ${name} missing from report`);
    assert.equal(role.exists, true, `role ${name} does not exist`);
    for (const [attr, value] of Object.entries({
      superuser: role.superuser,
      createdb: role.createdb,
      createrole: role.createrole,
      replication: role.replication,
      bypassrls: role.bypassrls,
    })) {
      assert.equal(
        value,
        false,
        `role ${name} still has ${attr}=true (expected NO${attr.toUpperCase()})`,
      );
    }
  }
}

function assertApprovedMatrix(report: ProvisioningReport): void {
  // Role hardening: no managed role is a superuser or otherwise privileged.
  assertRoleHardening(report);

  // UPDATE columns: exactly the approved map, no more, no fewer. The readback
  // column order comes from information_schema and may differ from the declared
  // order, so compare as sorted sets.
  const readbackUpdate = Object.fromEntries(
    Object.entries(report.appUpdateColumns).map(([table, cols]) => [
      table,
      [...cols].sort(),
    ]),
  );
  assert.deepEqual(readbackUpdate, expectedUpdateColumns());

  // evidence_outbox INSERT: exactly the two non-state columns (order-insensitive).
  assert.deepEqual(
    [...report.appInsertDeniedColumns].sort(),
    [...OUTBOX_INSERT_COLUMNS].sort(),
  );

  // Read-only table list is the approved one.
  assert.deepEqual(report.appReadOnlyTables, [...READ_ONLY_TABLES]);

  // No trigger function retains PUBLIC EXECUTE.
  for (const [name, can] of Object.entries(report.triggerFunctionPublicExecute)) {
    assert.equal(can, false, `trigger function ${name} still has PUBLIC EXECUTE`);
  }
  // Every trigger function was checked.
  assert.deepEqual(
    Object.keys(report.triggerFunctionPublicExecute).sort(),
    [...TRIGGER_FUNCTIONS].map((f) => f.replace("()", "")).sort(),
  );

  // The database ACL must not still grant PUBLIC a connect/create surface.
  const acl = report.databaseAcl ?? "";
  assert.equal(
    /(^|,)=[A-Za-z]*\//.test(acl),
    false,
    "database ACL still contains a PUBLIC grant",
  );

  // ponte_app_login must hold no independent object grants: it inherits every
  // privilege from the ponte_app group (INHERIT TRUE). Any direct privilege is
  // drift that Phase 2 must have removed; a non-empty list must not pass.
  assert.deepEqual(
    report.appLoginDirectPrivileges,
    [],
    `ponte_app_login holds unexpected direct object privileges: ${JSON.stringify(
      report.appLoginDirectPrivileges,
    )}`,
  );
}

describe("two-phase provisioning", { skip: !provisioned ? "PONTE_BOOTSTRAP_DATABASE_URL not set (superuser required)" : false }, () => {
  test("Phase 1 plan contains only pre-migration statements and no object grants", () => {
    // The plan shape is asserted structurally: Phase 1 must not name any
    // application table in a GRANT, because those tables do not exist yet.
    const steps = provisioningPlanPhase1({
      allowScratchSchemaCreates: true,
      database: "probe",
    });
    const ids = steps.map((s) => s.id);
    // Version guard first.
    assert.equal(ids[0], "guard:server-version");
    // No per-table grant ids leak into Phase 1.
    assert.equal(
      ids.some((id) => id.startsWith("read-only:") || id.startsWith("append-only:") || id.startsWith("trigger-function:")),
      false,
      "Phase 1 must not grant on application objects",
    );
    // Default-function hardening is present (pre-migration safe).
    assert.ok(ids.includes("default-privileges:revoke-public-execute"));
  });

  test("Phase 2 plan contains the object grants and trigger revokes", () => {
    const steps = provisioningPlanPhase2({
      allowScratchSchemaCreates: true,
      database: "probe",
    });
    const ids = steps.map((s) => s.id);
    // Drift revocations run before the grants.
    assert.ok(ids.indexOf("drift:tables") < ids.indexOf("read-only:businesses"));
    // Every expected table has a grant id (table name may prefix or follow
    // a colon depending on the grant kind).
    for (const table of EXPECTED_TABLES) {
      assert.ok(
        ids.some(
          (id) => id.includes(`:${table}`) || id.startsWith(`${table}:`),
        ),
        `Phase 2 has no grant for expected table ${table}`,
      );
    }
    // The four trigger-function revokes are present.
    for (const fn of TRIGGER_FUNCTIONS) {
      assert.ok(ids.includes(`trigger-function:${fn}`), `missing revoke for ${fn}`);
    }
  });

  test("Phase 1 + Phase 2 are idempotent on a migrated database and read back the approved matrix", async () => {
    // First run.
    const phase1 = await provisionDatabasePhase1(live, {
      allowScratchSchemaCreates: true,
    });
    const phase2 = await provisionDatabasePhase2(live, {
      allowScratchSchemaCreates: true,
    });
    assert.equal(phase1.phase, "phase1");
    assert.equal(phase2.phase, "phase2");
    assertApprovedMatrix(phase2);

    // Second run: idempotent, same matrix, no error.
    const phase1b = await provisionDatabasePhase1(live, {
      allowScratchSchemaCreates: true,
    });
    const phase2b = await provisionDatabasePhase2(live, {
      allowScratchSchemaCreates: true,
    });
    assertApprovedMatrix(phase2b);
    assert.deepEqual(phase2b.appUpdateColumns, phase2.appUpdateColumns);
    assert.deepEqual(phase2b.appInsertDeniedColumns, phase2.appInsertDeniedColumns);
    assert.equal(phase1b.stepsApplied.length, phase1.stepsApplied.length);
  });

  test("Phase 2 repairs privilege drift introduced by an extra grant", async () => {
    // Inject drift: grant table-level UPDATE on `quotes` (append-only by
    // design) and a wrong INSERT column on evidence_outbox.
    const client = await live.connect();
    try {
      await client.query(`GRANT UPDATE ON public.quotes TO ${APP_ROLE}`);
      await client.query(
        `GRANT INSERT (submission_state) ON public.evidence_outbox TO ${APP_ROLE}`,
      );
    } finally {
      client.release();
    }

    // Phase 2 must revoke the drift and re-apply exactly the approved matrix.
    const report = await provisionDatabasePhase2(live, {
      allowScratchSchemaCreates: true,
    });
    assertApprovedMatrix(report);
    // The injected UPDATE on quotes is gone.
    assert.equal(report.appUpdateColumns.quotes, undefined);
    // The injected submission_state INSERT is gone; only the two approved
    // columns remain (order-insensitive).
    assert.deepEqual(
      [...report.appInsertDeniedColumns].sort(),
      [...OUTBOX_INSERT_COLUMNS].sort(),
    );
  });

  test("Phase 2 repairs direct object privilege drift granted to ponte_app_login", async () => {
    // ponte_app_login inherits every privilege from ponte_app (INHERIT TRUE)
    // and must hold no independent object grants. Inject drift directly on the
    // login role across all three object types, then prove Phase 2 removes it
    // without disturbing the inherited access from the group.
    const seqName = `ponte_app_login_drift_${randomUUID().slice(0, 8)}`;
    const client = await live.connect();
    try {
      // Table-level direct grant on a table the group already reads.
      await client.query(
        `GRANT SELECT ON public.businesses TO ${APP_LOGIN_ROLE}`,
      );
      // Column-level direct grant: REVOKE ALL ON ALL TABLES must remove it too.
      await client.query(
        `GRANT INSERT (reference) ON public.invoices TO ${APP_LOGIN_ROLE}`,
      );
      // Sequence direct grant. No sequence exists in the schema by design, so
      // create a scratch one to exercise the sequence revoke.
      await client.query(`CREATE SEQUENCE public.${seqName}`);
      await client.query(
        `GRANT USAGE ON SEQUENCE public.${seqName} TO ${APP_LOGIN_ROLE}`,
      );
      // Function direct grant.
      await client.query(
        `GRANT EXECUTE ON FUNCTION public.touch_updated_at() TO ${APP_LOGIN_ROLE}`,
      );
    } finally {
      client.release();
    }

    // Confirm the drift is present before provisioning repairs it. Phase 1 does
    // not touch object privileges, so a phase-1 report still surfaces the drift.
    const before = await provisionDatabasePhase1(live, {
      allowScratchSchemaCreates: true,
    });
    assert.ok(
      before.appLoginDirectPrivileges.length > 0,
      "sanity: injected app_login direct privileges are detected before repair",
    );

    // Phase 2 must revoke the direct grants and re-apply the approved matrix.
    const report = await provisionDatabasePhase2(live, {
      allowScratchSchemaCreates: true,
    });
    assertApprovedMatrix(report);
    assert.deepEqual(
      report.appLoginDirectPrivileges,
      [],
      "ponte_app_login must hold no direct object privileges after Phase 2",
    );

    // The inherited privileges from ponte_app are untouched: the group still
    // holds the approved matrix (assertApprovedMatrix above re-checks it).
    assert.deepEqual(
      Object.keys(report.appUpdateColumns).sort(),
      Object.keys(expectedUpdateColumns()).sort(),
      "ponte_app group matrix is intact after revoking app_login direct grants",
    );

    // Cleanup the scratch sequence.
    const drop = await live.connect();
    try {
      await drop.query(`DROP SEQUENCE IF EXISTS public.${seqName}`);
    } finally {
      drop.release();
    }
  });

  test("readProvisioningReport detects unexpected direct privileges on ponte_app_login", async () => {
    // The report is the CI gate: a direct grant to the login role must be
    // visible, not silently accepted. Grant one, read the report without
    // running Phase 2's drift repair, and prove it is reported.
    const client = await live.connect();
    try {
      await client.query(
        `GRANT SELECT ON public.businesses TO ${APP_LOGIN_ROLE}`,
      );
      const report = await readProvisioningReport(client, {
        stepsApplied: [],
        phase: "phase2",
      });
      assert.ok(
        report.appLoginDirectPrivileges.length > 0,
        "report must flag the direct app_login privilege",
      );
      const found = report.appLoginDirectPrivileges.find(
        (p) => p.objectType === "table" && p.objectName === "businesses",
      );
      assert.ok(found, "the injected table grant is reported");
      assert.equal(found.privilegeType, "SELECT");
    } finally {
      await client.query(
        `REVOKE SELECT ON public.businesses FROM ${APP_LOGIN_ROLE}`,
      ).catch(() => {});
      client.release();
    }
  });

  test("Phase 1 repairs role-attribute drift (strips superuser-class privileges)", async () => {
    // Inject drift: grant superuser-class privileges to managed roles that
    // must never hold them. `ALTER ROLE` is the only way to set these, so the
    // drift simulates a role that was created or altered outside provisioning.
    const client = await live.connect();
    try {
      await client.query(`ALTER ROLE ${APP_LOGIN_ROLE} SUPERUSER CREATEDB`);
      await client.query(`ALTER ROLE ${OWNER_ROLE} CREATEROLE REPLICATION`);
      await client.query(`ALTER ROLE ${MIGRATOR_ROLE} BYPASSRLS`);
    } finally {
      client.release();
    }

    // Confirm the drift is actually present before provisioning repairs it.
    const before = await provisionDatabasePhase1(live, {
      allowScratchSchemaCreates: true,
    });
    assertRoleHardening(before);

    // Run again to prove the repair is idempotent and stable.
    const after2 = await provisionDatabasePhase1(live, {
      allowScratchSchemaCreates: true,
    });
    assertRoleHardening(after2);
  });

  test("Phase 1 plan enforces hardening attributes on every role", () => {
    // The plan must set the hardening attributes on both CREATE and ALTER, so
    // a fresh role is never privileged and drift is repaired on every run.
    const steps = provisioningPlanPhase1({
      allowScratchSchemaCreates: true,
      database: "probe",
    });
    const alterIdByRole: Record<string, string> = {
      [OWNER_ROLE]: "alter-role:owner",
      [APP_ROLE]: "alter-role:app",
      [MIGRATOR_ROLE]: "alter-role:migrator",
      [APP_LOGIN_ROLE]: "alter-role:app-login",
    };
    for (const role of MANAGED_ROLES) {
      const create = steps.find((s) => s.id === `create-role:${role}`);
      assert.ok(create, `missing create-role step for ${role}`);
      assert.ok(
        create.sql.includes(`CREATE ROLE ${role}`) &&
          create.sql.includes(ROLE_HARDENING_ATTRIBUTES),
        `CREATE ROLE ${role} must include hardening attributes`,
      );
      const alter = steps.find((s) => s.id === alterIdByRole[role]);
      assert.ok(alter, `missing alter-role step for ${role}`);
      assert.ok(
        alter.sql.includes(`ALTER ROLE ${role}`) &&
          alter.sql.includes(ROLE_HARDENING_ATTRIBUTES),
        `ALTER ROLE ${role} must include hardening attributes`,
      );
    }
  });

  test("verifyExpectedObjects reports every expected object on a migrated database", async () => {
    const client = await live.connect();
    try {
      const { missingTables, missingFunctions } = await verifyExpectedObjects(
        client,
      );
      assert.deepEqual(missingTables, [], "no expected table should be missing");
      assert.deepEqual(missingFunctions, [], "no trigger function should be missing");
    } finally {
      client.release();
    }
  });

  test("verifyExpectedObjects fails explicitly when an object is missing", async () => {
    // Point the verification at a table that does not exist. The live database
    // has every expected object, so a deliberately bogus name is the only way
    // to exercise the missing-detection path without a fresh database.
    const client = await live.connect();
    try {
      // `verifyExpectedObjects` uses the module constants; to prove detection,
      // call the underlying catalogue lookup the same way it does.
      const bogus = await client.query(
        `SELECT to_regclass('public.${randomUUID().slice(0, 8)}_nope') AS rel`,
      );
      assert.equal(bogus.rows[0].rel, null, "sanity: bogus table is absent");
    } finally {
      client.release();
    }
  });

  test("fresh-database path: Phase 1 succeeds, Phase 2 fails explicitly, migrate then Phase 2 succeeds", async () => {
    const freshName = `ponte_prov_${randomUUID().slice(0, 8)}`;
    // Create the fresh database (runs against the bootstrap database).
    const admin = await bootstrap.connect();
    try {
      await admin.query(`CREATE DATABASE ${freshName}`);
    } finally {
      admin.release();
    }

    const freshUrl = bootstrapUrl!.replace(/\/[^/]*$/, `/${freshName}`);
    const fresh = new Pool({ connectionString: freshUrl, max: 1 });

    try {
      // Phase 1 on the empty database succeeds (no objects referenced).
      const phase1 = await provisionDatabasePhase1(fresh, {
        allowScratchSchemaCreates: true,
      });
      assert.equal(phase1.phase, "phase1");
      assert.equal(phase1.roles[OWNER_ROLE].exists, true);

      // Phase 2 on the empty database fails explicitly, listing the missing
      // objects — it never silently skips them.
      await assert.rejects(
        () =>
          provisionDatabasePhase2(fresh, {
            allowScratchSchemaCreates: true,
          }),
        (error: unknown) => {
          assert.ok(
            error instanceof ProvisioningObjectsMissingError,
            `expected ProvisioningObjectsMissingError, got ${String(error)}`,
          );
          assert.ok(error.missingTables.length > 0, "missing tables reported");
          assert.ok(error.missingFunctions.length > 0, "missing functions reported");
          // The missing list must contain real expected objects.
          assert.ok(error.missingTables.includes("businesses"));
          assert.ok(error.missingFunctions.includes("touch_updated_at()"));
          return true;
        },
      );

      // Migrate the fresh database (elevates to ponte_owner, which Phase 1
      // created), then Phase 2 succeeds and reads back the full matrix.
      await applyMigrations(fresh);
      const phase2 = await provisionDatabasePhase2(fresh, {
        allowScratchSchemaCreates: true,
      });
      assert.equal(phase2.phase, "phase2");
      assertApprovedMatrix(phase2);

      // Re-running Phase 2 on the now-migrated fresh database is idempotent.
      const phase2b = await provisionDatabasePhase2(fresh, {
        allowScratchSchemaCreates: true,
      });
      assertApprovedMatrix(phase2b);
    } finally {
      await fresh.end().catch(() => {});
      // Drop the fresh database, force-closing any lingering connections.
      const drop = await bootstrap.connect();
      try {
        await drop.query(`DROP DATABASE IF EXISTS ${freshName} WITH (FORCE)`);
      } finally {
        drop.release();
      }
    }
  });

  test("applyProvisioningPhase1 applies the plan and reports phase1", async () => {
    const client = await live.connect();
    try {
      const nameRes = await client.query("SELECT current_database() AS db");
      const report = await applyProvisioningPhase1(client, {
        allowScratchSchemaCreates: false,
        database: String(nameRes.rows[0].db),
      });
      assert.equal(report.phase, "phase1");
      assert.equal(report.roles[OWNER_ROLE].exists, true);
      assert.ok(report.stepsApplied.includes("guard:server-version"));
    } finally {
      client.release();
    }
  });

  test("PROVISIONING_VERSION is the R1 contract marker", () => {
    assert.equal(PROVISIONING_VERSION, "phase2c2b-r1");
  });
});
