import { z } from "zod";

/**
 * Runtime database transport policy for the zero-cost deployment (Render Free
 * web service + Neon Free PostgreSQL through PgBouncer).
 *
 * Four facts drive this module:
 *
 * 1. `pg` parses `connectionString` *over* explicit options
 *    (`ConnectionParameters` does `Object.assign({}, config, parse(url))`), so
 *    any `?ssl=` / `?sslmode=` value in the URL silently replaces an `ssl`
 *    object passed in code. TLS is therefore enforced by restricting the URL
 *    query string, not by "also passing ssl" and hoping.
 * 2. `pg-connection-string` 2.14.1 treats `require`, `prefer`, and `verify-ca`
 *    as aliases for `verify-full` and warns that this changes in v3 (`require`
 *    becomes the weaker libpq behaviour). Only `sslmode=verify-full` means
 *    "verify the chain and the hostname" in both the current and the future
 *    semantics, so it is the only SSL mode this policy accepts.
 * 3. PgBouncer in `pool_mode=transaction` carries a few session settings
 *    (`statement_timeout`, `search_path`, `synchronous_commit`) across
 *    unrelated clients, and Neon documents `statement_timeout` as one of them.
 *    The application pool already sends `statement_timeout` and
 *    `idle_in_transaction_session_timeout` in the startup packet, so the URL
 *    must not set either one as well.
 * 4. A direct (non-pooled) host bypasses PgBouncer entirely. Neon gives a
 *    0.25 CU compute 112 server connections (105 after superuser reservations);
 *    the runtime must use the `-pooler` endpoint so a small web instance cannot
 *    exhaust them.
 *
 * Deliberately *not* marked `server-only`: it is imported by the pure guard
 * tests and must stay loadable outside a Next.js server bundle. It reads no
 * `process.env`, imports no driver, and is inert on import.
 *
 * The module is pure: it reads a supplied environment record, never
 * `process.env`, performs no I/O, and returns either a validated snapshot or a
 * closed reason code. Callers may log the reason code and the host name, never
 * the URL.
 */

/** Loopback, wildcard, and link-local targets are never a hosted database. */
const localHostnames = [
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
] as const;

/** Hostname suffixes that only ever exist on a developer machine or cluster. */
const forbiddenHostSuffixes = [".internal", ".local", ".localhost"] as const;

/**
 * The complete set of query parameters the runtime accepts.
 *
 * `sslmode` may only be `verify-full`; `channel_binding` is accepted because
 * recent Neon connection strings include it and it strengthens SCRAM auth.
 * Everything else — including `ssl`, `sslrootcert`, `statement_timeout`,
 * `options`, and libpq compatibility switches — is rejected so that transport
 * behaviour is owned by this module rather than by a pasted string.
 */
const allowedSslModes = ["verify-full"] as const;
const allowedQueryParameters = ["sslmode", "channel_binding"] as const;

/** How long the app may wait to establish one pooled connection. */
export const RUNTIME_CONNECTION_TIMEOUT_MS = 10_000;

/** Application-level statement budget for ordinary request work. */
export const RUNTIME_STATEMENT_TIMEOUT_MS = 15_000;

/** Mirrors the readiness-probe budget in `src/server/health.ts`. */
export const RUNTIME_IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000;

/** Small, fixed ceiling: one Render instance must stay far below 105 slots. */
export const RUNTIME_POOL_MAX = 5;

export type RuntimeDatabaseConfig = {
  /** Fully validated URL. Never returned to a client and never logged. */
  connectionString: string;
  /** Database hostname only; safe for an operator-facing startup log. */
  host: string;
  /** True when the hostname carries the Neon `-pooler` suffix. */
  pooled: boolean;
  max: number;
  connectionTimeoutMillis: number;
  statementTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
};

export type RuntimeDatabaseConfigFailure =
  | "DATABASE_URL_UNCONFIGURED"
  | "DATABASE_URL_INVALID"
  | "DATABASE_URL_SCHEME"
  | "DATABASE_URL_LOCAL_HOST"
  | "DATABASE_URL_FORBIDDEN_HOST"
  | "DATABASE_URL_NOT_POOLED"
  | "DATABASE_URL_SSL_NOT_VERIFIED"
  | "DATABASE_URL_UNSUPPORTED_PARAMETER";

export type RuntimeDatabaseConfigResult =
  | { ok: true; config: RuntimeDatabaseConfig }
  | { ok: false; reason: RuntimeDatabaseConfigFailure };

/**
 * z.url() with a fixed scheme. Its hostname regex is used below only as a
 * structural check; the policy checks in `parseRuntimeDatabaseUrl` run first
 * so a loopback URL reports `DATABASE_URL_LOCAL_HOST`, not a generic parse
 * error.
 */
const postgresUrlSchema = z.url({ protocol: /^postgres(?:ql)?$/ });

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if ((localHostnames as readonly string[]).includes(normalized)) return true;
  // IPv4 loopback 127.0.0.0/8 and IPv6 loopback inside brackets.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/**
 * Validates a runtime database URL. Checks run in a fixed order, so every
 * failure maps to exactly one stable reason code and the reason text never
 * quotes the input.
 */
