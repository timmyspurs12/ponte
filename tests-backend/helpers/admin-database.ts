/**
 * Administrative database helper for tests and fixtures.
 *
 * The administrative identity is `ponte_migrator`: `LOGIN NOINHERIT`, with
 * `ponte_owner` granted `WITH INHERIT FALSE, SET TRUE`. It therefore has **no**
 * privileges until a transaction explicitly elevates with
 * `SET LOCAL ROLE ponte_owner`, and the elevation ends with that transaction.
 *
 * Why a separate module:
 *
 * - Destructive fixture work (`TRUNCATE`, `DELETE`) and private metadata reads
 *   (`wrapped_dek`, `attempt_count`) are impossible for the application
 *   identity by design. Putting them behind one narrow helper keeps every such
 *   use visible in a diff.
 * - `SET LOCAL ROLE` cannot leak: it is a transaction-local setting, so a
 *   pooled connection returned to the pool is never left elevated. This module
 *   never issues a session-level `SET ROLE`.
 *
 * Two operations, deliberately distinct:
 *
 * - `adminRead` wraps work in `BEGIN; SET TRANSACTION READ ONLY; SET LOCAL ROLE`.
 *   The read-only marker makes an accidental write fail with `25006` instead of
 *   quietly succeeding.
 * - `adminWrite` wraps work in `BEGIN; SET LOCAL ROLE`. Writes are explicit.
 *
 * The URL is never read from `process.env` here: the caller passes it, so every
 * elevation site is visible. Errors never carry the connection string.
 */

import { Pool, type PoolClient } from "pg";

/** Where an administrative call gets its connection. */
export type AdminPool = Pick<Pool, "connect">;

export type AdminContext = {
  /** Elevation is transaction-local; work must not outlive this callback. */
  db: PoolClient;
  /** `ponte_owner`, so callers can assert the effective identity. */
  elevatedAs: string;
};

export class AdminHelperError extends Error {
  constructor(
    readonly code: "ADMIN_POOL_MISSING" | "ADMIN_ELEVATION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "AdminHelperError";
  }
}

/** The role the helper elevates to. Kept in one place so tests can assert it. */
export const ADMIN_ELEVATED_ROLE = "ponte_owner";

function requirePool(pool: AdminPool | undefined): AdminPool {
  if (!pool) {
    throw new AdminHelperError(
      "ADMIN_POOL_MISSING",
      "An administrative pool is required for this operation; the application identity cannot perform it.",
    );
  }
  return pool;
}

async function withElevation<T>(
  pool: AdminPool | undefined,
  mode: "read-only" | "write",
  work: (context: AdminContext) => Promise<T>,
): Promise<T> {
  const client = await requirePool(pool).connect();
  try {
    await client.query("BEGIN");
    if (mode === "read-only") {
      await client.query("SET TRANSACTION READ ONLY");
    }
    /**
     * `SET LOCAL ROLE` is what makes the elevation transactional. If the role
     * grant were missing (a provisioning bug), this fails loudly here rather
     * than producing a confusing `42501` deeper in the callback.
     */
    try {
      await client.query(`SET LOCAL ROLE ${ADMIN_ELEVATED_ROLE}`);
    } catch {
      await client.query("ROLLBACK").catch(() => {});
      throw new AdminHelperError(
        "ADMIN_ELEVATION_FAILED",
        `The administrative identity could not SET LOCAL ROLE ${ADMIN_ELEVATED_ROLE}.`,
      );
    }
    const result = await work({ db: client, elevatedAs: ADMIN_ELEVATED_ROLE });
    // A read-only transaction has nothing to persist; ROLLBACK is the correct
    // close for it and costs nothing. A write transaction commits.
    await client.query(mode === "read-only" ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs `work` inside a read-only, owner-elevated transaction.
 *
 * Use for the private metadata query and for any assertion that must see
 * committed state only.
 */
export function adminRead<T>(
  pool: AdminPool | undefined,
  work: (context: AdminContext) => Promise<T>,
): Promise<T> {
  return withElevation(pool, "read-only", work);
}

/**
 * Runs `work` inside a write-capable, owner-elevated transaction.
 *
 * Use for fixture destruction and state priming. Not for application writes:
 * `seed-fixtures.ts` stays on the application identity on purpose.
 */
export function adminWrite<T>(
  pool: AdminPool | undefined,
  work: (context: AdminContext) => Promise<T>,
): Promise<T> {
  return withElevation(pool, "write", work);
}
