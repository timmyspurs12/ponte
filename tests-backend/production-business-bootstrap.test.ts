import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../src/server/repository";
import { operatorPool } from "./helpers/operator-pool";

/**
 * The operator CLIs run administrative provisioning: they elevate with
 * `SET LOCAL ROLE ponte_owner` because `businesses` is SELECT-only for the
 * application identity. They therefore take the operator pool, not the
 * application pool the tests use for assertions.
 */
import {
  ProductionBusinessBootstrapError,
  bootstrapProductionBusiness,
  parseProductionBusinessBootstrapInput,
  readProductionBusinessBootstrapCommand,
} from "../scripts/production-business-bootstrap";

after(async () => {
  await pool.end();
});

const bootstrapError = (code: string) => (error: unknown) =>
  error instanceof ProductionBusinessBootstrapError && error.code === code;

const productionEnvironment = (
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://runtime@private-postgres.internal/ponte",
  ...overrides,
});

test("production business bootstrap creates exactly one private business record", async () => {
  const before = await pool.query(
    "SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM memberships) AS memberships,(SELECT count(*) FROM external_identities) AS external_identities,(SELECT count(*) FROM invoices) AS invoices,(SELECT count(*) FROM route_decision_evidence) AS evidence",
  );
  const businessId = randomUUID();
  const result = await bootstrapProductionBusiness(operatorPool(), {
    businessId,
    businessName: "Bootstrap-only private business",
  });

  assert.deepEqual(result, { created: true });
  assert.deepEqual(
    (
      await pool.query("SELECT id,name FROM businesses WHERE id=$1", [
        businessId,
      ])
    ).rows,
    [{ id: businessId, name: "Bootstrap-only private business" }],
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM memberships WHERE business_id=$1", [
        businessId,
      ])
    ).rowCount,
    0,
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM memberships) AS memberships,(SELECT count(*) FROM external_identities) AS external_identities,(SELECT count(*) FROM invoices) AS invoices,(SELECT count(*) FROM route_decision_evidence) AS evidence",
      )
    ).rows,
    before.rows,
  );
});

test("production business bootstrap is idempotent for matching normalized details", async () => {
  const businessId = randomUUID();
  const input = {
    businessId,
    businessName: "Repeatable private business",
  };

  assert.deepEqual(await bootstrapProductionBusiness(operatorPool(), input), {
    created: true,
  });
  assert.deepEqual(await bootstrapProductionBusiness(operatorPool(), input), {
    created: false,
  });
  assert.deepEqual(
    (
      await pool.query("SELECT id,name FROM businesses WHERE id=$1", [
        businessId,
      ])
    ).rows,
    [
      {
        id: businessId,
        name: "Repeatable private business",
      },
    ],
  );
});

test("production business bootstrap rejects a reused UUID with conflicting details", async () => {
  const businessId = randomUUID();
  await bootstrapProductionBusiness(operatorPool(), {
    businessId,
    businessName: "Original private business",
  });

  await assert.rejects(
    bootstrapProductionBusiness(operatorPool(), {
      businessId,
      businessName: "Conflicting private business",
    }),
    bootstrapError("CONFLICT"),
  );
  assert.deepEqual(
    (await pool.query("SELECT name FROM businesses WHERE id=$1", [businessId]))
      .rows,
    [{ name: "Original private business" }],
  );
});

test("production business bootstrap rejects invalid UUIDs and blank names before database work", () => {
  assert.throws(
    () =>
      parseProductionBusinessBootstrapInput({
        businessId: "not-a-uuid",
        businessName: "Valid name",
      }),
    bootstrapError("INVALID_INPUT"),
  );
  assert.throws(
    () =>
      parseProductionBusinessBootstrapInput({
        businessId: randomUUID(),
        businessName: "   ",
      }),
    bootstrapError("INVALID_INPUT"),
  );
});

test("bootstrap command refuses development, local databases, local providers, and missing confirmation", () => {
  const args = [
    "--confirm-production",
    "--business-id",
    randomUUID(),
    "--business-name",
    "Protected private business",
  ];

  assert.throws(
    () =>
      readProductionBusinessBootstrapCommand(
        args,
        productionEnvironment({ NODE_ENV: "test" }),
      ),
    bootstrapError("REFUSED"),
  );
  assert.throws(
    () =>
      readProductionBusinessBootstrapCommand(
        args,
        productionEnvironment({
          DATABASE_URL: "postgresql://ponte:local-only@localhost:54329/ponte",
        }),
      ),
    bootstrapError("REFUSED"),
  );
  assert.throws(
    () =>
      readProductionBusinessBootstrapCommand(
        args,
        productionEnvironment({ PONTE_DEV_AUTH: "1" }),
      ),
    bootstrapError("REFUSED"),
  );
  assert.throws(
    () =>
      readProductionBusinessBootstrapCommand(
        args.filter((argument) => argument !== "--confirm-production"),
        productionEnvironment(),
      ),
    bootstrapError("INVALID_INPUT"),
  );
});
