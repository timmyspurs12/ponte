import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getToken } from "next-auth/jwt";
import { NextRequest } from "next/server";
import {
  authSessionCookieName,
  isProductionRuntime,
  readProductionAuthConfig,
  type ProductionAuthConfig,
} from "./auth-config";
import { githubSessionClaims } from "../auth";
import { findGithubIdentity } from "./external-identities";
import { pool } from "./repository";
import { fail } from "./errors";

const uuid = z.uuid();
export type Context = {
  business: string;
  user: string;
  role: "admin" | "operator" | "viewer";
  authMode: "development" | "github";
  isPublicDemo: boolean;
};

type GithubSession = { subject: string; login: string };
type Membership = {
  business: string;
  role: "admin" | "operator" | "viewer";
  isPublicDemo: boolean;
};

async function consumeRateLimit(business: string, user: string) {
  const limit = await pool.query<{ hits: number }>(
    "INSERT INTO rate_limits VALUES($1,now(),1) ON CONFLICT(identity) DO UPDATE SET window_start=CASE WHEN rate_limits.window_start < now()-interval '1 minute' THEN now() ELSE rate_limits.window_start END, hits=CASE WHEN rate_limits.window_start < now()-interval '1 minute' THEN 1 ELSE rate_limits.hits+1 END RETURNING hits",
    [`${business}:${user}`],
  );
  if (limit.rows[0].hits > 120) fail(429, "RATE_LIMITED");
}

async function activeProductionMembership(
  user: string,
  config: ProductionAuthConfig,
): Promise<Membership | null> {
  const businessIds = [
    config.administratorBusinessId,
    ...(config.publicDemo ? [config.publicDemo.businessId] : []),
  ];
  const result = await pool.query<{
    business_id: string;
    role: "admin" | "operator" | "viewer";
  }>(
    "SELECT business_id,role FROM memberships WHERE user_id=$1 AND status='active' AND business_id=ANY($2::uuid[])",
    [user, businessIds],
  );
  const primary = result.rows.find(
    (membership) => membership.business_id === config.administratorBusinessId,
  );
  if (primary)
    return {
      business: primary.business_id,
      role: primary.role,
      isPublicDemo: false,
    };
  const publicDemo = config.publicDemo;
  if (publicDemo) {
    const demo = result.rows.find(
      (membership) => membership.business_id === publicDemo.businessId,
    );
    if (demo)
      return {
        business: demo.business_id,
        role: demo.role,
        isPublicDemo: true,
      };
  }
  return null;
}

async function githubSessionFromRequest(
  request: Request,
): Promise<GithubSession | null> {
  // Production sessions are cookie-only. In particular, a local development
  // bearer token (or any caller-supplied bearer value) is never an OAuth API
  // credential, even though Auth.js' generic token helper supports headers.
  if (request.headers.has("authorization")) return null;
  const config = readProductionAuthConfig();
  if (!config) return fail(503, "AUTH_NOT_CONFIGURED");
  const token = await getToken({
    req: new NextRequest(request),
    secret: config.secret,
    cookieName: authSessionCookieName(),
    secureCookie: true,
  });
  return githubSessionClaims(token);
}

async function contextForGithubSession(
  session: GithubSession,
  config: ProductionAuthConfig,
): Promise<Context> {
  const identity = await findGithubIdentity(session.subject);
  // A verified OAuth session without a locally mapped identity is authenticated
  // but has no tenant grant. It must not be treated as an anonymous request.
  if (!identity) return fail(403, "FORBIDDEN");
  const membership = await activeProductionMembership(identity.userId, config);
  if (!membership) return fail(403, "FORBIDDEN");
  await consumeRateLimit(membership.business, identity.userId);
  return {
    business: membership.business,
    user: identity.userId,
    role: membership.role,
    authMode: "github",
    isPublicDemo: membership.isPublicDemo,
  };
}

async function authenticateProduction(request: Request): Promise<Context> {
  const config = readProductionAuthConfig();
  if (!config) return fail(503, "AUTH_NOT_CONFIGURED");
  const session = await githubSessionFromRequest(request);
  if (!session) return fail(401, "UNAUTHENTICATED");
  return contextForGithubSession(session, config);
}

