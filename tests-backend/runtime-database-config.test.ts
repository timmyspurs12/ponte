import { test } from "node:test";
import assert from "node:assert/strict";
import {
  declaresVerifiedTls,
  parseRuntimeDatabaseUrl,
  RUNTIME_CONNECTION_TIMEOUT_MS,
  RUNTIME_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  RUNTIME_POOL_MAX,
  RUNTIME_STATEMENT_TIMEOUT_MS,
  runtimeDatabaseConfigFailureText,
  runtimePoolOptions,
  type RuntimeDatabaseConfigFailure,
} from "../src/server/database-config";
import {
  adminDatabaseFailureText,
  adminDatabaseTransport,
  ADMIN_STATEMENT_TIMEOUT_MS,
} from "../src/server/admin-database";

/**
 * These cases describe the transport policy, not a live database. Nothing in
 * this file opens a connection, so it runs in every environment, including the
 * hosted one it is designed to protect.
 */

const POOLED = "ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech";
const DIRECT = "ep-cool-name-123456.eu-central-1.aws.neon.tech";

const url = (host: string, query = "", credentials = "ponte_app:pw") =>
  `postgresql://${credentials}@${host}/ponte${query}`;

function reason(
  connectionString: string | undefined,
): RuntimeDatabaseConfigFailure {
  const result = parseRuntimeDatabaseUrl(
    { DATABASE_URL: connectionString },
    { requirePooled: true },
  );
  assert.equal(result.ok, false, `expected a refusal for ${connectionString}`);
  return (result as { ok: false; reason: RuntimeDatabaseConfigFailure }).reason;
}

test("a Neon pooled URL with verified TLS is accepted", () => {
  for (const query of [
    "",
    "?sslmode=verify-full",
    "?sslmode=verify-full&channel_binding=require",
  ]) {
    const result = parseRuntimeDatabaseUrl(
      { DATABASE_URL: url(POOLED, query) },
      { requirePooled: true },
    );
    assert.equal(result.ok, true, `expected acceptance for query "${query}"`);
    if (!result.ok) return;
    assert.equal(result.config.pooled, true);
    assert.equal(result.config.host, POOLED);
    assert.equal(result.config.max, RUNTIME_POOL_MAX);
    assert.deepEqual(Object.keys(result.config).sort(), [
      "connectionString",
      "connectionTimeoutMillis",
      "host",
      "idleInTransactionTimeoutMs",
      "max",
      "pooled",
      "statementTimeoutMs",
    ]);
  }
});

test("the runtime refuses a direct (non-pooler) endpoint", () => {
  assert.equal(reason(url(DIRECT)), "DATABASE_URL_NOT_POOLED");
  // The administrative path is the explicit exception.
  const administrative = adminDatabaseTransport(url(DIRECT));
  assert.equal(administrative.ok, true);
});

test("the runtime refuses TLS settings weaker than verify-full", () => {
  for (const mode of [
    "require",
    "prefer",
    "verify-ca",
    "disable",
    "no-verify",
  ]) {
    assert.equal(
      reason(url(POOLED, `?sslmode=${mode}`)),
      "DATABASE_URL_SSL_NOT_VERIFIED",
      `sslmode=${mode} must not be accepted`,
    );
  }
});

test("the runtime refuses any query parameter it does not own", () => {
  const rejected = [
    "ssl=true",
    "sslcert=/tmp/cert.pem",
    "sslrootcert=/tmp/ca.pem",
    "uselibpqcompat=true&sslmode=verify-full",
    // Session settings: PgBouncer transaction mode leaks statement_timeout
    // across clients, and the pool already sends its own startup value.
    "statement_timeout=1000",
    "lock_timeout=1000",
    "idle_in_transaction_session_timeout=1000",
    "options=-c%20search_path%3Dcustom",
    "application_name=other",
  ];
  for (const query of rejected) {
    assert.equal(
      reason(url(POOLED, `?${query}`)),
      "DATABASE_URL_UNSUPPORTED_PARAMETER",
      `?${query} must be refused`,
    );
  }
});

