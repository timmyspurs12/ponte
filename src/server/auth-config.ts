import "server-only";
import { z } from "zod";

const businessId = z.uuid();
const githubSubject = /^[1-9][0-9]{0,19}$/;
const clientId = /^[A-Za-z0-9_-]{8,256}$/;
const clientSecret = /^[A-Za-z0-9_-]{20,512}$/;
const authSecret = /^[\x21-\x7e]{32,512}$/;

export type ProductionAuthConfig = {
  secret: string;
  githubClientId: string;
  githubClientSecret: string;
  /** Canonical HTTPS origin used by Auth.js callbacks; never request supplied. */
  baseUrl: string;
  administratorBusinessId: string;
  administratorGithubSubjects: ReadonlySet<string>;
  publicDemo: false | { businessId: string };
};

type Environment = Record<string, string | undefined>;

function exactGithubSubject(value: string | undefined): value is string {
  return typeof value === "string" && githubSubject.test(value);
}

function parseAdministratorSubjects(
  value: string | undefined,
): Set<string> | null {
  if (!value || value.length > 4096) return null;
  const ids = value.split(",");
  if (
    !ids.length ||
    ids.some((id) => !exactGithubSubject(id)) ||
    new Set(ids).size !== ids.length
  )
    return null;
  return new Set(ids);
}

function parseBaseUrl(value: string | undefined): string | null {
  if (!value || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/"
    )
      return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Parses only explicit production settings. It intentionally returns no detail
 * to callers: malformed, missing, and contradictory settings have the same
 * fail-closed API outcome.
 */
export function readProductionAuthConfig(
  env: Environment = process.env,
): ProductionAuthConfig | null {
  const secret = env.AUTH_SECRET;
  const githubClientId = env.AUTH_GITHUB_ID;
  const githubClientSecret = env.AUTH_GITHUB_SECRET;
  const baseUrl = parseBaseUrl(env.NEXTAUTH_URL);
  const administratorBusinessId = env.PONTE_AUTH_BUSINESS_ID;
  const administratorGithubSubjects = parseAdministratorSubjects(
    env.PONTE_AUTH_ADMIN_GITHUB_IDS,
  );

  if (
    !secret ||
    !authSecret.test(secret) ||
    !githubClientId ||
    !clientId.test(githubClientId) ||
    !githubClientSecret ||
    !clientSecret.test(githubClientSecret) ||
    !baseUrl ||
    !administratorBusinessId ||
    !businessId.safeParse(administratorBusinessId).success ||
    !administratorGithubSubjects ||
    (env.NEXTAUTH_SECRET !== undefined && env.NEXTAUTH_SECRET !== secret)
  )
    return null;

  const publicDemoSetting = env.PONTE_PUBLIC_DEMO_READ_ONLY;
  if (
    publicDemoSetting !== undefined &&
    publicDemoSetting !== "0" &&
    publicDemoSetting !== "1"
  )
    return null;
  if (publicDemoSetting !== "1")
    return {
      secret,
      githubClientId,
      githubClientSecret,
      baseUrl,
      administratorBusinessId,
      administratorGithubSubjects,
      publicDemo: false,
    };

  const demoBusinessId = env.PONTE_PUBLIC_DEMO_BUSINESS_ID;
  if (
    !demoBusinessId ||
    !businessId.safeParse(demoBusinessId).success ||
    demoBusinessId === administratorBusinessId
  )
    return null;

  return {
    secret,
    githubClientId,
    githubClientSecret,
    baseUrl,
    administratorBusinessId,
    administratorGithubSubjects,
    publicDemo: { businessId: demoBusinessId },
  };
}

export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Session cookie name shared by the Auth.js handler and server token reader. */
export function authSessionCookieName(): string {
  return isProductionRuntime()
    ? "__Secure-ponte-auth.session-token"
    : "ponte-auth.session-token";
}

export function isGithubNumericSubject(value: unknown): value is string {
  return typeof value === "string" && githubSubject.test(value);
}
