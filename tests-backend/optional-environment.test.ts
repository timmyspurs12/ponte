import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  demoFlagIsEnabled,
  readDemoFlag,
  readOptionalString,
  readOptionalUuid,
} from "../scripts/optional-environment";
import {
  guardOperation,
  type GuardInput,
} from "../scripts/deployment-workflow-guards";
import {
  assertPublicDemoBootstrapEnvironment,
  readPublicDemoBootstrapCommand,
} from "../scripts/production-demo-bootstrap";
import {
  assertProductionBusinessBootstrapEnvironment,
  readConfiguredAdministratorBusinessId,
} from "../scripts/production-business-bootstrap";

/**
 * Regression suite for the empty-string mismatch between GitHub Actions and
 * the application's guards.
 *
 * Every case below builds the environment a *workflow job* would actually have,
 * not a JavaScript literal with `undefined`. A workflow that writes
 *
 * ```yaml
 * env:
 *   PONTE_AUTH_BUSINESS_ID: ${{ vars.PONTE_AUTH_BUSINESS_ID }}
 * ```
 *
 * gives the process `""` when the repository variable does not exist. Passing
 * `{ PONTE_AUTH_BUSINESS_ID: undefined }` in a test deletes the variable and
 * models a shell invocation, not a dispatch — which is precisely why the defect
 * survived the previous suite.
 *
 * Nothing here connects to a database or leaves the process.
 */

const administratorId = "1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const privateTenantId = "c73f9a10-2b64-4f8e-8a51-6d0c9e2b7f34";
const demoId = "5b0c7d84-9e21-4f3a-8c6d-1a2b3c4d5e6f";
const otherDemoId = "9f4e2d10-6b8c-4a7e-b3d1-0c2e5f7a9b13";

/** The dispatch inputs are workflow *inputs*, which GitHub does send as "". */
const dispatch = (overrides: Partial<GuardInput> = {}): GuardInput => ({
  eventName: "workflow_dispatch",
  ref: "refs/heads/main",
  actor: "octocat",
  operatorAllowlist: "octocat",
  operation: "verify",
  businessId: "",
  businessName: "",
  confirmation: "",
  administratorBusinessId: administratorId,
  demoBusinessId: undefined,
  ...overrides,
});

const failure = (overrides: Partial<GuardInput>) => {
  const result = guardOperation(dispatch(overrides));
  assert.equal(result.ok, false, "expected a refusal");
  return (result as { ok: false; failure: string }).failure;
};

/** A job environment as the workflow builds it: unset vars are `""`. */
const workflowEnvironment = (
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
  NODE_ENV: "production",
  DATABASE_URL:
    "postgres://operator@ep-example-123456.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full",
  PONTE_AUTH_BUSINESS_ID: administratorId,
  PONTE_PUBLIC_DEMO_BUSINESS_ID: "",
  PONTE_PUBLIC_DEMO_READ_ONLY: "",
  ...overrides,
});

/** `assertPublicDemoBootstrapEnvironment` signals refusal by throwing. */
const demoPreflightReason = (
  environment: Record<string, string | undefined>,
  verifyOnly = false,
): string => {
  try {
    assertPublicDemoBootstrapEnvironment(environment, { verifyOnly });
    return "ACCEPTED";
  } catch (error) {
    return (error as { reason?: string }).reason ?? "UNKNOWN";
  }
};

/* -------------------------------------------------------------------------- *
 * 1. The shared helper's contract, stated once
 * -------------------------------------------------------------------------- */

test("only absent and the exact empty string are 'unset'", () => {
  assert.deepEqual(readOptionalString(undefined), { state: "unset" });
  assert.deepEqual(readOptionalString(""), { state: "unset" });
  assert.deepEqual(readOptionalString("0"), {
    state: "configured",
    value: "0",
  });
  // Whitespace is not blankness: it is a value nobody meant to type.
  assert.deepEqual(readOptionalString(" "), {
    state: "configured",
    value: " ",
  });
});