test("the runtime refuses local, loopback, and internal hosts", () => {
  assert.equal(
    reason("postgresql://u:p@localhost:5432/ponte"),
    "DATABASE_URL_LOCAL_HOST",
  );
  assert.equal(
    reason("postgresql://u:p@127.0.0.1:5432/ponte"),
    "DATABASE_URL_LOCAL_HOST",
  );
  assert.equal(
    reason("postgresql://u:p@127.9.9.9:5432/ponte"),
    "DATABASE_URL_LOCAL_HOST",
  );
  assert.equal(
    reason("postgresql://u:p@[::1]:5432/ponte"),
    "DATABASE_URL_LOCAL_HOST",
  );
  assert.equal(
    reason("postgresql://u:p@0.0.0.0:5432/ponte"),
    "DATABASE_URL_LOCAL_HOST",
  );
  assert.equal(
    reason("postgresql://u:p@db.internal:5432/ponte"),
    "DATABASE_URL_FORBIDDEN_HOST",
  );
  assert.equal(
    reason("postgresql://u:p@postgres.local:5432/ponte"),
    "DATABASE_URL_FORBIDDEN_HOST",
  );
});

test("the runtime refuses missing, malformed, and incomplete URLs", () => {
  assert.equal(reason(undefined), "DATABASE_URL_UNCONFIGURED");
  assert.equal(reason(""), "DATABASE_URL_UNCONFIGURED");
  assert.equal(reason(` ${url(POOLED)}`), "DATABASE_URL_UNCONFIGURED");
  assert.equal(reason(`${url(POOLED)}\n`), "DATABASE_URL_UNCONFIGURED");
  assert.equal(reason("not a url"), "DATABASE_URL_INVALID");
  assert.equal(reason("mysql://u:p@example.com/ponte"), "DATABASE_URL_SCHEME");
  assert.equal(
    reason("postgresql://ponte_app@" + POOLED + "/ponte"),
    "DATABASE_URL_INVALID",
  );
  assert.equal(reason(url(POOLED, "", "ponte_app")), "DATABASE_URL_INVALID");
  assert.equal(
    reason(`postgresql://ponte_app:pw@${POOLED}`),
    "DATABASE_URL_INVALID",
  );
  assert.equal(reason(url(POOLED, "#fragment")), "DATABASE_URL_INVALID");
});

test("every failure has a sentence that never quotes the URL", () => {
  const secrets = ["pw", POOLED, "ponte_app"];
  for (const [failure, text] of Object.entries(
    runtimeDatabaseConfigFailureText,
  )) {
    assert.ok(text.length > 20, `${failure} needs an operator sentence`);
    for (const secret of secrets) {
      assert.equal(
        text.includes(secret),
        false,
        `${failure} must not quote "${secret}"`,
      );
    }
  }
});

