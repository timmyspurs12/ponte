import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Session } from "next-auth";
import { encode } from "next-auth/jwt";
import { NextRequest } from "next/server";
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
  authSessionCookieName,
  readProductionAuthConfig,
  type ProductionAuthConfig,
} from "../src/server/auth-config";
import { ApiError, __testOnlyExecute } from "../src/server/service";
import { pool } from "../src/server/repository";
import { GET as authRouteGet } from "../src/app/api/auth/[...nextauth]/route";
import { GET as apiRouteGet } from "../src/app/api/v1/[...path]/route";
import {
  browserSession,
  githubOAuthChecks,
  safeAuthRedirect,
} from "../src/auth";
import { fixtures } from "./helpers/fixtures";

let githubSequence = BigInt(Date.now());
const githubId = (_suffix: string) => `9${(githubSequence++).toString()}`;
const productionAuthEnvironmentNames = [
  "NODE_ENV",
  "AUTH_SECRET",
  "AUTH_GITHUB_ID",
  "AUTH_GITHUB_SECRET",
  "AUTH_URL",
  "NEXTAUTH_URL",
  "NEXTAUTH_SECRET",
  "PONTE_AUTH_BUSINESS_ID",
  "PONTE_AUTH_ADMIN_GITHUB_IDS",
  "PONTE_PUBLIC_DEMO_READ_ONLY",
  "PONTE_PUBLIC_DEMO_BUSINESS_ID",
  "PONTE_DEV_AUTH",
  "PONTE_DEV_TOKEN",
] as const;

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

async function withProductionAuthEnvironment<T>(
  overrides: Record<string, string | undefined>,
  work: () => Promise<T>,
): Promise<T> {
  const before = Object.fromEntries(
    productionAuthEnvironmentNames.map((name) => [name, process.env[name]]),
  );
  try {
    Object.assign(process.env, validEnvironment(overrides), {
      NODE_ENV: "production",
    });
    return await work();
  } finally {
    const environment = process.env as Record<string, string | undefined>;
    for (const name of productionAuthEnvironmentNames) {
      const value = before[name];
      if (value === undefined) delete environment[name];
      else environment[name] = value;
    }
  }
}

async function githubSessionCookie(
  subject: string,
  login = "safe-github-login",
): Promise<string> {
  const secret = process.env.AUTH_SECRET;
  if (typeof secret !== "string") throw new Error("missing test auth secret");
  const cookieName = authSessionCookieName();
  const token = await encode({
    secret,
    salt: cookieName,
    maxAge: 8 * 60 * 60,
    // Deliberately include prohibited server-side values. browserSession must
    // never return any of these through the actual /api/auth/session handler.
    token: {
      githubSubject: subject,
      githubLogin: login,
      userId: randomUUID(),
      externalIdentityId: randomUUID(),
      businessId: randomUUID(),
      role: "admin",
      access_token: "oauth-access-token-must-not-leak",
      refresh_token: "oauth-refresh-token-must-not-leak",
      client_secret: "oauth-client-secret-must-not-leak",
      sessionSecret: "session-secret-must-not-leak",
    },
  });
  return `${cookieName}=${token}`;
}

async function invoicesResponse(cookie: string): Promise<Response> {
  return apiRouteGet(
    new NextRequest("https://ponte.example.test/api/v1/invoices", {
      headers: { cookie },
    }),
    { params: Promise.resolve({ path: ["invoices"] }) },
  );
}

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
  await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [id, name]);
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