test("a whitespace-only UUID is malformed, never silently unset", () => {
  assert.deepEqual(readOptionalUuid(undefined), { state: "unset" });
  assert.deepEqual(readOptionalUuid(""), { state: "unset" });
  for (const blank of [" ", "   ", "\t", "\n", "  \n "]) {
    assert.deepEqual(
      readOptionalUuid(blank),
      { state: "invalid", reason: "malformed" },
      JSON.stringify(blank),
    );
  }
});

test("a configured UUID is trimmed and lower-cased", () => {
  assert.deepEqual(readOptionalUuid(`  ${administratorId.toUpperCase()}\n`), {
    state: "configured",
    value: administratorId,
  });
  assert.deepEqual(readOptionalUuid(`${administratorId}t`), {
    state: "invalid",
    reason: "malformed",
  });
  assert.deepEqual(readOptionalUuid("00000000-0000-4000-8000-00000000000"), {
    state: "invalid",
    reason: "malformed",
  });
});

test("the demo flag is tri-state with an explicit invalid state", () => {
  assert.equal(readDemoFlag(undefined).state, "unset");
  assert.equal(readDemoFlag("").state, "unset");
  assert.equal(readDemoFlag("0").state, "disabled");
  assert.equal(readDemoFlag("1").state, "enabled");
  for (const wrong of ["2", "true", "enable", "01", " 1", "1 ", "1\n", " "]) {
    assert.equal(readDemoFlag(wrong).state, "invalid", JSON.stringify(wrong));
  }
  // Only "1" ever counts as enabled, so a typo can never switch the demo on.
  assert.equal(demoFlagIsEnabled(""), false);
  assert.equal(demoFlagIsEnabled("0"), false);
  assert.equal(demoFlagIsEnabled("1"), true);
  assert.equal(demoFlagIsEnabled("TRUE"), false);
});

/* -------------------------------------------------------------------------- *
 * 2. Private business UUID
 * -------------------------------------------------------------------------- */

test("an empty private UUID means unconfigured and allows the bootstrap", () => {
  for (const value of ["", undefined]) {
    const result = guardOperation(
      dispatch({
        operation: "business-bootstrap",
        businessId: privateTenantId,
        businessName: "Acme Comércio Ltda",
        confirmation: "APPLY business-bootstrap",
        administratorBusinessId: value,
      }),
    );
    assert.equal(result.ok, true, `administratorBusinessId=${String(value)}`);
    if (!result.ok) continue;
    assert.equal(result.operation.administratorUnconfigured, true);
    assert.equal(result.operation.businessId, privateTenantId);
  }
});

test("a valid configured private UUID must match the bootstrap exactly", () => {
  const matching = guardOperation(
    dispatch({
      operation: "business-bootstrap",
      businessId: administratorId,
      businessName: "Acme Comércio Ltda",
      confirmation: "APPLY business-bootstrap",
      administratorBusinessId: administratorId,
    }),
  );
  assert.equal(matching.ok, true);
  if (matching.ok)
    assert.equal(matching.operation.administratorUnconfigured, undefined);

  // Upper case names the same tenant, so it is accepted and normalised.
  const upper = guardOperation(
    dispatch({
      operation: "business-bootstrap",
      businessId: administratorId.toUpperCase(),
      businessName: "Acme Comércio Ltda",
      confirmation: "APPLY business-bootstrap",
      administratorBusinessId: administratorId.toUpperCase(),
    }),
  );
  assert.equal(upper.ok, true);

  assert.equal(
    failure({
      operation: "business-bootstrap",
      businessId: privateTenantId,
      businessName: "Acme Comércio Ltda",
      confirmation: "APPLY business-bootstrap",
    }),
    "BUSINESS_ID_DOES_NOT_MATCH_ADMIN",
  );
});

test("a malformed non-empty private UUID is refused, not ignored", () => {
  for (const malformed of [
    "not-a-uuid",
    "00000000-0000-4000-8000-00000000000",
    `${administratorId}t`,
    "   ",
    "\t",
  ]) {
    assert.equal(
      failure({
        operation: "business-bootstrap",
        businessId: privateTenantId,
        businessName: "Acme Comércio Ltda",
        confirmation: "APPLY business-bootstrap",
        administratorBusinessId: malformed,
      }),
      "ADMIN_BUSINESS_INVALID",
      JSON.stringify(malformed),
    );
  }
});

