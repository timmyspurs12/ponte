# Auth.js v5 security review

**Review date:** 2026-11-19
**Scope:** the server-only GitHub OAuth and PostgreSQL membership boundary. No OAuth application, credentials, live provider request, deployment, or other identity resource was created for this review.

## Resolved dependency

The application pins the official `next-auth@beta` release in the root lockfile:

| Package      |  Locked version | Reason                                                                                                                      |
| ------------ | --------------: | --------------------------------------------------------------------------------------------------------------------------- |
| `next-auth`  | `5.0.0-beta.32` | Current `beta` dist-tag at review time and the first patched release for the 2026 Auth.js v5 advisories below.              |
| `@auth/core` |        `0.41.3` | Exact transitive version required by the selected `next-auth`; first patched core release for the relevant core advisories. |

`package.json` uses exact `next-auth` versioning and `package-lock.json` records the exact tarball integrity. The integration follows the Auth.js v5 Next.js shape: `NextAuth(() => config)` exports `handlers` and `auth`; `/api/auth/[...nextauth]` delegates only to `handlers.GET`/`handlers.POST` after a fail-closed policy check.

## Auth.js advisory review

GitHub Security Advisory API was reviewed on 2026-11-19 for npm package `next-auth`.

| Advisory                                                                                                                                           | Affected range                                     | Resolution / application control                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [GHSA-8fpg-xm3f-6cx3 / CVE-2026-73421](https://github.com/advisories/GHSA-8fpg-xm3f-6cx3) — critical configuration-error auth object can fail open | `next-auth >=5.0.0-beta.0, <=5.0.0-beta.31`        | Resolved in `5.0.0-beta.32`. The app also treats invalid config as `503 AUTH_NOT_CONFIGURED` before Auth.js handlers run. It never uses `!!auth`, `if (req.auth)`, or session-object truthiness as proof; it structurally validates `githubSubject` and then re-reads PostgreSQL membership. |
| [GHSA-xmf8-cvqr-rfgj / CVE-2026-73418](https://github.com/advisories/GHSA-xmf8-cvqr-rfgj) — high malformed Bearer value can throw in `getToken()`  | `next-auth <=5.0.0-beta.31`; `@auth/core <0.41.3`  | Resolved by `next-auth@5.0.0-beta.32` and `@auth/core@0.41.3`. The application removed `getToken()` from authorization and rejects all production `Authorization` headers before asking Auth.js to process the cookie-only session.                                                          |
| [GHSA-7rqj-j65f-68wh / CVE-2026-73420](https://github.com/advisories/GHSA-7rqj-j65f-68wh) — critical email normalization issue                     | `next-auth <=5.0.0-beta.31`; `@auth/core <0.41.3`  | Resolved in the locked versions. No Email provider is configured, and email is never an identity or account-linking input.                                                                                                                                                                   |
| [GHSA-x445-f3h2-j279 / CVE-2026-73419](https://github.com/advisories/GHSA-x445-f3h2-j279) — medium provider-unbound OAuth check cookies            | `next-auth <=5.0.0-beta.31`; `@auth/core <=0.41.2` | Resolved in the locked versions. GitHub explicitly uses `checks: ["pkce", "state"]`; checks are never set to `none`.                                                                                                                                                                         |
| [GHSA-5jpx-9hw9-2fx4](https://github.com/advisories/GHSA-5jpx-9hw9-2fx4) — email misdelivery                                                       | v5 beta before `5.0.0-beta.30`                     | The locked beta.32 is outside the affected range; no Email provider is configured.                                                                                                                                                                                                           |

Older listed NextAuth advisories affect historical v3/v4 ranges only and are outside the pinned v5 beta. The use of a stable GitHub numeric profile ID, disabled dangerous email linking, explicit redirect allowlisting, server-side identity mapping, and fresh membership lookup are application controls in addition to the package patches.

## npm audit result

`npm audit --omit=dev --json` was run after the lockfile refresh. It reports **two production findings**, neither in `next-auth` nor `@auth/core`:

| Dependency path                          | Findings                                                                                                                                                                                                                                    | Audit-proposed remediation  | Decision                                                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| direct `ethers@6.16.0` → transitive `ws` | moderate [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx), uninitialized-memory disclosure; high [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p), fragmented-message memory-exhaustion DoS | `ethers@6.17.0` (non-major) | Not changed in this authentication-focused review. It is not an Auth.js dependency and the repository's payment/chain dependency behavior needs separately scoped regression review. No `npm audit fix` or destructive audit command was run. |

## Acceptance evidence added

The backend integration suite now demonstrates, without live GitHub OAuth:

1. The real `/api/auth/session` handler returns only `expires`, even when the encrypted test JWT contains OAuth tokens, a client secret, identity mapping values, business/role, and a session-secret sentinel.
2. A malformed Auth.js cookie and malformed Bearer value both receive `401 UNAUTHENTICATED` from a protected API; Bearer values are rejected before Auth.js parsing.
3. Missing Auth.js configuration receives `503 AUTH_NOT_CONFIGURED` from a protected API and the Auth.js route.
4. A same-email, different-numeric-subject identity cannot inherit the privileged mapping or membership.
5. A JWT issued before membership disablement changes from protected API success to `403 FORBIDDEN` after PostgreSQL membership is disabled.
6. An explicitly configured demo user gets only `viewer` in the distinct synthetic business and is denied both private-tenant reads (`404`) and mutation (`403`).
7. PostgreSQL constraints reject duplicate or remapped external identities.

Run the acceptance suite against the disposable local PostgreSQL configuration with `npm run test:backend`. The runner serializes backend files because they intentionally mutate process-level authentication policy and share one disposable database.
