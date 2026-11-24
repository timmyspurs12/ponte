import "server-only";

import { Pool } from "pg";
import {
  parseRuntimeDatabaseUrl,
  runtimeDatabaseConfigFailureText,
  runtimePoolOptions,
} from "./database-config";

/**
 * The one shared `pg` pool for the application runtime.
 *
 * A *hosted* runtime (Render sets `RENDER=true`) must satisfy the pooled
 * transport policy in `database-config.ts`: Neon `-pooler` hostname, verified
 * TLS, no URL parameter that could override the pool's session settings. A
 * hosted process with a non-conforming URL fails here, before its first query,
 * with a reason code instead of a driver message.
 *
 * Local development and the test runners deliberately keep the historical
 * options: they point at a disposable loopback PostgreSQL with no TLS, which
 * the hosted policy correctly refuses.
 *
 * `NODE_ENV=production` is **not** the selector. `next build` evaluates the
 * route modules with `NODE_ENV=production` while no database is necessarily
 * configured, and the CI browser suite runs a development server against a
 * loopback database.
 */
const hostedRuntime = process.env.RENDER === "true";

function createPool(): Pool {
  if (!hostedRuntime) {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      idle_in_transaction_session_timeout: 10000,
    });
  }

  // `process.env` carries the value; `undefined` must stay `undefined` (and not
  // become the string "undefined") so the reason code names the real problem.
  const parsed = parseRuntimeDatabaseUrl(
    { DATABASE_URL: process.env.DATABASE_URL },
    { requirePooled: true },
  );
  if (!parsed.ok) {
    // Fail closed with the reason code only: the URL never reaches a log.
    throw new Error(
      `PONTE database configuration is invalid: ${parsed.reason} — ${runtimeDatabaseConfigFailureText[parsed.reason]}`,
    );
  }
  return new Pool(runtimePoolOptions(parsed.config));
}

const globalDb = globalThis as unknown as {
  pontePool?: Pool;
  pontePoolErrorHandlerAttached?: boolean;
};
export const pool = (globalDb.pontePool ??= createPool());

/**
 * `pg` emits `error` on the *pool* when an **idle** backend connection is lost
 * — for example when a Neon compute suspends after five idle minutes, when
 * PgBouncer closes a server connection, or when Render restarts the service.
 * Node's EventEmitter throws on an unhandled `error` event, which would
 * terminate the web process. This listener keeps the process alive: `pg-pool`
 * has already discarded the dead client before emitting, and the next query
 * opens a fresh connection and wakes the Neon compute.
 *
 * Nothing is logged on purpose: the emitted error can carry driver-level
 * detail, and this module must not become a place where connection information
 * reaches a log.
 */
if (!globalDb.pontePoolErrorHandlerAttached) {
  pool.on("error", () => {});
  globalDb.pontePoolErrorHandlerAttached = true;
}
