import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../src/server/repository";

/**
 * The operator CLIs run administrative provisioning: they elevate with
 * `SET LOCAL ROLE ponte_owner` because `businesses` is SELECT-only for the
 * application identity. They therefore take the operator pool, not the
 * application pool the tests use for assertions.
 */
import {
  PUBLIC_DEMO_INVOICES,
  PUBLIC_DEMO_NAMESPACE,
  publicDemoInvoiceData,
  publicDemoInvoiceId,
  publicDemoPaymentId,
  publicDemoQuote,
  publicDemoQuoteId,
  publicDemoSettlementId,
  publicDemoUuid,
} from "../src/server/public-demo-data";
import { resetSyntheticDemo } from "./public-demo-fixture";
import {
  PublicDemoBootstrapError,
  bootstrapPublicDemo,
  parsePublicDemoBootstrapArguments,
  readPublicDemoBootstrapCommand,
  verifyPublicDemoContent,
} from "../scripts/production-demo-bootstrap";
import { fixtures } from "./helpers/fixtures";
import { operatorPool } from "./helpers/operator-pool";

after(async () => {
  await pool.end();
});

beforeEach(resetSyntheticDemo);

const demoError = (reason: string) => (error: unknown) =>
  error instanceof PublicDemoBootstrapError && error.reason === reason;

const productionEnvironment = (
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://runtime@private-postgres.internal/ponte",
  PONTE_AUTH_BUSINESS_ID: "00000000-0000-4000-8000-0000000000aa",
  PONTE_PUBLIC_DEMO_READ_ONLY: "0",
  ...overrides,
});

type DemoBusiness = { businessId: string; businessName: string };

function demoBusiness(): DemoBusiness {
  const businessId = randomUUID();
  return {
    businessId,
    businessName: `Synthetic demo tenant ${businessId}`,
  };
}

const presenceCounts = () =>
  pool.query(
    "SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM memberships) AS memberships,(SELECT count(*) FROM external_identities) AS identities,(SELECT count(*) FROM payment_events) AS events,(SELECT count(*) FROM route_decision_evidence) AS evidence,(SELECT count(*) FROM evidence_outbox) AS outbox",
  );

const demoCounts = () =>
  pool.query(
    "SELECT (SELECT count(*) FROM invoices) AS invoices,(SELECT count(*) FROM quotes) AS quotes,(SELECT count(*) FROM payments) AS payments,(SELECT count(*) FROM settlements) AS settlements",
  );

