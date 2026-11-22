import "server-only";

import { pool } from "./repository";

export type DatabaseReadinessProbe = () => Promise<void>;

/**
 * A deliberately minimal readiness probe. It opens no transaction and touches
 * no tenant or application data; a successful result means PostgreSQL accepted
 * one ordinary query from this process.
 */
export async function probeDatabaseReadiness(): Promise<void> {
  await pool.query("SELECT 1");
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
