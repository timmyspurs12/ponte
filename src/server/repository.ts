import type { PoolClient, QueryResult } from "pg";
import type { Invoice, PaymentQuote, Status } from "../lib/models";
import { pool } from "./database";
import { EvidenceReadError } from "./evidence/errors";
import type {
  KmsProviderIdentifier,
  WrappedDekAlgorithmIdentifier,
  WrappedDekFormatIdentifier,
} from "./evidence/kms";

/**
 * Re-exported so every existing call site (`import { pool } from
 * "./repository"`) keeps working. The pool itself now lives in
 * `src/server/database.ts`, where the hosted transport policy is applied.
 */
export { pool };

/**
 * Narrow persisted invoice view for evidence preparation. `funding_minor` is
 * PostgreSQL int8 text from node-postgres and is the authoritative amount;
 * `data` supplies fixed JSONB metadata validation only.
 */
export interface EvidencePreparationInvoiceRow {
  id: string;
  business_id: string;
  status: Status;
  funding_minor: string;
  /** Stored generated projection of data.fundingCurrency, constrained to BRL. */
  funding_currency: "BRL";
  data: Pick<Invoice, "fundingCurrency" | "fundingMinor">;
}

/**
 * Narrow persisted quote view for evidence preparation. Its identities come
 * from the row, never from lookup arguments.
 */
export interface EvidencePreparationQuoteRow {
  id: string;
  business_id: string;
  invoice_id: string;
  source: string;
  simulated: boolean;
  /** node-postgres parses the millisecond-constrained timestamptz as a Date. */
  expires_at: Date;
  data: PaymentQuote;
}

/**
 * One non-locking read-only snapshot has either the exact valid invoice/quote
 * pair, a missing invoice, or an exact quote that is missing or expired.
 */
export type EvidencePreparationSnapshot =
  | {
      kind: "ready";
      invoice: EvidencePreparationInvoiceRow;
      quote: EvidencePreparationQuoteRow;
    }
  | { kind: "invoice_missing" }
  | {
      kind: "quote_missing_or_expired";
      invoice: EvidencePreparationInvoiceRow;
    };

/**
 * Final-transaction invoice view. `status` is the relational lifecycle
 * authority, `funding_minor` is the amount authority, and `funding_currency`
 * is the stored generated projection of JSONB funding metadata.
 */
export interface LockedEvidenceInvoiceRow extends EvidencePreparationInvoiceRow {}

/**
 * Final-transaction quote view. It shares the preparation row shape but is
 * locked through the SECURITY DEFINER function `ponte_lock_routing_quote`,
 * which locks the exact quote row by identity and applies the database-time
 * expiry check only after the lock is acquired.
 */
export interface LockedEvidenceQuoteRow extends EvidencePreparationQuoteRow {}

type EvidencePreparationSnapshotQueryRow = {
  invoice_id: string;
  invoice_business_id: string;
  invoice_status: Status;
  invoice_funding_minor: string;
  invoice_funding_currency: "BRL";
  invoice_data: Pick<Invoice, "fundingCurrency" | "fundingMinor">;
  quote_id: string | null;
  quote_business_id: string | null;
  quote_invoice_id: string | null;
  quote_source: string | null;
  quote_simulated: boolean | null;
  quote_expires_at: Date | null;
  quote_data: PaymentQuote | null;
};

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
  kmsProvider: KmsProviderIdentifier;
  wrappedDekAlgorithm: WrappedDekAlgorithmIdentifier;
  wrappedDekFormat: WrappedDekFormatIdentifier;
  kmsKeyReference: string;
  kmsKeyVersion: string;
  aadVersion: number;
}

export interface PendingEvidenceOutboxInsert {
  id: string;
  evidenceRecordId: string;
}

/**
 * Public-commitment-only projection for the invoice evidence status endpoint.
 * Sensitive envelope, KMS, and private-payload columns are deliberately absent.
 */
export interface InvoiceEvidenceStatusRow {
  public_evidence_id: Buffer;
  evidence_schema_version: number;
  chain_id: string;
  registry_address: Buffer;
  sequence: string;
  evidence_kind: number;
  previous_payload_hash: Buffer;
  payload_hash: Buffer;
  kms_provider: string;
  created_at: Date;
  submission_state: string | null;
}

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