test("synthetic demo identifiers are stable, unique, and carry no personal input", () => {
  assert.equal(
    publicDemoUuid("invoice:settled-example"),
    publicDemoUuid("invoice:settled-example"),
  );
  assert.equal(
    publicDemoUuid("invoice:settled-example"),
    publicDemoInvoiceId("settled-example"),
  );
  assert.notEqual(
    publicDemoUuid("invoice:settled-example"),
    publicDemoUuid("invoice:funded-example"),
  );
  assert.match(
    publicDemoUuid("invoice:created-example"),
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(PUBLIC_DEMO_NAMESPACE.length, 36);
  const ids = PUBLIC_DEMO_INVOICES.map((spec) =>
    publicDemoInvoiceId(spec.slug),
  );
  assert.equal(new Set(ids).size, ids.length);
  for (const spec of PUBLIC_DEMO_INVOICES) {
    assert.match(spec.reference, /^DEMO-SYN-/);
    assert.match(spec.supplier, /synthetic|sample|example|fictional/i);
    assert.match(spec.description, /synthetic|simulated|no |not a|example/i);
    assert.match(spec.wallet, /^0x(.)\1{39}$/);
  }
});

test("first-time demo provisioning creates only the synthetic tenant and its sample records", async () => {
  const before = await presenceCounts();
  const business = demoBusiness();

  const result = await bootstrapPublicDemo(operatorPool(), business);

  assert.deepEqual(result, {
    created: true,
    verified: true,
    invoices: 6,
    quotes: 2,
    payments: 3,
    settlements: 2,
  });
  const invoices = await pool.query<{ status: string }>(
    "SELECT status FROM invoices WHERE business_id=$1 ORDER BY created_at",
    [business.businessId],
  );
  assert.deepEqual(
    invoices.rows.map((row) => row.status),
    ["Draft", "Pending payment", "Funded", "Routing", "Settled", "Failed"],
  );
  assert.deepEqual(
    (
      await pool.query("SELECT name FROM businesses WHERE id=$1", [
        business.businessId,
      ])
    ).rows,
    [{ name: business.businessName }],
  );

  // No users, memberships, identities, events, evidence, or outbox jobs.
  assert.deepEqual((await presenceCounts()).rows, before.rows);
  assert.equal(
    (
      await pool.query("SELECT 1 FROM memberships WHERE business_id=$1", [
        business.businessId,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM route_decision_evidence WHERE business_id=$1",
        [business.businessId],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM evidence_outbox o JOIN route_decision_evidence e ON e.id=o.evidence_record_id WHERE e.business_id=$1",
        [business.businessId],
      )
    ).rowCount,
    0,
  );
});

test("simulated settlements keep transaction_hash NULL and claim no anchoring", async () => {
  const business = demoBusiness();
  await bootstrapPublicDemo(operatorPool(), business);
  const settlements = await pool.query<{
    status: string;
    transaction_hash: string | null;
    actual_minor: string | null;
  }>(
    "SELECT status,transaction_hash,actual_minor FROM settlements WHERE business_id=$1 ORDER BY status",
    [business.businessId],
  );
  assert.equal(settlements.rowCount, 2);
  for (const row of settlements.rows) {
    assert.equal(row.transaction_hash, null);
    if (row.status === "Routing") assert.equal(row.actual_minor, null);
    if (row.status === "Settled") assert.notEqual(row.actual_minor, null);
  }
  for (const spec of PUBLIC_DEMO_INVOICES) {
    const quote = publicDemoQuote(spec);
    assert.equal(quote.simulated, true);
    assert.equal(quote.rate.numerator, "525");
  }
});

test("repeat demo provisioning is idempotent and verifies instead of overwriting", async () => {
  const business = demoBusiness();
  assert.equal((await bootstrapPublicDemo(operatorPool(), business)).created, true);
  const snapshot = await pool.query(
    "SELECT id,status,data,created_at FROM invoices WHERE business_id=$1 ORDER BY id",
    [business.businessId],
  );

  const repeated = await bootstrapPublicDemo(operatorPool(), business);
  assert.equal(repeated.created, false);
  assert.equal(repeated.verified, true);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT id,status,data,created_at FROM invoices WHERE business_id=$1 ORDER BY id",
        [business.businessId],
      )
    ).rows,
    snapshot.rows,
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM invoices WHERE business_id=$1", [
        business.businessId,
      ])
    ).rowCount,
    6,
  );
});

test("a conflicting sample invoice fails closed and leaves every row untouched", async () => {
  const business = demoBusiness();
  await bootstrapPublicDemo(operatorPool(), business);
  const invoiceId = publicDemoInvoiceId(PUBLIC_DEMO_INVOICES[0].slug);
  // An operator edit (or an identifier collision) must never be overwritten.
  await fixtures(
    "UPDATE invoices SET reference='DEMO-CONFLICT',data=jsonb_set(data,'{reference}',to_jsonb('DEMO-CONFLICT'::text)) WHERE id=$1 AND business_id=$2",
    [invoiceId, business.businessId],
  );
  const before = await demoCounts();

  await assert.rejects(
    bootstrapPublicDemo(operatorPool(), business),
    demoError("CONFLICT"),
  );
  assert.deepEqual((await demoCounts()).rows, before.rows);
  assert.deepEqual(
    (
      await pool.query("SELECT reference FROM invoices WHERE id=$1", [
        invoiceId,
      ])
    ).rows,
    [{ reference: "DEMO-CONFLICT" }],
  );
});

