# PONTE

**Phase 2A — persistent PostgreSQL backend for the bilingual Pix-to-USDG simulation.** Built for Arbitrum Open House São Paulo. No real funds move: no banking QR code, PSP, wallet signing, contract, custody or Stylus execution is connected.

## Run locally

Requires Node.js **24.22.1** (pinned in [`.node-version`](.node-version) and constrained by `engines.node`), npm and PostgreSQL 18. No hosted account or paid service is required. The deliberate runtime-update procedure and the tested Render production procedure are in [the Stage A Render runbook](docs/RENDER_STAGE_A_DEPLOYMENT_RUNBOOK.md).

1. `npm ci`
2. Copy `.env.example` to `.env.local`. Generate a local token with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and put it in `PONTE_DEV_TOKEN`. Do not commit this file or share the token.
3. In another terminal, `npm run db:local` starts a **real PostgreSQL** cluster, bound to loopback on port 54329, with data under ignored `.cache/postgres`. Alternatively use your own disposable PostgreSQL database and change `DATABASE_URL`.
4. `npm run db:seed` applies the versioned migration and creates a local business/user/admin membership. `npm run db:fixtures` adds eight explicitly illustrative records using the backend lifecycle.
5. `npm run dev`; open `http://localhost:3000/dev-login`, enter your local token, then continue to the workspace.

The Node scripts load `.env.local`; existing environment variables take precedence. Commands do not require shell-specific environment syntax. Embedded PostgreSQL is a development convenience (a prerelease binary-distribution package), not a production database manager. Linux x64 is verified here; Windows/macOS are **not verified** in this phase. A separately installed PostgreSQL is the fallback if its binaries are unsupported.

Routing evidence persistence is **disabled by default**. To exercise the local-only integration, explicitly set both commented `PONTE_LOCAL_EVIDENCE_TEST_*` values in `.env.example` to `1` and a non-zero EVM address, respectively. The guarded path requires `NODE_ENV=development` or `test`, development authentication, and a loopback database; it creates fresh `local-test-only` buffers, not a production KMS envelope or a deployed/anchored registry record. Do not enable it on a shared, preview, staging, or production system. Set this opt-in before `npm run db:fixtures`, which intentionally creates Routing examples. A default `db:reset` still restores the base local seed but skips those Routing fixtures.

`npm run db:migrate` is safe to repeat. To **delete all local simulation data**, run `npm run db:reset -- --confirm-local-reset`; this requires a loopback database, refuses production, and reseeds. Never point test/reset commands at valuable data. Back up a persistent database with PostgreSQL's standard tools before changing it.

A distinct `npm run db:bootstrap-business -- --confirm-production --business-id "<PRIVATE_BUSINESS_UUID>" --business-name "<PRIVATE_BUSINESS_NAME>"` command is the narrowly guarded production-only initializer for one private business; it is not a seed command and refuses non-production or loopback execution. Follow the full manual order, secret handling, and first-admin procedure in [the Stage A Render runbook](docs/RENDER_STAGE_A_DEPLOYMENT_RUNBOOK.md). Do not run it against this local database.

### Production GitHub OAuth and safety

Production uses the official Auth.js v5 (`next-auth@5.0.0-beta.32`) GitHub OAuth Route Handler at `/api/auth/[...nextauth]`. It remains **fail closed** with `503 AUTH_NOT_CONFIGURED` until every server-only setting below is valid. Production never accepts `PONTE_DEV_*`, the local bearer token, or `/dev-login`; the latter always returns 404 in a production runtime. The [Auth.js v5 security review](docs/AUTHJS_V5_SECURITY_REVIEW.md) records the locked version, advisory analysis, audit findings, and regression evidence.

