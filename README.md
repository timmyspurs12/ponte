# PONTE

**Phase 1: a frontend-only Pix-to-USDG settlement concept for Brazilian businesses.** Built for Arbitrum Open House São Paulo. No real funds move, no bank QR code is generated, no wallet is connected, and no contract is called.

## Run locally

Requires Node.js 22+ and npm.

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
3. Choose **Simulate Pix payment received**.
4. Compare the three deterministic routes, choose one and continue.
5. Choose **Simulate settlement**, review and confirm.
6. Export the clearly labeled JSON demo receipt. Refresh to verify local persistence.

Invoices and transitions are stored in `localStorage` under `ponte-demo-v1`. Created invoice links are not shareable across browsers/devices/origins. Clear this key in browser storage to reset to the eight sample records. Seeded settled receipts use fixed sample timestamps; new simulated settlements use the interaction timestamp. A malformed store falls back to fixtures. Storage write failures show an error instead of claiming success.

## Architecture

- Next.js App Router, React, TypeScript, Motion React, Lucide; custom responsive CSS tokens.
- `src/components`: shared UI, marketing, overview, invoice table, invoice form, payment journey and application shell.
- `src/lib/models.ts`: Invoice, Payment, PaymentQuote, RouteCandidate, RouteExecution, SettlementReceipt, Business and Wallet.
- `src/lib/services.ts`: single composition root for the asynchronous invoice-service interface.
- `src/lib/demo-service.ts`: browser-only service and deterministic quote fixtures. FX is fixed at **R$5.25 per USDG**. Candidate output is funding / FX less the displayed percentage fee, rounded down to cents. Minimum output is selected output less a 0.5% tolerance; execution cost is a separate illustrative $0.02. None of these values is a market quote or executable guarantee.
- Future real API adapter replaces the demo invoice service. Wallet, PSP, token, contract and routing integrations belong in separate adapters, not visual components.

The proposed platform is not an operational financial service. All businesses, invoices, addresses and amounts are illustrative. Arbitrum, USDG, Pix and Stylus references describe a proposed technology direction, not partnerships or completed integrations.

## Quality checks

```sh
npm run lint
npm run typecheck
npm run build
# Keep the app running on port 3000 in another terminal:
npm test
```

The included test runner uses Playwright and a **Linux x64 registry-packaged Chromium fallback**, because the browser CDN is blocked in the Arena environment. `npm test` prepares Chromium and its bundled libraries in ignored local caches. For another operating system, install a standard Playwright Chromium and change `launchOptions` in `playwright.config.ts`. Browser binaries and generated test artifacts are not committed.

Tests cover invoice validation, the complete simulation, alternate route selection, dialog cancel/confirm/Escape, receipt downloads, persistence, public checkout, search, status filters, sorting, pagination, missing invoices, mobile navigation, console errors, reduced motion, keyboard radio navigation and overflow checks at **1440, 1280, 768, 390 and 360px**. Axe checks selected default screens for WCAG 2 A/AA and 2.1 AA rules; this is not a full accessibility certification or physical-device performance assessment.

See [QA.md](docs/QA.md), [DESIGN.md](DESIGN.md), and [screenshots](docs/screenshots).

## Simulated now / later

**Now:** local invoice CRUD creation/read flow, mocked Pix receipt, deterministic liquidity choices, frontend execution states, simulated receipt identifier, JSON export. No account authentication; “Sign in” opens a demo workspace. Data is browser-local, editable and not secure storage for sensitive records.

**Later, only after frontend approval:** authenticated backend and database; authoritative invoice validation/idempotency; sandbox Pix PSP and signed webhooks; wallet network and recipient checks; USDG token integration; Arbitrum Solidity settlement contracts; separately benchmarked Rust/Stylus optimization; compliance/security review; reconciliation, observability and recovery. See [PHASE2.md](docs/PHASE2.md).

## Design research and skills

Research findings and access limitations are recorded in `DESIGN.md`. Local skill installations are intentionally excluded from Git; pinned installation sources are in `skills-lock.json`. Reinstall with `npx skills experimental_install -a claude-code`. Skill suggestions are reference material, not runtime dependencies. No external reference assets were copied into the product.

## Current boundaries

English interface with Brazilian funding terminology. No real-time rates, tax calculations, KYB, authentication, multi-user synchronization, PDF generation, wallet signing or onchain explorers. Receipt export is JSON. The accessible table scrolls horizontally on mobile. Real-world provider eligibility and USDG liquidity availability still require validation in Phase 2. All frontend checks passed as documented; manual screen-reader and physical low-powered-device testing remain recommended.