async function authenticateDevelopment(
  request: Request,
  consumeLimit = true,
): Promise<Context> {
  const developmentToken = process.env.PONTE_DEV_TOKEN;
  if (
    process.env.PONTE_DEV_AUTH !== "1" ||
    !developmentToken ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(developmentToken)
  )
    return fail(503, "AUTH_NOT_CONFIGURED");
  const raw =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ??
    request.headers
      .get("cookie")
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("ponte-dev-session="))
      ?.slice(18) ??
    "";
  const digest = (s: string) => createHash("sha256").update(s).digest();
  if (!timingSafeEqual(digest(raw), digest(developmentToken)))
    return fail(401, "UNAUTHENTICATED");
  const business = uuid.parse(process.env.PONTE_DEV_BUSINESS_ID);
  const user = uuid.parse(process.env.PONTE_DEV_USER_ID);
  const result = await pool.query<{
    role: "admin" | "operator" | "viewer";
  }>(
    "SELECT role FROM memberships WHERE business_id=$1 AND user_id=$2 AND status='active'",
    [business, user],
  );
  if (!result.rowCount) fail(403, "FORBIDDEN");
  if (consumeLimit) await consumeRateLimit(business, user);
  return {
    business,
    user,
    role: result.rows[0].role,
    authMode: "development",
    isPublicDemo: false,
  };
}

/**
 * Authenticates both a verified identity session and a fresh active membership
 * on every API request. Browser/session state never supplies a business, role,
 * or internal user ID.
 */
export async function authenticate(request: Request): Promise<Context> {
  return isProductionRuntime()
    ? authenticateProduction(request)
    : authenticateDevelopment(request);
}

export type PublicAuthContext = {
  authenticated: true;
  accountLabel: string;
  access: {
    role: "admin" | "operator" | "viewer";
    readOnly: boolean;
    publicDemo: boolean;
  } | null;
};

/**
 * UI-only account status. This has no financial data and does not make a
 * membership-less identity authorized; protected API requests still receive
 * 403. It lets the application show a clear access-denied screen without
 * exposing an internal ID or any OAuth credential.
 */
export async function publicAuthenticationContext(
  request: Request,
): Promise<PublicAuthContext> {
  if (!isProductionRuntime()) {
    // The UI status probe is not a financial API operation. Avoid counting a
    // page shell's own session display request against the established API
    // rate budget, while still validating token and active membership.
    const ctx = await authenticateDevelopment(request, false);
    return {
      authenticated: true,
      accountLabel: "Local development account",
      access: {
        role: ctx.role,
        readOnly: ctx.role === "viewer",
        publicDemo: false,
      },
    };
  }

  const config = readProductionAuthConfig();
  if (!config) return fail(503, "AUTH_NOT_CONFIGURED");
  const session = await githubSessionFromRequest(request);
  if (!session) return fail(401, "UNAUTHENTICATED");
  const identity = await findGithubIdentity(session.subject);
  if (!identity)
    return {
      authenticated: true,
      accountLabel: `GitHub · ${session.login}`,
      access: null,
    };
  const membership = await activeProductionMembership(identity.userId, config);
  if (!membership)
    return {
      authenticated: true,
      accountLabel: `GitHub · ${identity.login}`,
      access: null,
    };
  return {
    authenticated: true,
    accountLabel: `GitHub · ${identity.login}`,
    access: {
      role: membership.role,
      readOnly: membership.role === "viewer",
      publicDemo: membership.isPublicDemo,
    },
  };
}

/** Test-only production-session seam; no live GitHub request is involved. */
export async function __testOnlyAuthenticateProduction(
  request: Request,
  options: {
    config: ProductionAuthConfig;
    session: GithubSession | null;
  },
): Promise<Context> {
  if (process.env.NODE_ENV !== "test")
    throw new Error("test-only production authentication is unavailable");
  void request;
  if (!options.session) return fail(401, "UNAUTHENTICATED");
  return contextForGithubSession(options.session, options.config);
}
