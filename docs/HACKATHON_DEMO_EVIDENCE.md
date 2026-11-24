# Hackathon demo evidence

**Baseline:** PR #13 head `051b2f17d658a0e11af68afe4666fc85c16b1ca4`, 18 November 2026. PR #13 remains open and draft against `main`; PR #14 is incorporated into that branch. `main` was not changed by this work.

This is the authoritative, evidence-first description of what PONTE is today. It deliberately separates the user-facing simulation from the separate Rust optimizer and Stylus work. No live payment, liquidity, wallet or blockchain settlement is claimed.

## Problem and target user

Brazilian businesses paying overseas suppliers face an opaque cross-border journey: local payment, currency conversion, route selection and final settlement are difficult to inspect together. PONTE is a prototype for a Brazilian finance/operations user who wants to pay a supplier in BRL through a familiar Pix-style flow and understand the assumed conversion, route and demo receipt in one workspace.

Evidence: `DESIGN.md` (“financial bridge for Brazilian businesses and international suppliers”), `README.md`, and the landing/workspace copy in `src/components/marketing.tsx` and `src/components/overview.tsx`.

## What works today

| Area | Current capability | Evidence |
| --- | --- | --- |
| Local access | Development-only token login issues an HttpOnly/SameSite=Strict cookie; production API fails closed with `503 AUTH_NOT_CONFIGURED`. | `src/app/dev-login/route.ts`, `src/server/auth.ts`, `docs/API.md` |
| Backend | Next.js Route Handlers, strict Zod validation, real PostgreSQL persistence, tenant-scoped queries, idempotency, rate limiting and append-only events. | `src/server/service.ts`, `src/server/repository.ts`, `migrations/`, `tests-backend/foundation.test.ts` |
| Lifecycle | `Draft → Pending payment → Funded → Routing → Settled/Failed`; failed is terminal; replacement creates a new invoice. | `src/server/service.ts`, `tests/consistency.spec.ts`, `docs/API.md` |
| Workspace | Overview, invoice table, validated create form, detail flow, route comparison, settlement confirmation, JSON receipt export, workspace-restricted `/pay/[id]`. | `tests/frontend.spec.ts`, `tests/localization.spec.ts`, `docs/QA_PHASE2A.md` |
| Quote arithmetic | Server-owned BigInt/rational calculation with integer BRL cents, fixed illustrative rate `525/100`, three fixed route candidates and a 50 bps minimum-output tolerance. | `src/lib/quotes.ts`, `docs/FINANCIAL_MODEL.md`, `tests/quotes.spec.ts` |
| Persistence proof | Browser lifecycle test clears `localStorage`, reloads, and opens the settled invoice in a second authenticated context. | `tests/frontend.spec.ts` |
| Bilingual/responsive UI | Portuguese default, English option, five tested widths, selected Axe checks and reduced-motion behaviour. | `src/lib/i18n/`, `tests/localization.spec.ts`, `tests/frontend.spec.ts` |
| Separate Rust optimizer | Independent `no_std + alloc` library with checked `U256` arithmetic, 1–64 candidate validation, deterministic rejection precedence and tie-breaking. | `rust/optimizer/`, `docs/PHASE2B_IMPLEMENTATION.md` |
| Separate Stylus wrapper | Synthetic-only ABI evaluator `evaluateSynthetic`, selector `0x31631981`, bounded calldata, complete client ABI and offline WASM host-stub tests. | `rust/stylus-wrapper/`, `docs/PHASE2B2_IMPLEMENTATION.md`, `docs/PHASE2B3_2A_BOUNDED_CALLDATA.md`, `docs/PHASE2B3_3_CLIENT_ABI.md` |
| Build provenance | Pinned SDK/CLI/toolchain; host and reproducible container builds recorded; container path fixed in Phase 2B.6.1. | `docs/PHASE2B6_1_WORKSPACE_LAYOUT.md` |

## What is simulated

- **Pix confirmation:** a button transitions the invoice after a server-side simulated payment record; there is no PSP, QR code or webhook.
- **Route candidates:** the UI shows three fixed illustrative routes (35/48/65 bps fees, 5/8/12 bps estimated impact, 50 bps tolerance). They are not discovered liquidity or executable quotes.
- **FX/rate:** `525/100` BRL per demo USDG is a fixed example. Real market data, token decimals, token address and redemption guarantees are unknown.
- **Settlement:** the server writes a locked expected output and receipt with a `SIM-…` identifier. No chain transaction occurs; the UI says “No blockchain transaction occurred.”
- **Payment link:** `/pay/[id]` is a workspace-authenticated view for internal demonstrations, not a public supplier checkout.
- **Seed data:** eight invoices are illustrative records created through the real backend lifecycle; all metrics derived from them are demo values.

## What is not implemented

Production identity/session integration, hosted deployment, PSP/webhook adapter, wallet or signing, verified USDG token adapter, market/liquidity data, real settlement, audit, KYB/AML, reconciliation/retry orchestration, public supplier access, PDF receipts, and any deployed or activated Stylus program.

## Three separate calculation layers

| Layer | Role | Evidence and boundary |
| --- | --- | --- |
| **UI quote** | `src/lib/quotes.ts` produces the candidates shown in the app; the server persists and locks them. | This is the only calculation that powers the displayed demo quotes. |
| **Rust optimizer** | `rust/optimizer` is a separately tested route-evaluation library with a host JSON-lines CLI. | It is **not called by the web application**. Its inputs are synthetic and caller supplied. |
| **Stylus wrapper** | `rust/stylus-wrapper` exposes the Rust optimizer through a synthetic ABI evaluator. | It is **not called by the web application**, is not deployed/activated, and its result is not an executable quote. |

