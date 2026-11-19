import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  insertPendingEvidenceOutbox,
  insertRouteDecisionEvidence,
  lockValidQuoteForEvidence,
  pool,
  transaction,
} from "../src/server/repository";
import { quote } from "../src/lib/quotes";

function bytes(length: number, value: number) {
  return Buffer.alloc(length, value);
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

  await pool.query("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    businessId,
    "Evidence repository test business",
  ]);
  await pool.query("INSERT INTO users(id,email) VALUES($1,$2)", [
    userId,
    `${userId}@example.invalid`,
  ]);
  await pool.query(
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
  return { businessId, userId, invoiceId, quoteId, quote: invoice.quote };
}

after(async () => {
  await pool.end();
});

test("evidence repository helpers lock a persisted quote and atomically insert synthetic encrypted rows", async () => {
  const context = await createContext();
  const evidenceId = randomUUID();
  const outboxId = randomUUID();
  const publicEvidenceId = testOnlyEvidenceId();

  await transaction(async (db) => {
    const locked = await lockValidQuoteForEvidence(
      db,
      context.businessId,
      context.invoiceId,
      context.quoteId,
    );
    assert.equal(locked.rowCount, 1);
    assert.deepEqual(locked.rows[0], {
      id: context.quoteId,
      source: "simulation-fixed-525",
      simulated: true,
      expires_at: new Date("2027-12-20T00:00:00.123Z"),
      data: context.quote,
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
      kmsKeyReference: "test-kms-reference",
      kmsKeyVersion: "test-kms-version",
      aadVersion: 1,
    });
    await insertPendingEvidenceOutbox(db, {
      id: outboxId,
      evidenceRecordId: evidenceId,
    });

    const stored = await db.query(
      "SELECT e.public_evidence_id,o.submission_state,o.attempt_count FROM route_decision_evidence e JOIN evidence_outbox o ON o.evidence_record_id=e.id WHERE e.id=$1",
      [evidenceId],
    );
    assert.equal(stored.rowCount, 1);
    assert.deepEqual(stored.rows[0].public_evidence_id, publicEvidenceId);
    assert.equal(stored.rows[0].submission_state, "pending");
    assert.equal(stored.rows[0].attempt_count, 0);
  });

  await transaction(async (db) => {
    const crossTenantQuote = await lockValidQuoteForEvidence(
      db,
      context.businessId,
      context.invoiceId,
      randomUUID(),
    );
    assert.equal(crossTenantQuote.rowCount, 0);
  });
});
