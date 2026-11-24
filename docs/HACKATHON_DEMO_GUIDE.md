# Deterministic hackathon demonstration guide

This guide produces the same local, wallet-free demonstration every time. It uses the real application and real PostgreSQL, but all Pix, route and settlement outputs are explicitly simulated. Do not use a hosted deployment: production builds intentionally disable development authentication.

For claim boundaries and CI evidence, read [HACKATHON_DEMO_EVIDENCE.md](HACKATHON_DEMO_EVIDENCE.md) first.

## Prerequisites

- Node.js **24.22.1** and npm. This is the exact runtime the project pins in
  [`.node-version`](../.node-version), `package.json#engines` (`>=24.22.1 <25`)
  and CI; other majors are not supported.
- Linux x64 with the `embedded-postgres` binaries supplied by `npm ci`. The project’s documented local PostgreSQL path uses port `54329`; a separately installed PostgreSQL 18 is the fallback.
- For **Windows 10 Pro x64 (unverified)**, follow [HACKATHON_DEMO_WINDOWS.md](HACKATHON_DEMO_WINDOWS.md). It contains PowerShell commands, low-memory guidance and explicit verification limits; do not set `PONTE_BROWSER_FALLBACK`.
- A free local loopback port `3000` and database port `54329`.
- No wallet, key, RPC endpoint, paid service, Rust toolchain or cloud account.

## Exact setup

From the repository root:

