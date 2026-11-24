/**
 * Administrative (direct-endpoint) database transport.
 *
 * Migrations and one-time bootstraps run from GitHub Actions, never from the
 * Render web service, and they connect through Neon's **direct** endpoint:
 *
 * - Neon recommends direct connections for schema migrations and admin tasks.
 *   PgBouncer in transaction mode cannot host a migration that keeps one
 *   session open across many statements.
 * - A direct connection is also the only way an operator can see a truthful
 *   server version and `max_connections` value without pooler rewriting.
 *
 * Deliberately *not* marked `server-only`: the migration and bootstrap CLIs
 * import it under plain Node in GitHub Actions, where that package throws.
 * It reads no `process.env`, imports no driver, and is inert on import, so it
 * is safe to load in any process.
 *
 * This module is deliberately separate from `database-config.ts`: the runtime
 * policy *refuses* non-pooled hosts (that is the point), and the administrative
 * policy *requires* a hosted, non-loopback host and rejects the `-pooler`
 * suffix so an operator cannot silently run DDL through the pooler. Both
 * require TLS verification. Neither ever logs or returns an error detail.
 */

export type AdminDatabaseTransport = {
  connectionString: string;
  /** Hostname only; safe for an operator log line. */
  host: string;
  ssl: { rejectUnauthorized: true };
  /** Administrative work runs one statement at a time, by design. */
  max: 1;
  /**
   * Long enough for `CREATE INDEX` or a table rewrite on the smallest Neon
   * compute; the workflow itself enforces a shorter job-level ceiling.
   */
  statement_timeout: number;
  application_name: string;
};

export type AdminDatabaseFailure =
  | "ADMIN_DATABASE_URL_UNCONFIGURED"
  | "ADMIN_DATABASE_URL_INVALID"
  | "ADMIN_DATABASE_URL_LOCAL_HOST"
  | "ADMIN_DATABASE_URL_FORBIDDEN_HOST"
  | "ADMIN_DATABASE_URL_IS_POOLED"
  | "ADMIN_DATABASE_URL_SSL_NOT_VERIFIED"
  | "ADMIN_DATABASE_URL_UNSUPPORTED_PARAMETER";

const localHostnames = [
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
] as const;
const forbiddenHostSuffixes = [".internal", ".local", ".localhost"] as const;
const allowedQueryParameters = ["sslmode", "channel_binding"] as const;

export const ADMIN_STATEMENT_TIMEOUT_MS = 120_000;

/**
 * The administrative URL is supplied by a GitHub Actions secret and is never
 * exposed to the Render service. Passing the value in explicitly (instead of
 * reading `process.env` here) keeps the rule visible at each call site.
 */
export function adminDatabaseTransport(
  connectionString: string | undefined,
):
  | { ok: true; transport: AdminDatabaseTransport }
  | { ok: false; failure: AdminDatabaseFailure } {
  if (!connectionString || connectionString.trim() !== connectionString) {
    return { ok: false, failure: "ADMIN_DATABASE_URL_UNCONFIGURED" };
  }

  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    return { ok: false, failure: "ADMIN_DATABASE_URL_INVALID" };
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return { ok: false, failure: "ADMIN_DATABASE_URL_INVALID" };
  }

  const hostname = parsed.hostname;
  const normalizedHost = hostname.toLowerCase();
  if (!hostname) return { ok: false, failure: "ADMIN_DATABASE_URL_INVALID" };
  if (
    (localHostnames as readonly string[]).includes(normalizedHost) ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalizedHost)
  ) {
    return { ok: false, failure: "ADMIN_DATABASE_URL_LOCAL_HOST" };
  }
  if (forbiddenHostSuffixes.some((suffix) => normalizedHost.endsWith(suffix))) {
    return { ok: false, failure: "ADMIN_DATABASE_URL_FORBIDDEN_HOST" };
  }
  // An administrative connection through PgBouncer would run DDL in
  // transaction pooling, which is exactly the unsupported combination Neon
  // warns about. Reject it instead of relying on operator discipline.
  if (/-pooler\./i.test(hostname)) {
    return { ok: false, failure: "ADMIN_DATABASE_URL_IS_POOLED" };
  }

  for (const [name, parameterValue] of parsed.searchParams) {
    if (!(allowedQueryParameters as readonly string[]).includes(name)) {
      return { ok: false, failure: "ADMIN_DATABASE_URL_UNSUPPORTED_PARAMETER" };
    }
    if (name === "sslmode" && parameterValue !== "verify-full") {
      return { ok: false, failure: "ADMIN_DATABASE_URL_SSL_NOT_VERIFIED" };
    }
  }

  if (!parsed.username || !parsed.password || parsed.pathname.length < 2) {
    return { ok: false, failure: "ADMIN_DATABASE_URL_INVALID" };
  }
  if (parsed.hash) return { ok: false, failure: "ADMIN_DATABASE_URL_INVALID" };

  return {
    ok: true,
    transport: {
      connectionString,
      host: hostname,
      ssl: { rejectUnauthorized: true },
      max: 1,
      statement_timeout: ADMIN_STATEMENT_TIMEOUT_MS,
      application_name: "ponte-admin",
    },
  };
}

/** One sentence per failure, safe to print in a workflow log. */
export const adminDatabaseFailureText: Record<AdminDatabaseFailure, string> = {
  ADMIN_DATABASE_URL_UNCONFIGURED:
    "The administrative database URL secret is not set, or has leading/trailing whitespace.",
  ADMIN_DATABASE_URL_INVALID:
    "The administrative database URL is not a valid PostgreSQL URL with a role, password, and database name.",
  ADMIN_DATABASE_URL_LOCAL_HOST:
    "The administrative database URL points at a loopback or wildcard address.",
  ADMIN_DATABASE_URL_FORBIDDEN_HOST:
    "The administrative database URL points at an internal or local-only hostname.",
  ADMIN_DATABASE_URL_IS_POOLED:
    "The administrative database URL uses the pooled (-pooler) host. Administrative work must use the direct endpoint.",
  ADMIN_DATABASE_URL_SSL_NOT_VERIFIED:
    "The administrative database URL must use sslmode=verify-full.",
  ADMIN_DATABASE_URL_UNSUPPORTED_PARAMETER:
    "The administrative database URL carries a query parameter the admin transport does not support.",
};
