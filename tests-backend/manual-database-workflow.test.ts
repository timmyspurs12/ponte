import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  APPROVED_REF,
  DATABASE_OPERATIONS,
  expectedConfirmation,
  guardFailureText,
  guardOperation,
  type GuardInput,
} from "../scripts/deployment-workflow-guards";

/**
 * Two layers are tested here:
 *
 * 1. The dispatch policy (`guardOperation`), which is the rule set the CLI
 *    re-applies on every run.
 * 2. The workflow YAML itself, parsed and asserted structurally: dispatch-only
 *    trigger, least privilege, no forbidden npm script anywhere, and a guard
 *    step that runs before the secret is placed in the environment.
 *
 * Neither layer needs GitHub or a database.
 */

const WORKFLOW_PATH = ".github/workflows/manual-database-operations.yml";
const workflowSource = readFileSync(WORKFLOW_PATH, "utf8");
const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as {
  load: (source: string) => Record<string, unknown>;
};
const workflow = yaml.load(workflowSource) as {
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<
    string,
    {
      if: string;
      "timeout-minutes": number;
      "runs-on": string;
      steps: Array<{
        name?: string;
        run?: string;
        env?: Record<string, string>;
        uses?: string;
        with?: Record<string, unknown>;
      }>;
    }
  >;
};

const tenantId = "8a1f3d62-6c4b-4c1e-9f3d-2b7c5a0e4d18";
const otherTenantId = "c73f9a10-2b64-4f8e-8a51-6d0c9e2b7f34";
const administratorId = "1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

const base = (overrides: Partial<GuardInput> = {}): GuardInput => ({
  eventName: "workflow_dispatch",
  ref: APPROVED_REF,
  actor: "octocat",
  operatorAllowlist: "octocat, review-bot",
  operation: "verify",
  businessId: "",
  businessName: "",
  confirmation: "",
  administratorBusinessId: administratorId,
  ...overrides,
});

const reason = (overrides: Partial<GuardInput>) => {
  const result = guardOperation(base(overrides));
  assert.equal(result.ok, false, "expected the guard to refuse");
  return (result as { ok: false; failure: string }).failure;
};

test("every operation is accepted with its own confirmation phrase", () => {
  for (const operation of DATABASE_OPERATIONS) {
    const mutation = operation !== "verify";
    const result = guardOperation(
      base({
        operation,
        businessId:
          operation === "business-bootstrap" || operation === "demo-bootstrap"
            ? tenantId
            : "",
        businessName:
          operation === "business-bootstrap" || operation === "demo-bootstrap"
            ? "Acme Comércio Ltda"
            : "",
        confirmation: mutation ? expectedConfirmation(operation) : "",
      }),
    );
    assert.equal(result.ok, true, `${operation} should be accepted`);
    if (!result.ok) continue;
    assert.equal(result.operation.operation, operation);
    assert.equal(result.operation.readOnly, operation === "verify");
  }
});

test("only a main-branch manual dispatch is accepted", () => {
  assert.equal(reason({ eventName: "push" }), "UNEXPECTED_EVENT");
  assert.equal(reason({ eventName: "schedule" }), "UNEXPECTED_EVENT");
  assert.equal(reason({ eventName: "workflow_run" }), "UNEXPECTED_EVENT");
  assert.equal(reason({ eventName: "" }), "UNEXPECTED_EVENT");
  assert.equal(
    reason({ ref: "refs/heads/arena/40fa34c0-ponte" }),
    "UNAPPROVED_REF",
  );
  assert.equal(reason({ ref: "refs/pull/1/merge" }), "UNAPPROVED_REF");
  assert.equal(reason({ ref: "refs/tags/v1.3.9" }), "UNAPPROVED_REF");
  assert.equal(reason({ ref: "" }), "UNAPPROVED_REF");
});

test("the operator allow-list is matching, not advisory", () => {
  assert.equal(reason({ actor: "someone-else" }), "UNAPPROVED_ACTOR");
  assert.equal(reason({ actor: "" }), "UNAPPROVED_ACTOR");
  assert.equal(
    reason({ operatorAllowlist: undefined }),
    "OPERATOR_ALLOWLIST_INVALID",
  );
  assert.equal(reason({ operatorAllowlist: "" }), "OPERATOR_ALLOWLIST_INVALID");
  assert.equal(
    reason({ operatorAllowlist: " , , " }),
    "OPERATOR_ALLOWLIST_INVALID",
  );
  assert.equal(
    reason({ operatorAllowlist: "octocat,not a login" }),
    "OPERATOR_ALLOWLIST_INVALID",
  );
  // Case-insensitive, whitespace-tolerant, and never a prefix match.
  assert.equal(guardOperation(base({ actor: "OctoCat " })).ok, true);
  assert.equal(reason({ actor: "octocat2" }), "UNAPPROVED_ACTOR");
});

