# PONTE

**Phase 1.1: a frontend-only Pix-to-USDG settlement concept for Brazilian businesses.** Built for Arbitrum Open House São Paulo. No real funds move, no bank QR code is generated, no wallet is connected, and no contract is called.

## Run locally

Requires Node.js 22 (22.17+ recommended) and npm. Ubuntu and Windows 10 development use the same npm commands.

```sh
npm ci
npm run dev
# http://localhost:3000
```

Production preview: `npm run build && npm start`. Both servers bind to `0.0.0.0`. No environment variables, accounts, keys, or paid services are required. Fonts are self-hosted through fontsource packages. The Next.js server only serves the frontend; there are no backend APIs.

## Explore

| Route | Experience |
|---|---|
| `/` | Marketing, animated SVG corridor, process, routing, receipt, infrastructure and security sections |
| `/app` | Business overview, calculated demo totals, recent invoices, settlements and activity |
| `/app/invoices` | Search, all six status filters, sorting, pagination and empty state |
| `/app/invoices/new` | Validated supplier/address/amount/reference/date form; duplicate reference protection |
| `/app/invoices/[id]` | Payment request, explicit Pix simulation, three routes, confirmation dialog, settlement and receipt export |
| `/pay/[id]` | Public-facing demo payment presentation |
| `/developers` | Integration boundaries and proposed Phase 2 roadmap |

### Recommended demonstration

1. Open `/app/invoices/new` and create an invoice. Use an illustrative address such as `0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`—**never send funds**.
2. Open the generated payment link in the **same browser and origin**.
3. Choose **Simular recebimento via Pix** / **Simulate Pix payment received**.
4. Compare the three deterministic routes, choose one and continue.
5. Choose **Simular liquidação** / **Simulate settlement**, review and confirm.
6. Export the clearly labeled JSON demo receipt. Refresh to verify local persistence.

Invoices and transitions are stored in `localStorage` under `ponte-demo-v1`. Created invoice links are not shareable across browsers/devices/origins. Clear this key in browser storage to reset to the eight sample records. Seeded settled receipts use fixed sample timestamps; new simulated settlements use the interaction timestamp. A malformed store falls back to fixtures. Storage write failures show an error instead of claiming success.

## Architecture

- Next.js App Router, React, TypeScript, Motion React, Lucide; custom responsive CSS tokens.
- `src/components`: shared UI, marketing, overview, invoice table, invoice form, payment journey and application shell.
- `src/lib/models.ts`: Invoice, Payment, PaymentQuote, RouteCandidate, RouteExecution, SettlementReceipt, Business and Wallet.
- `src/lib/services.ts`: single composition root for the asynchronous invoice-service interface.
- `src/lib/demo-service.ts`: browser-only persistence and simulation state machine, with locked-route validation and legacy receipt normalization.
- `src/lib/quotes.ts`: deterministic **BigInt/rational** quote calculation, JSON-safe integer minor-unit strings, candidate-specific floored minimums and basis-point fees. Illustrative FX is **R$5.25 per USDG**. No executable quotes or market data. Legacy invoice/payment major-unit numbers stay behind an explicit adapter; new quote/receipt/execution interfaces do not use floating amounts. See [FINANCIAL_MODEL.md](docs/FINANCIAL_MODEL.md) for exact formulas, scales, rounding and future migration.
- `src/lib/i18n`: Portuguese messages, locale provider and independent Intl display formatters.
- Future real API adapter replaces the demo invoice service. Wallet, PSP, token, contract and routing integrations belong in separate adapters, not visual components.

The proposed platform is not an operational financial service. All businesses, invoices, addresses and amounts are illustrative. Arbitrum, USDG, Pix and Stylus references describe a proposed technology direction, not partnerships or completed integrations.

## Language and formatting

**Português (Brasil)** is the default; use the header language selector for **English**. The `ponte-locale` cookie preserves your preference across pages and reloads. The server renders the matching HTML `lang`; client switching also updates language and page metadata. Clear that cookie to return to Portuguese. If cookies are blocked, switching still works for the current session but will not persist on reload.

All major pages, labels, validation, statuses, errors, toasts and developer information are translated without duplicating components. Business names, protocol names, token symbols, technical identifiers and your own invoice descriptions are not translated. Brazilian figures display as `R$ 25.000,00`, English as `R$25,000.00`; USDG amounts use localized decimal separators without mislabeling the token as ISO USD. Native number/date form controls use browser input conventions; displayed dates are `dd/mm/yyyy` in pt-BR and `mm/dd/yyyy` in en-US. Settlement timestamps explicitly use UTC.

