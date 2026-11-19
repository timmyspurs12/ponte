import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { quote } from "../src/lib/quotes";

const constraint = (error: unknown) =>
  (error as { code?: string }).code === "23514";
const foreignKey = (error: unknown) =>
  (error as { code?: string }).code === "23503";
const unique = (error: unknown) =>
  (error as { code?: string }).code === "23505";
const notNull = (error: unknown) =>
  (error as { code?: string }).code === "23502";

let marker = 1;
const syntheticBytes = (length: number) => Buffer.alloc(length, marker++);

type Context = {
  businessId: string;
  userId: string;
  invoiceId: string;
  quoteId: string;
};

type Evidence = {
  id: string;
  businessId: string;
  invoiceId: string;
  quoteId: string;
  createdByUserId: string;
  routingCorrelationId: string;
  publicEvidenceId: Buffer;
  evidenceSchemaVersion: number;
  quoteSchemaVersion: number;
  chainId: string;
  registryAddress: Buffer;
  sequence: string;
  evidenceKind: number;
  selectedRouteCode: number;
  quoteSnapshotHash: Buffer;
  previousPayloadHash: Buffer;
  payloadHash: Buffer;
  envelopeVersion: number;
  contentAlgorithm: string;
  ciphertext: Buffer;
  nonce: Buffer;
  authenticationTag: Buffer;
  wrappedDek: Buffer;
  kmsProvider: string;
  wrappedDekAlgorithm: string;
  wrappedDekFormat: string;
  kmsKeyReference: string;
  kmsKeyVersion: string;
  aadVersion: number;
};

const evidenceColumns = [
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

const evidenceSqlFor = (columns: readonly string[]) =>
  `INSERT INTO route_decision_evidence(${columns.join(",")}) VALUES(${columns
    .map((_, index) => `$${index + 1}`)
    .join(",")})`;
const evidenceSql = evidenceSqlFor(evidenceColumns);
const legacyEvidenceColumns = evidenceColumns.filter(
  (column) =>
    !["kms_provider", "wrapped_dek_algorithm", "wrapped_dek_format"].includes(
      column,
    ),
);

function invoiceData(id: string, reference: string) {
  return {
    id,
    reference,
    supplier: "Migration evidence supplier",
    wallet: `0x${"a".repeat(40)}`,
    amount: 25000.01,
    fundingMinor: "2500001",
    fundingCurrency: "BRL",
    settlementCurrency: "USDG",
    due: "2027-12-20",
    description: "Migration evidence fixture",
    status: "Draft",
    created: "2026-11-16",
    quote: quote({ fundingMinor: "2500001" }),
  };
}

async function createContext(
  db: PoolClient,
  label: string,
  expiresAt = "2027-12-20T00:00:00.123Z",
): Promise<Context> {
  const businessId = randomUUID();
  const userId = randomUUID();
  const invoiceId = randomUUID();
  const quoteId = randomUUID();
  const data = invoiceData(invoiceId, `EVIDENCE-${label}-${invoiceId}`);

  await db.query("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    businessId,
    `Evidence business ${label}`,
  ]);
  await db.query("INSERT INTO users(id,email) VALUES($1,$2)", [
    userId,
    `${userId}@example.invalid`,
  ]);
  await db.query(
    "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,'admin','active')",
    [businessId, userId],
  );
  await db.query(
    "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data) VALUES($1,$2,$3,$4,$5,$6)",
    [
      invoiceId,
      businessId,
      data.reference,
      data.fundingMinor,
      data.status,
      JSON.stringify(data),
    ],
  );
  await db.query(
    "INSERT INTO quotes(id,business_id,invoice_id,source,simulated,data,expires_at) VALUES($1,$2,$3,'simulation-fixed-525',true,$4,$5)",
    [quoteId, businessId, invoiceId, JSON.stringify(data.quote), expiresAt],
  );
  return { businessId, userId, invoiceId, quoteId };
}

