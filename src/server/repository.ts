import { Pool, type PoolClient } from "pg";
import type { PaymentQuote } from "../lib/models";

export interface LockedEvidenceQuoteRow {
  id: string;
  source: string;
  simulated: boolean;
  expires_at: Date;
  data: PaymentQuote;
}

export interface RouteDecisionEvidenceInsert {
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
  contentAlgorithm: "AES-256-GCM";
  ciphertext: Buffer;
  nonce: Buffer;
  authenticationTag: Buffer;
  wrappedDek: Buffer;
  kmsKeyReference: string;
  kmsKeyVersion: string;
  aadVersion: number;
}

export interface PendingEvidenceOutboxInsert {
  id: string;
  evidenceRecordId: string;
}

const globalDb = globalThis as unknown as { pontePool?: Pool };
export const pool = (globalDb.pontePool ??= new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
  idle_in_transaction_session_timeout: 10000,
}));
export async function transaction<T>(
  work: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await work(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

export const appendEvent = (db: PoolClient, values: unknown[]) =>
  db.query(
    "INSERT INTO payment_events(id,business_id,invoice_id,actor_id,correlation_id,kind,data,previous_state,new_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    values,
  );
export const listInvoices = (db: PoolClient, values: unknown[]) =>
  db.query(
    "SELECT data || jsonb_build_object('createdAt',created_at,'updatedAt',updated_at) AS data FROM invoices WHERE business_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC,id LIMIT $3 OFFSET $4",
    values,
  );
export const listQuotes = (db: PoolClient, values: unknown[]) =>
  db.query(
    "SELECT id,data,expires_at,source,simulated FROM quotes WHERE business_id=$1 AND invoice_id=$2 ORDER BY created_at DESC",
    values,
  );
export const lockIdempotencyKey = (db: PoolClient, values: unknown[]) =>
  db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", values);
export const findIdempotency = (db: PoolClient, values: unknown[]) =>
  db.query("SELECT * FROM idempotency WHERE business_id=$1 AND key=$2", values);
export const insertInvoice = (db: PoolClient, values: unknown[]) =>
  db.query(
    "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data) VALUES($1,$2,$3,$4,$5,($6::jsonb - ARRAY['createdAt','updatedAt']))",
    values,
  );
export const insertQuote = (db: PoolClient, values: unknown[]) =>
  db.query(
    "INSERT INTO quotes(id,business_id,invoice_id,source,simulated,data,expires_at,created_at) VALUES($1,$2,$3,'simulation-fixed-525',true,$4,$5,now())",
    values,
  );
export const insertPayment = (db: PoolClient, values: unknown[]) =>
  db.query(
    "INSERT INTO payments(id,business_id,invoice_id,provider,provider_reference,funding_minor,received_at) VALUES($1,$2,$3,'simulation',$4,$5,now())",
    values,
  );
export const findValidQuote = (db: PoolClient, values: unknown[]) =>
  db.query(
    "SELECT * FROM quotes WHERE business_id=$1 AND invoice_id=$2 AND id=$3 AND expires_at>clock_timestamp()",
    values,
  );

/**
 * Locks the exact persisted quote fields needed by future evidence creation.
 * This helper does not create evidence or alter the current Routing lifecycle.
 */
export function lockValidQuoteForEvidence(
  db: PoolClient,
  businessId: string,
  invoiceId: string,
  quoteId: string,
) {
  return db.query<LockedEvidenceQuoteRow>(
    "SELECT id,source,simulated,expires_at,data FROM quotes WHERE business_id=$1 AND invoice_id=$2 AND id=$3 AND expires_at>clock_timestamp() FOR UPDATE",
    [businessId, invoiceId, quoteId],
  );
}

/** Inserts a complete encrypted evidence envelope using the caller's transaction. */
export function insertRouteDecisionEvidence(
  db: PoolClient,
  evidence: RouteDecisionEvidenceInsert,
) {
  return db.query(
    "INSERT INTO route_decision_evidence(id,business_id,invoice_id,quote_id,created_by_user_id,routing_correlation_id,public_evidence_id,evidence_schema_version,quote_schema_version,chain_id,registry_address,sequence,evidence_kind,selected_route_code,quote_snapshot_hash,previous_payload_hash,payload_hash,envelope_version,content_algorithm,ciphertext,nonce,authentication_tag,wrapped_dek,kms_key_reference,kms_key_version,aad_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)",
    [
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
      evidence.kmsKeyReference,
      evidence.kmsKeyVersion,
      evidence.aadVersion,
    ],
  );
}

/** Creates the durable pending job for an already-inserted evidence record. */
export function insertPendingEvidenceOutbox(
  db: PoolClient,
  outbox: PendingEvidenceOutboxInsert,
) {
  return db.query(
    "INSERT INTO evidence_outbox(id,evidence_record_id,submission_state) VALUES($1,$2,'pending')",
    [outbox.id, outbox.evidenceRecordId],
  );
}

export const insertSettlement = (db: PoolClient, values: unknown[]) =>
  db.query(
    "INSERT INTO settlements(id,business_id,invoice_id,quote_id,route_id,expected_minor,minimum_minor,status) VALUES($1,$2,$3,$4,$5,$6,$7,'Routing')",
    values,
  );
export const lockValidSettlement = (db: PoolClient, values: unknown[]) =>
  db.query(
    "SELECT s.*,q.data AS quote FROM settlements s JOIN quotes q ON q.id=s.quote_id WHERE s.business_id=$1 AND s.invoice_id=$2 AND q.expires_at>clock_timestamp() FOR UPDATE OF s",
    values,
  );
export const completeSettlement = (db: PoolClient, values: unknown[]) =>
  db.query(
    "UPDATE settlements SET status='Settled',actual_minor=expected_minor,settled_at=now() WHERE id=$1",
    values,
  );
export const failSettlement = (db: PoolClient, values: unknown[]) =>
  db.query(
    "UPDATE settlements SET status='Failed' WHERE business_id=$1 AND invoice_id=$2 AND status='Routing'",
    values,
  );
export const saveInvoiceState = (db: PoolClient, values: unknown[]) =>
  db.query(
    "UPDATE invoices SET status=$3,data=($4::jsonb - ARRAY['createdAt','updatedAt']) WHERE business_id=$1 AND id=$2",
    values,
  );
export const updateDraft = (db: PoolClient, values: unknown[]) =>
  db.query(
    "UPDATE invoices SET reference=$3,funding_minor=$4,data=($5::jsonb - ARRAY['createdAt','updatedAt']) WHERE business_id=$1 AND id=$2",
    values,
  );
export const saveIdempotency = (db: PoolClient, values: unknown[]) =>
  db.query(
    "INSERT INTO idempotency(business_id,key,fingerprint,response) VALUES($1,$2,$3,$4)",
    values,
  );

export function findInvoice(
  db: PoolClient,
  business: string,
  id: string,
  lock: boolean,
) {
  return db.query(
    `SELECT data || jsonb_build_object('createdAt',created_at,'updatedAt',updated_at) AS data FROM invoices WHERE business_id=$1 AND id=$2 ${lock ? "FOR UPDATE" : ""}`,
    [business, id],
  );
}
export function history(
  db: PoolClient,
  business: string,
  id: string,
  resource: "payments" | "settlements" | "activity",
) {
  const tables = {
    payments: "payments",
    settlements: "settlements",
    activity: "payment_events",
  };
  return db.query(
    `SELECT * FROM ${tables[resource]} WHERE business_id=$1 AND invoice_id=$2 ORDER BY ${resource === "payments" ? "received_at" : "created_at"}`,
    [business, id],
  );
}

export function findResource(
  db: PoolClient,
  business: string,
  invoice: string,
  resource: "quotes" | "payments",
  id: string,
) {
  const tables = { quotes: "quotes", payments: "payments" };
  return db.query(
    `SELECT * FROM ${tables[resource]} WHERE business_id=$1 AND invoice_id=$2 AND id=$3`,
    [business, invoice, id],
  );
}

export function businessActivity(
  db: PoolClient,
  business: string,
  limit: number,
  offset: number,
  kind: string | null,
) {
  return db.query(
    "SELECT * FROM payment_events WHERE business_id=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY created_at DESC,id LIMIT $3 OFFSET $4",
    [business, kind, limit, offset],
  );
}