Do not describe the UI routes as “optimizer-powered” or “onchain-calculated”.

## Test evidence at the baseline head

| Check | Result | Link |
| --- | --- | --- |
| Application quality (backend tests, migrations, lint, typecheck, production build, Playwright) | Success | [run 44407116517](https://github.com/timmyspurs12/ponte/actions/runs/44407116517) |
| Optimizer and environment-check | Success | [run 44407116646](https://github.com/timmyspurs12/ponte/actions/runs/44407116646) |
| `validate` | Success | [run 44407104631](https://github.com/timmyspurs12/ponte/actions/runs/44407104631) |
| Dependency evidence | Failure at existing RustSec gate after graph capture, WASM reproduction and artifact upload | [run 44407116518](https://github.com/timmyspurs12/ponte/actions/runs/44407116518) |

The push and pull-request evidence runs at this head are duplicates of the same findings, not independent failures.

### Optimizer differential result

[Run 43959588203](https://github.com/timmyspurs12/ponte/actions/runs/43959588203) on commit `6a64337384aabcb063194a3b170043f6bc397bd5` recorded **10,760 finite synthetic comparisons with zero mismatches**: 60 static fixtures, 10,000 generated synthetic cases, 500 permutation cases and 200 adversarial cases. The result breakdown was 5,236 `SELECTED`, 3,298 `NO_ROUTE` and 2,226 `ERROR`; all 10,760 canonical JSON outputs matched byte for byte. This is evidence of finite differential parity on a synthetic corpus, **not** a proof of production correctness, market validity or onchain safety. Current-head optimizer checks pass in run 44407116646.

### Stylus wrapper and artifact evidence

- [Wrapper run 44398146837](https://github.com/timmyspurs12/ponte/actions/runs/44398146837) passed advisory guard, ABI checks, formatter, tests, Clippy, WASM inspection and offline host-stub execution at commit `d3dae37`.
- [Candidate artifact run 44398147388](https://github.com/timmyspurs12/ponte/actions/runs/44398147388) passed all 17 steps with a `complete` record at the same commit. [Artifact 14471989038](https://github.com/timmyspurs12/ponte/actions/runs/44398147388/artifacts/14471989038) is a locally built, unactivated candidate.
- Current baseline head `051b2f17` differs from `d3dae37` only by two documentation files; no Rust source, manifest, lockfile or workflow changed.

| Artifact measurement | Value |
| --- | --- |
| Host release WASM | 90,498 bytes; SHA-256 `b3574ee3ee4c9bbc11c2fe103c101008f5b775b5890ad1fbefe118b8846f3a3f` |
| Reproducible container WASM | Two clean exports byte-identical; SHA-256 `42d8a474d8762aa37df09c9c415dcec1ff7e904e8bfcdcfa365669ad30cd93d2` |
| Container project hash | `dcc4f735fcbfe7fb214d3a3dfda06567f5104684a54d14aebfebe962e5e4f70f` (20 hashed files) |
| Container init code | 24,151 bytes; deployed code 24,108 bytes; Brotli-compressed program 24,084 bytes |
| Single-contract headroom | 492 bytes below 24,576; no fragmentation |

Host and container WASM differ because the CLI image installs `rust-src` and builds from `/source`. The init code is not a deployment payload. Neither hash establishes Nitro activation, gas, codehash match or deployability.

## Known limitations

- **RustSec remains red.** Against advisory DB `472a4c9a785030434f15d7da84964d60fbe789ab`: stylus-wrapper has one vulnerability (`crypto-bigint 0.5.5`, RUSTSEC-2026-0387), one unsoundness warning (`lru 0.16.4`, RUSTSEC-2026-0253) and five unmaintained warnings (`chrono`, `derivative`, `paste`, `proc-macro-error`, `proc-macro-error2`); optimizer has one unmaintained `paste` warning; environment-check is clean. `--deny warnings` was not removed and no advisory was suppressed.
- These are lockfile-wide findings. Existing evidence distinguishes host/dev/build paths from release WASM, but does not prove universal unreachability or exploitability. No compatible minimal remediation was identified under the current pins; further investigation is required.
- Contract inputs are caller supplied and unauthenticated. A synthetic result is not freshness, liquidity, price protection or settlement authority.
- No `cargo stylus check` against an endpoint, deployment, activation or verification was performed. No RPC endpoint was contacted.
- Selected Axe checks at five widths are not a full accessibility certification; no physical-device or screen-reader testing was performed.
- The UI is a local development application. Production financial access is intentionally closed.

## Current visual evidence

Regenerated from the running application at the current branch state:

- `docs/screenshots/home-1440.png`, `docs/screenshots/home-390.png`
- `docs/screenshots/overview-desktop.png`, `docs/screenshots/overview-mobile.png`
- `docs/screenshots/invoice-routes-desktop.png`, `docs/screenshots/invoice-routes-mobile.png`
- `docs/screenshots/receipt-desktop.png`, `docs/screenshots/receipt-mobile.png`
- `docs/screenshots/developers-desktop.png`, `docs/screenshots/developers-mobile.png`

Files prefixed `phase1.1-pt-` are historical Phase 1.1 visual baselines and are not current product evidence.
