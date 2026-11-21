import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Session } from "next-auth";
import {
  __testOnlyAuthenticateProduction,
  authenticate,
  type Context,
} from "../src/server/auth";
import {
  githubIdentityFromProfile,
  provisionGithubIdentity,
} from "../src/server/external-identities";
import {
  readProductionAuthConfig,
  type ProductionAuthConfig,
} from "../src/server/auth-config";
import { ApiError, __testOnlyExecute } from "../src/server/service";
import { pool } from "../src/server/repository";
import { GET as authRouteGet } from "../src/app/api/auth/[...nextauth]/route";
import {
  browserSession,
  githubOAuthChecks,
  safeAuthRedirect,
} from "../src/auth";

let githubSequence = BigInt(Date.now());
const githubId = (_suffix: string) => `9${(githubSequence++).toString()}`;
const validEnvironment = (
  overrides: Record<string, string | undefined> = {},
) => ({
  AUTH_SECRET: "s".repeat(48),
  AUTH_GITHUB_ID: "Ov23liPonte123456",
  AUTH_GITHUB_SECRET: "c".repeat(40),
  NEXTAUTH_URL: "https://ponte.example.test",
  PONTE_AUTH_BUSINESS_ID: "00000000-0000-4000-8000-000000000101",
  PONTE_AUTH_ADMIN_GITHUB_IDS: "9000000001",
  PONTE_PUBLIC_DEMO_READ_ONLY: "0",
  ...overrides,
});

function config(
  administratorBusinessId: string,
  administratorSubject: string,
  publicDemo: false | { businessId: string } = false,
): ProductionAuthConfig {
  return {
    secret: "s".repeat(48),
    githubClientId: "Ov23liPonte123456",
    githubClientSecret: "c".repeat(40),
    baseUrl: "https://ponte.example.test",
    administratorBusinessId,
    administratorGithubSubjects: new Set([administratorSubject]),
    publicDemo,
  };
}

const apiError = (code: string) => (error: unknown) =>
  error instanceof ApiError && error.code === code;

async function business(name: string): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO businesses(id,name) VALUES($1,$2)", [id, name]);
  return id;
}

function apiRequest(method = "GET") {
  return new Request("http://localhost/api/v1/invoices", {
    method,
    headers:
      method === "GET"
        ? {}
        : {
            origin: "http://localhost",
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
          },
    body: method === "GET" ? undefined : JSON.stringify({}),
  });
}

after(async () => {
  await pool.end();
});

test("GitHub numeric identity mapping is stable, one-time, and not e-mail based", async () => {
  const privateBusiness = await business("OAuth mapping private business");
  const subject = githubId("101");
  const policy = config(privateBusiness, subject);
  const profile = {
    id: Number(subject),
    login: "stable-account",
    email: "first@example.test",
  };
  const parsed = githubIdentityFromProfile(profile);
  assert.deepEqual(parsed, { subject, login: "stable-account" });
  assert.equal(
    githubIdentityFromProfile({
      id: subject,
      login: "stable-account",
      email: "changed@example.test",
    })?.subject,
    subject,
  );

  const first = await provisionGithubIdentity(parsed!, policy);
  const second = await provisionGithubIdentity(
    { subject, login: "renamed-account" },
    policy,
  );
  assert.equal(second.userId, first.userId);
  assert.equal(second.login, "stable-account");

  const membership = await pool.query(
    "SELECT role,status FROM memberships WHERE business_id=$1 AND user_id=$2",
    [privateBusiness, first.userId],
  );
  assert.deepEqual(membership.rows, [{ role: "admin", status: "active" }]);
  const user = await pool.query("SELECT email FROM users WHERE id=$1", [
    first.userId,
  ]);
  assert.equal(user.rows[0].email, `github-${subject}@identity.invalid`);
});

