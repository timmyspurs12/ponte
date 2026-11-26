/**
 * The two database identities the suite needs, resolved in one place.
 *
 * - **Application**: `ponte_app_login`, inheriting `ponte_app`. Every ordinary
 *   query in a test uses this. It is what `DATABASE_URL` points at once the
 *   roles are provisioned, so the runtime and the suite exercise the *same*
 *   privilege boundary the deployed application gets.
 * - **Administrative**: `ponte_migrator`, `LOGIN NOINHERIT` with `ponte_owner`
 *   granted `SET TRUE`. Used only through `admin-database.ts`, which elevates
 *   inside a transaction.
 *
 * Two separate variables, deliberately:
 *
 * - `PONTE_TEST_ADMIN_DATABASE_URL` is the test-specific name. It must not be
 *   `ADMIN_DATABASE_URL`, which is the hosted administrative secret consumed by
 *   `src/server/admin-database.ts` and gated by a policy that rejects loopback
 *   hosts. A local suite connecting as `ponte_migrator` would be refused by that
 *   policy for the correct reason, so the two names stay distinct.
 *
 * Neither value is ever logged. A missing administrative URL is not an error at
 * import time: suites that do not need elevation must keep running.
 */

import { Pool } from "pg";

export const APP_LOGIN_ROLE = "ponte_app_login";
export const ADMIN_LOGIN_ROLE = "ponte_migrator";

export type TestDatabaseIdentities = {
  /** Application pool, or `undefined` when the suite is running unprovisioned. */
  appUrl: string | undefined;
  /** Administrative pool, or `undefined` when elevation is unavailable. */
  adminUrl: string | undefined;
  /**
   * True when `DATABASE_URL` is a provisioned application login rather than a
   * superuser. Tests that assert `42501` require it.
   */
  appIdentityProvisioned: boolean;
};

let cachedAdminPool: Pool | undefined;

/** Reads the two URLs without ever echoing them. */
export function testDatabaseIdentities(): TestDatabaseIdentities {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.PONTE_TEST_ADMIN_DATABASE_URL;
  return {
    appUrl,
    adminUrl,
    /**
     * `ponte:local-only` is the bootstrap superuser of the disposable cluster:
     * provisioning has been applied but `DATABASE_URL` still points at the
     * superuser, so `42501` assertions would pass for the wrong reason. The
     * provisioned-runner sets `PONTE_TEST_APP_IDENTITY=1` to say so explicitly
     * rather than inferring it from a username.
     */
    appIdentityProvisioned: process.env.PONTE_TEST_APP_IDENTITY === "1",
  };
}

/**
 * The administrative pool, created once and reused.
 *
 * `max: 1` mirrors the production administrative transport: administrative work
 * runs one statement at a time, and a single connection keeps `SET LOCAL ROLE`
 * scopes trivially auditable.
 */
export function adminPool(): Pool | undefined {
  const { adminUrl } = testDatabaseIdentities();
  if (!adminUrl) return undefined;
  cachedAdminPool ??= new Pool({ connectionString: adminUrl, max: 1 });
  return cachedAdminPool;
}

/** Closes the cached administrative pool between suites. */
export async function closeAdminPool(): Promise<void> {
  if (!cachedAdminPool) return;
  const pool = cachedAdminPool;
  cachedAdminPool = undefined;
  await pool.end().catch(() => {});
}
