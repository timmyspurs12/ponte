# Phase 2 — delivered 2A / remaining integrations

Phase 1 + 1.1 frontend approval and merged PR #1 were verified before starting Phase 2A. The approved identity, bilingual components and explicit simulation labels are retained. Work is on Arena's assigned branch, not main. No deployment or paid infrastructure is authorized by this implementation.

## Delivered in Phase 2A

- Next.js Route Handler API, Zod server validation, service/repository boundaries and real PostgreSQL persistence.
- Versioned forward SQL migrations, database-managed timestamps, generated descriptive invoice columns, enforced snapshot consistency, explicit previous/new audit states and paginated business activity; seeded business/user/membership; reproducible local PG, guarded reset and CI PG service.
- Tenant-scoped access, active roles, explicit local development login; **production API fails closed** until real authentication is implemented.
- Exact integer BRL funding strings, server BigInt quote candidates/minima, persisted simulation source/expiry, locked route and expected/actual demo settlement output.
- Draft → Pending payment → Funded → Routing → Settled/Failed server state machine; transactional payments/events/receipts; duplicate, replay, invalid-state and expired-quote protection.
- API-backed asynchronous InvoiceService. No localStorage invoice authority or silent browser fixture fallback.
- Real database integration tests plus bilingual/responsive Playwright journey, production build and final-head Actions verification (see PR handoff / QA).

Details: [architecture and hosting evaluation](BACKEND_ARCHITECTURE.md), [API contract](API.md), [financial model](FINANCIAL_MODEL.md), [verification](QA_PHASE2A.md).

## Added in Phase 2B (current PR branch)

- Phase 2B.1 added an isolated `no_std + alloc` Rust optimizer with checked arithmetic, deterministic route validation and a host JSON-lines adapter. It is not connected to the app.
- Phase 2B.2–2B.4 added a synthetic-only Stylus wrapper, bounded calldata preflight, a complete client ABI and an offline advisory guard.
- Phase 2B.5–2B.6 captured hosted dependency/WASM evidence and produced a locally built, unactivated candidate artifact with a working reproducible container build path. No network check, deployment or activation was performed.
- Phase 2B.7 corrects product wording, adds the authoritative [hackathon evidence](HACKATHON_DEMO_EVIDENCE.md) and [demo guide](HACKATHON_DEMO_GUIDE.md), and refreshes screenshots from the running application.

The user-facing quotes still come from `src/lib/quotes.ts`. The Rust optimizer and Stylus wrapper are separate components, not the source of the UI's displayed candidates.

## Still gated / explicitly not implemented

1. **Production identity and deployment:** choose an established auth/session integration, production tenant selection, session revocation, staging access and least-privilege database roles. Approve exact hosts/plans/region/cost ceilings before creating any resource. Local token login cannot be enabled in production.
2. **Feasibility/compliance:** verify Brazilian PSP eligibility/sandbox, KYB/AML/licensing and FX/custody obligations with qualified providers; validate actual USDG availability, permitted use, metadata and liquidity.
3. **Pix adapter:** verified provider sandbox, real requests/QR codes, signed replay-protected webhooks, reconciliation/refunds/expiry and failure handling. Current payment confirmation is explicitly simulated and authenticated, not a webhook.
4. **Wallet/token adapters:** chain/network guards, verified decimals/contract address, recipient verification, explicit signing/approvals. Current illustrative wallet syntax is not ownership validation. No private keys or wallet secret storage.
5. **Contracts:** separate audited Solidity settlement project with unit/invariant/fuzz tests, pause/access controls, minimum output/deadlines, testnet validation, chain confirmations and reorg handling.
6. **Stylus runtime:** a synthetic wrapper and unactivated candidate exist, but no app integration, RPC check, deployment, activation, audit or contract-calculated route claim exists.
7. **Orchestration/recovery:** durable jobs, retry/reconciliation policies, expiry recovery/requote workflow, real provider/chain correlation and partial-failure handling. The current expired Routing record must fail rather than bypass route/quote locks.
8. **Operational readiness:** managed TLS/pooling, constrained roles, backups/restore drills, observability/alerts, retention/history pagination, login abuse prevention, security review, manual accessibility and physical-device tests.

The fixed 5.25 simulation rate establishes no market liquidity, economic advantage, settlement time or legal feasibility. No real Pix/USDG transfer, wallet signing, custody, contracts, public writable production endpoint or Stylus execution is part of Phase 2A.
