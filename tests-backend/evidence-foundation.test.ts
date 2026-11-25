import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  insertPendingEvidenceOutbox,
  insertRouteDecisionEvidence,
  lockInvoiceForEvidence,
  lockValidQuoteForEvidence,
  pool,
  readEvidencePreparationSnapshot,
  transaction,
} from "../src/server/repository";
import { quote } from "../src/lib/quotes";
import {
  KMS_PROVIDER,
  WRAPPED_DEK_ALGORITHM,
  WRAPPED_DEK_FORMAT,
} from "../src/server/evidence/kms";
import { fixtures, fixturesRead } from "./helpers/fixtures";

function bytes(length: number, value: number) {
  return Buffer.alloc(length, value);
}

/** SQLSTATE of a direct database denial; keeps assertions off message text. */
function sqlstateOf(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

function testOnlyEvidenceId() {
  return Buffer.from(
    `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`,
    "hex",
  );
}

async function createContext() {
  const businessId = randomUUID();
  const userId = randomUUID();
  const invoiceId = randomUUID();
  const quoteId = randomUUID();
  const invoice = {
    id: invoiceId,
    reference: `EVIDENCE-${invoiceId}`,
    supplier: "Evidence repository test supplier",
    wallet: `0x${"b".repeat(40)}`,
    amount: 25000.01,
    fundingMinor: "2500001",
    fundingCurrency: "BRL",
    settlementCurrency: "USDG",
    due: "2027-12-20",
    description: "Synthetic repository test only",
    status: "Funded",
    created: "2026-11-16",
    quote: quote({ fundingMinor: "2500001" }),
  };

  await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    businessId,
    "Evidence repository test business",
  ]);
  await fixtures("INSERT INTO users(id,email) VALUES($1,$2)", [
    userId,
    `${userId}@example.invalid`,
  ]);
  await fixtures(
    "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,'admin','active')",
    [businessId, userId],
  );
  await pool.query(
    "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data) VALUES($1,$2,$3,$4,$5,$6)",
    [
      invoiceId,
      businessId,
      invoice.reference,
      invoice.fundingMinor,
      invoice.status,
      JSON.stringify(invoice),
    ],
  );
  await pool.query(
    "INSERT INTO quotes(id,business_id,invoice_id,source,simulated,data,expires_at) VALUES($1,$2,$3,'simulation-fixed-525',true,$4,$5)",
    [
      quoteId,
      businessId,
      invoiceId,
      JSON.stringify(invoice.quote),
      "2027-12-20T00:00:00.123Z",
    ],
  );
  return {
    businessId,
    userId,
    invoiceId,
    quoteId,
    invoice,
    quote: invoice.quote,
  };
}

async function createSiblingInvoiceAndQuote(
  context: Awaited<ReturnType<typeof createContext>>,
) {
  const invoiceId = randomUUID();
  const quoteId = randomUUID();
  const invoice = {
    ...context.invoice,
    id: invoiceId,
    reference: `EVIDENCE-SIBLING-${invoiceId}`,
  };
  await pool.query(
    "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data) VALUES($1,$2,$3,$4,$5,$6)",
    [
      invoiceId,
      context.businessId,
      invoice.reference,
      invoice.fundingMinor,
      invoice.status,
      JSON.stringify(invoice),
    ],
  );
  await pool.query(
    "INSERT INTO quotes(id,business_id,invoice_id,source,simulated,data,expires_at) VALUES($1,$2,$3,'simulation-fixed-525',true,$4,$5)",
    [
      quoteId,
      context.businessId,
      invoiceId,
      JSON.stringify(invoice.quote),
      "2027-12-20T00:00:00.123Z",
    ],
  );
  return { invoiceId, quoteId };
}

async function evidenceTableCounts(businessId: string) {
  return (
    await pool.query(
      "SELECT (SELECT count(*) FROM invoices WHERE business_id=$1)::text AS invoices,(SELECT count(*) FROM quotes WHERE business_id=$1)::text AS quotes,(SELECT count(*) FROM route_decision_evidence WHERE business_id=$1)::text AS evidence,(SELECT count(*) FROM evidence_outbox o JOIN route_decision_evidence e ON e.id=o.evidence_record_id WHERE e.business_id=$1)::text AS outbox,(SELECT count(*) FROM settlements WHERE business_id=$1)::text AS settlements,(SELECT count(*) FROM payment_events WHERE business_id=$1)::text AS events,(SELECT count(*) FROM idempotency WHERE business_id=$1)::text AS idempotency",
      [businessId],
    )
  ).rows[0];
}