function evidenceFor(
  context: Context,
  overrides: Partial<Evidence> = {},
): Evidence {
  return {
    id: randomUUID(),
    businessId: context.businessId,
    invoiceId: context.invoiceId,
    quoteId: context.quoteId,
    createdByUserId: context.userId,
    routingCorrelationId: randomUUID(),
    publicEvidenceId: syntheticBytes(32),
    evidenceSchemaVersion: 1,
    quoteSchemaVersion: 1,
    chainId: "421614",
    registryAddress: syntheticBytes(20),
    sequence: "1",
    evidenceKind: 1,
    selectedRouteCode: 1,
    quoteSnapshotHash: syntheticBytes(32),
    previousPayloadHash: Buffer.alloc(32),
    payloadHash: syntheticBytes(32),
    envelopeVersion: 1,
    contentAlgorithm: "AES-256-GCM",
    ciphertext: syntheticBytes(24),
    nonce: syntheticBytes(12),
    authenticationTag: syntheticBytes(16),
    wrappedDek: syntheticBytes(48),
    kmsProvider: "gcp-cloud-kms",
    wrappedDekAlgorithm: "GOOGLE_SYMMETRIC_ENCRYPTION",
    wrappedDekFormat: "gcp-kms-encrypt-ciphertext-v1",
    kmsKeyReference:
      "projects/test/locations/africa-south1/keyRings/test/cryptoKeys/evidence",
    kmsKeyVersion:
      "projects/test/locations/africa-south1/keyRings/test/cryptoKeys/evidence/cryptoKeyVersions/1",
    aadVersion: 1,
    ...overrides,
  };
}

function evidenceValues(evidence: Evidence) {
  return [
    evidence.id,
    evidence.businessId,
    evidence.invoiceId,
    evidence.quoteId,
    evidence.createdByUserId,
    evidence.routingCorrelationId,
    evidence.publicEvidenceId,
    evidence.evidenceSchemaVersion,
    evidence.quoteSchemaVersion,
    evidence.chainId,
    evidence.registryAddress,
    evidence.sequence,
    evidence.evidenceKind,
    evidence.selectedRouteCode,
    evidence.quoteSnapshotHash,
    evidence.previousPayloadHash,
    evidence.payloadHash,
    evidence.envelopeVersion,
    evidence.contentAlgorithm,
    evidence.ciphertext,
    evidence.nonce,
    evidence.authenticationTag,
    evidence.wrappedDek,
    evidence.kmsProvider,
    evidence.wrappedDekAlgorithm,
    evidence.wrappedDekFormat,
    evidence.kmsKeyReference,
    evidence.kmsKeyVersion,
    evidence.aadVersion,
  ];
}

function valuesForColumns(evidence: Evidence, columns: readonly string[]) {
  const values = evidenceValues(evidence);
  return columns.map(
    (column) => values[(evidenceColumns as readonly string[]).indexOf(column)],
  );
}

async function insertEvidence(
  db: PoolClient,
  context: Context,
  overrides: Partial<Evidence> = {},
) {
  const evidence = evidenceFor(context, overrides);
  await db.query(evidenceSql, evidenceValues(evidence));
  return evidence;
}

async function insertLegacyEvidence(
  db: PoolClient,
  context: Context,
  overrides: Partial<Evidence> = {},
) {
  const evidence = evidenceFor(context, overrides);
  await db.query(
    evidenceSqlFor(legacyEvidenceColumns),
    valuesForColumns(evidence, legacyEvidenceColumns),
  );
  return evidence;
}

async function insertEvidenceWithoutColumn(
  db: PoolClient,
  context: Context,
  column: string,
) {
  const evidence = evidenceFor(context);
  const columns = evidenceColumns.filter((candidate) => candidate !== column);
  await db.query(evidenceSqlFor(columns), valuesForColumns(evidence, columns));
}

