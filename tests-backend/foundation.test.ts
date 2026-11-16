import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execute, ApiError } from "../src/server/service";
import { pool } from "../src/server/repository";
import type { Invoice } from "../src/lib/models";
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
after(async () => {
  await pool.end();
});
test("authorization fails closed; inactive memberships and viewers cannot mutate", async () => {
  await assert.rejects(
    request("", undefined, undefined, undefined, "wrong"),
    error("UNAUTHENTICATED"),
  );
  await pool.query(
    "UPDATE memberships SET role='viewer' WHERE business_id=$1",
    [business],
  );
  try {
    await assert.rejects(create(), error("FORBIDDEN"));
    await request("");
  } finally {
    await pool.query(
      "UPDATE memberships SET role='admin' WHERE business_id=$1",
      [business],
    );
  }
  await pool.query(
    "UPDATE memberships SET status='disabled' WHERE business_id=$1",
    [business],
  );
  try {
    await assert.rejects(request(""), error("FORBIDDEN"));
  } finally {
    await pool.query(
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
    pool.query("UPDATE payment_events SET kind='tamper' WHERE invoice_id=$1", [
      i.id,
    ]),
    /append only/,
  );
});
test("cross-tenant reads/mutations rejected even with a valid active membership", async () => {
  const i = await create(),
    other = randomUUID(),
    user = process.env.PONTE_DEV_USER_ID!;
  await pool.query("INSERT INTO businesses VALUES($1,$2)", [
    other,
    "Other tenant",
  ]);
  await pool.query("INSERT INTO memberships VALUES($1,$2,'admin','active')", [
    other,
    user,
  ]);
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
  const q = (await request(`/${i.id}/quotes`, {})) as { id: string };
  await pool.query(
    "UPDATE quotes SET expires_at=now()-interval '1 second' WHERE id=$1",
    [q.id],
  );
  await assert.rejects(
    transition(i.id, "Routing", { route: "split", quoteId: q.id }),
    error("QUOTE_EXPIRED_OR_MISSING"),
  );
  const fresh = (await request(`/${i.id}/quotes`, {})) as { id: string };
  await transition(i.id, "Routing", { route: "split", quoteId: fresh.id });
  await assert.rejects(
    transition(i.id, "Settled", { route: "direct" }),
    error("ROUTE_LOCKED"),
  );
  await pool.query(
    "UPDATE quotes SET expires_at=now()-interval '1 second' WHERE id=$1",
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
  const i = await funded(),
    q = (await request(`/${i.id}/quotes`, {})) as { id: string };
  await transition(i.id, "Routing", { route: "split", quoteId: q.id });
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
    await pool.query("DELETE FROM rate_limits WHERE identity=$1", [identity]);
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
      await db.query("UPDATE invoices SET status='Failed' WHERE id=$1", [i.id]);
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
      "INSERT INTO payments VALUES($1,$2,$3,'simulation',$4,100,now())",
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