after(async () => {
  await pool.end();
});

test("evidence repository helpers lock persisted invoice/quote identity and atomically insert synthetic encrypted rows", async () => {
  const context = await createContext();
  const evidenceId = randomUUID();
  const outboxId = randomUUID();
  const publicEvidenceId = testOnlyEvidenceId();

  // R1 (Phase 2C.2B): the application identity holds SELECT+INSERT on `quotes`
  // and no UPDATE, and PostgreSQL requires UPDATE on a table for *every* row-lock
  // mode. `lockValidQuoteForEvidence` therefore fails closed with 42501. Evidence
  // persistence is dormant scaffolding in this phase; Routing stays unavailable
  // under the application identity until a separately reviewed lock-only design
  // exists. See docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.
  await assert.rejects(
    transaction(async (db) => {
      await lockValidQuoteForEvidence(
        db,
        context.businessId,
        context.invoiceId,
        context.quoteId,
      );
    }),
    (error) => sqlstateOf(error) === "42501",
  );

  // The quote lock is the first statement in the transaction, so the denial
  // leaves no partial write behind: nothing from that attempt can be visible.
  const afterDenial = await pool.query(
    "SELECT count(*)::int AS n FROM route_decision_evidence WHERE id=$1",
    [evidenceId],
  );
  assert.equal(afterDenial.rows[0].n, 0);

  // What remains reachable for the application is the invoice lock (invoices has
  // a scoped UPDATE grant), and the two writes it is allowed to make: the full
  // 29-column evidence envelope and the pending-only outbox row.
  await transaction(async (db) => {
    const lockedInvoice = await lockInvoiceForEvidence(
      db,
      context.businessId,
      context.invoiceId,
    );
    assert.equal(lockedInvoice.rowCount, 1);
    assert.deepEqual(lockedInvoice.rows[0], {
      id: context.invoiceId,
      business_id: context.businessId,
      status: "Funded",
      funding_minor: "2500001",
      funding_currency: "BRL",
      data: context.invoice,
    });

    await insertRouteDecisionEvidence(db, {
      id: evidenceId,
      businessId: context.businessId,
      invoiceId: context.invoiceId,
      quoteId: context.quoteId,
      createdByUserId: context.userId,
      routingCorrelationId: randomUUID(),
      publicEvidenceId,
      evidenceSchemaVersion: 1,
      quoteSchemaVersion: 1,
      chainId: "421614",
      registryAddress: bytes(20, 2),
      sequence: "1",
      evidenceKind: 1,
      selectedRouteCode: 2,
      quoteSnapshotHash: bytes(32, 3),
      previousPayloadHash: Buffer.alloc(32),
      payloadHash: bytes(32, 4),
      envelopeVersion: 1,
      contentAlgorithm: "AES-256-GCM",
      ciphertext: bytes(24, 5),
      nonce: bytes(12, 6),
      authenticationTag: bytes(16, 7),
      wrappedDek: bytes(48, 8),
      kmsProvider: KMS_PROVIDER.LOCAL_TEST_ONLY,
      wrappedDekAlgorithm: WRAPPED_DEK_ALGORITHM.LOCAL_TEST_RANDOM_BYTES_V1,
      wrappedDekFormat: WRAPPED_DEK_FORMAT.LOCAL_TEST_RANDOM_BYTES_V1,
      kmsKeyReference: "local-test-only/repository/evidence",
      kmsKeyVersion: "local-test-only/repository/v1",
      aadVersion: 1,
    });
    await insertPendingEvidenceOutbox(db, {
      id: outboxId,
      evidenceRecordId: evidenceId,
    });
  });

  // The application may read back only its public commitment projection: the
  // sensitive envelope/KMS columns have no SELECT grant. `wrapped_dek` is read
  // here through the administrative helper, which is the documented division.
  const stored = await pool.query(
    "SELECT e.public_evidence_id,e.kms_provider,o.submission_state FROM route_decision_evidence e JOIN evidence_outbox o ON o.evidence_record_id=e.id WHERE e.id=$1",
    [evidenceId],
  );
  assert.equal(stored.rowCount, 1);
  assert.deepEqual(stored.rows[0].public_evidence_id, publicEvidenceId);
  assert.equal(stored.rows[0].kms_provider, KMS_PROVIDER.LOCAL_TEST_ONLY);
  assert.equal(stored.rows[0].submission_state, "pending");

  // `attempt_count` and the envelope columns are outside the application's
  // SELECT projection, so the read that needs them runs on the admin helper.
  const privateRow = await fixturesRead(
    "SELECT wrapped_dek, wrapped_dek_algorithm, wrapped_dek_format, kms_key_reference, kms_key_version, attempt_count FROM route_decision_evidence e JOIN evidence_outbox o ON o.evidence_record_id=e.id WHERE e.id=$1",
    [evidenceId],
  );

  assert.equal(privateRow.rowCount, 1);
  assert.equal(privateRow.rows[0].attempt_count, 0);
  assert.deepEqual(privateRow.rows[0].wrapped_dek, bytes(48, 8));
  assert.equal(
    privateRow.rows[0].wrapped_dek_algorithm,
    WRAPPED_DEK_ALGORITHM.LOCAL_TEST_RANDOM_BYTES_V1,
  );
  assert.equal(
    privateRow.rows[0].wrapped_dek_format,
    WRAPPED_DEK_FORMAT.LOCAL_TEST_RANDOM_BYTES_V1,
  );
  assert.equal(
    privateRow.rows[0].kms_key_reference,
    "local-test-only/repository/evidence",
  );
  assert.equal(
    privateRow.rows[0].kms_key_version,
    "local-test-only/repository/v1",
  );

  // A quote lock naming a quote that does not belong to the tenant fails closed
  // for the same privilege reason before it could ever report zero rows.
  await assert.rejects(
    transaction(async (db) => {
      await lockValidQuoteForEvidence(
        db,
        context.businessId,
        context.invoiceId,
        randomUUID(),
      );
    }),
    (error) => sqlstateOf(error) === "42501",
  );
});