/* -------------------------------------------------------------------------- *
 * 3. Demo business UUID
 * -------------------------------------------------------------------------- */

test("an empty demo UUID means nothing is configured yet", () => {
  for (const value of ["", undefined]) {
    for (const operation of ["demo-bootstrap", "demo-verify"] as const) {
      const result = guardOperation(
        dispatch({
          operation,
          businessId: demoId,
          businessName: "PONTE Public Demo",
          confirmation:
            operation === "demo-bootstrap" ? "APPLY demo-bootstrap" : "",
          demoBusinessId: value,
        }),
      );
      assert.equal(
        result.ok,
        true,
        `${operation} demoBusinessId=${String(value)}`,
      );
      if (result.ok)
        assert.equal(result.operation.demoBusinessIdUnconfigured, true);
    }
  }
});

test("a valid configured demo UUID must match the operation's tenant", () => {
  for (const operation of ["demo-bootstrap", "demo-verify"] as const) {
    const confirmation =
      operation === "demo-bootstrap" ? "APPLY demo-bootstrap" : "";
    const matched = guardOperation(
      dispatch({
        operation,
        businessId: demoId,
        businessName: "PONTE Public Demo",
        confirmation,
        demoBusinessId: demoId,
      }),
    );
    assert.equal(matched.ok, true, operation);
    if (matched.ok)
      assert.equal(matched.operation.demoBusinessIdUnconfigured, undefined);

    assert.equal(
      failure({
        operation,
        businessId: demoId,
        businessName: "PONTE Public Demo",
        confirmation,
        demoBusinessId: otherDemoId,
      }),
      "DEMO_BUSINESS_ID_MISMATCH",
      operation,
    );
  }
});

test("the demo tenant can never be the private tenant", () => {
  for (const operation of ["demo-bootstrap", "demo-verify"] as const) {
    assert.equal(
      failure({
        operation,
        businessId: administratorId,
        businessName: "PONTE Public Demo",
        confirmation:
          operation === "demo-bootstrap" ? "APPLY demo-bootstrap" : "",
      }),
      "BUSINESS_ID_MATCHES_ADMIN",
      operation,
    );
  }
  /*
   * With no private UUID configured the guard cannot compare: it has no value to
   * say "that is the private tenant". The dispatch is therefore accepted *by
   * the guard*, and the demo preflight is the layer that refuses — it requires a
   * configured private UUID precisely because the demo must be provably distinct
   * from it. Asserting a `BUSINESS_ID_MATCHES_ADMIN` refusal here would be
   * asserting knowledge the guard does not have.
   */
  const uncomparable = guardOperation(
    dispatch({
      operation: "demo-verify",
      businessId: administratorId,
      businessName: "PONTE Public Demo",
      administratorBusinessId: "",
      demoBusinessId: administratorId,
    }),
  );
  assert.equal(uncomparable.ok, true);
  assert.equal(
    demoPreflightReason(
      workflowEnvironment({ PONTE_AUTH_BUSINESS_ID: "" }),
      true,
    ),
    "ADMIN_BUSINESS_UNCONFIGURED",
  );
});

test("a whitespace-only demo UUID is refused", () => {
  for (const blank of [" ", "   ", "\t", "\n"]) {
    for (const operation of ["demo-bootstrap", "demo-verify"] as const) {
      assert.equal(
        failure({
          operation,
          businessId: demoId,
          businessName: "PONTE Public Demo",
          confirmation:
            operation === "demo-bootstrap" ? "APPLY demo-bootstrap" : "",
          demoBusinessId: blank,
        }),
        "DEMO_BUSINESS_ID_MISMATCH",
        `${operation} ${JSON.stringify(blank)}`,
      );
    }
  }
});

/* -------------------------------------------------------------------------- *
 * 4. The whole workflow environment
 * -------------------------------------------------------------------------- */

