import "server-only";

import { pool } from "./database";

export type DatabaseReadinessProbe = () => Promise<void>;

/**
 * Neon Free scales its compute to zero after five idle minutes; the first
 * connection afterwards wakes the compute and can take noticeably longer than
 * a warm query. Render's HTTP health check gives an endpoint five seconds to
 * answer and restarts an instance after sixty seconds of consecutive failures,
 * so the probe's own budget must stay comfortably below sixty seconds while
 * still covering a cold wake.
 */
const READINESS_TIMEOUT_MS = 15_000;

/**
 * A deliberately minimal readiness probe. It opens no transaction, takes no
 * lock, and touches no tenant or application data; a successful result means
 * PostgreSQL accepted one ordinary query from this process.
 *
 * The connection is opened by the shared pool under the runtime transport
 * policy (verified TLS, pooled Neon endpoint). Because PgBouncer in transaction
 * mode does not reset client session state, this probe must not run `SET`.
 */
export async function probeDatabaseReadiness(): Promise<void> {
  // `query_timeout` is a valid runtime `pg` option but is missing from the
  // bundled @types/pg QueryConfig; the cast keeps the option while satisfying
  // the compiler rather than silently dropping the budget.
  await pool.query({
    text: "SELECT 1",
    query_timeout: READINESS_TIMEOUT_MS,
  } as unknown as string);
}

/**
 * Builds the public readiness response without ever serializing a database
 * exception. The optional probe exists to exercise the failure boundary in
 * tests; production routes always use the pool-backed default.
 */
export async function databaseReadinessResponse(
  probe: DatabaseReadinessProbe = probeDatabaseReadiness,
): Promise<Response> {
  try {
    await probe();
    return Response.json(
      { status: "ready" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