test("evidence preparation snapshot returns the exact persisted invoice and valid quote", async () => {
  const context = await createContext();
  const snapshot = await readEvidencePreparationSnapshot(
    context.businessId,
    context.invoiceId,
    context.quoteId,
  );

  if (snapshot.kind !== "ready")
    assert.fail(`unexpected snapshot: ${snapshot.kind}`);
  assert.deepEqual(snapshot.invoice, {
    id: context.invoiceId,
    business_id: context.businessId,
    status: "Funded",
    funding_minor: "2500001",
    funding_currency: "BRL",
    data: context.invoice,
  });
  assert.deepEqual(snapshot.quote, {
    id: context.quoteId,
    business_id: context.businessId,
    invoice_id: context.invoiceId,
    source: "simulation-fixed-525",
    simulated: true,
    expires_at: new Date("2027-12-20T00:00:00.123Z"),
    data: context.quote,
  });
  assert.equal(
    snapshot.quote.expires_at.toISOString(),
    "2027-12-20T00:00:00.123Z",
  );
});

test("evidence preparation snapshots scope invoice/quote identities and report missing records", async () => {
  const context = await createContext();
  const sibling = await createSiblingInvoiceAndQuote(context);
  const otherTenant = await createContext();
  const crossTenant = await readEvidencePreparationSnapshot(
    otherTenant.businessId,
    context.invoiceId,
    context.quoteId,
  );
  assert.deepEqual(crossTenant, { kind: "invoice_missing" });

  const missingInvoice = await readEvidencePreparationSnapshot(
    context.businessId,
    randomUUID(),
    context.quoteId,
  );
  assert.deepEqual(missingInvoice, { kind: "invoice_missing" });

  const missingQuote = await readEvidencePreparationSnapshot(
    context.businessId,
    context.invoiceId,
    randomUUID(),
  );
  assert.equal(missingQuote.kind, "quote_missing_or_expired");
  if (missingQuote.kind === "quote_missing_or_expired")
    assert.equal(missingQuote.invoice.id, context.invoiceId);

  const crossInvoice = await readEvidencePreparationSnapshot(
    context.businessId,
    context.invoiceId,
    sibling.quoteId,
  );
  assert.equal(crossInvoice.kind, "quote_missing_or_expired");
  if (crossInvoice.kind === "quote_missing_or_expired") {
    assert.equal(crossInvoice.invoice.id, context.invoiceId);
    assert.notEqual(crossInvoice.invoice.id, sibling.invoiceId);
  }
});

test("evidence preparation snapshot treats an expired quote as missing or expired", async () => {
  const context = await createContext();
  await fixtures(
    "UPDATE quotes SET expires_at=date_trunc('milliseconds',clock_timestamp())-interval '1 millisecond' WHERE id=$1",
    [context.quoteId],
  );

  const snapshot = await readEvidencePreparationSnapshot(
    context.businessId,
    context.invoiceId,
    context.quoteId,
  );
  assert.equal(snapshot.kind, "quote_missing_or_expired");
  if (snapshot.kind === "quote_missing_or_expired")
    assert.equal(snapshot.invoice.id, context.invoiceId);
});

