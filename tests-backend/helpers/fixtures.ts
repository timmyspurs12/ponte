/**
 * Fixture-side query adapter for the suite.
 *
 * `fixtures` runs as `ponte_migrator`, elevated to `ponte_owner` inside a single
 * transaction, and returns a `pg`-shaped `{ rows, rowCount }`.
 *
 * Use it for exactly four kinds of statement — the four the application
 * identity must not perform:
 *
 * 1. **Tenant scaffolding** — `INSERT INTO businesses/users/memberships/
 *    external_identities`. The application has `SELECT` only on `businesses`,
 *    and membership rows are created by the login flow, not by request handlers.
 * 2. **Destruction** — `DELETE` / `TRUNCATE` between cases.
 * 3. **State priming** — putting an outbox row into `submitted`, which is
 *    otherwise unreachable for the application.
 * 4. **Constraint tampering** — writes that must reach the constraint rather
 *    than stop at `42501`, so `23514` / `428C9` stay observable.
 *
 * Everything else — ordinary invoice, quote, payment and evidence writes, and
 * the application's own `UPDATE`s — stays on the application connection. A test
 * that used this adapter for those would stop proving anything about the
 * privilege boundary the application actually runs under.
 */

import {
  adminRead,
  adminWrite,
  type AdminPool,
} from "./admin-database";
import { adminPool } from "./database-identities";

export type FixtureResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
};

export class FixtureAdminUnavailableError extends Error {
  constructor() {
    super(
      "This fixture statement requires the administrative identity. Set PONTE_TEST_ADMIN_DATABASE_URL (ponte_migrator) and provision the roles.",
    );
    this.name = "FixtureAdminUnavailableError";
  }
}

function poolOrThrow(): AdminPool {
  const pool = adminPool();
  if (!pool) throw new FixtureAdminUnavailableError();
  return pool;
}

/** Owner-elevated write. Use for scaffolding, destruction, priming and tamper. */
export function fixtures(
  sql: string,
  values: unknown[] = [],
): Promise<FixtureResult> {
  return adminWrite(poolOrThrow(), async ({ db }) => {
    const result = await db.query(sql, values as never[]);
    return {
      rows: result.rows as Record<string, unknown>[],
      rowCount: result.rowCount ?? 0,
    };
  });
}

/** Owner-elevated read-on-a-read-only-transaction. Use for private metadata. */
export function fixturesRead(
  sql: string,
  values: unknown[] = [],
): Promise<FixtureResult> {
  return adminRead(poolOrThrow(), async ({ db }) => {
    const result = await db.query(sql, values as never[]);
    return {
      rows: result.rows as Record<string, unknown>[],
      rowCount: result.rowCount ?? 0,
    };
  });
}

/**
 * True when an administrative URL is configured.
 *
 * The privilege suite uses this to decide whether it can run at all. It is not
 * a skip condition in disguise: running those assertions against a superuser
 * would make every `42501` pass for the wrong reason, so a missing admin URL is
 * reported rather than silently tolerated.
 */
export function fixtureScopeAvailable(): boolean {
  return Boolean(process.env.PONTE_TEST_ADMIN_DATABASE_URL);
}