| Variable                        |    Required | Purpose                                                                                                                                                                                     |
| ------------------------------- | ----------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`                   |         yes | 32–512 printable-character Auth.js/JWT secret; keep only in the deployment secret store.                                                                                                    |
| `AUTH_GITHUB_ID`                |         yes | GitHub OAuth App client ID.                                                                                                                                                                 |
| `AUTH_GITHUB_SECRET`            |         yes | GitHub OAuth App client secret.                                                                                                                                                             |
| `NEXTAUTH_URL`                  |         yes | Canonical HTTPS production origin, with no path/query/fragment; this is the approved callback origin.                                                                                       |
| `PONTE_AUTH_BUSINESS_ID`        |         yes | Existing private business UUID for configured administrators and manually provisioned members. Login never creates this business.                                                           |
| `PONTE_AUTH_ADMIN_GITHUB_IDS`   |         yes | Unique comma-separated immutable **numeric GitHub account IDs**. These explicit bootstrap identities receive an initial active `admin` membership only when their mapping is first created. |
| `PONTE_PUBLIC_DEMO_READ_ONLY`   |          no | Exactly `1` enables public-demo onboarding; omitted or `0` disables it. Any other value fails closed.                                                                                       |
| `PONTE_PUBLIC_DEMO_BUSINESS_ID` | conditional | Existing UUID required when public demo is enabled; it must differ from `PONTE_AUTH_BUSINESS_ID`.                                                                                           |

Set a different GitHub OAuth App and callback URL for local development versus production. Register the production callback as `https://your-canonical-host/api/auth/callback/github`; do not reuse production client secrets locally. The application does not create OAuth Apps, credentials, businesses, or hosting resources.

GitHub's numeric account ID is the sole external authorization subject. Email, GitHub display name, and profile label are never used to find or authorize an internal user. A first verified GitHub callback creates one immutable `external_identities` binding and a non-routable technical `users.email` placeholder required by the legacy schema. It can create only the explicitly configured bootstrap `admin` membership or, when the public-demo flag is explicitly on, a `viewer` membership in the configured demo business. Existing mappings and memberships are never upgraded, re-enabled, or repointed by sign-in.

Every protected API request re-reads the active membership from PostgreSQL. OAuth session validity therefore does not outlive a disabled/revoked membership. Sessions use Auth.js encrypted JWT cookies with `HttpOnly`, `SameSite=Lax`, and `Secure` settings in production; the browser-visible `/api/auth/session` projection contains only expiry and excludes OAuth access/refresh tokens, client secrets, session secret, internal user or mapping IDs, GitHub subject, roles, business IDs, and authorization state. GitHub explicitly retains Auth.js OAuth `pkce` and `state` checks (never `none`), and post-sign-in redirects are restricted to the configured origin.

The optional public demo tenant must contain **synthetic data only**. It only grants an unprovisioned authenticated GitHub user a `viewer` membership in that one configured tenant; it never creates a business or grants mutation authority. The UI labels this access read-only and the server independently rejects every mutation.

## Explore

| Route                | Experience                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `/`                  | Approved mineral-green/chalk-white marketing and animated SVG architecture                  |
| `/dev-login`         | Local-only token-to-HttpOnly-cookie access boundary                                         |
| `/app`               | Persistent business overview and recent activity                                            |
| `/app/invoices`      | Search, six status filters, sorting, pagination and empty state                             |
| `/app/invoices/new`  | Validated invoice creation; server-enforced tenant-unique reference                         |
| `/app/invoices/[id]` | Pix simulation, server-calculated routes, locked selection, confirmation and receipt export |
| `/pay/[id]`          | Payment presentation; **authenticated tenant access**, not a public payment capability      |
| `/developers`        | Implemented boundaries and remaining integrations                                           |
| `/api/v1/activity`   | Paginated tenant-scoped persisted business events                                           |
| `/api/v1/invoices…`  | [Documented JSON API](docs/API.md)                                                          |