export function parseRuntimeDatabaseUrl(
  environment: Record<string, string | undefined>,
  options: { requirePooled: boolean },
): RuntimeDatabaseConfigResult {
  const value = environment.DATABASE_URL;
  // Reject surrounding whitespace explicitly: a trailing newline is a common
  // copy/paste failure, and `new URL` would silently trim it.
  if (!value || value.trim() !== value) {
    return { ok: false, reason: "DATABASE_URL_UNCONFIGURED" };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: "DATABASE_URL_INVALID" };
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return { ok: false, reason: "DATABASE_URL_SCHEME" };
  }

  const hostname = parsed.hostname;
  if (!hostname) return { ok: false, reason: "DATABASE_URL_INVALID" };
  if (isLocalHostname(hostname)) {
    return { ok: false, reason: "DATABASE_URL_LOCAL_HOST" };
  }
  const normalizedHost = hostname.toLowerCase();
  if (forbiddenHostSuffixes.some((suffix) => normalizedHost.endsWith(suffix))) {
    return { ok: false, reason: "DATABASE_URL_FORBIDDEN_HOST" };
  }

  const pooled = /-pooler\./i.test(hostname);
  if (options.requirePooled && !pooled) {
    return { ok: false, reason: "DATABASE_URL_NOT_POOLED" };
  }

  for (const [name, parameterValue] of parsed.searchParams) {
    if (!(allowedQueryParameters as readonly string[]).includes(name)) {
      return { ok: false, reason: "DATABASE_URL_UNSUPPORTED_PARAMETER" };
    }
    if (
      name === "sslmode" &&
      !(allowedSslModes as readonly string[]).includes(parameterValue)
    ) {
      return { ok: false, reason: "DATABASE_URL_SSL_NOT_VERIFIED" };
    }
  }

  // After the policy checks, confirm the string is still structurally a
  // PostgreSQL URL with an embedded role, password, and database name.
  if (!postgresUrlSchema.safeParse(value).success) {
    return { ok: false, reason: "DATABASE_URL_INVALID" };
  }
  if (!parsed.username || !parsed.password) {
    return { ok: false, reason: "DATABASE_URL_INVALID" };
  }
  // `pathname` holds the database name; an empty path would connect to a
  // database named after the role.
  if (parsed.pathname.length < 2) {
    return { ok: false, reason: "DATABASE_URL_INVALID" };
  }
  if (parsed.hash) return { ok: false, reason: "DATABASE_URL_INVALID" };

  return {
    ok: true,
    config: {
      connectionString: value,
      host: hostname,
      pooled,
      max: RUNTIME_POOL_MAX,
      connectionTimeoutMillis: RUNTIME_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: RUNTIME_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: RUNTIME_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    },
  };
}

/**
 * True when the URL carries `sslmode=verify-full`. Exposed so the transport
 * layer can assert that explicit TLS options and the URL agree.
 */
export function declaresVerifiedTls(connectionString: string): boolean {
  try {
    const parsed = new URL(connectionString);
    return parsed.searchParams.getAll("sslmode").includes("verify-full");
  } catch {
    return false;
  }
}

/**
 * Complete `pg` options for the runtime pool.
 *
 * `ssl.rejectUnauthorized: true` is passed explicitly because `pg`'s `ssl: true`
 * only *requests* TLS — it does not verify the chain — and because an explicit
 * object keeps verification in force even if a future `pg` release changes what
 * `sslmode` means. The URL may not override it: the policy above rejects every
 * SSL-related query parameter except `sslmode=verify-full`, which resolves to
 * the same verified behaviour.
 */
export function runtimePoolOptions(config: RuntimeDatabaseConfig): {
  connectionString: string;
  ssl: { rejectUnauthorized: true };
  max: number;
  connectionTimeoutMillis: number;
  statement_timeout: number;
  idle_in_transaction_session_timeout: number;
  application_name: string;
  allowExitOnIdle: false;
} {
  return {
    connectionString: config.connectionString,
    ssl: { rejectUnauthorized: true },
    max: config.max,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    statement_timeout: config.statementTimeoutMs,
    idle_in_transaction_session_timeout: config.idleInTransactionTimeoutMs,
    // PgBouncer tracks `application_name` per client, so this is safe in
    // transaction pooling and makes app queries identifiable in Neon.
    application_name: "ponte-web",
    allowExitOnIdle: false,
  };
}

/** One sentence per failure, safe to print in a deploy log. */
export const runtimeDatabaseConfigFailureText: Record<
  RuntimeDatabaseConfigFailure,
  string
> = {
  DATABASE_URL_UNCONFIGURED:
    "DATABASE_URL is not set on this service, or has leading/trailing whitespace.",
  DATABASE_URL_INVALID:
    "DATABASE_URL is not a valid PostgreSQL URL with a role, password, and database name.",
  DATABASE_URL_SCHEME:
    "DATABASE_URL must use the postgres:// or postgresql:// scheme.",
  DATABASE_URL_LOCAL_HOST:
    "DATABASE_URL points at a loopback or wildcard address; the hosted runtime requires a hosted database.",
  DATABASE_URL_FORBIDDEN_HOST:
    "DATABASE_URL points at an internal or local-only hostname.",
  DATABASE_URL_NOT_POOLED:
    "DATABASE_URL must use the Neon pooled (-pooler) endpoint for the web service.",
  DATABASE_URL_SSL_NOT_VERIFIED:
    "DATABASE_URL must use sslmode=verify-full. Remove sslmode, or change require/prefer/verify-ca/no-verify to verify-full.",
  DATABASE_URL_UNSUPPORTED_PARAMETER:
    "DATABASE_URL carries a query parameter the runtime does not support. Keep only sslmode=verify-full and channel_binding.",
};