/**
 * A sanitized signal used only when a COMMIT acknowledgement cannot establish
 * whether PostgreSQL committed. It deliberately carries no database error.
 */
export class CommitOutcomeUnknownError extends Error {
  constructor() {
    super("commit outcome is unknown");
    this.name = "CommitOutcomeUnknownError";
  }
}

// PostgreSQL's documented SQLSTATE classes. Requiring both a known class and
// five uppercase alphanumeric characters keeps transport labels such as EPIPE
// (which happens to be five uppercase letters) out of the server-error path.
const POSTGRESQL_SQLSTATE =
  /^(?:00|01|02|03|08|09|10|0A|0B|0F|0L|0P|0Z|20|21|22|23|24|25|26|27|28|2B|2D|2F|34|38|39|3B|3D|3F|40|42|44|53|54|55|57|58|72|F0|HV|P0|XX)[0-9A-Z]{3}$/;

function commitOutcomeIsUnknown(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (typeof code !== "string" || !POSTGRESQL_SQLSTATE.test(code)) return true;
  // Connection exceptions, shutdown-family reports, and PostgreSQL's explicit
  // statement-completion-unknown result cannot establish whether COMMIT won.
  return code.startsWith("08") || code.startsWith("57P0") || code === "40003";
}

/**
 * Evidence-only transaction wrapper with commit-outcome classification. Unlike
 * `transaction`, it never reuses a client after an ambiguous COMMIT failure and
 * never lets a secondary ROLLBACK error replace the original failure.
 */