test("a conflicting tenant name is refused rather than renamed", async () => {
  const business = demoBusiness();
  await bootstrapPublicDemo(operatorPool(), business);
  const mismatched = {
    businessId: business.businessId,
    businessName: `${business.businessName} renamed`,
  };
  await assert.rejects(
    bootstrapPublicDemo(operatorPool(), mismatched),
    demoError("CONFLICT"),
  );
  assert.deepEqual(
    (
      await pool.query("SELECT name FROM businesses WHERE id=$1", [
        business.businessId,
      ])
    ).rows,
    [{ name: business.businessName }],
  );
});

test("a missing dependent row is restored without duplicating the tenant", async () => {
  const business = demoBusiness();
  await bootstrapPublicDemo(operatorPool(), business);
  const settled = PUBLIC_DEMO_INVOICES.find(
    (spec) => spec.status === "Settled",
  )!;
  const invoiceId = publicDemoInvoiceId(settled.slug);
  await fixtures(
    "DELETE FROM settlements WHERE business_id=$1 AND invoice_id=$2",
    [business.businessId, invoiceId],
  );
  await fixtures(
    "DELETE FROM quotes WHERE business_id=$1 AND invoice_id=$2",
    [business.businessId, invoiceId],
  );
  const before = await demoCounts();

  const repaired = await bootstrapPublicDemo(operatorPool(), business);
  assert.equal(repaired.created, true);
  const after = await demoCounts();
  assert.equal(Number(after.rows[0].quotes), Number(before.rows[0].quotes) + 1);
  assert.equal(
    Number(after.rows[0].settlements),
    Number(before.rows[0].settlements) + 1,
  );
  assert.equal(Number(after.rows[0].invoices), Number(before.rows[0].invoices));
  assert.equal(
    (
      await pool.query("SELECT 1 FROM businesses WHERE name=$1", [
        business.businessName,
      ])
    ).rowCount,
    1,
  );
});

test("a conflict after earlier inserts rolls back the whole attempt", async () => {
  const business = demoBusiness();
  const conflicting = PUBLIC_DEMO_INVOICES[5];
  const invoiceId = publicDemoInvoiceId(conflicting.slug);
  await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    business.businessId,
    business.businessName,
  ]);
  const data = publicDemoInvoiceData(conflicting);
  await pool.query(
    "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)",
    [
      invoiceId,
      business.businessId,
      "DEMO-CONFLICTING",
      conflicting.fundingMinor,
      conflicting.status,
      JSON.stringify({
        ...data,
        reference: "DEMO-CONFLICTING",
      }),
      conflicting.createdAt,
    ],
  );
  const before = await demoCounts();

  await assert.rejects(
    bootstrapPublicDemo(operatorPool(), business),
    demoError("CONFLICT"),
  );
  assert.deepEqual((await demoCounts()).rows, before.rows);
  assert.equal(
    (
      await pool.query("SELECT 1 FROM payments WHERE business_id=$1", [
        business.businessId,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM quotes WHERE business_id=$1", [
        business.businessId,
      ])
    ).rowCount,
    0,
  );
});

test("the synthetic demo tenant stays separate from a private administrator business", async () => {
  const privateBusiness = {
    id: randomUUID(),
    name: `Private admin business ${randomUUID()}`,
  };
  const demo = demoBusiness();
  await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    privateBusiness.id,
    privateBusiness.name,
  ]);
  await bootstrapPublicDemo(operatorPool(), demo);

  assert.equal(
    (
      await pool.query("SELECT 1 FROM invoices WHERE business_id=$1", [
        privateBusiness.id,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM invoices WHERE business_id=$1", [
        demo.businessId,
      ])
    ).rowCount,
    6,
  );
  const demoInvoiceIds = new Set(
    PUBLIC_DEMO_INVOICES.map((spec) => publicDemoInvoiceId(spec.slug)),
  );
  const privateInvoices = await pool.query<{ id: string }>(
    "SELECT id FROM invoices WHERE business_id=$1",
    [privateBusiness.id],
  );
  assert.ok(privateInvoices.rows.every((row) => !demoInvoiceIds.has(row.id)));
});