Create an invoice with a future due date and an illustrative address such as `0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (**never send funds**). Confirm simulated Pix, select a route, confirm simulated settlement, export JSON, and reload/open the saved invoice URL. The database—not cookies or browser storage—owns the invoice and financial lifecycle. Another browser must authenticate to the same local tenant before opening that URL. Old `ponte-demo-v1` browser records are intentionally not imported or trusted.

### Failed invoices and replacement invoices

Failed is a terminal state: it cannot return to Pending payment. The detail screen offers **Create replacement invoice** / **Criar fatura substituta**, linking to `/app/invoices/new`. This opens a new invoice form; it does not reset, delete, retry or alter the original failed invoice or its activity history.

### Workspace-restricted payment links

The copy-link action is for **internal demonstrations only**. `/pay/[id]` requires an account that already has access to the relevant authenticated workspace; possession of the URL does not grant access. External supplier access is **not implemented**. Invoice/payment authority is PostgreSQL, not a browser-local demo store. An anonymous visitor can load the generic application shell but receives 401 from the financial API and cannot view invoice data. Other tenants remain excluded by authorization. Production access requires valid server-only GitHub OAuth configuration and an active database membership; no OAuth App, credential, or deployment is created by this repository.

## Architecture

Next.js Route Handlers → Zod validation/authentication → lifecycle service → SQL repository/transaction → PostgreSQL. This is one modular application, not multiple microservices. Explicit `pg` SQL was selected over an ORM for this small locking-heavy schema; rationale and trade-offs are in [BACKEND_ARCHITECTURE.md](docs/BACKEND_ARCHITECTURE.md).

- `src/app/api/v1/[...path]/route.ts`: HTTP envelopes, status codes, safe errors and correlation IDs.
- `src/server/auth.ts`: development-only identity boundary, active membership/role checks and database-backed rate limits.
- `src/server/service.ts`: validation, idempotency, authoritative state machine, exact quote/receipt generation.
- `src/server/repository.ts`: parameterized tenant-scoped queries, pool and transaction unit-of-work.
- `migrations/001_foundation.sql` + `002_audit_metadata.sql`: versioned relational constraints, generated descriptive columns, timestamps, exact snapshot consistency and append-only previous/new-state events.
- `src/lib/services.ts`: asynchronous API-backed InvoiceService. No localStorage persistence.
- `src/lib/quotes.ts`: deterministic BigInt/rational simulation arithmetic, called by the server. The UI renders server-provided estimates; numbers in legacy visual models are display adapters only.
- `src/lib/i18n`: pt-BR default, English option, locale cookie and Intl display boundaries.

See [financial units and rounding](docs/FINANCIAL_MODEL.md), [API examples](docs/API.md), [deployment preparation](docs/BACKEND_ARCHITECTURE.md#deployment-preparation), and [remaining Phase 2 work](docs/PHASE2.md).

## Verification

Use a **disposable local database**. The browser suite resets simulation tables before each scenario.

```sh
npm run db:seed
npm run db:migrate
npm run test:migrations
npm run test:backend
npm run lint
npm run typecheck
npm run build
npm run test:install
npm test
```

Playwright starts the **development** server on port 3000, because development auth intentionally does not work in production builds. The production build is independently checked. Stop an unrelated server before testing; local tests may reuse an existing server. CI always starts a fresh one.

The GitHub [Application quality workflow](.github/workflows/frontend.yml) runs on this branch and PRs to main: Ubuntu 24.04, Node 22, **PostgreSQL 18 service**, migrations twice (repeatability), clean/upgrade migration tests, backend integration tests, lint, TypeScript, production build and standard Playwright Chromium. Reports are uploaded. See [QA_PHASE2A.md](docs/QA_PHASE2A.md) for actual results and limitations, not just configured checks.

In this restricted Arena Linux sandbox only, use `PONTE_BROWSER_FALLBACK=1 npm test` to use the existing registry-packaged Chromium fallback. Standard Chromium remains the CI/default browser; no executable path editing is needed. Reports/screenshots stay in ignored `test-results` and `playwright-report`.

Browser coverage includes Portuguese/English, full backend lifecycle and refresh persistence, alternate-route lock, dialogs/keyboard, JSON export, search/filter/sort/pagination, missing invoices, mobile navigation, console errors, selected Axe checks, reduced motion and overflow at **1440/1280/768/390/360px**. This is not full accessibility certification or physical-device testing.

## Boundaries

Only the simulations are implemented. No market/executable quotes, real Pix, actual USDG token precision, wallet, signing, chain transactions, contracts, Stylus, KYB/AML, refunds, queue/reconciliation, OAuth App credentials/resources, PDF or production SLA is claimed. GitHub OAuth code and membership enforcement are implemented, but the operational identity-provider/deployment review remains required. All sample businesses and metrics are illustrative; protocol names do not imply partnerships. USD accounting cents and the illustrative two-decimal USDG scale are distinct from unknown real token base units.

The approved typography, custom responsive CSS, restrained Motion, bilingual interface and SVG visuals are retained. Phase 1 design research, skill sources and limitations remain in [DESIGN.md](DESIGN.md), `skills-lock.json`, [historical QA](docs/QA.md) and `docs/screenshots`. Local skill installations are not runtime dependencies or committed assets.
