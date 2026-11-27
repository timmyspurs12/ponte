import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execute, ApiError } from "../src/server/service";
import { pool } from "../src/server/repository";
import type { Invoice } from "../src/lib/models";
import { fixtures } from "./helpers/fixtures";
import { primeRoutedState } from "./helpers/routed-fixture";
const token = process.env.PONTE_DEV_TOKEN!,
  business = process.env.PONTE_DEV_BUSINESS_ID!;
const input = () => ({
  reference: `TEST-${randomUUID()}`,
  supplier: "Integration supplier",
  wallet: `0x${"a".repeat(40)}`,
  fundingMinor: "2500001",
  due: "2027-12-20",
  description: "Test simulation",
});
function request(
  path: string,
  body?: unknown,
  key = randomUUID(),
  method = "POST",
  auth = token,
) {
  return execute(
    new Request(`http://localhost/api/v1/invoices${path}`, {
      method: body === undefined ? "GET" : method,
      headers: {
        authorization: `Bearer ${auth}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    ["invoices", ...path.split("/").filter(Boolean)],
  );
}
async function create() {
  return (await request("", input())) as Invoice;
}
async function transition(id: string, status: string, extra = {}) {
  return request(`/${id}/transitions`, {
    status,
    ...extra,
  }) as Promise<Invoice>;
}
async function funded() {
  const i = await create();
  await transition(i.id, "Pending payment");
  await transition(i.id, "Funded");
  return i;
}
const error = (code: string) => (e: unknown) =>
  e instanceof ApiError && e.code === code;

/**
 * Creates an invoice, moves it to `Funded` through the application API, creates
 * a quote through the API, and then primes the `Routing` state administratively.
 *
 * Routing itself cannot run under the application identity: the quote row lock
 * requires an UPDATE grant that R1 deliberately withholds, so
 * `POST /transitions {status:"Routing"}` fails closed with a sanitised
 * `EVIDENCE_PERSISTENCE_FAILED` (docs/PHASE2C2B_R1_ROUTING_LIMITATION.md).
 *
 * Settlement is *not* blocked — `settlements` carries an app UPDATE grant — so
 * every step after this priming (settling, replay, receipts, history) runs on
 * the application identity and is asserted as real application behaviour.
 */
async function routed(routeId: "direct" | "split" | "multi" = "split") {
  const i = await funded();
  const q = (await request(`/${i.id}/quotes`, {})) as {
    id: string;
    data: {
      routes: { id: string; outputMinor: string; minimumOutputMinor: string }[];
    };
  };
  const chosen = q.data.routes.find((r) => r.id === routeId)!;
  await primeRoutedState({
    businessId: business,
    invoiceId: i.id,
    quoteId: q.id,
    userId: process.env.PONTE_DEV_USER_ID!,
    routeId,
    expectedMinor: chosen.outputMinor,
    minimumMinor: chosen.minimumOutputMinor,
  });
  return { invoice: i, quoteId: q.id };
}
after(async () => {
  await pool.end();
});
test("authorization fails closed; inactive memberships and viewers cannot mutate", async () => {
  await assert.rejects(
    request("", undefined, undefined, undefined, "wrong"),
    error("UNAUTHENTICATED"),
  );
  await fixtures(
    "UPDATE memberships SET role='viewer' WHERE business_id=$1",
    [business],
  );
  try {
    await assert.rejects(create(), error("FORBIDDEN"));
    await request("");
  } finally {
    await fixtures(
      "UPDATE memberships SET role='admin' WHERE business_id=$1",
      [business],
    );
  }
  await fixtures(
    "UPDATE memberships SET status='disabled' WHERE business_id=$1",
    [business],
  );
  try {
    await assert.rejects(request(""), error("FORBIDDEN"));
  } finally {
    await fixtures(
      "UPDATE memberships SET status='active' WHERE business_id=$1",
      [business],
    );
  }
  const previous = process.env.NODE_ENV;
  Object.assign(process.env, { NODE_ENV: "production" });
  try {
    await assert.rejects(request(""), error("AUTH_NOT_CONFIGURED"));
  } finally {
    Object.assign(process.env, { NODE_ENV: previous });
  }
});
test("exact amount validation, strict fields, unique reference and Draft-only update", async () => {
  for (const fundingMinor of ["1", "1.00", "-100", "1000000001", "1e4"])
    await assert.rejects(request("", { ...input(), fundingMinor }));
  await assert.rejects(request("", { ...input(), status: "Settled" }));
  const body = input(),
    i = (await request("", body)) as Invoice;
  assert.equal(i.fundingMinor, "2500001");
  assert.equal(i.quote!.routes[1].outputMinor, "473904");
  await assert.rejects(
    request("", { ...body, reference: body.reference.toLowerCase() }),
    (e) => (e as { code: string }).code === "23505",
  );
  const updated = (await request(
    `/${i.id}`,
    { ...body, supplier: "Updated supplier" },
    undefined,
    "PATCH",
  )) as Invoice;
  assert.equal(updated.supplier, "Updated supplier");
  await transition(i.id, "Pending payment");
  await assert.rejects(
    request(`/${i.id}`, body, undefined, "PATCH"),
    error("INVOICE_LOCKED"),
  );
});
test("idempotency replay, conflicting payload, and concurrent duplicate payments are safe", async () => {
  const body = input(),
    key = randomUUID();
  const results = await Promise.all([
    request("", body, key),
    request("", body, key),
  ]);
  assert.deepEqual(results[0], results[1]);
  await assert.rejects(
    request("", input(), key),
    error("IDEMPOTENCY_CONFLICT"),
  );
  const i = results[0] as Invoice;
  await transition(i.id, "Pending payment");
  const raced = await Promise.allSettled([
    transition(i.id, "Funded"),
    transition(i.id, "Funded"),
  ]);
  assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(((await request(`/${i.id}/payments`)) as unknown[]).length, 1);
  const events = (await request(`/${i.id}/activity`)) as unknown[];
  assert.equal(events.length, 3);
  await assert.rejects(
    fixtures("UPDATE payment_events SET kind='tamper' WHERE invoice_id=$1", [
      i.id,
    ]),
    /append only/,
  );
});
test("cross-tenant reads/mutations rejected even with a valid active membership", async () => {
  const i = await create(),
    other = randomUUID(),
    user = process.env.PONTE_DEV_USER_ID!;
  await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    other,
    "Other tenant",
  ]);
  await fixtures(
    "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,'admin','active')",
    [other, user],
  );
  process.env.PONTE_DEV_BUSINESS_ID = other;
  try {
    await assert.rejects(request(`/${i.id}`), error("NOT_FOUND"));
    await assert.rejects(
      transition(i.id, "Pending payment"),
      error("NOT_FOUND"),
    );
    assert.deepEqual(await request(""), []);
    await request("", { ...input(), reference: i.reference });
  } finally {
    process.env.PONTE_DEV_BUSINESS_ID = business;
  }
});
test("Routing persists the full effect set while the rest of the state machine is unchanged", async () => {
  // Phase 2C.3 restores the pre-R1 contract: the Routing transition completes
  // through the SECURITY DEFINER lock functions and commits the full
  // final-persistence effect set — settlement, evidence envelope, pending
  // outbox row, and the Routing invoice state.
  const i = await funded();
  const q = (await request(`/${i.id}/quotes`, {})) as { id: string };
  const routed = (await transition(i.id, "Routing", {
    route: "split",
    quoteId: q.id,
  })) as Invoice;
  assert.equal(routed.status, "Routing");

  // Exactly one settlement, one evidence envelope, and one outbox row exist
  // for the invoice (the outbox is keyed by evidence record).
  for (const table of [
    "settlements",
    "route_decision_evidence",
  ]) {
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE invoice_id=$1`,
      [i.id],
    );
    assert.equal(rows.rows[0].n, 1, `${table} must hold exactly one row`);
  }
  const outbox = await pool.query(
    `SELECT count(*)::int AS n
       FROM evidence_outbox o
       JOIN route_decision_evidence e ON e.id = o.evidence_record_id
      WHERE e.invoice_id=$1`,
    [i.id],
  );
  assert.equal(outbox.rows[0].n, 1, "evidence_outbox must hold one row");
});

test("state machine rejects skipped transitions; server quote locks route and expires", async () => {
  const i = await create();
  await assert.rejects(
    transition(i.id, "Settled"),
    error("INVALID_TRANSITION"),
  );
  await transition(i.id, "Pending payment");
  await transition(i.id, "Funded");
  await assert.rejects(
    transition(i.id, "Routing", { route: "split" }),
    error("QUOTE_AND_ROUTE_REQUIRED"),
  );
  const q = (await request(`/${i.id}/quotes`, {})) as {
    id: string;
    data: {
      routes: { id: string; outputMinor: string; minimumOutputMinor: string }[];
    };
  };
  await fixtures(
    "UPDATE quotes SET expires_at=date_trunc('milliseconds',clock_timestamp())-interval '1 second' WHERE id=$1",
    [q.id],
  );
  // Phase 2C.3: the quote lock function applies the database-time expiry
  // predicate at lock time, so an expired quote surfaces the precise
  // `QUOTE_EXPIRED_OR_MISSING` precondition — not the R1 generic failure.
  await assert.rejects(
    transition(i.id, "Routing", { route: "split", quoteId: q.id }),
    error("QUOTE_EXPIRED_OR_MISSING"),
  );

  // Routing now completes through the application itself (the lock functions
  // carry the row locks). Every settlement assertion below is still
  // application behaviour: `settlements` carries an app UPDATE grant.
  const fresh = (await request(`/${i.id}/quotes`, {})) as typeof q;
  await transition(i.id, "Routing", { route: "split", quoteId: fresh.id });
  await assert.rejects(
    transition(i.id, "Settled", { route: "direct" }),
    error("ROUTE_LOCKED"),
  );

  // Expiry is what the settlement lock checks, and it is evaluated at settle
  // time: priming uses the still-valid quote above, then the quote is expired
  // so the app-side settlement is refused.
  await fixtures(
    "UPDATE quotes SET expires_at=date_trunc('milliseconds',clock_timestamp())-interval '1 second' WHERE id=$1",
    [fresh.id],
  );
  await assert.rejects(
    transition(i.id, "Settled", { route: "split" }),
    error("QUOTE_EXPIRED_OR_MISSING"),
  );
  await transition(i.id, "Failed");
  await assert.rejects(
    transition(i.id, "Routing"),
    error("INVALID_TRANSITION"),
  );
});
test("full settlement persists exact receipt, expected/actual output, no hash, and atomic history", async () => {
  const { invoice: i } = await routed("split");
  const key = randomUUID();
  const settled = (await request(
    `/${i.id}/transitions`,
    { status: "Settled", route: "split" },
    key,
  )) as Invoice;
  assert.equal(settled.receipt!.amountMinor, "473904");
  assert.deepEqual(
    await request(
      `/${i.id}/transitions`,
      { status: "Settled", route: "split" },
      key,
    ),
    settled,
  );
  assert.deepEqual(await request(`/${i.id}`), settled);
  await assert.rejects(
    transition(i.id, "Settled"),
    error("INVALID_TRANSITION"),
  );
  const records = (await request(`/${i.id}/settlements`)) as {
    actual_minor: string;
    expected_minor: string;
    transaction_hash: null;
  }[];
  assert.equal(records.length, 1);
  assert.equal(records[0].actual_minor, records[0].expected_minor);
  assert.equal(records[0].transaction_hash, null);
  assert.equal(((await request(`/${i.id}/activity`)) as unknown[]).length, 6);
});
test("settlement history carries server-owned simulation provenance for current and existing rows", async () => {
  const { GET, POST } = await import("../src/app/api/v1/[...path]/route");
  const i = await funded();
  const path = ["invoices", i.id, "settlements"];
  const url = `http://localhost/api/v1/invoices/${i.id}/settlements`;
  const history = (authorization = `Bearer ${token}`) =>
    GET(new Request(url, { headers: { authorization } }), {
      params: Promise.resolve({ path }),
    });
  const readHistory = async (status: string) => {
    const response = await history();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.match(body.requestId, /^[\w-]+$/);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].simulated, true);
    assert.equal(body.data[0].status, status);
    assert.equal(body.data[0].transaction_hash, null);
    const stored = await pool.query(
      "SELECT * FROM settlements WHERE invoice_id=$1",
      [i.id],
    );
    // JSON serialization mirrors the HTTP handler's Date conversion. Every
    // original field is preserved; only server-owned provenance is added.
    assert.deepEqual(body.data[0], {
      ...JSON.parse(JSON.stringify(stored.rows[0])),
      simulated: true,
    });
    return body.data[0];
  };
  const send = (resource: string, body: unknown, key = randomUUID()) =>
    POST(
      new Request(`http://localhost/api/v1/invoices/${i.id}/${resource}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ path: ["invoices", i.id, resource] }) },
    );

  assert.deepEqual((await (await history()).json()).data, []);
  const rejectedQuote = await send("quotes", { simulated: false });
  assert.equal(rejectedQuote.status, 422);
  assert.equal((await rejectedQuote.json()).error.code, "VALIDATION_ERROR");
  const q = (await request(`/${i.id}/quotes`, {})) as {
    id: string;
    data: {
      simulated: boolean;
      routes: { id: string; outputMinor: string; minimumOutputMinor: string }[];
    };
  };
  assert.equal(q.data.simulated, true);

  const routing = { status: "Routing", route: "split", quoteId: q.id };
  for (const simulated of [false, true, "false", null]) {
    const rejected = await send("transitions", { ...routing, simulated });
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error.code, "VALIDATION_ERROR");
  }
  assert.deepEqual((await (await history()).json()).data, []);

  // Prime `Routing` (see `routed()`). Settlement itself is app-permitted: the
  // `settlements` UPDATE grant exists, so the transitions below are real
  // application behaviour.
  const splitRoute = q.data.routes.find((r) => r.id === "split")!;
  await primeRoutedState({
    businessId: business,
    invoiceId: i.id,
    quoteId: q.id,
    userId: process.env.PONTE_DEV_USER_ID!,
    routeId: "split",
    expectedMinor: splitRoute.outputMinor,
    minimumMinor: splitRoute.minimumOutputMinor,
  });

  // The invoice is already `Routing` from the priming step; the settlement row
  // that history reports is the one it wrote. Simulated provenance is
  // server-owned and must not be forgeable through the query string.
  const first = await readHistory("Routing");
  assert.equal(first.actual_minor, null);
  assert.equal(first.settled_at, null);
  const forgedQuery = await GET(
    new Request(`${url}?simulated=false`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({ path }) },
  );
  assert.equal((await forgedQuery.json()).data[0].simulated, true);
  assert.equal((await send("settlements", { simulated: false })).status, 404);
  await assert.rejects(
    fixtures("UPDATE quotes SET simulated=false WHERE id=$1", [q.id]),
    (e) => (e as { code: string }).code === "23514",
  );
  await assert.rejects(
    fixtures(
      "UPDATE settlements SET transaction_hash='not-a-real-hash' WHERE id=$1",
      [first.id],
    ),
    (e) => (e as { code: string }).code === "23514",
  );

  assert.equal((await history("Bearer wrong")).status, 401);
  const denied = await GET(new Request(url), {
    params: Promise.resolve({ path }),
  });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.code, "UNAUTHENTICATED");
  const user = process.env.PONTE_DEV_USER_ID!;
  const other = randomUUID();
  await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    other,
    "Other history tenant",
  ]);
  await fixtures(
    "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,'admin','active')",
    [other, user],
  );
  process.env.PONTE_DEV_BUSINESS_ID = other;
  try {
    const crossTenant = await history();
    assert.equal(crossTenant.status, 404);
    assert.equal((await crossTenant.json()).error.code, "NOT_FOUND");
  } finally {
    process.env.PONTE_DEV_BUSINESS_ID = business;
  }
  await fixtures(
    "UPDATE memberships SET role='viewer' WHERE business_id=$1 AND user_id=$2",
    [business, user],
  );
  try {
    assert.equal((await history()).status, 200);
    assert.equal(
      (await send("transitions", { status: "Settled" })).status,
      403,
    );
  } finally {
    await fixtures(
      "UPDATE memberships SET role='admin' WHERE business_id=$1 AND user_id=$2",
      [business, user],
    );
  }
  await fixtures(
    "UPDATE memberships SET status='disabled' WHERE business_id=$1 AND user_id=$2",
    [business, user],
  );
  try {
    assert.equal((await history()).status, 403);
  } finally {
    await fixtures(
      "UPDATE memberships SET status='active' WHERE business_id=$1 AND user_id=$2",
      [business, user],
    );
  }
  const previous = process.env.NODE_ENV;
  Object.assign(process.env, { NODE_ENV: "production" });
  try {
    const production = await history();
    assert.equal(production.status, 503);
    assert.equal((await production.json()).error.code, "AUTH_NOT_CONFIGURED");
  } finally {
    Object.assign(process.env, { NODE_ENV: previous });
  }
  const rejectedSettle = await send("transitions", {
    status: "Settled",
    simulated: false,
  });
  assert.equal(rejectedSettle.status, 422);
  assert.equal((await readHistory("Routing")).id, first.id);
  const settleKey = randomUUID();
  const settled = (await request(
    `/${i.id}/transitions`,
    { status: "Settled" },
    settleKey,
  )) as Invoice;
  assert.deepEqual(
    await request(`/${i.id}/transitions`, { status: "Settled" }, settleKey),
    settled,
  );
  assert.equal(settled.receipt!.execution.simulated, true);
  assert.match(settled.receipt!.execution.identifier, /^SIM-/);
  const completed = await readHistory("Settled");
  assert.equal(completed.id, first.id);
  assert.equal(completed.actual_minor, completed.expected_minor);
  assert.ok(completed.settled_at);

  // A `Failed` settlement edge: primed into `Routing` (see `routed()`), then
  // failed through the application API. `failSettlement` is app-permitted.
  const failed = await funded();
  const failedQuote = (await request(`/${failed.id}/quotes`, {})) as {
    id: string;
    data: {
      routes: { id: string; outputMinor: string; minimumOutputMinor: string }[];
    };
  };
  const failedRoute = failedQuote.data.routes.find((r) => r.id === "split")!;
  await primeRoutedState({
    businessId: business,
    invoiceId: failed.id,
    quoteId: failedQuote.id,
    userId: process.env.PONTE_DEV_USER_ID!,
    routeId: "split",
    expectedMinor: failedRoute.outputMinor,
    minimumMinor: failedRoute.minimumOutputMinor,
  });
  await transition(failed.id, "Failed");
  const failedHistory = (await request(`/${failed.id}/settlements`)) as Array<
    Record<string, unknown>
  >;
  assert.equal(failedHistory.length, 1);
  assert.equal(failedHistory[0].simulated, true);
  assert.equal(failedHistory[0].status, "Failed");
  assert.equal(failedHistory[0].transaction_hash, null);
  assert.equal(failedHistory[0].actual_minor, null);

  // Construct a record in the unchanged legacy schema, without any persisted
  // simulated field, just as a settlement created before this response change.
  const legacy = await funded();
  const legacyQuote = (await request(`/${legacy.id}/quotes`, {})) as {
    id: string;
  };
  await pool.query(
    "INSERT INTO settlements(id,business_id,invoice_id,quote_id,route_id,expected_minor,minimum_minor,status) VALUES($1,$2,$3,$4,'direct',100,99,'Routing')",
    [randomUUID(), business, legacy.id, legacyQuote.id],
  );
  const legacyRow = (
    await pool.query("SELECT * FROM settlements WHERE invoice_id=$1", [
      legacy.id,
    ])
  ).rows[0];
  assert.equal(Object.hasOwn(legacyRow, "simulated"), false);
  const legacyHistory = await request(`/${legacy.id}/settlements`);
  assert.deepEqual(legacyHistory, [{ ...legacyRow, simulated: true }]);
  const payment = (
    (await request(`/${i.id}/payments`)) as Array<Record<string, unknown>>
  )[0];
  const events = (await request(`/${i.id}/activity`)) as Array<
    Record<string, unknown>
  >;
  assert.equal(Object.hasOwn(payment, "simulated"), false);
  assert.ok(events.every((entry) => !Object.hasOwn(entry, "simulated")));
});
test("pagination/filter validation and persisted rate limiting", async () => {
  await assert.rejects(
    execute(
      new Request("http://localhost/api/v1/invoices?limit=101", {
        headers: { authorization: `Bearer ${token}` },
      }),
      ["invoices"],
    ),
  );
  const identity = `${business}:${process.env.PONTE_DEV_USER_ID}`;
  await pool.query("UPDATE rate_limits SET hits=120 WHERE identity=$1", [
    identity,
  ]);
  try {
    await assert.rejects(request(""), error("RATE_LIMITED"));
  } finally {
    await fixtures("DELETE FROM rate_limits WHERE identity=$1", [identity]);
  }
});
test("Route Handler returns stable envelopes, safe errors and correct status codes", async () => {
  const { GET, POST } = await import("../src/app/api/v1/[...path]/route");
  const params = { params: Promise.resolve({ path: ["invoices"] }) };
  const denied = await GET(
    new Request("http://localhost/api/v1/invoices"),
    params,
  );
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.code, "UNAUTHENTICATED");
  const invalid = await POST(
    new Request("http://localhost/api/v1/invoices", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: "{}",
    }),
    params,
  );
  assert.equal(invalid.status, 422);
  assert.equal((await invalid.json()).error.code, "VALIDATION_ERROR");
  const good = await GET(
    new Request("http://localhost/api/v1/invoices?limit=2", {
      headers: { authorization: `Bearer ${token}` },
    }),
    params,
  );
  assert.equal(good.status, 200);
  assert.equal(good.headers.get("cache-control"), "no-store");
  const result = await good.json();
  assert.equal(result.data.length, 2);
  assert.match(result.requestId, /^[\w-]+$/);
});
test("database constraints, real PostgreSQL UTF8 and rollback protect financial records", async () => {
  const { transaction } = await import("../src/server/repository");
  const version = await pool.query(
    "SELECT version(),current_setting('server_encoding') AS encoding",
  );
  assert.match(version.rows[0].version, /PostgreSQL 18/);
  assert.equal(version.rows[0].encoding, "UTF8");
  const i = await create();
  await assert.rejects(
    pool.query("UPDATE invoices SET funding_minor=0 WHERE id=$1", [i.id]),
    (e) => (e as { code: string }).code === "23514",
  );
  await assert.rejects(
    transaction(async (db) => {
      await db.query(
        "UPDATE invoices SET status='Failed',data=jsonb_set(data,'{status}','\"Failed\"') WHERE id=$1",
        [i.id],
      );
      throw new Error("forced rollback");
    }),
    /forced rollback/,
  );
  assert.equal(
    (await pool.query("SELECT status FROM invoices WHERE id=$1", [i.id]))
      .rows[0].status,
    "Draft",
  );
  const wrongTenant = randomUUID();
  await assert.rejects(
    pool.query(
      "INSERT INTO payments(id,business_id,invoice_id,provider,provider_reference,funding_minor,received_at) VALUES($1,$2,$3,'simulation',$4,100,now())",
      [randomUUID(), wrongTenant, i.id, `SIM-${randomUUID()}`],
    ),
    (e) => (e as { code: string }).code === "23503",
  );
  await transition(i.id, "Pending payment");
  const q = (await request(`/${i.id}/quotes`, {})) as { id: string };
  assert.equal(
    ((await request(`/${i.id}/quotes/${q.id}`)) as { id: string }).id,
    q.id,
  );
  const other = await create();
  await assert.rejects(
    request(`/${other.id}/quotes/${q.id}`),
    error("NOT_FOUND"),
  );
});
test("same-origin checks accept the browser Host behind the Next bind address, not an attacker origin", async () => {
  const { sameOrigin } = await import("../src/server/security");
  assert.equal(
    sameOrigin(
      new Request("http://0.0.0.0:3000/dev-login", {
        headers: { host: "localhost:3000", origin: "http://localhost:3000" },
      }),
    ),
    true,
  );
  assert.equal(
    sameOrigin(
      new Request("http://0.0.0.0:3000/dev-login", {
        headers: {
          host: "localhost:3000",
          origin: "https://attacker.invalid",
          "x-forwarded-host": "attacker.invalid",
        },
      }),
    ),
    false,
  );
});
test("requested relational metadata stays consistent and timestamped through updates", async () => {
  const i = await create();
  assert.ok(i.createdAt);
  assert.ok(i.updatedAt);
  const updated = (await request(
    `/${i.id}`,
    { ...input(), reference: i.reference, supplier: "Metadata supplier" },
    undefined,
    "PATCH",
  )) as Invoice;
  assert.equal(updated.createdAt, i.createdAt);
  assert.ok(
    new Date(updated.updatedAt!).valueOf() >= new Date(i.updatedAt!).valueOf(),
  );
  const row = (
    await pool.query(
      "SELECT supplier_name,supplier_wallet_address,funding_currency,settlement_asset,due_date::text,description,data FROM invoices WHERE id=$1",
      [i.id],
    )
  ).rows[0];
  assert.equal(row.supplier_name, "Metadata supplier");
  assert.equal(row.funding_currency, "BRL");
  assert.equal(row.settlement_asset, "USDG");
  assert.equal(row.due_date, "2027-12-20");
  assert.equal(row.data.createdAt, undefined);
  assert.equal(row.data.updatedAt, undefined);
  await assert.rejects(
    fixtures(
      "UPDATE invoices SET data=jsonb_set(data,'{fundingMinor}','\"999\"') WHERE id=$1",
      [i.id],
    ),
    (e) => (e as { code: string }).code === "23514",
  );
  await assert.rejects(
    fixtures(
      "UPDATE invoices SET data=jsonb_set(data,'{status}','\"Settled\"') WHERE id=$1",
      [i.id],
    ),
    (e) => (e as { code: string }).code === "23514",
  );
  await assert.rejects(
    fixtures(
      "UPDATE invoices SET data=jsonb_set(data,'{fundingMinor}','null') WHERE id=$1",
      [i.id],
    ),
    (e) => (e as { code: string }).code === "23514",
  );
  await transition(i.id, "Pending payment");
  await transition(i.id, "Funded");
  const payment = (
    (await request(`/${i.id}/payments`)) as {
      funding_currency: string;
      status: string;
      received_at: string;
      created_at: string;
    }[]
  )[0];
  assert.equal(payment.funding_currency, "BRL");
  assert.equal(payment.status, "Confirmed");
  assert.ok(payment.received_at);
  assert.ok(payment.created_at);
  const metadata = await pool.query(
    "SELECT b.created_at,b.updated_at,u.created_at AS user_created,m.created_at AS membership_created FROM businesses b JOIN memberships m ON m.business_id=b.id JOIN users u ON u.id=m.user_id WHERE b.id=$1",
    [business],
  );
  assert.ok(metadata.rows[0].created_at);
  assert.ok(metadata.rows[0].user_created);
  assert.ok(metadata.rows[0].membership_created);
});
test("business activity is paginated, filtered and tenant scoped with explicit state edges", async () => {
  const i = await create();
  await transition(i.id, "Pending payment");
  await transition(i.id, "Funded");
  const activity = async (query = "") =>
    execute(
      new Request(`http://localhost/api/v1/activity${query}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      ["activity"],
    ) as Promise<
      {
        id: string;
        business_id: string;
        invoice_id: string;
        previous_state: string | null;
        new_state: string;
        kind: string;
      }[]
    >;
  const events = (await request(`/${i.id}/activity`)) as {
    previous_state: string | null;
    new_state: string;
  }[];
  assert.deepEqual(
    events.map((e) => [e.previous_state, e.new_state]),
    [
      [null, "Draft"],
      ["Draft", "Pending payment"],
      ["Pending payment", "Funded"],
    ],
  );
  const page = await activity("?limit=2&offset=0&type=invoice.Funded");
  assert.ok(page.length <= 2);
  assert.ok(
    page.every(
      (e) => e.business_id === business && e.kind === "invoice.Funded",
    ),
  );
  const all = await activity("?limit=100");
  assert.ok(all.some((e) => e.invoice_id === i.id));
  if (all.length > 1) {
    const first = await activity("?limit=1");
    const second = await activity("?limit=1&offset=1");
    assert.notEqual(first[0].id, second[0].id);
  }
  await assert.rejects(activity("?limit=101"));
  const other = randomUUID();
  await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    other,
    "Empty activity tenant",
  ]);
  await fixtures(
    "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,'admin','active')",
    [other, process.env.PONTE_DEV_USER_ID],
  );
  process.env.PONTE_DEV_BUSINESS_ID = other;
  try {
    assert.deepEqual(await activity(), []);
  } finally {
    process.env.PONTE_DEV_BUSINESS_ID = business;
  }
});
test("malformed monetary values return validation errors, never BigInt conversion failures", async () => {
  const { POST } = await import("../src/app/api/v1/[...path]/route");
  for (const fundingMinor of [
    "1.00",
    "NaN",
    "1e4",
    "-100",
    "000100",
    "1000000000000000000000000000000000000",
  ]) {
    const response = await POST(
      new Request("http://localhost/api/v1/invoices", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify({ ...input(), fundingMinor }),
      }),
      { params: Promise.resolve({ path: ["invoices"] }) },
    );
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, "VALIDATION_ERROR");
  }
});