test("verification is read-only and reports the exact expected counts", async () => {
  const business = demoBusiness();
  await bootstrapPublicDemo(operatorPool(), business);
  const before = await demoCounts();
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result = await verifyPublicDemoContent(client, business);
    await client.query("COMMIT");
    assert.equal(result.verified, true);
    assert.deepEqual(
      [result.invoices, result.quotes, result.payments, result.settlements],
      [6, 2, 3, 2],
    );
  } finally {
    client.release();
  }
  assert.deepEqual((await demoCounts()).rows, before.rows);
});

test("verification refuses a tenant that has not been provisioned", async () => {
  const business = demoBusiness();
  const client = await pool.connect();
  try {
    await assert.rejects(
      verifyPublicDemoContent(client, business),
      demoError("CONTENT_MISSING"),
    );
  } finally {
    client.release();
  }
});

test("read-only verification of an unprovisioned tenant performs no writes", async () => {
  const business = demoBusiness();
  const before = await demoCounts();
  await assert.rejects(
    bootstrapPublicDemo(operatorPool(), business, { verifyOnly: true }),
    demoError("CONTENT_MISSING"),
  );
  assert.deepEqual((await demoCounts()).rows, before.rows);
  assert.equal(
    (
      await pool.query("SELECT 1 FROM businesses WHERE id=$1", [
        business.businessId,
      ])
    ).rowCount,
    0,
  );
});

test("demo identifiers do not overlap the private bootstrap or local seed rows", () => {
  const demoIds = PUBLIC_DEMO_INVOICES.map((spec) => [
    publicDemoInvoiceId(spec.slug),
    publicDemoQuoteId(spec.slug),
    publicDemoPaymentId(spec.slug),
    publicDemoSettlementId(spec.slug),
  ]).flat();
  assert.equal(new Set(demoIds).size, demoIds.length);
  for (const id of demoIds) {
    assert.ok(!/^00000000-0000-4000-8000-/.test(id));
    assert.notEqual(id, "00000000-0000-4000-8000-000000000001");
  }
});

test("demo provisioning rejects invalid UUIDs and blank names before database work", () => {
  assert.throws(
    () =>
      parsePublicDemoBootstrapArguments([
        "--confirm-production",
        "--business-id",
        "not-a-uuid",
        "--business-name",
        "Valid name",
      ]),
    demoError("INVALID_INPUT"),
  );
  assert.throws(
    () =>
      parsePublicDemoBootstrapArguments([
        "--confirm-production",
        "--business-id",
        randomUUID(),
        "--business-name",
        "   ",
      ]),
    demoError("INVALID_INPUT"),
  );
  assert.throws(
    () =>
      parsePublicDemoBootstrapArguments([
        "--business-id",
        randomUUID(),
        "--business-name",
        "Valid name",
      ]),
    demoError("INVALID_INPUT"),
  );
  for (const args of [
    [
      "--confirm-production",
      "--confirm-production",
      "--business-id",
      randomUUID(),
      "--business-name",
      "Valid name",
    ],
    [
      "--confirm-production",
      "--business-id",
      randomUUID(),
      "--business-name",
      "Valid name",
      "--forced",
    ],
    [
      "--confirm-production",
      "--business-id",
      randomUUID(),
      "--business-name",
      "Valid name",
      "--business-name",
      "Second name",
    ],
  ])
    assert.throws(
      () => parsePublicDemoBootstrapArguments(args),
      demoError("INVALID_INPUT"),
    );
});