test("evidence preparation snapshot keeps relational funding authoritative and generated BRL projection fixed", async () => {
  const context = await createContext();
  const before = await readEvidencePreparationSnapshot(
    context.businessId,
    context.invoiceId,
    context.quoteId,
  );
  if (before.kind !== "ready")
    assert.fail(`unexpected snapshot: ${before.kind}`);
  assert.equal(before.invoice.funding_minor, "2500001");
  assert.equal(before.invoice.funding_currency, "BRL");
  assert.equal(before.invoice.data.fundingMinor, "2500001");
  assert.equal(before.invoice.data.fundingCurrency, "BRL");

  await assert.rejects(
    fixtures("UPDATE invoices SET funding_currency='USD' WHERE id=$1", [
      context.invoiceId,
    ]),
    (error) => (error as { code?: string }).code === "428C9",
  );
  await assert.rejects(
    fixtures(
      "UPDATE invoices SET data=jsonb_set(data,'{fundingMinor}',to_jsonb('2500002'::text)) WHERE id=$1",
      [context.invoiceId],
    ),
    (error) => (error as { code?: string }).code === "23514",
  );
  await assert.rejects(
    fixtures(
      "UPDATE invoices SET data=jsonb_set(data,'{fundingCurrency}',to_jsonb('USD'::text)) WHERE id=$1",
      [context.invoiceId],
    ),
    (error) => (error as { code?: string }).code === "23514",
  );

  const after = await readEvidencePreparationSnapshot(
    context.businessId,
    context.invoiceId,
    context.quoteId,
  );
  if (after.kind !== "ready") assert.fail(`unexpected snapshot: ${after.kind}`);
  assert.equal(after.invoice.funding_minor, "2500001");
  assert.equal(after.invoice.funding_currency, "BRL");
  assert.equal(after.invoice.data.fundingMinor, "2500001");
  assert.equal(after.invoice.data.fundingCurrency, "BRL");
});

test("evidence preparation snapshot does not mutate persisted lifecycle or evidence tables", async () => {
  const context = await createContext();
  const beforeCounts = await evidenceTableCounts(context.businessId);
  const beforeRows = await pool.query(
    "SELECT i.status,i.funding_minor,i.funding_currency,i.data AS invoice_data,q.source,q.simulated,q.expires_at,q.data AS quote_data FROM invoices i JOIN quotes q ON q.business_id=i.business_id AND q.invoice_id=i.id WHERE i.id=$1 AND q.id=$2",
    [context.invoiceId, context.quoteId],
  );

  const snapshot = await readEvidencePreparationSnapshot(
    context.businessId,
    context.invoiceId,
    context.quoteId,
  );
  assert.equal(snapshot.kind, "ready");

  const afterCounts = await evidenceTableCounts(context.businessId);
  const afterRows = await pool.query(
    "SELECT i.status,i.funding_minor,i.funding_currency,i.data AS invoice_data,q.source,q.simulated,q.expires_at,q.data AS quote_data FROM invoices i JOIN quotes q ON q.business_id=i.business_id AND q.invoice_id=i.id WHERE i.id=$1 AND q.id=$2",
    [context.invoiceId, context.quoteId],
  );
  assert.deepEqual(afterCounts, beforeCounts);
  assert.deepEqual(afterRows.rows, beforeRows.rows);
});

test(
  "evidence preparation snapshot does not wait for a competing invoice row lock",
  { timeout: 5000 },
  async () => {
    const context = await createContext();
    const locker = await pool.connect();
    let transactionOpen = false;
    try {
      await locker.query("BEGIN");
      transactionOpen = true;
      await locker.query(
        "SELECT id FROM invoices WHERE business_id=$1 AND id=$2 FOR UPDATE",
        [context.businessId, context.invoiceId],
      );

      // The competing transaction remains open while this non-locking read returns.
      const snapshot = await readEvidencePreparationSnapshot(
        context.businessId,
        context.invoiceId,
        context.quoteId,
      );
      assert.equal(snapshot.kind, "ready");
      assert.equal(transactionOpen, true);
    } finally {
      if (transactionOpen) await locker.query("ROLLBACK");
      locker.release();
    }
  },
);
