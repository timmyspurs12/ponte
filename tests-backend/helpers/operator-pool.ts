/**
 * The pool the operator bootstrap CLIs run on.
 *
 * `bootstrapPublicDemo()` and `bootstrapProductionBusiness()` provision the
 * `businesses` table, which the application identity may only SELECT. They
 * therefore perform their work under a transaction-local
 * `SET LOCAL ROLE ponte_owner` and must be handed the operator credential —
 * never the ordinary application pool.
 *
 * Tests import this instead of building the pool inline so that the "the
 * application pool is not the operator pool" rule is stated in exactly one
 * place. If `PONTE_TEST_ADMIN_DATABASE_URL` is absent the helper throws rather
 * than silently falling back to an identity that would fail mid-transaction.
 */
import { adminPool } from "./database-identities";

export function operatorPool() {
  const pool = adminPool();
  if (!pool)
    throw new Error(
      "PONTE_TEST_ADMIN_DATABASE_URL is required to run an operator bootstrap CLI under test",
    );
  return pool;
}
