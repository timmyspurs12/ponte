import NextAuth, { type NextAuthConfig, type Session } from "next-auth";
import GitHubProvider from "next-auth/providers/github";
import type { JWT } from "next-auth/jwt";
import {
  authSessionCookieName,
  isGithubNumericSubject,
  isProductionRuntime,
  readProductionAuthConfig,
} from "@/server/auth-config";
import {
  githubIdentityFromProfile,
  provisionGithubIdentity,
} from "@/server/external-identities";

// Auth.js v5 defaults to PKCE. State binds the authorization response to this
// browser flow as well. Never use the insecure `none` check.
export const githubOAuthChecks: ["pkce", "state"] = ["pkce", "state"];
export const allowDangerousEmailAccountLinking = false;
const disabledFallbackSecret =
  "ponte-auth-disabled-fallback-secret-32-bytes-minimum";

/**
 * Restricts Auth.js post-auth redirects to this deployment origin. OAuth state
 * and PKCE are enforced by Auth.js; this callback adds a strict destination
 * boundary for callbackUrl values.
 */
export function safeAuthRedirect(url: string, baseUrl: string): string {
  try {
    const base = new URL(baseUrl);
    if (url.startsWith("/") && !url.startsWith("//"))
      return new URL(url, base).toString();
    const target = new URL(url);
    if (target.origin === base.origin) return target.toString();
    return new URL("/app", base).toString();
  } catch {
    return `${baseUrl.replace(/\/$/, "")}/app`;
  }
}

/**
 * Browser-visible Auth.js projection. In particular, it never releases an
 * internal user/mapping ID, GitHub subject, business, role, authorization
 * result, OAuth token, refresh token, provider secret, or session secret.
 */
export function browserSession(session: Session): Session {
  return { expires: session.expires };
}

function applyGithubIdentityClaim(token: JWT, profile: unknown): JWT {
  const identity = githubIdentityFromProfile(profile);
  if (identity === null) return token;
  // Auth.js encrypts its JWT cookie and marks it HttpOnly. The session callback
  // above intentionally does not project these server-only claims to browsers.
  token.githubSubject = identity.subject;
  token.githubLogin = identity.login;
  return token;
}

/**
 * Official Auth.js v5 lazy Next.js configuration. Reading the strict runtime
 * policy for each action avoids import-time environment capture and means an
 * incomplete production policy cannot silently become a usable provider.
 */
function createAuthConfig(): NextAuthConfig {
  const productionConfig = readProductionAuthConfig();
  const production = isProductionRuntime();

  return {
    secret: productionConfig?.secret ?? disabledFallbackSecret,
    providers: [
      GitHubProvider({
        clientId:
          productionConfig?.githubClientId ?? "disabled-github-client-id",
        clientSecret:
          productionConfig?.githubClientSecret ??
          "disabled-github-client-secret",
        checks: githubOAuthChecks,
        allowDangerousEmailAccountLinking,
      }),
    ],
    // In production the request URL is fixed by the validated NEXTAUTH_URL in
    // NextAuth's Next.js adapter. Do not trust a forwarded host when config is
    // missing; the route boundary denies it before Auth.js is invoked.
    trustHost: !production || productionConfig !== null,
    session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
    jwt: { maxAge: 8 * 60 * 60 },
    pages: { signIn: "/sign-in", error: "/sign-in" },
    useSecureCookies: production,
    cookies: {
      sessionToken: {
        name: authSessionCookieName(),
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: production,
        },
      },
    },
    callbacks: {
      async signIn({ account, profile }) {
        if (productionConfig === null || account?.provider !== "github")
          return false;
        const identity = githubIdentityFromProfile(profile);
        if (identity === null) return false;
        try {
          await provisionGithubIdentity(identity, productionConfig);
          return true;
        } catch {
          // Provider/database errors are never authorization grants.
          return false;
        }
      },
      async jwt({ token, account, profile }) {
        if (account?.provider === "github")
          return applyGithubIdentityClaim(token, profile);
        return token;
      },
      async session({ session }) {
        return browserSession(session);
      },
      async redirect({ url, baseUrl }) {
        return safeAuthRedirect(url, baseUrl);
      },
    },
  };
}

/** Official Auth.js v5 App Router integration exports. */
export const { handlers, auth } = NextAuth(() => createAuthConfig());

/**
 * `auth()` exposes the encrypted JWT claims server-side. The parser is the
 * authorization proof boundary: a missing, malformed, or contradictory value
 * is not a session and must fail closed.
 */
export function githubSessionClaims(session: unknown): {
  subject: string;
  login: string;
} | null {
  if (session === null || typeof session !== "object") return null;
  const user = (session as { user?: unknown }).user;
  if (user === null || typeof user !== "object") return null;
  const claims = user as { githubSubject?: unknown; githubLogin?: unknown };
  if (!isGithubNumericSubject(claims.githubSubject)) return null;
  return {
    subject: claims.githubSubject,
    login:
      typeof claims.githubLogin === "string" &&
      /^[A-Za-z0-9-]{1,39}$/.test(claims.githubLogin)
        ? claims.githubLogin
        : "GitHub-account",
  };
}