test("duplicate provider subjects and identity remapping are rejected by PostgreSQL", async () => {
  const privateBusiness = await business("OAuth identity uniqueness business");
  const subject = githubId("102");
  const policy = config(privateBusiness, subject);
  const mapped = await provisionGithubIdentity(
    { subject, login: "unique-account" },
    policy,
  );
  const otherUser = randomUUID();
  await pool.query("INSERT INTO users(id,email) VALUES($1,$2)", [
    otherUser,
    `${otherUser}@identity.invalid`,
  ]);
  await assert.rejects(
    pool.query(
      "INSERT INTO external_identities(provider,subject,user_id,display_name) VALUES('github',$1,$2,'other-account')",
      [subject, otherUser],
    ),
    (error) => (error as { code?: string }).code === "23505",
  );
  await assert.rejects(
    pool.query(
      "UPDATE external_identities SET user_id=$1 WHERE provider='github' AND subject=$2",
      [otherUser, mapped.subject],
    ),
    /External identity mappings are immutable/,
  );
});

test("configured public-demo onboarding grants only a viewer and server mutations reject it", async () => {
  const privateBusiness = await business("OAuth private policy business");
  const demoBusiness = await business("OAuth synthetic demo business");
  const policy = config(privateBusiness, githubId("103"), {
    businessId: demoBusiness,
  });
  const identity = await provisionGithubIdentity(
    { subject: githubId("104"), login: "demo-viewer" },
    policy,
  );
  const context = await __testOnlyAuthenticateProduction(apiRequest(), {
    config: policy,
    session: { subject: identity.subject, login: identity.login },
  });
  assert.deepEqual(
    {
      business: context.business,
      role: context.role,
      isPublicDemo: context.isPublicDemo,
    },
    { business: demoBusiness, role: "viewer", isPublicDemo: true },
  );
  await assert.rejects(
    __testOnlyExecute(apiRequest("POST"), ["invoices"], {
      authenticate: async (): Promise<Context> => context,
    }),
    apiError("FORBIDDEN"),
  );
});

test("unknown GitHub users and disabled memberships do not outlive their authorization", async () => {
  const privateBusiness = await business("OAuth denial business");
  const adminSubject = githubId("105");
  const policy = config(privateBusiness, adminSubject);
  const unknown = await provisionGithubIdentity(
    { subject: githubId("106"), login: "no-membership" },
    policy,
  );
  await assert.rejects(
    __testOnlyAuthenticateProduction(apiRequest(), {
      config: policy,
      session: { subject: unknown.subject, login: unknown.login },
    }),
    apiError("FORBIDDEN"),
  );

  const administrator = await provisionGithubIdentity(
    { subject: adminSubject, login: "configured-admin" },
    policy,
  );
  await pool.query(
    "UPDATE memberships SET status='disabled' WHERE business_id=$1 AND user_id=$2",
    [privateBusiness, administrator.userId],
  );
  await assert.rejects(
    __testOnlyAuthenticateProduction(apiRequest(), {
      config: policy,
      session: { subject: administrator.subject, login: administrator.login },
    }),
    apiError("FORBIDDEN"),
  );
});

test("production context preserves cross-business invoice and evidence isolation", async () => {
  const privateBusiness = await business("OAuth isolation private business");
  const otherBusiness = await business("OAuth isolation other business");
  const subject = githubId("107");
  const policy = config(privateBusiness, subject);
  const identity = await provisionGithubIdentity(
    { subject, login: "isolation-admin" },
    policy,
  );
  const otherInvoice = randomUUID();
  const otherReference = `OTHER-${otherInvoice}`;
  await pool.query(
    "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data) VALUES($1,$2,$3,100,'Draft',$4)",
    [
      otherInvoice,
      otherBusiness,
      otherReference,
      JSON.stringify({
        id: otherInvoice,
        reference: otherReference,
        supplier: "Other business supplier",
        wallet: `0x${"a".repeat(40)}`,
        fundingCurrency: "BRL",
        settlementCurrency: "USDG",
        fundingMinor: "100",
        amount: 1,
        due: "2027-12-20",
        description: "Cross-business test",
        status: "Draft",
      }),
    ],
  );
  const context = await __testOnlyAuthenticateProduction(apiRequest(), {
    config: policy,
    session: { subject: identity.subject, login: identity.login },
  });
  for (const resource of [undefined, "evidence"] as const)
    await assert.rejects(
      __testOnlyExecute(
        apiRequest(),
        ["invoices", otherInvoice, ...(resource ? [resource] : [])],
        { authenticate: async (): Promise<Context> => context },
      ),
      apiError("NOT_FOUND"),
    );
});