test("all three optional variables as empty strings is a working dispatch", () => {
  // This is the state of a repository where only PONTE_DB_OPERATORS and the
  // secret have been configured — i.e. the first documented run.
  const allBlank = {
    administratorBusinessId: "",
    demoBusinessId: "",
  };

  // Business bootstrap: allowed, with the "set the variable afterwards" warning.
  const business = guardOperation(
    dispatch({
      ...allBlank,
      operation: "business-bootstrap",
      businessId: privateTenantId,
      businessName: "Acme Comércio Ltda",
      confirmation: "APPLY business-bootstrap",
    }),
  );
  assert.equal(business.ok, true);
  if (business.ok)
    assert.equal(business.operation.administratorUnconfigured, true);

  // Demo bootstrap: allowed while the demo is disabled.
  const demo = guardOperation(
    dispatch({
      ...allBlank,
      operation: "demo-bootstrap",
      businessId: demoId,
      businessName: "PONTE Public Demo",
      confirmation: "APPLY demo-bootstrap",
    }),
  );
  assert.equal(demo.ok, true);
  if (demo.ok) assert.equal(demo.operation.demoBusinessIdUnconfigured, true);

  // demo-verify: read-only, and works with every optional variable blank.
  const verify = guardOperation(
    dispatch({
      ...allBlank,
      operation: "demo-verify",
      businessId: demoId,
      businessName: "PONTE Public Demo",
    }),
  );
  assert.equal(verify.ok, true);
  if (verify.ok) assert.equal(verify.operation.readOnly, true);
});

test("the provisioning preflights accept empty optional variables", () => {
  const environment = workflowEnvironment();
  // Empty demo flag = disabled, empty demo UUID = not configured yet.
  assert.equal(demoPreflightReason(environment), "ACCEPTED");
  assert.equal(demoPreflightReason(environment, true), "ACCEPTED");

  // A whitespace-only demo UUID is a configuration error, not "unset".
  for (const blank of [" ", "  ", "\t"]) {
    assert.equal(
      demoPreflightReason(
        workflowEnvironment({ PONTE_PUBLIC_DEMO_BUSINESS_ID: blank }),
      ),
      "DEMO_CONFIG_MISMATCH",
      JSON.stringify(blank),
    );
  }
  // A malformed non-empty demo flag is likewise refused.
  for (const wrong of ["2", "true", " 1", "1 "]) {
    assert.equal(
      demoPreflightReason(
        workflowEnvironment({ PONTE_PUBLIC_DEMO_READ_ONLY: wrong }),
      ),
      "DEMO_CONFIG_MISMATCH",
      JSON.stringify(wrong),
    );
  }
});

test("an enabled demo flag blocks provisioning but permits verification", () => {
  for (const enabled of ["1"]) {
    assert.equal(
      demoPreflightReason(
        workflowEnvironment({ PONTE_PUBLIC_DEMO_READ_ONLY: enabled }),
      ),
      "DEMO_ALREADY_ENABLED",
    );
    assert.equal(
      demoPreflightReason(
        workflowEnvironment({ PONTE_PUBLIC_DEMO_READ_ONLY: enabled }),
        true,
      ),
      "ACCEPTED",
    );
  }
  // `0` and `""` are both "disabled": provisioning is allowed.
  for (const disabled of ["0", ""]) {
    assert.equal(
      demoPreflightReason(
        workflowEnvironment({ PONTE_PUBLIC_DEMO_READ_ONLY: disabled }),
      ),
      "ACCEPTED",
      JSON.stringify(disabled),
    );
  }
});

test("an empty or malformed private UUID still blocks the demo preflight", () => {
  // The demo module genuinely requires a private UUID: it is the value the demo
  // must differ from. "Not configured" cannot mean "no rule".
  for (const value of ["", "   ", "not-a-uuid", undefined]) {
    assert.equal(
      demoPreflightReason(
        workflowEnvironment({ PONTE_AUTH_BUSINESS_ID: value }),
      ),
      "ADMIN_BUSINESS_UNCONFIGURED",
      JSON.stringify(value),
    );
  }
});

