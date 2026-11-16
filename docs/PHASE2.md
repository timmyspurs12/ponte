# Proposed Phase 2 — not implemented

Frontend approval is the gate. No public deployment or paid infrastructure was created during Phase 1.

1. **Feasibility & compliance:** verify Brazilian PSP sandbox/eligibility, KYB/AML and licensing obligations with qualified providers; verify USDG contract/network availability, permitted use and actual liquidity. Resolve custody and FX responsibilities before implementing money movement.
2. **Backend boundary:** define authenticated invoice API and error contracts using the existing asynchronous InvoiceService. Use integer minor units/fixed-point arithmetic, server validation, authorization, event log, idempotency keys and database migrations. Browser-local records are not authoritative.
3. **Pix adapter:** provider sandbox, real payment requests, signed/replay-protected webhooks, funding reconciliation, expiry, refunds and failure states. Generate actual banking QR codes only through the verified provider.
4. **Wallet & token adapters:** chain/network guards, provider interface, chain-verified token metadata/decimals, recipient confirmation, approvals and explicit user signing. No frontend secrets.
5. **Settlement contracts:** separate Solidity project, unit/invariant/fuzz tests, access control, pause controls, minimum-output/deadline protections, external security review and testnet validation. Add chain receipts only after confirmations; handle reorgs and failed execution.
6. **Stylus optimizer:** separate Rust implementation; compare deterministic inputs and outputs with a reference model, benchmark total fees/slippage/gas; only claim contract-calculated routes once independently verified.
7. **Orchestration:** quote API, short validity, authoritative status machine, queue/retries, provider/chain correlation IDs and settlement reconciliation. Keep API, Pix, wallet, USDG, contracts and route engine as independent adapters.
8. **Operational readiness:** observability, audit trails, incident playbooks, security review, accessibility/manual device testing and user acceptance. Obtain explicit permission before deployment, charges or any production payment testing.

The current quote fixtures are only demonstration math. They do not establish liquidity, price, settlement time, legal feasibility, or economic advantage.