test("production OAuth configuration fails closed and never accepts a development bearer token", async () => {
  assert.equal(readProductionAuthConfig({}), null);
  assert.equal(
    readProductionAuthConfig(
      validEnvironment({
        PONTE_AUTH_ADMIN_GITHUB_IDS: "9000000001,not-a-github-id",
      }),
    ),
    null,
  );
  assert.equal(
    readProductionAuthConfig(
      validEnvironment({
        PONTE_PUBLIC_DEMO_READ_ONLY: "1",
        PONTE_PUBLIC_DEMO_BUSINESS_ID: "00000000-0000-4000-8000-000000000101",
      }),
    ),
    null,
  );

  const names = [
    "NODE_ENV",
    "AUTH_SECRET",
    "AUTH_GITHUB_ID",
    "AUTH_GITHUB_SECRET",
    "NEXTAUTH_URL",
    "PONTE_AUTH_BUSINESS_ID",
    "PONTE_AUTH_ADMIN_GITHUB_IDS",
    "PONTE_PUBLIC_DEMO_READ_ONLY",
    "PONTE_PUBLIC_DEMO_BUSINESS_ID",
    "PONTE_DEV_AUTH",
    "PONTE_DEV_TOKEN",
  ] as const;
  const before = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  try {
    Object.assign(process.env, validEnvironment());
    Object.assign(process.env, {
      NODE_ENV: "production",
      PONTE_DEV_AUTH: "1",
      PONTE_DEV_TOKEN: "a".repeat(32),
    });
    await assert.rejects(
      authenticate(
        new Request("https://ponte.example.test/api/v1/invoices", {
          headers: { authorization: `Bearer ${process.env.PONTE_DEV_TOKEN}` },
        }),
      ),
      apiError("UNAUTHENTICATED"),
    );

    delete process.env.AUTH_SECRET;
    await assert.rejects(
      authenticate(new Request("https://ponte.example.test/api/v1/invoices")),
      apiError("AUTH_NOT_CONFIGURED"),
    );
    const unavailable = await authRouteGet(
      new Request("https://ponte.example.test/api/auth/providers"),
      { params: Promise.resolve({ nextauth: ["providers"] }) },
    );
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      error: { code: "AUTH_NOT_CONFIGURED" },
    });
  } finally {
    const environment = process.env as Record<string, string | undefined>;
    for (const name of names) {
      const value = before[name];
      if (value === undefined) delete environment[name];
      else environment[name] = value;
    }
  }
});

test("OAuth state, redirect destination, and browser session projection stay bounded", () => {
  assert.deepEqual(githubOAuthChecks, ["state"]);
  assert.equal(
    safeAuthRedirect(
      "https://attacker.example/steal",
      "https://ponte.example.test",
    ),
    "https://ponte.example.test/app",
  );
  assert.equal(
    safeAuthRedirect("/app/invoices", "https://ponte.example.test"),
    "https://ponte.example.test/app/invoices",
  );
  const session = browserSession({
    expires: "2030-01-01T00:00:00.000Z",
    user: {
      name: "GitHub user",
      email: "not-returned@example.test",
      image: "https://avatars.example.test/u/1",
    },
  } as Session);
  assert.deepEqual(session, {
    expires: "2030-01-01T00:00:00.000Z",
    user: {
      name: "GitHub user",
      image: "https://avatars.example.test/u/1",
    },
  });
  assert.equal(JSON.stringify(session).includes("access_token"), false);
  assert.equal(
    JSON.stringify(session).includes("not-returned@example.test"),
    false,
  );
});
