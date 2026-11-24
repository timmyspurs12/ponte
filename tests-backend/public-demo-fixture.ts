import { pool } from "../src/server/repository";
import {
  PUBLIC_DEMO_INVOICES,
  publicDemoInvoiceId,
} from "../src/server/public-demo-data";

/**
 * The synthetic demo uses fixed identifiers, so one disposable database holds
 * exactly one demo tenant. Tests therefore remove only those fixed synthetic
 * rows (and the clearly marked test tenants) between cases; no other tenant,
 * user, membership, or evidence data is ever touched.
 */
export async function resetSyntheticDemo(): Promise<void> {
  const ids = PUBLIC_DEMO_INVOICES.map((spec) =>
    publicDemoInvoiceId(spec.slug),
  );
  await pool.query(
    "DELETE FROM settlements WHERE invoice_id = ANY($1::uuid[])",
    [ids],
  );
  await pool.query("DELETE FROM quotes WHERE invoice_id = ANY($1::uuid[])", [
    ids,
  ]);
  await pool.query("DELETE FROM payments WHERE invoice_id = ANY($1::uuid[])", [
    ids,
  ]);
  await pool.query("DELETE FROM invoices WHERE id = ANY($1::uuid[])", [ids]);
  // Only unresolved synthetic test tenants with no dependants are removed; a
  // tenant that gained a membership or invoice is left untouched.
  await pool.query(
    "DELETE FROM businesses b WHERE b.name LIKE 'Synthetic demo tenant %' AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.business_id=b.id) AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.business_id=b.id)",
  );
}