test("a mutating operation requires its exact confirmation phrase", () => {
  assert.equal(reason({ operation: "migrate" }), "CONFIRMATION_MISSING");
  assert.equal(
    reason({ operation: "migrate", confirmation: "apply migrate" }),
    "CONFIRMATION_MISMATCH",
  );
  assert.equal(
    reason({ operation: "migrate", confirmation: "APPLY demo-bootstrap" }),
    "CONFIRMATION_MISMATCH",
  );
  assert.equal(
    guardOperation(
      base({ operation: "migrate", confirmation: "APPLY migrate" }),
    ).ok,
    true,
  );
});

test("unknown operations and misplaced inputs are refused", () => {
  assert.equal(reason({ operation: "reset" }), "UNKNOWN_OPERATION");
  assert.equal(reason({ operation: "seed" }), "UNKNOWN_OPERATION");
  assert.equal(reason({ operation: "fixtures" }), "UNKNOWN_OPERATION");
  assert.equal(reason({ operation: "" }), "UNKNOWN_OPERATION");
  // `verify` is read-only and must carry no tenant inputs at all.
  assert.equal(
    reason({ operation: "verify", businessId: tenantId }),
    "UNEXPECTED_INPUT",
  );
  assert.equal(
    reason({ operation: "verify", businessName: "Acme" }),
    "UNEXPECTED_INPUT",
  );
  assert.equal(
    reason({ operation: "verify", confirmation: "APPLY verify" }),
    "UNEXPECTED_INPUT",
  );
  // `migrate` changes schema only.
  assert.equal(
    reason({
      operation: "migrate",
      confirmation: "APPLY migrate",
      businessId: tenantId,
    }),
    "UNEXPECTED_INPUT",
  );
});

test("tenant identifiers are validated before any database work", () => {
  const confirmed = (overrides: Partial<GuardInput>) =>
    reason({
      operation: "business-bootstrap",
      confirmation: "APPLY business-bootstrap",
      businessName: "Acme Comércio Ltda",
      ...overrides,
    });
  assert.equal(confirmed({ businessId: "not-a-uuid" }), "INVALID_BUSINESS_ID");
  assert.equal(confirmed({ businessId: "" }), "INVALID_BUSINESS_ID");
  assert.equal(
    confirmed({ businessId: administratorId }),
    "BUSINESS_ID_MATCHES_ADMIN",
  );
  // The local seed / documentation placeholders are refused outright.
  assert.equal(
    confirmed({ businessId: "00000000-0000-4000-8000-000000000001" }),
    "BUSINESS_ID_IN_RESERVED_RANGE",
  );
  assert.equal(
    confirmed({ businessId: "00000000-0000-4000-8000-000000000002" }),
    "BUSINESS_ID_IN_RESERVED_RANGE",
  );
  // A derived (v5) UUID is not a legitimate new tenant identifier.
  assert.equal(
    confirmed({
      businessId: "8bd1f0f2-4c3a-5f6e-9b57-2f5f1a7c9d01",
      businessName: "Acme Comércio Ltda",
    }),
    "INVALID_BUSINESS_ID",
  );
  // `demo-bootstrap` may use a deterministic UUIDv5 tenant identifier; the
  // server-side demo guards, not the UUID version, keep it distinct.
  const demo = guardOperation(
    base({
      operation: "demo-bootstrap",
      confirmation: "APPLY demo-bootstrap",
      businessId: "8bd1f0f2-4c3a-5f6e-9b57-2f5f1a7c9d01",
      businessName: "PONTE Public Demo",
    }),
  );
  assert.equal(demo.ok, true);
  assert.equal(
    guardOperation(
      base({
        operation: "business-bootstrap",
        confirmation: "APPLY business-bootstrap",
        businessId: otherTenantId,
        businessName: "Acme Comércio Ltda",
      }),
    ).ok,
    true,
  );
});

test("business names are restricted to a safe, human-readable charset", () => {
  const name = (businessName: string) =>
    reason({
      operation: "business-bootstrap",
      confirmation: "APPLY business-bootstrap",
      businessId: tenantId,
      businessName,
    });
  assert.equal(name("A"), "INVALID_BUSINESS_NAME");
  assert.equal(name("x".repeat(81)), "INVALID_BUSINESS_NAME");
  assert.equal(name(" Acme Ltda"), "INVALID_BUSINESS_NAME");
  assert.equal(name("Acme Ltda "), "INVALID_BUSINESS_NAME");
  // Shell metacharacters and control characters must never reach a command.
  for (const hostile of [
    "Acme; rm -rf /",
    "Acme $(whoami)",
    "Acme `id`",
    "Acme && echo",
    "Acme | cat /etc/passwd",
    "Acme\nAPPLY migrate",
    "Acme\u0000Ltda",
    'Acme "quoted"',
    "Acme && rm -rf /",
    "Acme || true",
    "Acme ${HOME}",
  ]) {
    assert.equal(name(hostile), "INVALID_BUSINESS_NAME", hostile);
  }
  for (const accepted of [
    "Acme Comércio Ltda",
    "Silva & Filhos",
    "O'Reilly Distribuidora",
    "Norte-Sul (Matriz)",
    "Rede A/B",
    "Empresa 42",
  ]) {
    const result = guardOperation(
      base({
        operation: "business-bootstrap",
        confirmation: "APPLY business-bootstrap",
        businessId: tenantId,
        businessName: accepted,
      }),
    );
    assert.equal(result.ok, true, accepted);
  }
});

