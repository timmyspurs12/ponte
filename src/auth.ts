import NextAuth, { type AuthOptions, type Session } from "next-auth";
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

export const githubOAuthChecks: ["state"] = ["state"];
const safeFallbackSecret =
  "ponte-auth-disabled-fallback-secret-32-bytes-minimum";

/**
 * Restricts Auth.js post-auth redirects to this deployment origin. OAuth state
 * validation remains Auth.js' responsibility; this callback adds a strict
 * destination boundary for callbackUrl values.
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

/** Browser-visible Auth.js session projection: never include OAuth tokens. */
export function browserSession(session: Session): Session {
  return {
    expires: session.expires,
    user: {
      name: typeof session.user?.name === "string" ? session.user.name : null,
      image:
        typeof session.user?.image === "string" ? session.user.image : null,
    },
  };
}

function applyGithubIdentityClaim(token: JWT, profile: unknown): JWT {
  const identity = githubIdentityFromProfile(profile);
  if (!identity) return token;
  // These claims stay in Auth.js' encrypted, HttpOnly JWT cookie. The session
  // callback above intentionally omits them from browser session responses.
  token.githubSubject = identity.subject;
  token.githubLogin = identity.login;
  return token;
}

// Keep the official provider registered at module initialization so a server
// deployment can supply its server-only environment at runtime. The route and
// callback separately validate the complete policy before any OAuth action.
const provider = GitHubProvider({
  clientId: process.env.AUTH_GITHUB_ID ?? "disabled-github-client-id",
  clientSecret:
    process.env.AUTH_GITHUB_SECRET ?? "disabled-github-client-secret",
  checks: githubOAuthChecks,
});

export const authOptions: AuthOptions = {
  secret: process.env.AUTH_SECRET ?? safeFallbackSecret,
  providers: [provider],
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  jwt: { maxAge: 8 * 60 * 60 },
  pages: { signIn: "/sign-in", error: "/sign-in" },
  useSecureCookies: isProductionRuntime(),
  cookies: {
    sessionToken: {
      name: authSessionCookieName(),
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: isProductionRuntime(),
      },
    },
  },
  callbacks: {
    async signIn({ account, profile }) {
      const config = readProductionAuthConfig();
      if (!config || account?.provider !== "github") return false;
      const identity = githubIdentityFromProfile(profile);
      if (!identity) return false;
      try {
        await provisionGithubIdentity(identity, config);
        return true;
      } catch {
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

/**
 * Exported for the official Next.js App Router handler. Configuration is
 * pre-checked at the route boundary, so a missing production configuration
 * never turns into an implicit provider or development-token fallback.
 */
export const authHandler = NextAuth(authOptions);

export function githubSessionClaims(token: JWT | null): {
  subject: string;
  login: string;
} | null {
  if (!token || !isGithubNumericSubject(token.githubSubject)) return null;
  return {
    subject: token.githubSubject,
    login:
      typeof token.githubLogin === "string" &&
      /^[A-Za-z0-9-]{1,39}$/.test(token.githubLogin)
        ? token.githubLogin
        : "GitHub-account",
  };
}