test("the runtime never returns connection details in a failure", () => {
  const result = parseRuntimeDatabaseUrl(
    { DATABASE_URL: url(DIRECT) },
    { requirePooled: true },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(result).sort(), ["ok", "reason"]);
  const serialized = JSON.stringify(result);
  for (const secret of ["pw", "ponte_app", DIRECT]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("pool options force verified TLS and the documented budgets", () => {
  const parsed = parseRuntimeDatabaseUrl(
    { DATABASE_URL: url(POOLED) },
    { requirePooled: true },
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const options = runtimePoolOptions(parsed.config);
  // `pg`'s `ssl: true` only requests TLS; an explicit object verifies the
  // chain and hostname. A future sslmode-semantics change cannot weaken this.
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.equal(options.max, RUNTIME_POOL_MAX);
  assert.equal(options.connectionTimeoutMillis, RUNTIME_CONNECTION_TIMEOUT_MS);
  assert.equal(options.statement_timeout, RUNTIME_STATEMENT_TIMEOUT_MS);
  assert.equal(
    options.idle_in_transaction_session_timeout,
    RUNTIME_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  );
  // PgBouncer tracks application_name per client, so it is safe and useful.
  assert.equal(options.application_name, "ponte-web");
  // A live web process must not exit with idle clients; Next.js keeps serving.
  assert.equal(options.allowExitOnIdle, false);
});

test("the policy accepts no connection string that overrides its TLS object", () => {
  // `pg` parses a connection string over explicit options, so an accepted URL
  // must never carry an SSL override. The accepted set is checked exhaustively
  // here rather than trusting the individual cases above.
  const candidates = [
    "",
    "?ssl=true",
    "?ssl=false",
    "?sslmode=require",
    "?sslmode=verify-full",
    "?sslrootcert=/etc/ca.pem",
    "?uselibpqcompat=true",
  ];
  for (const query of candidates) {
    const parsed = parseRuntimeDatabaseUrl(
      { DATABASE_URL: url(POOLED, query) },
      { requirePooled: true },
    );
    if (!parsed.ok) continue;
    assert.equal(
      parsed.config.connectionString.includes("ssl"),
      query.includes("sslmode=verify-full"),
      `accepted URL must only mention ssl via sslmode=verify-full (got "${query}")`,
    );
    assert.equal(
      declaresVerifiedTls(parsed.config.connectionString),
      query.includes("verify-full"),
    );
  }
});

test("declaresVerifiedTls is false for a URL without the parameter", () => {
  assert.equal(declaresVerifiedTls(url(POOLED)), false);
  assert.equal(declaresVerifiedTls(url(POOLED, "?sslmode=verify-full")), true);
  assert.equal(declaresVerifiedTls("not a url"), false);
});

test("the administrative transport requires the direct endpoint", () => {
  const pooled = adminDatabaseTransport(url(POOLED));
  assert.equal(pooled.ok, false);
  if (pooled.ok) return;
  assert.equal(pooled.failure, "ADMIN_DATABASE_URL_IS_POOLED");

  const direct = adminDatabaseTransport(url(DIRECT));
  assert.equal(direct.ok, true);
  if (!direct.ok) return;
  assert.equal(direct.transport.max, 1);
  assert.deepEqual(direct.transport.ssl, { rejectUnauthorized: true });
  assert.equal(direct.transport.application_name, "ponte-admin");
  assert.equal(direct.transport.statement_timeout, ADMIN_STATEMENT_TIMEOUT_MS);
});

test("the administrative transport refuses weak TLS and local hosts", () => {
  const cases: Array<[string | undefined, string]> = [
    [undefined, "ADMIN_DATABASE_URL_UNCONFIGURED"],
    [" ", "ADMIN_DATABASE_URL_UNCONFIGURED"],
    ["nope", "ADMIN_DATABASE_URL_INVALID"],
    ["mysql://u:p@example.com/db", "ADMIN_DATABASE_URL_INVALID"],
    ["postgresql://u:p@localhost:5432/ponte", "ADMIN_DATABASE_URL_LOCAL_HOST"],
    ["postgresql://u:p@127.0.0.1:5432/ponte", "ADMIN_DATABASE_URL_LOCAL_HOST"],
    [
      "postgresql://u:p@db.internal:5432/ponte",
      "ADMIN_DATABASE_URL_FORBIDDEN_HOST",
    ],
    [url(DIRECT, "?sslmode=require"), "ADMIN_DATABASE_URL_SSL_NOT_VERIFIED"],
    [url(DIRECT, "?ssl=true"), "ADMIN_DATABASE_URL_UNSUPPORTED_PARAMETER"],
    [
      url(DIRECT, "?statement_timeout=1"),
      "ADMIN_DATABASE_URL_UNSUPPORTED_PARAMETER",
    ],
    [`postgresql://ponte_app@${DIRECT}/ponte`, "ADMIN_DATABASE_URL_INVALID"],
  ];
  for (const [connectionString, expected] of cases) {
    const result = adminDatabaseTransport(connectionString);
    assert.equal(result.ok, false, `expected refusal for ${connectionString}`);
    if (result.ok) continue;
    assert.equal(result.failure, expected);
    assert.ok(adminDatabaseFailureText[result.failure].length > 20);
  }
});
