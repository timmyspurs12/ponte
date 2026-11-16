import { Pool, type PoolClient } from "pg";
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