test("every guard failure has an actionable, secret-free sentence", () => {
  for (const [failure, text] of Object.entries(guardFailureText)) {
    assert.ok(text.length > 25, `${failure} needs an operator sentence`);
    assert.equal(/postgres:\/\/|pooler|password/i.test(text), false, failure);
  }
});

test("the workflow is dispatch-only, least-privilege, and serialized", () => {
  // js-yaml keeps the key `on` as a normal property here (YAML 1.1 boolean
  // coercion applies only to unquoted keys nested in a mapping value).
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency.group, "ponte-manual-database-operations");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  // Inputs are a closed choice list plus opaque strings; no free-form command.
  const inputs = (
    workflow.on.workflow_dispatch as {
      inputs: Record<string, { type: string; options?: string[] }>;
    }
  ).inputs;
  assert.deepEqual(inputs.operation.options, [...DATABASE_OPERATIONS]);
  assert.equal(inputs.operation.type, "choice");
  for (const name of ["business_id", "business_name", "confirmation"]) {
    assert.equal(inputs[name].type, "string");
  }
});

test("the workflow job cannot run without a dispatch event and a main ref", () => {
  const job = workflow.jobs.operate;
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.ok(job["timeout-minutes"] <= 30);
  assert.match(job.if, /github\.event_name == 'workflow_dispatch'/);
  const guardStep = job.steps.find((step) =>
    step.name?.startsWith("Refuse anything except"),
  );
  assert.ok(guardStep?.run, "a dispatch guard step must exist");
  assert.match(guardStep.run, /refs\/heads\/main/);
  assert.match(guardStep.run, /PONTE_DB_OPERATORS/);
  // Node is pinned from the same file Render reads.
  const setup = job.steps.find((step) =>
    step.uses?.startsWith("actions/setup-node"),
  );
  assert.deepEqual(setup?.with, {
    "node-version-file": ".node-version",
    cache: "npm",
  });
});

test("validation runs before the database secret is in scope", () => {
  const job = workflow.jobs.operate;
  const validateIndex = job.steps.findIndex((step) =>
    step.run?.includes("db:ops:validate"),
  );
  const operateIndex = job.steps.findIndex((step) =>
    step.run?.includes("db:ops:run"),
  );
  assert.ok(validateIndex > 0, "a validation step must exist");
  assert.ok(
    operateIndex > validateIndex,
    "validation must precede the operation",
  );

  const validateStep = job.steps[validateIndex];
  const operateStep = job.steps[operateIndex];
  const validateEnv = validateStep.env ?? {};
  const operateEnv = operateStep.env ?? {};

  // The direct-endpoint secret appears exactly once, on the operating step.
  assert.equal(
    (workflowSource.match(/secrets\.PONTE_DATABASE_URL_DIRECT/g) ?? []).length,
    1,
  );
  assert.equal(validateEnv.DATABASE_URL, undefined);
  assert.equal(
    operateEnv.DATABASE_URL,
    "${{ secrets.PONTE_DATABASE_URL_DIRECT }}",
  );
  // Inputs reach the shell only as environment variables.
  for (const step of [validateStep, operateStep]) {
    for (const value of Object.values(step.env ?? {})) {
      assert.equal(/\$\{\{\s*github\.event\.inputs/.test(value), false);
    }
  }
  for (const name of [
    "PONTE_DB_OPS_OPERATION",
    "PONTE_DB_OPS_BUSINESS_ID",
    "PONTE_DB_OPS_BUSINESS_NAME",
    "PONTE_DB_OPS_CONFIRMATION",
  ]) {
    assert.ok(
      operateEnv[name],
      `${name} must be passed as an environment variable`,
    );
  }
});

test("forbidden database commands never appear in the workflow", () => {
  for (const script of ["db:reset", "db:seed", "db:fixtures"]) {
    assert.equal(
      workflowSource.includes(script),
      false,
      `${script} must not appear`,
    );
  }
  for (const statement of ["TRUNCATE", "DROP TABLE", "DELETE FROM"]) {
    assert.equal(
      workflowSource.toUpperCase().includes(statement),
      false,
      `${statement} must not appear`,
    );
  }
  // The only `run:` commands are the guard, install, validate, operate, report.
  const runs = workflow.jobs.operate.steps
    .map((step) => step.run)
    .filter((value): value is string => typeof value === "string");
  assert.equal(runs.length, 5);
});

test("the workflow never enables the public demo and never edits env on Render", () => {
  // Enabling the demo is an operator decision made in the Render dashboard
  // after verification, not a side effect of a database command.
  assert.equal(workflowSource.includes("PONTE_PUBLIC_DEMO_READ_ONLY="), false);
  assert.equal(/render\.com\/v1\/services/.test(workflowSource), false);
  assert.equal(/curl\s/.test(workflowSource), false);
});