export async function transactionWithCommitOutcome<T>(
  work: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  let transactionOpen = false;
  let commitAttempted = false;
  let destroyClient = false;
  try {
    await db.query("BEGIN");
    transactionOpen = true;
    const result = await work(db);
    commitAttempted = true;
    try {
      await db.query("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (commitOutcomeIsUnknown(error)) {
        destroyClient = true;
        throw new CommitOutcomeUnknownError();
      }
      try {
        await db.query("ROLLBACK");
        transactionOpen = false;
      } catch {
        destroyClient = true;
      }
      throw error;
    }
  } catch (error) {
    if (transactionOpen && !commitAttempted) {
      try {
        await db.query("ROLLBACK");
      } catch {
        destroyClient = true;
      }
    }
    throw error;
  } finally {
    db.release(destroyClient);
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

/**
 * Non-authoritative result for a future Routing orchestration cost preflight.
 * The final persistence transaction always repeats this lookup while holding
 * the business/key advisory lock and reauthorizes membership before replay.
 */
export type RoutingIdempotencyPreflight =
  | { kind: "miss" }
  | { kind: "match"; response: unknown }
  | { kind: "conflict" };

type ReadOnlyTransactionClient = Pick<PoolClient, "query" | "release">;

/**
 * Test-only client seam for read-only transaction cleanup. Production helpers
 * always acquire their own pool client through `withReadOnlyTransaction`.
 */
export async function __testOnlyRunReadOnlyTransaction<T>(
  db: ReadOnlyTransactionClient,
  work: (db: ReadOnlyTransactionClient) => Promise<T>,
): Promise<T> {
  let beginAttempted = false;
  let transactionOpen = false;
  let commitAttempted = false;
  let destroyClient = false;
  let originalError: unknown;
  try {
    beginAttempted = true;
    await db.query("BEGIN READ ONLY");
    transactionOpen = true;
    const result = await work(db);
    commitAttempted = true;
    await db.query("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    originalError = error;
    // BEGIN acknowledgement failure cannot establish whether PostgreSQL opened
    // a transaction, so this connection is never returned to the pool.
    if (beginAttempted && !transactionOpen) destroyClient = true;
    if (transactionOpen) {
      // A failed COMMIT acknowledgement cannot prove connection state. Even if
      // ROLLBACK succeeds, this client is discarded rather than reused.
      if (commitAttempted) destroyClient = true;
      try {
        await db.query("ROLLBACK");
        transactionOpen = false;
      } catch {
        destroyClient = true;
      }
    }
    throw error;
  } finally {
    try {
      db.release(destroyClient);
    } catch (releaseError) {
      // Preserve the read/commit error; never turn cleanup into false success.
      if (originalError === undefined) throw releaseError;
    }
  }
}

async function withReadOnlyTransaction<T>(
  work: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  return __testOnlyRunReadOnlyTransaction(db, (client) =>
    work(client as PoolClient),
  );
}

/**
 * Runs one short READ ONLY idempotency lookup and releases its client before
 * resolving. It acquires no advisory, invoice, or quote lock and must never be
 * used as a durable replay/conflict decision.
 */
export async function readRoutingIdempotencyPreflight(
  businessId: string,
  idempotencyKey: string,
  requestFingerprint: string,
): Promise<RoutingIdempotencyPreflight> {
  try {
    const result = await withReadOnlyTransaction((db) =>
      findIdempotency(db, [businessId, idempotencyKey]),
    );
    if (!result.rowCount) return { kind: "miss" };
    return result.rows[0].fingerprint === requestFingerprint
      ? { kind: "match", response: result.rows[0].response }
      : { kind: "conflict" };
  } catch {
    throw new EvidenceReadError("PREFLIGHT_READ_FAILED");
  }
}
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
 * Reads a coherent, non-locking preparation snapshot and releases its
 * read-only transaction before resolving. An absent/expired quote is one
 * intentional result because both map to the current valid-quote semantics.
 */
export async function readEvidencePreparationSnapshot(
  businessId: string,
  invoiceId: string,
  quoteId: string,
): Promise<EvidencePreparationSnapshot> {
  let result: QueryResult<EvidencePreparationSnapshotQueryRow>;
  try {
    result = await withReadOnlyTransaction((db) =>
      db.query<EvidencePreparationSnapshotQueryRow>(
        "SELECT i.id AS invoice_id,i.business_id AS invoice_business_id,i.status AS invoice_status,i.funding_minor AS invoice_funding_minor,i.funding_currency AS invoice_funding_currency,i.data AS invoice_data,q.id AS quote_id,q.business_id AS quote_business_id,q.invoice_id AS quote_invoice_id,q.source AS quote_source,q.simulated AS quote_simulated,q.expires_at AS quote_expires_at,q.data AS quote_data FROM invoices i LEFT JOIN quotes q ON q.business_id=i.business_id AND q.invoice_id=i.id AND q.id=$3 AND q.expires_at>clock_timestamp() WHERE i.business_id=$1 AND i.id=$2",
        [businessId, invoiceId, quoteId],
      ),
    );
  } catch {
    throw new EvidenceReadError("SNAPSHOT_READ_FAILED");
  }

  if (!result.rowCount) return { kind: "invoice_missing" };
  const row = result.rows[0] as EvidencePreparationSnapshotQueryRow;
  const invoice: EvidencePreparationInvoiceRow = {
    id: row.invoice_id,
    business_id: row.invoice_business_id,
    status: row.invoice_status,
    funding_minor: row.invoice_funding_minor,
    funding_currency: row.invoice_funding_currency,
    data: row.invoice_data,
  };
  if (
    row.quote_id === null ||
    row.quote_business_id === null ||
    row.quote_invoice_id === null ||
    row.quote_source === null ||
    row.quote_simulated === null ||
    row.quote_expires_at === null ||
    row.quote_data === null
  )
    return { kind: "quote_missing_or_expired", invoice };

  return {
    kind: "ready",
    invoice,
    quote: {
      id: row.quote_id,
      business_id: row.quote_business_id,
      invoice_id: row.quote_invoice_id,
      source: row.quote_source,
      simulated: row.quote_simulated,
      expires_at: row.quote_expires_at,
      data: row.quote_data,
    },
  };
}

/**
 * Locks the authoritative invoice identity/funding/state columns for a future
 * evidence transaction. It has no normal Routing or service integration.
 */
export function lockInvoiceForEvidence(
  db: PoolClient,
  businessId: string,
  invoiceId: string,
) {
  return db.query<LockedEvidenceInvoiceRow>(
    "SELECT id,business_id,status,funding_minor,funding_currency,data FROM invoices WHERE business_id=$1 AND id=$2 FOR UPDATE",
    [businessId, invoiceId],
  );
}

/**
 * Locks the exact persisted quote fields needed by future evidence creation.
 * This helper does not create evidence or alter the current Routing lifecycle.
 *
 * Phase 2C.3: the row lock is carried by the SECURITY DEFINER function
 * `ponte_lock_routing_quote`, owned by `ponte_routing_lock`. The application
 * identity holds no UPDATE on `quotes`, so a direct `FOR UPDATE` here fails
 * with 42501 (the R1 dormancy); the function takes the lock with its own
 * column-level privileges and returns the same locked row. The function's
 * expiry semantics: a missing quote locks nothing and returns zero rows; a
 * valid quote is locked and then returned; an expired quote is locked
 * first, rejected by the post-lock expiry check, and returns zero rows — the
 * caller fails closed with `INVOICE_OR_QUOTE_UNAVAILABLE` on a zero-row
 * result.
 */
export function lockValidQuoteForEvidence(
  db: PoolClient,
  businessId: string,
  invoiceId: string,
  quoteId: string,
) {
  return db.query<LockedEvidenceQuoteRow>(
    "SELECT id,business_id,invoice_id,source,simulated,expires_at,data FROM public.ponte_lock_routing_quote($1,$2,$3)",
    [businessId, invoiceId, quoteId],
  );
}

/** Inserts a complete encrypted evidence envelope using the caller's transaction. */
export function insertRouteDecisionEvidence(
  db: PoolClient,
  evidence: RouteDecisionEvidenceInsert,
) {
  return db.query(
    "INSERT INTO route_decision_evidence(id,business_id,invoice_id,quote_id,created_by_user_id,routing_correlation_id,public_evidence_id,evidence_schema_version,quote_schema_version,chain_id,registry_address,sequence,evidence_kind,selected_route_code,quote_snapshot_hash,previous_payload_hash,payload_hash,envelope_version,content_algorithm,ciphertext,nonce,authentication_tag,wrapped_dek,kms_provider,wrapped_dek_algorithm,wrapped_dek_format,kms_key_reference,kms_key_version,aad_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)",
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
      evidence.kmsProvider,
      evidence.wrappedDekAlgorithm,
      evidence.wrappedDekFormat,
      evidence.kmsKeyReference,
      evidence.kmsKeyVersion,
      evidence.aadVersion,
    ],
  );
}

/**
 * Creates the durable pending job for an already-inserted evidence record.
 *
 * `submission_state` is deliberately *not* named. Migration 007 supplies
 * `DEFAULT 'pending'`, and the application holds a column-level
 * `INSERT (id, evidence_record_id)` grant with no grant on `submission_state`.
 * That is what makes `'submitted'` and `'confirmed'` unreachable for the
 * application identity: a column grant cannot restrict which *value* is
 * written, so the column must not be writable at all.
 */
export function insertPendingEvidenceOutbox(
  db: PoolClient,
  outbox: PendingEvidenceOutboxInsert,
) {
  return db.query(
    "INSERT INTO evidence_outbox(id,evidence_record_id) VALUES($1,$2)",
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

/**
 * Reads only the safe public commitment projection for one tenant-scoped
 * invoice. Do not expand this SELECT with encrypted envelope/KMS secret fields.
 */
export function findInvoiceEvidenceStatus(
  db: PoolClient,
  business: string,
  invoice: string,
) {
  return db.query<InvoiceEvidenceStatusRow>(
    "SELECT e.public_evidence_id,e.evidence_schema_version,e.chain_id,e.registry_address,e.sequence,e.evidence_kind,e.previous_payload_hash,e.payload_hash,e.kms_provider,e.created_at,o.submission_state FROM route_decision_evidence e LEFT JOIN evidence_outbox o ON o.evidence_record_id=e.id WHERE e.business_id=$1 AND e.invoice_id=$2",
    [business, invoice],
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