```sh
npm ci
cp .env.example .env.local
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the generated 64-character value into `PONTE_DEV_TOKEN` in `.env.local`. Keep `PONTE_DEV_AUTH=1`, `PONTE_DEV_BUSINESS_ID` and `PONTE_DEV_USER_ID` as provided. Never commit or share `.env.local`.

In terminal 1, start the disposable database and leave it running:

```sh
npm run db:local
```

In terminal 2, migrate, seed and start the application:

```sh
npm run db:seed
npm run db:fixtures
npm run dev
```

`db:seed` is repeatable. `db:fixtures` creates eight illustrative invoices through the real backend lifecycle. Open <http://localhost:3000/dev-login>, enter the local token and continue to `/app`.

## The exact demo invoice

Use reference **`PNT-2026-1048`**:

| Field | Value |
| --- | --- |
| Supplier | Meridian Supply Co. |
| BRL funding | `R$25,000.00` (`fundingMinor = "2500000"`) |
| Wallet | `0x` followed by 40 `1` characters; format only, no ownership check |
| Due date | `2027-12-20` |
| Initial status | `Pending payment` |
| Description | `Illustrative database seed — simulation only` |

Other useful seeded records: `PNT-2026-1042` (Lume Design) is terminal `Failed` and demonstrates the replacement link; `PNT-2026-1047` and `PNT-2026-1043` are already settled.

## Exact actions and expected results

1. In `/app`, confirm the banner says **Demo mode** and that metrics are labelled as demo data.
2. Open `/app/invoices`, find `PNT-2026-1048`, and open its detail page.
3. Click **Simulate Pix payment received**. The invoice moves to `Funded`; the UI records a simulated payment, not a PSP event.
4. Compare the three illustrative candidates:

| Route | Fee | Estimated impact | Expected output | Minimum output |
| --- | ---: | ---: | ---: | ---: |
| Direct liquidity | 0.35% | 0.05% | 4,745.23 USDG | 4,721.50 USDG |
| Split liquidity | 0.48% | 0.08% | 4,739.04 USDG | 4,715.34 USDG |
| Multi-hop route | 0.65% | 0.12% | 4,730.95 USDG | 4,707.29 USDG |

   The panel says **Sample FX**, **No live market data** and **Illustrative fixtures**. These are UI quote calculations from `src/lib/quotes.ts`, not Rust optimizer or Stylus outputs.
5. Select **Split liquidity**, then click **Select route & continue**. The invoice moves to `Routing`; the quote and route are locked server-side. Reloading preserves the state.
6. Click **Simulate settlement**, then **Confirm simulation**. The invoice moves to `Settled`.
7. The receipt should show:
   - **Simulated settlement complete**;
   - **4,739.04 USDG**;
   - **No blockchain transaction occurred**;
   - selected route **Split liquidity**;
   - sender `PONTE simulation`;
   - recipient `Meridian Supply Co.`;
   - original amount `R$25,000.00`;
   - execution cost `$0.02 · illustrative`;
   - a demo transaction ID beginning `SIM-`, not a chain hash;
   - a UTC timestamp.
8. Click **Export demo receipt**. The downloaded JSON begins with `SIMULATED SETTLEMENT — NO REAL FUNDS MOVED` and is named `ponte-demo-PNT-2026-1048.json`.
9. **Open demo payment page** opens `/pay/<uuid>`. It is viewable only with an account already authenticated for this workspace. Copying the URL does not grant external access.

## Two-minute demonstration script

| Time | Action | Narration |
| --- | --- | --- |
| 0:00–0:20 | Show the landing page and route atlas. | “Brazilian businesses paying overseas suppliers lack a clear view from local payment to final settlement. PONTE is an interactive prototype: no real funds move.” |
| 0:20–0:35 | Log in at `/dev-login`; show `/app`. | “A development-only token opens a tenant-scoped workspace backed by PostgreSQL. The eight invoices and all metrics are demo data.” |
| 0:35–1:15 | Open `PNT-2026-1048`; simulate Pix; compare routes; choose Split; confirm settlement; show receipt. | “This is the full lifecycle. Pix confirmation and settlement are simulated; the server calculates and locks the illustrative quote, route and receipt. There is no blockchain transaction.” |
| 1:15–1:35 | Reload the receipt and open the payment page. | “State comes from the database, not browser storage. The payment link requires an authenticated workspace member; it is not a public checkout.” |
| 1:35–1:55 | Open `/developers`; optionally show the evidence document. | “The Rust optimizer and Stylus wrapper are separate, offline-tested components. They do not power these UI quotes and nothing is deployed.” |
| 1:55–2:00 | Return to the receipt. | “What works today is a transparent, persistent simulation. Real PSP, wallet, liquidity and settlement integrations remain future gates.” |

## 90-second recording script

Use one browser tab, no audio, and large captions. Do not record any RPC, wallet or provider screen.

1. **0–8s** — Landing page, desktop 1440px. Caption: “Pix → illustrative USDG journey · no real funds”.
2. **8–18s** — `/dev-login` form, then overview. Caption: “Local development login · PostgreSQL-backed demo workspace”.
3. **18–30s** — Invoice `PNT-2026-1048`; click Simulate Pix. Caption: “Simulated Pix confirmation · server-side state transition”.
4. **30–48s** — Route comparison; select Split. Caption: “Illustrative routes from `src/lib/quotes.ts` · no live market data”.
5. **48–66s** — Select route, confirm simulation, show receipt. Caption: “Simulated settlement · locked route · SIM receipt · no chain transaction”.
6. **66–76s** — Export JSON and reload the settled page. Caption: “Receipt export and database persistence”.
7. **76–84s** — `/developers`. Caption: “Rust optimizer and Stylus wrapper are separate and offline; no deployment”.
8. **84–90s** — Final receipt frame. Caption: “Prototype, not production: no PSP, wallet, liquidity or onchain settlement”.

## Regenerating the committed screenshots

With the dev server running and the seeded database in its initial state:

```sh
PONTE_BROWSER_FALLBACK=1 node scripts/capture-hackathon-screenshots.mjs
```

The script writes current desktop/mobile images to `docs/screenshots/`. The fallback is the existing registry-packaged Chromium used by the repository’s Linux tests; it contacts no external service. On Windows, install Playwright Chromium with `npm run test:install` and run `node scripts/capture-hackathon-screenshots.mjs` without the fallback variable; see [HACKATHON_DEMO_WINDOWS.md](HACKATHON_DEMO_WINDOWS.md).

## Recovery if the demo fails

- **Port 3000 already in use:** stop the unrelated server, or run the demo on a clean machine. Tests and screenshots assume `http://localhost:3000`.
- **Database not reachable:** confirm terminal 1 still shows `database system is ready` and `npm run db:local` is running. Re-run `npm run db:seed`.
- **Login rejected:** confirm `.env.local` has `PONTE_DEV_AUTH=1` and a token of 32–128 `[A-Za-z0-9_-]` characters. Use `npm run dev`, not a production build.
- **Duplicate reference:** use a new unique reference when creating a fresh invoice; references are tenant-unique and case-insensitive.
- **Route buttons disabled:** the invoice is not in `Funded` state. Use `PNT-2026-1048` after a local reset, or complete the current invoice’s earlier step.
- **Need a clean deterministic state:** run `npm run db:reset -- --confirm-local-reset`, then `npm run db:fixtures`. This is destructive and refuses non-loopback databases; never point it at valuable data.
- **Browser tests/screenshots fail in this restricted Linux sandbox:** use `PONTE_BROWSER_FALLBACK=1 npm test` or the screenshot command above. Standard Chromium remains the default in CI.

## Boundaries to repeat during the demo

- Pix confirmation, routes, FX and settlement are simulated.
- USDG uses a two-decimal **demo** scale, not claimed token decimals.
- The Rust optimizer is separately tested and is not connected to the UI.
- The Stylus candidate is unactivated and undeployed; no RPC check or transaction was performed.
- There is no production authentication, public supplier checkout, real liquidity or financial integration.