test("demo provisioning command refuses development, loopback, local providers, and the private tenant", () => {
  const demoId = randomUUID();
  const args = [
    "--confirm-production",
    "--business-id",
    demoId,
    "--business-name",
    "PONTE synthetic public demo",
  ];

  assert.throws(
    () =>
      readPublicDemoBootstrapCommand(
        args,
        productionEnvironment({ NODE_ENV: "test" }),
      ),
    demoError("NOT_PRODUCTION"),
  );
  assert.throws(
    () =>
      readPublicDemoBootstrapCommand(
        args,
        productionEnvironment({ NODE_ENV: undefined }),
      ),
    demoError("NOT_PRODUCTION"),
  );
  assert.throws(
    () =>
      readPublicDemoBootstrapCommand(
        args,
        productionEnvironment({
          DATABASE_URL: "postgresql://ponte:local-only@localhost:54329/ponte",
        }),
      ),
    demoError("LOCAL_DATABASE"),
  );
  assert.throws(
    () =>
      readPublicDemoBootstrapCommand(
        args,
        productionEnvironment({ DATABASE_URL: undefined }),
      ),
    demoError("LOCAL_DATABASE"),
  );
  for (const localOnly of [
    { PONTE_DEV_AUTH: "1" },
    { PONTE_DEV_TOKEN: "token" },
    { PONTE_DEV_BUSINESS_ID: randomUUID() },
    { PONTE_DEV_USER_ID: randomUUID() },
    { PONTE_LOCAL_EVIDENCE_TEST_PROVIDER: "1" },
    { PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS: `0x${"1".repeat(40)}` },
  ])
    assert.throws(
      () =>
        readPublicDemoBootstrapCommand(args, productionEnvironment(localOnly)),
      demoError("LOCAL_PROVIDER"),
    );
  assert.throws(
    () =>
      readPublicDemoBootstrapCommand(
        [
          "--confirm-production",
          "--business-id",
          "00000000-0000-4000-8000-0000000000aa",
          "--business-name",
          "Demo",
        ],
        productionEnvironment(),
      ),
    demoError("ADMIN_BUSINESS_MISMATCH"),
  );
  assert.throws(
    () =>
      readPublicDemoBootstrapCommand(
        args,
        productionEnvironment({ PONTE_PUBLIC_DEMO_READ_ONLY: "1" }),
      ),
    demoError("DEMO_ALREADY_ENABLED"),
  );
  assert.throws(
    () =>
      readPublicDemoBootstrapCommand(
        args,
        productionEnvironment({ PONTE_PUBLIC_DEMO_READ_ONLY: "2" }),
      ),
    demoError("DEMO_CONFIG_MISMATCH"),
  );
  assert.throws(
    () =>
      readPublicDemoBootstrapCommand(
        args,
        productionEnvironment({ PONTE_PUBLIC_DEMO_BUSINESS_ID: randomUUID() }),
      ),
    demoError("DEMO_CONFIG_MISMATCH"),
  );
  assert.throws(
    () =>
      readPublicDemoBootstrapCommand(
        args,
        productionEnvironment({ PONTE_AUTH_BUSINESS_ID: undefined }),
      ),
    demoError("ADMIN_BUSINESS_UNCONFIGURED"),
  );

  // The documented happy path, plus a matching pre-set demo identifier, is
  // accepted: the flag itself is enabled later, at deploy time.
  const accepted = readPublicDemoBootstrapCommand(
    args,
    productionEnvironment({ PONTE_PUBLIC_DEMO_BUSINESS_ID: demoId }),
  );
  assert.equal(accepted.input.businessId, demoId);
  assert.equal(accepted.verifyOnly, false);

  // Read-only verification is the one path allowed after the flag is enabled:
  // it is how an operator confirms a live demo without further writes.
  assert.equal(
    readPublicDemoBootstrapCommand(
      [...args, "--verify"],
      productionEnvironment({
        PONTE_PUBLIC_DEMO_READ_ONLY: "1",
        PONTE_PUBLIC_DEMO_BUSINESS_ID: demoId,
      }),
    ).verifyOnly,
    true,
  );
});