async function assertInvalidEvidence(
  db: PoolClient,
  label: string,
  overrides: Partial<Evidence>,
) {
  const context = await createContext(db, label);
  await assert.rejects(insertEvidence(db, context, overrides), constraint);
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();
  const schema = `migration_test_${randomUUID().replaceAll("-", "")}`;
  const precisionSchema = `${schema}_precision`;
  const migration = (name: string) =>
    readFile(`migrations/${name}.sql`, "utf8");
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query(await migration("001_foundation"));

    const legacy = await createContext(db, "legacy");
    const legacyQuote = quote({ fundingMinor: "2500001" });
    const paymentId = randomUUID();
    const settlementId = randomUUID();
    await db.query(
      "INSERT INTO payments(id,business_id,invoice_id,provider,provider_reference,funding_minor,received_at) VALUES($1,$2,$3,'simulation',$4,$5,now())",
      [
        paymentId,
        legacy.businessId,
        legacy.invoiceId,
        `SIM-${paymentId}`,
        "2500001",
      ],
    );
    await db.query(
      "INSERT INTO settlements(id,business_id,invoice_id,quote_id,route_id,expected_minor,minimum_minor,status) VALUES($1,$2,$3,$4,'direct',$5,$6,'Routing')",
      [
        settlementId,
        legacy.businessId,
        legacy.invoiceId,
        legacy.quoteId,
        legacyQuote.routes[0].outputMinor,
        legacyQuote.routes[0].minimumOutputMinor,
      ],
    );
    await db.query(
      "INSERT INTO payment_events(id,business_id,invoice_id,actor_id,correlation_id,kind,data) VALUES($1,$2,$3,$4,$5,'invoice.created',$6)",
      [
        randomUUID(),
        legacy.businessId,
        legacy.invoiceId,
        legacy.userId,
        randomUUID(),
        JSON.stringify({ status: "Draft", simulated: true }),
      ],
    );

    await db.query("BEGIN");
    await db.query(await migration("002_audit_metadata"));
    await db.query("COMMIT");
    await db.query("BEGIN");
    await db.query(await migration("003_route_decision_evidence"));
    await db.query("COMMIT");
    await db.query("BEGIN");
    await db.query(await migration("004_kms_envelope_metadata"));
    await db.query("COMMIT");

    const preservedInvoice = (
      await db.query(
        "SELECT data,supplier_name,funding_currency,created_at,updated_at FROM invoices WHERE id=$1",
        [legacy.invoiceId],
      )
    ).rows[0];
    assert.deepEqual(
      preservedInvoice.data,
      invoiceData(legacy.invoiceId, preservedInvoice.data.reference),
    );
    assert.equal(preservedInvoice.supplier_name, "Migration evidence supplier");
    assert.equal(preservedInvoice.funding_currency, "BRL");
    assert.ok(preservedInvoice.created_at);
    assert.ok(preservedInvoice.updated_at);
    assert.equal(
      (await db.query("SELECT id FROM payments WHERE id=$1", [paymentId]))
        .rowCount,
      1,
    );
    assert.equal(
      (await db.query("SELECT id FROM quotes WHERE id=$1", [legacy.quoteId]))
        .rowCount,
      1,
    );
    assert.equal(
      (await db.query("SELECT id FROM settlements WHERE id=$1", [settlementId]))
        .rowCount,
      1,
    );
    assert.equal(
      (
        await db.query("SELECT id FROM payment_events WHERE invoice_id=$1", [
          legacy.invoiceId,
        ])
      ).rowCount,
      1,
    );

    const validContext = await createContext(db, "valid-millisecond");
    const validEvidence = await insertEvidence(db, validContext);
    await db.query(
      "INSERT INTO evidence_outbox(id,evidence_record_id,submission_state) VALUES($1,$2,'pending')",
      [randomUUID(), validEvidence.id],
    );
    assert.equal(
      (
        await db.query(
          "SELECT submission_state,attempt_count FROM evidence_outbox WHERE evidence_record_id=$1",
          [validEvidence.id],
        )
      ).rows[0].submission_state,
      "pending",
    );
    assert.equal(
      (
        await db.query(
          "SELECT attempt_count FROM evidence_outbox WHERE evidence_record_id=$1",
          [validEvidence.id],
        )
      ).rows[0].attempt_count,
      0,
    );

    await assert.rejects(
      db.query(
        "INSERT INTO evidence_outbox(id,evidence_record_id,submission_state) VALUES($1,$2,'pending')",
        [randomUUID(), validEvidence.id],
      ),
      unique,
    );
    const invalidStateEvidence = await insertEvidence(
      db,
      await createContext(db, "invalid-outbox-state"),
    );
    await assert.rejects(
      db.query(
        "INSERT INTO evidence_outbox(id,evidence_record_id,submission_state) VALUES($1,$2,'invalid')",
        [randomUUID(), invalidStateEvidence.id],
      ),
      constraint,
    );
    const invalidAttemptEvidence = await insertEvidence(
      db,
      await createContext(db, "invalid-outbox-attempt"),
    );
    await assert.rejects(
      db.query(
        "INSERT INTO evidence_outbox(id,evidence_record_id,submission_state,attempt_count) VALUES($1,$2,'pending',-1)",
        [randomUUID(), invalidAttemptEvidence.id],
      ),
      constraint,
    );

    await assert.rejects(
      db.query("UPDATE route_decision_evidence SET chain_id=1 WHERE id=$1", [
        validEvidence.id,
      ]),
      /Route-decision evidence is immutable/,
    );
    await assert.rejects(
      db.query("DELETE FROM route_decision_evidence WHERE id=$1", [
        validEvidence.id,
      ]),
      /Route-decision evidence is immutable/,
    );
    await assert.rejects(insertEvidence(db, validContext), unique);

    const duplicateEvidenceIdContext = await createContext(
      db,
      "duplicate-evidence-id",
    );
    await assert.rejects(
      insertEvidence(db, duplicateEvidenceIdContext, {
        publicEvidenceId: validEvidence.publicEvidenceId,
      }),
      unique,
    );

    const otherBusiness = await createContext(db, "cross-business");
    const crossBusiness = await createContext(db, "cross-business-target");
    await assert.rejects(
      insertEvidence(db, otherBusiness, { quoteId: crossBusiness.quoteId }),
      foreignKey,
    );

    await assertInvalidEvidence(db, "short-evidence-id", {
      publicEvidenceId: syntheticBytes(31),
    });
    await assertInvalidEvidence(db, "zero-evidence-id", {
      publicEvidenceId: Buffer.alloc(32),
    });
    await assertInvalidEvidence(db, "short-registry", {
      registryAddress: syntheticBytes(19),
    });
    await assertInvalidEvidence(db, "zero-registry", {
      registryAddress: Buffer.alloc(20),
    });
    await assertInvalidEvidence(db, "short-quote-hash", {
      quoteSnapshotHash: syntheticBytes(31),
    });
    await assertInvalidEvidence(db, "short-nonce", {
      nonce: syntheticBytes(11),
    });
    await assertInvalidEvidence(db, "short-tag", {
      authenticationTag: syntheticBytes(15),
    });
    await assertInvalidEvidence(db, "invalid-evidence-version", {
      evidenceSchemaVersion: 2,
    });
    await assertInvalidEvidence(db, "invalid-quote-version", {
      quoteSchemaVersion: 2,
    });
    await assertInvalidEvidence(db, "invalid-envelope-version", {
      envelopeVersion: 2,
    });
    await assertInvalidEvidence(db, "invalid-aad-version", { aadVersion: 2 });
    await assertInvalidEvidence(db, "invalid-chain", { chainId: "1" });
    await assertInvalidEvidence(db, "invalid-sequence", { sequence: "2" });
    await assertInvalidEvidence(db, "invalid-kind", { evidenceKind: 2 });
    await assertInvalidEvidence(db, "invalid-route-code", {
      selectedRouteCode: 4,
    });
    await assertInvalidEvidence(db, "non-genesis-predecessor", {
      previousPayloadHash: syntheticBytes(32),
    });
    await assertInvalidEvidence(db, "zero-payload", {
      payloadHash: Buffer.alloc(32),
    });
    await assertInvalidEvidence(db, "unknown-kms-provider", {
      kmsProvider: "unknown-kms",
    });
    await assertInvalidEvidence(db, "invalid-provider-algorithm", {
      kmsProvider: "gcp-cloud-kms",
      wrappedDekAlgorithm: "AWS_KMS_GENERATE_DATA_KEY_AES_256",
      wrappedDekFormat: "aws-kms-generate-data-key-ciphertext-blob-v1",
    });
    await assertInvalidEvidence(db, "invalid-provider-format", {
      kmsProvider: "aws-kms",
      wrappedDekAlgorithm: "AWS_KMS_GENERATE_DATA_KEY_AES_256",
      wrappedDekFormat: "gcp-kms-encrypt-ciphertext-v1",
    });
    await assertInvalidEvidence(db, "malformed-key-reference", {
      kmsKeyReference: "invalid key reference",
    });
    await assertInvalidEvidence(db, "malformed-key-version", {
      kmsKeyVersion: "invalid key version",
    });

    for (const requiredColumn of [
      "kms_provider",
      "wrapped_dek_algorithm",
      "wrapped_dek_format",
    ]) {
      await assert.rejects(
        insertEvidenceWithoutColumn(
          db,
          await createContext(db, `missing-${requiredColumn}`),
          requiredColumn,
        ),
        notNull,
      );
    }

    await assert.rejects(
      createContext(db, "sub-millisecond", "2027-12-20T00:00:00.123456Z"),
      constraint,
    );

    await db.query(`CREATE SCHEMA ${precisionSchema}`);
    try {
      await db.query(`SET search_path TO ${precisionSchema}`);
      await db.query(await migration("001_foundation"));
      await db.query(await migration("002_audit_metadata"));
      await createContext(
        db,
        "legacy-sub-millisecond",
        "2027-12-20T00:00:00.123456Z",
      );
      await assert.rejects(
        db.query(await migration("003_route_decision_evidence")),
        /sub-millisecond data/,
      );
    } finally {
      await db.query(`SET search_path TO ${schema}`);
      await db.query(`DROP SCHEMA ${precisionSchema} CASCADE`);
    }

    const metadataAbortSchema = `${schema}_metadata_abort`;
    await db.query(`CREATE SCHEMA ${metadataAbortSchema}`);
    try {
      await db.query(`SET search_path TO ${metadataAbortSchema}`);
      await db.query(await migration("001_foundation"));
      await db.query(await migration("002_audit_metadata"));
      await db.query(await migration("003_route_decision_evidence"));
      const existingEvidenceContext = await createContext(
        db,
        "metadata-abort-existing-evidence",
      );
      await insertLegacyEvidence(db, existingEvidenceContext);
      await assert.rejects(
        db.query(await migration("004_kms_envelope_metadata")),
        /cannot add required KMS envelope metadata while route_decision_evidence contains rows/,
      );
    } finally {
      await db.query(`SET search_path TO ${schema}`);
      await db.query(`DROP SCHEMA ${metadataAbortSchema} CASCADE`);
    }

    const fresh = `${schema}_fresh`;
    await db.query(`CREATE SCHEMA ${fresh}`);
    try {
      const env = { ...process.env, PGOPTIONS: `-c search_path=${fresh}` };
      for (let run = 0; run < 2; run++)
        execFileSync(
          process.execPath,
          ["--import", "tsx", "scripts/database.ts", "--seed"],
          { env, stdio: "pipe" },
        );
      const applied = await db.query(
        `SELECT name FROM ${fresh}.schema_migrations ORDER BY name`,
      );
      assert.deepEqual(
        applied.rows.map((row) => row.name),
        [
          "001_foundation",
          "002_audit_metadata",
          "003_route_decision_evidence",
          "004_kms_envelope_metadata",
        ],
      );
    } finally {
      await db.query(`DROP SCHEMA ${fresh} CASCADE`);
    }

    console.log(
      "Migration integration passed: legacy records preserved; evidence, outbox, and quote precision constraints verified.",
    );
  } finally {
    await db.query("ROLLBACK");
    await db.query("SET search_path TO public");
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    db.release();
    await pool.end();
  }
}
void main();
