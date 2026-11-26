import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import {
  __testOnlyAuthenticateProduction,
  type Context,
} from "../src/server/auth";
import { provisionGithubIdentity } from "../src/server/external-identities";
import type { ProductionAuthConfig } from "../src/server/auth-config";
import { ApiError, __testOnlyExecute } from "../src/server/service";
import { pool } from "../src/server/repository";
import {
  PUBLIC_DEMO_INVOICES,
  publicDemoInvoiceId,
  publicDemoQuoteId,
} from "../src/server/public-demo-data";
import { bootstrapPublicDemo } from "../scripts/production-demo-bootstrap";
import { resetSyntheticDemo } from "./public-demo-fixture";
import { operatorPool } from "./helpers/operator-pool";
import { fixtures } from "./helpers/fixtures";

after(async () => {
  await pool.end();
});

beforeEach(resetSyntheticDemo);

let subjectSequence = BigInt(Date.now()) + 5000000n;
const githubSubject = (label: string) => {
  void label;
  return `${subjectSequence++}`;
};

function config(
  administratorBusinessId: string,
  demoBusinessId: string,
  administratorSubject: string,
): ProductionAuthConfig {
  return {
    secret: "s".repeat(48),
    githubClientId: "Ov23liPonte123456",
    githubClientSecret: "c".repeat(40),
    baseUrl: "https://ponte.example.test",
    administratorBusinessId,
    administratorGithubSubjects: new Set([administratorSubject]),
    publicDemo: { businessId: demoBusinessId },
  };
}

const apiError = (code: string) => (error: unknown) =>
  error instanceof ApiError && error.code === code;

async function business(name: string): Promise<string> {
  const id = randomUUID();
  await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [id, name]);
  return id;
}