test("same e-mail with a different GitHub numeric subject cannot inherit membership", async () => {
  const privateBusiness = await business("OAuth same-email isolation business");
  const administratorSubject = githubId("same-email-admin");
  const attackerSubject = githubId("same-email-attacker");
  const policy = config(privateBusiness, administratorSubject);
  const administratorProfile = githubIdentityFromProfile({
    id: Number(administratorSubject),
    login: "same-email-admin",
    email: "shared@example.test",
  });
  const attackerProfile = githubIdentityFromProfile({
    id: Number(attackerSubject),
    login: "same-email-attacker",
    email: "shared@example.test",
  });
  assert.notEqual(administratorProfile?.subject, attackerProfile?.subject);

  const administrator = await provisionGithubIdentity(
    administratorProfile!,
    policy,
  );
  const attacker = await provisionGithubIdentity(attackerProfile!, policy);
  assert.notEqual(administrator.userId, attacker.userId);
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM memberships WHERE business_id=$1 AND user_id=$2",
        [privateBusiness, attacker.userId],
      )
    ).rowCount,
    0,
  );
  await assert.rejects(
    __testOnlyAuthenticateProduction(apiRequest(), {
      config: policy,
      session: { subject: attacker.subject, login: attacker.login },
    }),
    apiError("FORBIDDEN"),
  );
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
  await fixtures("INSERT INTO users(id,email) VALUES($1,$2)", [
    otherUser,
    `${otherUser}@identity.invalid`,
  ]);
  await assert.rejects(
    fixtures(
      "INSERT INTO external_identities(provider,subject,user_id,display_name) VALUES('github',$1,$2,'other-account')",
      [subject, otherUser],
    ),
    (error) => (error as { code?: string }).code === "23505",
  );
  await assert.rejects(
    fixtures(
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
  const privateInvoice = randomUUID();
  const privateReference = `PRIVATE-${privateInvoice}`;
  await pool.query(
    "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data) VALUES($1,$2,$3,100,'Draft',$4)",
    [
      privateInvoice,
      privateBusiness,
      privateReference,
      JSON.stringify({
        id: privateInvoice,
        reference: privateReference,
        supplier: "Production-only supplier",
        wallet: `0x${"b".repeat(40)}`,
        fundingCurrency: "BRL",
        settlementCurrency: "USDG",
        fundingMinor: "100",
        amount: 1,
        due: "2027-12-20",
        description: "Synthetic demo must not read this",
        status: "Draft",
      }),
    ],
  );
  await assert.rejects(
    __testOnlyExecute(apiRequest(), ["invoices", privateInvoice], {
      authenticate: async (): Promise<Context> => context,
    }),
    apiError("NOT_FOUND"),
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
  await fixtures(
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

test("actual Auth.js session endpoint is a minimal safe browser projection", async () => {
  await withProductionAuthEnvironment({}, async () => {
    const cookie = await githubSessionCookie("9000000001");
    const response = await authRouteGet(
      new NextRequest("https://ponte.example.test/api/auth/session", {
        headers: { cookie },
      }),
    );
    assert.equal(response.status, 200);
    const session = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(session).sort(), ["expires"]);
    assert.equal(typeof session.expires, "string");

    const serialized = JSON.stringify(session);
    for (const prohibited of [
      "githubSubject",
      "githubLogin",
      "userId",
      "externalIdentityId",
      "businessId",
      "role",
      "access_token",
      "refresh_token",
      "client_secret",
      "sessionSecret",
      "oauth-access-token-must-not-leak",
      "oauth-refresh-token-must-not-leak",
      "oauth-client-secret-must-not-leak",
      "session-secret-must-not-leak",
      process.env.AUTH_SECRET!,
    ])
      assert.equal(serialized.includes(prohibited), false, prohibited);
  });
});

test("malformed Auth.js session cookie cannot access the protected API", async () => {
  await withProductionAuthEnvironment({}, async () => {
    const response = await invoicesResponse(
      `${authSessionCookieName()}=not-an-authjs-jwe`,
    );
    assert.equal(response.status, 401);
    assert.deepEqual((await response.json()).error, {
      code: "UNAUTHENTICATED",
    });

    // Production rejects any Bearer value before Auth.js parses it, including
    // malformed values that older getToken()-based paths could throw on.
    const bearerResponse = await apiRouteGet(
      new NextRequest("https://ponte.example.test/api/v1/invoices", {
        headers: { authorization: "Bearer %" },
      }),
      { params: Promise.resolve({ path: ["invoices"] }) },
    );
    assert.equal(bearerResponse.status, 401);
    assert.deepEqual((await bearerResponse.json()).error, {
      code: "UNAUTHENTICATED",
    });
  });
});

test("Auth.js rechecks active PostgreSQL membership after session issuance", async () => {
  const privateBusiness = await business("OAuth fresh membership business");
  const subject = githubId("fresh-membership");
  await withProductionAuthEnvironment(
    {
      PONTE_AUTH_BUSINESS_ID: privateBusiness,
      PONTE_AUTH_ADMIN_GITHUB_IDS: subject,
    },
    async () => {
      const policy = readProductionAuthConfig();
      assert.notEqual(policy, null);
      const identity = await provisionGithubIdentity(
        { subject, login: "fresh-membership-admin" },
        policy!,
      );
      const cookie = await githubSessionCookie(subject, identity.login);
      const beforeDisable = await invoicesResponse(cookie);
      assert.equal(beforeDisable.status, 200);

      await fixtures(
        "UPDATE memberships SET status='disabled' WHERE business_id=$1 AND user_id=$2",
        [privateBusiness, identity.userId],
      );
      const afterDisable = await invoicesResponse(cookie);
      assert.equal(afterDisable.status, 403);
      assert.deepEqual((await afterDisable.json()).error, {
        code: "FORBIDDEN",
      });
    },
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
  assert.equal(
    readProductionAuthConfig(
      validEnvironment({ AUTH_URL: "https://attacker.example.test" }),
    ),
    null,
  );

  const names = [
    "NODE_ENV",
    "AUTH_SECRET",
    "AUTH_GITHUB_ID",
    "AUTH_GITHUB_SECRET",
    "AUTH_URL",
    "NEXTAUTH_URL",
    "NEXTAUTH_SECRET",
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
    const protectedUnavailable = await apiRouteGet(
      new NextRequest("https://ponte.example.test/api/v1/invoices"),
      { params: Promise.resolve({ path: ["invoices"] }) },
    );
    assert.equal(protectedUnavailable.status, 503);
    assert.deepEqual((await protectedUnavailable.json()).error, {
      code: "AUTH_NOT_CONFIGURED",
    });
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

test("GitHub OAuth client IDs accept issued dotted values without weakening configuration validation", async () => {
  const dottedClientId = "Iv1.example123456789";
  assert.equal(
    readProductionAuthConfig(
      validEnvironment({ AUTH_GITHUB_ID: dottedClientId }),
    )?.githubClientId,
    dottedClientId,
  );
  assert.equal(
    readProductionAuthConfig(validEnvironment())?.githubClientId,
    "Ov23liPonte123456",
  );

  for (const invalidClientId of [
    "Iv1.example123456789 ",
    "https://github.com/Iv1.example123456789",
    "Iv1.example123456789/path",
    "Iv1.example123456789!",
    "Ov23.invalid-client-id",
    "Iv1.example12345678",
    "a".repeat(257),
  ])
    assert.equal(
      readProductionAuthConfig(
        validEnvironment({ AUTH_GITHUB_ID: invalidClientId }),
      ),
      null,
      invalidClientId,
    );

  // Changing the accepted ID shape must not relax the independent secret or
  // missing-configuration requirements.
  assert.equal(
    readProductionAuthConfig(validEnvironment({ AUTH_GITHUB_ID: undefined })),
    null,
  );
  assert.equal(
    readProductionAuthConfig(
      validEnvironment({ AUTH_GITHUB_SECRET: "c".repeat(19) }),
    ),
    null,
  );

  await withProductionAuthEnvironment(
    { AUTH_GITHUB_ID: dottedClientId },
    async () => {
      // A valid dotted client ID reaches the normal unauthenticated boundary,
      // rather than being treated as AUTH_NOT_CONFIGURED.
      const protectedResponse = await apiRouteGet(
        new NextRequest("https://ponte.example.test/api/v1/invoices"),
        { params: Promise.resolve({ path: ["invoices"] }) },
      );
      assert.equal(protectedResponse.status, 401);
      assert.deepEqual((await protectedResponse.json()).error, {
        code: "UNAUTHENTICATED",
      });

      // This metadata endpoint does not initiate OAuth, but proves the guarded
      // Auth.js route also accepts the exact same production configuration.
      const providersResponse = await authRouteGet(
        new NextRequest("https://ponte.example.test/api/auth/providers"),
        { params: Promise.resolve({ nextauth: ["providers"] }) },
      );
      assert.equal(providersResponse.status, 200);
      const providers = (await providersResponse.json()) as Record<
        string,
        { id?: unknown }
      >;
      assert.equal(providers.github?.id, "github");
    },
  );
});

test("OAuth state and PKCE, redirect destination, and browser session projection stay bounded", () => {
  assert.deepEqual(githubOAuthChecks, ["pkce", "state"]);
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
  });
  assert.equal(JSON.stringify(session).includes("access_token"), false);
  assert.equal(
    JSON.stringify(session).includes("not-returned@example.test"),
    false,
  );
});