## Quality checks — Ubuntu and Windows 10

```sh
npm ci
npm run test:install
npm run lint
npm run typecheck
npm run build
npm test
```

`test:install` installs **standard Playwright Chromium** on your platform. On Ubuntu CI, `npx playwright install --with-deps chromium` also installs OS dependencies. On Windows 10, run the same commands in PowerShell or Command Prompt; there is no Bash requirement and no executable path to edit. The test runner spawns Node directly and forwards arguments, e.g. `npm test -- --grep "quote"`.

Playwright starts the built frontend automatically on port 3000. Locally it may reuse an already-running server; ensure that server matches your build. In CI it always starts a fresh server. Run `npm run build` before testing if the build is missing or stale. Test screenshots/reports live in ignored `test-results/` and `playwright-report/`, not the approved screenshot baselines.

### Restricted Linux fallback (optional, not CI default)

This Arena sandbox blocks the standard browser CDN. Only here, opt into the existing registry-packaged **Linux x64** fallback:

```sh
# Bash in this restricted Linux sandbox only
PONTE_BROWSER_FALLBACK=1 npm test
```

This explicit opt-in prepares bundled libraries in `.cache` and passes the executable/library environment to the browser process from Node. No `/tmp/chromium` path is hardcoded in the test configuration; the fallback package resolves its own executable. Windows/macOS do **not** use this fallback. Standard Playwright is the default, including Ubuntu GitHub Actions. There is still only one browser (Chromium), not another browser dependency.

### GitHub Actions

[Frontend quality workflow](.github/workflows/frontend.yml) runs for PRs targeting `main` and pushes to `arena/8131b5f3-ponte`: Ubuntu 24.04, Node 22, `npm ci`, ESLint, TypeScript, production build, standard Chromium installation with dependencies, then the complete Playwright suite. Reports are uploaded even after failure. Actual observed run results and platform limitations are recorded in [QA.md](docs/QA.md); creating YAML is not itself a successful CI result.

Tests cover Portuguese and English interfaces, cookie persistence, language switching, localized currency/dates, exact quote calculations, candidate-specific minimums, invoice validation, the complete simulation, alternate route selection, dialog cancel/confirm/Escape, receipt downloads, persistence, public checkout, search, status filters, sorting, pagination, missing invoices, mobile navigation, console errors, reduced motion, keyboard radio navigation and overflow checks at **1440, 1280, 768, 390 and 360px**. Axe checks selected default screens for WCAG 2 A/AA and 2.1 AA rules; this is not a full accessibility certification or physical-device performance assessment.

See [QA.md](docs/QA.md), [DESIGN.md](DESIGN.md), and [screenshots](docs/screenshots).

## Simulated now / later

**Now:** local invoice CRUD creation/read flow, mocked Pix receipt, deterministic liquidity choices, frontend execution states, simulated receipt identifier, JSON export. No account authentication; “Sign in” opens a demo workspace. Data is browser-local, editable and not secure storage for sensitive records.

**Later, only after frontend approval:** authenticated backend and database; authoritative invoice validation/idempotency; sandbox Pix PSP and signed webhooks; wallet network and recipient checks; USDG token integration; Arbitrum Solidity settlement contracts; separately benchmarked Rust/Stylus optimization; compliance/security review; reconciliation, observability and recovery. See [PHASE2.md](docs/PHASE2.md).

## Design research and skills

Research findings and access limitations are recorded in `DESIGN.md`. Local skill installations are intentionally excluded from Git; pinned installation sources are in `skills-lock.json`. Reinstall with `npx skills experimental_install -a claude-code`. Skill suggestions are reference material, not runtime dependencies. No external reference assets were copied into the product.

## Current boundaries

Portuguese/English interface with Brazilian funding terminology. No real-time rates, tax calculations, KYB, authentication, multi-user synchronization, PDF generation, wallet signing or onchain explorers. Receipt export is JSON. The accessible table scrolls horizontally on mobile. Real-world provider eligibility and USDG liquidity availability still require validation in Phase 2. All frontend checks passed as documented; manual screen-reader and physical low-powered-device testing remain recommended.