function request(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Request {
  return new Request(`http://localhost/api/v1/${path}`, {
    method,
    headers:
      method === "GET"
        ? {}
        : {
            origin: "http://localhost",
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
          },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
}

/** Uses the real production authorization path with a verified session shape. */
async function viewerContext(
  policy: ProductionAuthConfig,
): Promise<{ context: Context; userId: string }> {
  const identity = await provisionGithubIdentity(
    { subject: githubSubject("viewer"), login: "demo-viewer" },
    policy,
  );
  const context = await __testOnlyAuthenticateProduction(
    request("GET", "invoices"),
    {
      config: policy,
      session: { subject: identity.subject, login: identity.login },
    },
  );
  return { context, userId: identity.userId };
}

async function executeAs(context: Context, path: string[], body?: unknown) {
  const method = body === undefined ? "GET" : "POST";
  const [first, ...rest] = path;
  return __testOnlyExecute(
    request(method, [first, ...rest].join("/"), body),
    path,
    {
      authenticate: async () => context,
    },
  );
}

test("a provisioned synthetic tenant is readable by a public-demo viewer", async () => {
  const privateBusiness = await business("Viewer read private business");
  const demo = {
    businessId: randomUUID(),
    businessName: "Synthetic demo tenant read",
  };
  await bootstrapPublicDemo(operatorPool(), demo);
  const policy = config(
    privateBusiness,
    demo.businessId,
    githubSubject("admin"),
  );
  const { context, userId } = await viewerContext(policy);

  assert.equal(context.business, demo.businessId);
  assert.equal(context.role, "viewer");
  assert.equal(context.isPublicDemo, true);

  const listed = (await executeAs(context, ["invoices"])) as { id: string }[];
  assert.equal(listed.length, PUBLIC_DEMO_INVOICES.length);
  const expectedIds = new Set(
    PUBLIC_DEMO_INVOICES.map((spec) => publicDemoInvoiceId(spec.slug)),
  );
  assert.ok(listed.every((invoice) => expectedIds.has(invoice.id)));

  const settled = PUBLIC_DEMO_INVOICES.find(
    (spec) => spec.status === "Settled",
  )!;
  const detail = (await executeAs(context, [
    "invoices",
    publicDemoInvoiceId(settled.slug),
  ])) as {
    status: string;
    receipt: { asset: string; execution: { simulated: true } };
  };
  assert.equal(detail.status, "Settled");
  assert.equal(detail.receipt.asset, "USDG");
  assert.equal(detail.receipt.execution.simulated, true);

  const settlements = (await executeAs(context, [
    "invoices",
    publicDemoInvoiceId(settled.slug),
    "settlements",
  ])) as { transaction_hash: string | null; simulated: true }[];
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].transaction_hash, null);
  assert.equal(settlements[0].simulated, true);

  const activity = (await executeAs(context, ["activity"])) as unknown[];
  assert.ok(Array.isArray(activity));

  // Viewing the demo must never create a membership or upgrade the viewer.
  const membership = await pool.query(
    "SELECT role,status FROM memberships WHERE business_id=$1 AND user_id=$2",
    [demo.businessId, userId],
  );
  assert.deepEqual(membership.rows, [{ role: "viewer", status: "active" }]);
});

test("a viewer cannot create, edit, fund, route or settle any demo record", async () => {
  const privateBusiness = await business("Viewer write private business");
  const demo = {
    businessId: randomUUID(),
    businessName: "Synthetic demo tenant write",
  };
  await bootstrapPublicDemo(operatorPool(), demo);
  const policy = config(
    privateBusiness,
    demo.businessId,
    githubSubject("admin"),
  );
  const { context } = await viewerContext(policy);

  const pendingInvoice = publicDemoInvoiceId(
    PUBLIC_DEMO_INVOICES.find((spec) => spec.status === "Pending payment")!
      .slug,
  );
  const fundedInvoice = publicDemoInvoiceId(
    PUBLIC_DEMO_INVOICES.find((spec) => spec.status === "Funded")!.slug,
  );
  const draftInvoice = publicDemoInvoiceId(
    PUBLIC_DEMO_INVOICES.find((spec) => spec.status === "Draft")!.slug,
  );
  const before = await pool.query(
    "SELECT (SELECT count(*) FROM invoices) AS invoices,(SELECT count(*) FROM payments) AS payments,(SELECT count(*) FROM quotes) AS quotes,(SELECT count(*) FROM settlements) AS settlements,(SELECT count(*) FROM payment_events) AS events",
  );

  const attempts: [string[], unknown][] = [
    [["invoices"], { reference: "DEMO-SYN-9999" }],
    [["invoices", pendingInvoice, "transitions"], { status: "Funded" }],
    [["invoices", pendingInvoice, "payments"], {}],
    [["invoices", fundedInvoice, "quotes"], {}],
    [
      ["invoices", fundedInvoice, "transitions"],
      {
        status: "Routing",
        route: "direct",
        quoteId: publicDemoQuoteId(
          PUBLIC_DEMO_INVOICES.find((spec) => spec.status === "Funded")!.slug,
        ),
      },
    ],
    [["invoices", draftInvoice, "transitions"], { status: "Pending payment" }],
  ];

  for (const [path, body] of attempts)
    await assert.rejects(
      executeAs(context, path, body),
      apiError("FORBIDDEN"),
      path.join("/"),
    );

  // PATCH on a demo invoice is a write and is refused before any body handling.
  await assert.rejects(
    __testOnlyExecute(
      new Request(`http://localhost/api/v1/invoices/${draftInvoice}`, {
        method: "PATCH",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify({}),
      }),
      ["invoices", draftInvoice],
      { authenticate: async () => context },
    ),
    apiError("FORBIDDEN"),
  );

  assert.deepEqual(
    (
      await pool.query(
        "SELECT (SELECT count(*) FROM invoices) AS invoices,(SELECT count(*) FROM payments) AS payments,(SELECT count(*) FROM quotes) AS quotes,(SELECT count(*) FROM settlements) AS settlements,(SELECT count(*) FROM payment_events) AS events",
      )
    ).rows,
    before.rows,
  );
});

test("a demo viewer cannot read or infer the private administrator tenant", async () => {
  const privateBusiness = await business("Cross-tenant private business");
  const privateInvoice = randomUUID();
  const privateReference = `PRIVATE-${privateInvoice}`;
  await pool.query(
    "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data) VALUES($1,$2,$3,250000,'Draft',$4)",
    [
      privateInvoice,
      privateBusiness,
      privateReference,
      JSON.stringify({
        id: privateInvoice,
        reference: privateReference,
        supplier: "Private tenant supplier must never leak",
        wallet: `0x${"c".repeat(40)}`,
        fundingCurrency: "BRL",
        settlementCurrency: "USDG",
        fundingMinor: "250000",
        amount: 2500,
        due: "2027-12-20",
        description: "Private record",
        status: "Draft",
      }),
    ],
  );
  const demo = {
    businessId: randomUUID(),
    businessName: "Synthetic demo tenant isolation",
  };
  await bootstrapPublicDemo(operatorPool(), demo);
  const policy = config(
    privateBusiness,
    demo.businessId,
    githubSubject("admin"),
  );
  const { context } = await viewerContext(policy);

  for (const path of [
    ["invoices", privateInvoice],
    ["invoices", privateInvoice, "evidence"],
    ["invoices", privateInvoice, "quotes"],
    ["invoices", privateInvoice, "payments"],
    ["invoices", privateInvoice, "settlements"],
    ["invoices", privateInvoice, "activity"],
  ])
    await assert.rejects(
      executeAs(context, path),
      apiError("NOT_FOUND"),
      path.join("/"),
    );

  const listed = JSON.stringify(await executeAs(context, ["invoices"]));
  assert.equal(listed.includes(privateReference), false);
  assert.equal(listed.includes("Private tenant supplier"), false);

  const activity = JSON.stringify(await executeAs(context, ["activity"]));
  assert.equal(activity.includes(privateInvoice), false);
});

test("a configured private administrator keeps the private tenant, not the demo", async () => {
  const privateBusiness = await business("Admin priority business");
  const demo = {
    businessId: randomUUID(),
    businessName: "Synthetic demo tenant priority",
  };
  await bootstrapPublicDemo(operatorPool(), demo);
  const administratorSubject = githubSubject("priority-admin");
  const policy = config(privateBusiness, demo.businessId, administratorSubject);
  const administrator = await provisionGithubIdentity(
    { subject: administratorSubject, login: "priority-admin" },
    policy,
  );
  const context = await __testOnlyAuthenticateProduction(
    request("GET", "invoices"),
    {
      config: policy,
      session: {
        subject: administrator.subject,
        login: administrator.login,
      },
    },
  );
  assert.equal(context.business, privateBusiness);
  assert.equal(context.role, "admin");
  assert.equal(context.isPublicDemo, false);

  const administratorMembership = await pool.query(
    "SELECT business_id,role FROM memberships WHERE user_id=$1",
    [administrator.userId],
  );
  assert.deepEqual(administratorMembership.rows, [
    { business_id: privateBusiness, role: "admin" },
  ]);
});

test("an identity provisioned before the demo was enabled gains no viewer access", async () => {
  const privateBusiness = await business("Pre-demo identity private business");
  const demo = {
    businessId: randomUUID(),
    businessName: "Synthetic demo tenant late",
  };
  await bootstrapPublicDemo(operatorPool(), demo);
  const administratorSubject = githubSubject("admin");
  const earlySubject = githubSubject("early");
  // The identity was mapped while public-demo onboarding was still disabled.
  const beforeDemo = config(
    privateBusiness,
    randomUUID(),
    administratorSubject,
  );
  beforeDemo.publicDemo = false;
  const early = await provisionGithubIdentity(
    { subject: earlySubject, login: "early-signin" },
    beforeDemo,
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM memberships WHERE user_id=$1", [
        early.userId,
      ])
    ).rowCount,
    0,
  );

  // A later login after enabling the demo still does not grant a membership:
  // immutable identity mapping is one-time and never upgraded retroactively.
  const afterDemo = config(
    privateBusiness,
    demo.businessId,
    administratorSubject,
  );
  await provisionGithubIdentity(
    { subject: earlySubject, login: "early-signin" },
    afterDemo,
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM memberships WHERE user_id=$1", [
        early.userId,
      ])
    ).rowCount,
    0,
  );
  await assert.rejects(
    __testOnlyAuthenticateProduction(request("GET", "invoices"), {
      config: afterDemo,
      session: { subject: early.subject, login: early.login },
    }),
    apiError("FORBIDDEN"),
  );

  // A genuinely first-time identity does receive exactly a viewer membership.
  const fresh = await provisionGithubIdentity(
    { subject: githubSubject("fresh"), login: "fresh-signin" },
    afterDemo,
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT business_id,role,status FROM memberships WHERE user_id=$1",
        [fresh.userId],
      )
    ).rows,
    [{ business_id: demo.businessId, role: "viewer", status: "active" }],
  );
});

test("viewer sessions cannot reach the API route without a valid cookie", async () => {
  const { GET } = await import("../src/app/api/v1/[...path]/route");
  const response = await GET(
    new NextRequest("http://localhost/api/v1/invoices"),
    { params: Promise.resolve({ path: ["invoices"] }) },
  );
  assert.equal(response.status, 401);
  assert.deepEqual((await response.json()).error, {
    code: "UNAUTHENTICATED",
  });
});
