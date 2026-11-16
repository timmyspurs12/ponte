# PONTE

**Phase 2A — persistent PostgreSQL backend for the bilingual Pix-to-USDG simulation.** Built for Arbitrum Open House São Paulo. No real funds move: no banking QR code, PSP, wallet signing, contract, custody or Stylus execution is connected.

## Run locally

Requires Node.js **22.17+**, npm and PostgreSQL 18. No hosted account or paid service is required.

1. `npm ci`
2. Copy `.env.example` to `.env.local`. Generate a local token with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and put it in `PONTE_DEV_TOKEN`. Do not commit this file or share the token.
3. In another terminal, `npm run db:local` starts a **real PostgreSQL** cluster, bound to loopback on port 54329, with data under ignored `.cache/postgres`. Alternatively use your own disposable PostgreSQL database and change `DATABASE_URL`.
4. `npm run db:seed` applies the versioned migration and creates a local business/user/admin membership. `npm run db:fixtures` adds eight explicitly illustrative records using the backend lifecycle.
5. `npm run dev`; open `http://localhost:3000/dev-login`, enter your local token, then continue to the workspace.

The Node scripts load `.env.local`; existing environment variables take precedence. Commands do not require shell-specific environment syntax. Embedded PostgreSQL is a development convenience (a prerelease binary-distribution package), not a production database manager. Linux x64 is verified here; Windows/macOS are **not verified** in this phase. A separately installed PostgreSQL is the fallback if its binaries are unsupported.

`npm run db:migrate` is safe to repeat. To **delete all local simulation data**, run `npm run db:reset -- --confirm-local-reset`; this requires a loopback database, refuses production, and reseeds. Never point test/reset commands at valuable data. Back up a persistent database with PostgreSQL's standard tools before changing it.

### Production safety

`npm run build && npm start` validates and serves the production build, but **all financial API access returns 503 `AUTH_NOT_CONFIGURED`** and `/dev-login` is disabled. Development authentication cannot be enabled in production with a flag. A real identity/session integration and deployment security review are explicit next gates. No cloud resources were created or deployed.

## Explore

| Route | Experience |
|---|---|
| `/` | Approved mineral-green/chalk-white marketing and animated SVG architecture |
| `/dev-login` | Local-only token-to-HttpOnly-cookie access boundary |
| `/app` | Persistent business overview and recent activity |
| `/app/invoices` | Search, six status filters, sorting, pagination and empty state |
| `/app/invoices/new` | Validated invoice creation; server-enforced tenant-unique reference |
| `/app/invoices/[id]` | Pix simulation, server-calculated routes, locked selection, confirmation and receipt export |
| `/pay/[id]` | Payment presentation; **authenticated tenant access**, not a public payment capability |
| `/developers` | Implemented boundaries and remaining integrations |
| `/api/v1/activity` | Paginated tenant-scoped persisted business events |
| `/api/v1/invoices…` | [Documented JSON API](docs/API.md) |

Create an invoice with a future due date and an illustrative address such as `0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (**never send funds**). Confirm simulated Pix, select a route, confirm simulated settlement, export JSON, and reload/open the saved invoice URL. The database—not cookies or browser storage—owns the invoice and financial lifecycle. Another browser must authenticate to the same local tenant before opening that URL. Old `ponte-demo-v1` browser records are intentionally not imported or trusted.

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

Only the simulations are implemented. No market/executable quotes, real Pix, actual USDG token precision, wallet, signing, chain transactions, contracts, Stylus, KYB/AML, refunds, queue/reconciliation, production authentication, PDF or production SLA is claimed. All sample businesses and metrics are illustrative; protocol names do not imply partnerships. USD accounting cents and the illustrative two-decimal USDG scale are distinct from unknown real token base units.

The approved typography, custom responsive CSS, restrained Motion, bilingual interface and SVG visuals are retained. Phase 1 design research, skill sources and limitations remain in [DESIGN.md](DESIGN.md), `skills-lock.json`, [historical QA](docs/QA.md) and `docs/screenshots`. Local skill installations are not runtime dependencies or committed assets.