test("the demo command matches a configured UUID against the dispatched one", () => {
  const args = [
    "--confirm-production",
    "--business-id",
    demoId,
    "--business-name",
    "PONTE Public Demo",
  ];
  // Empty values from unset variables are accepted.
  const ok = readPublicDemoBootstrapCommand(args, workflowEnvironment());
  assert.equal(ok.input.businessId, demoId);

  // A different configured UUID is refused before a pool could be created.
  assert.throws(
    () =>
      readPublicDemoBootstrapCommand(
        args,
        workflowEnvironment({ PONTE_PUBLIC_DEMO_BUSINESS_ID: otherDemoId }),
      ),
    (error: unknown) =>
      (error as { reason?: string }).reason === "DEMO_CONFIG_MISMATCH",
  );

  // An empty flag still refuses a *provisioning* run when the demo is on.
  assert.throws(
    () =>
      readPublicDemoBootstrapCommand(
        args,
        workflowEnvironment({ PONTE_PUBLIC_DEMO_READ_ONLY: "1" }),
      ),
    (error: unknown) =>
      (error as { reason?: string }).reason === "DEMO_ALREADY_ENABLED",
  );
});

test("the private UUID reader distinguishes unset from malformed", () => {
  assert.equal(
    readConfiguredAdministratorBusinessId({
      PONTE_AUTH_BUSINESS_ID: "",
    }),
    undefined,
  );
  assert.equal(
    readConfiguredAdministratorBusinessId({
      PONTE_AUTH_BUSINESS_ID: undefined,
    }),
    undefined,
  );
  assert.equal(
    readConfiguredAdministratorBusinessId({
      PONTE_AUTH_BUSINESS_ID: ` ${administratorId.toUpperCase()} `,
    }),
    administratorId,
  );
  for (const malformed of ["   ", "not-a-uuid", `${administratorId}x`]) {
    assert.throws(
      () =>
        readConfiguredAdministratorBusinessId({
          PONTE_AUTH_BUSINESS_ID: malformed,
        }),
      (error: unknown) => (error as { code?: string }).code === "REFUSED",
      JSON.stringify(malformed),
    );
  }
});

test("the business preflight is unaffected by an empty optional variable", () => {
  // No demo variable is read by this module at all; empty is simply inert.
  const transport = assertProductionBusinessBootstrapEnvironment(
    workflowEnvironment(),
  );
  assert.equal(
    transport,
    "postgres://operator@ep-example-123456.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full",
  );
});

/* -------------------------------------------------------------------------- *
 * 5. The workflow file itself
 * -------------------------------------------------------------------------- */

const workflowSource = readFileSync(
  ".github/workflows/manual-database-operations.yml",
  "utf8",
);

test("the workflow still maps every optional variable from vars", () => {
  for (const name of [
    "PONTE_AUTH_BUSINESS_ID",
    "PONTE_PUBLIC_DEMO_BUSINESS_ID",
    "PONTE_PUBLIC_DEMO_READ_ONLY",
  ]) {
    assert.ok(
      workflowSource.includes(`${name}: \${{ vars.${name} }}`),
      `${name} must come from a repository variable`,
    );
  }
  // The empty-string contract is documented where the mapping lives, so the
  // next person to edit the env block sees why the code distinguishes "".
  assert.match(workflowSource, /EMPTY STRING/);
  assert.match(workflowSource, /optional-environment\.ts/);
});

test("no guard treats an empty string as a configured value", () => {
  // A cheap structural check: the modules that read these variables must go
  // through the shared reader rather than re-testing truthiness by hand.
  for (const file of [
    "scripts/deployment-workflow-guards.ts",
    "scripts/production-demo-bootstrap.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.match(
      source,
      /from "\.\/optional-environment"/,
      `${file} must import the shared normaliser`,
    );
  }
  const guards = readFileSync("scripts/deployment-workflow-guards.ts", "utf8");
  assert.equal(
    /administratorBusinessId\s*!==\s*undefined\s*&&\s*!/.test(guards),
    false,
    "the old `!== undefined` special case must not return",
  );
});
