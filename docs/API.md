# PONTE Phase 2A API

Base: `/api/v1`. Node runtime; JSON; all operations require a verified tenant context. **Simulation only.** Production access fails closed pending production authentication. There is no public PSP webhook, actual payment initiation or chain execution.

## Local authorization

Set up `.env.local`/seed per README, then log in at `/dev-login`. Browser uses a HttpOnly SameSite=Strict cookie. Local CLI clients may send `Authorization: Bearer <your local PONTE_DEV_TOKEN>`. Never put tokens into URLs, repository files, client bundles or documentation examples with real values. Tenant/user IDs are server configuration in local mode, not request-controlled fields.

Active admin/operator: read and write. Active viewer: read only. Missing/incorrect credentials: 401. Missing/disabled membership or unauthorized role: 403. Other tenant's invoice: 404, including nested resources. Dev authentication is not a multi-user production login.

Every mutation requires `Content-Type: application/json` and an **`Idempotency-Key`** of 8–128 letters/digits/underscore/hyphen. Generate a fresh UUID for each intended operation and **reuse that same key and exact body when retrying** a lost response. Same tenant+key+method/path/body returns the original committed response; changed request under the same key returns 409. Keys are not currently automatically expired. HTTP and durable domain correlation IDs are separate.

## Envelopes and codes

Success: `{ "data": ..., "requestId": "uuid" }`. Lists put the array directly in `data`.

Error: `{ "error": { "code": "INVALID_TRANSITION" }, "requestId": "uuid" }`. No SQL text, stack, credentials or invoice existence outside the tenant is returned. Responses are `Cache-Control: no-store`.

- 200: read, update, transition, successful replay of those operations.
- 201: create invoice, quote or simulated payment (including its replay).
- 400 `INVALID_JSON`; 401 `UNAUTHENTICATED`; 403 `FORBIDDEN` / `ORIGIN_REJECTED`.
- 404 `NOT_FOUND`; 405 for unsupported methods.
- 409: `DUPLICATE_REFERENCE`, `IDEMPOTENCY_CONFLICT`, `INVALID_TRANSITION`, `INVOICE_LOCKED`, `ROUTE_LOCKED`, `QUOTE_EXPIRED_OR_MISSING`.
- 413 `BODY_TOO_LARGE` (16 KiB maximum JSON stream); 415 `UNSUPPORTED_MEDIA_TYPE` for non-JSON mutations.
- 422 `VALIDATION_ERROR`, `INVALID_DUE_DATE`, `QUOTE_AND_ROUTE_REQUIRED`.
- 429 `RATE_LIMITED`, with `Retry-After: 60`; 120 authenticated requests per tenant/user per fixed DB minute.
- 503 `AUTH_NOT_CONFIGURED`: dev mode off/unconfigured, or **any production build**.
- 500 `INTERNAL_ERROR`: unexpected server failure; use requestId for server-side investigation.

JSON bodies are strict; unknown fields (including caller-supplied status, receipt, amount outputs, tenant, simulated=false) are rejected. UUID path IDs and bounded fields are parsed by Zod. Native unsupported-method responses come from Next.js and may not use the JSON envelope.

## Resources

| Method/path | Input | Result |
|---|---|---|
| POST `/invoices` | Invoice fields below | Draft invoice |
| GET `/invoices?limit=100&offset=0&status=Funded` | limit 1–100, offset 0–100000, optional exact canonical status | Tenant invoices, created descending then UUID; next offset is offset+limit; a shorter page is the end |
| GET `/invoices/:id` | UUID | Persisted invoice snapshot |
| PATCH `/invoices/:id` | Full invoice fields below | Updated Draft only; not partial merge |
| POST `/invoices/:id/transitions` | `{ "status": "Pending payment" }`, or authorized next state; routing inputs below | Updated invoice |
| POST `/invoices/:id/payments` | `{}` | Confirm simulated funding, equivalent to transition to Funded; Pending payment only |
| GET `/invoices/:id/payments` | — | Array, zero/one simulated provider record |
| GET `/invoices/:id/payments/:paymentId` | UUID | Same-tenant, same-invoice payment record |
| POST `/invoices/:id/quotes` | `{}` | Persisted server quote; Pending payment/Funded only |
| GET `/invoices/:id/quotes` | — | Quote history including source/expiry/candidate snapshot |
| GET `/invoices/:id/quotes/:quoteId` | UUID | Same-tenant, same-invoice quote record |
| GET `/invoices/:id/settlements` | — | Array, zero/one locked simulation settlement |
| GET `/invoices/:id/activity` | — | Append-only correlated event history |

History endpoints return the invoice's complete history in this foundation. Pagination applies to the top-level invoice collection; a production history-retention/cursor strategy remains a scaling gate. Same-timestamp event ordering is not a sequence-number guarantee.

### Invoice fields

```json
{
  "reference": "PNT-LOCAL-001",
  "supplier": "Illustrative supplier",
  "wallet": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "fundingMinor": "2500001",
  "due": "2027-12-20",
  "description": "Simulation only — never send funds"
}
```

`fundingMinor` is canonical positive **BRL cents**, string, range 100–1000000000 (R$1–R$10,000,000). No decimals, exponents, leading zeros, numeric JSON values or negative signs. Due is a valid ISO calendar date, today or later at creation/update (server UTC). Reference is 1–100 characters, supplier 2–200, description up to 2000; strings are trimmed where appropriate. Wallet is a syntactically valid 0x/40-hex illustrative address: no network ownership, checksum, token availability or recipient identity verification is implied.

Response includes `fundingMinor`, canonical `status`, UUID and server-created date, plus a persisted server-generated illustrative `quote` for display. `amount: 25000.01` and `payment.amount` remain backward-compatible **display-only** fields for approved visual components; they are never accepted as authority by the server. Funding currency is fixed BRL, illustrative settlement asset USDG. Actual token base units are unknown and not used.

Reference uniqueness is **case-insensitive within a tenant**. Different tenants may use the same reference. Draft edits do not affect funded or locked invoices.

## Full local lifecycle example

The following uses a shell variable `TOKEN` set privately to the generated development token. Replace `<id>`/`<quote-id>` using actual `data.id` values returned by the preceding calls. These are documentation placeholders, not real IDs. Use a new reference for a second intended invoice.

```sh
curl http://localhost:3000/api/v1/invoices \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: local-create-001' \
  --data '{"reference":"PNT-LOCAL-001","supplier":"Illustrative supplier","wallet":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","fundingMinor":"2500001","due":"2027-12-20","description":"Simulation only"}'
```

Then send authenticated POST requests with distinct idempotency keys to:

1. `/invoices/<id>/transitions`, body `{"status":"Pending payment"}`.
2. `/invoices/<id>/payments`, body `{}`. Writes a unique simulated provider reference and received timestamp; no external Pix occurred.
3. `/invoices/<id>/quotes`, body `{}`. Save `data.id` as quote ID. `data.data` holds all candidates; `data.expires_at` is 15 minutes after quote creation. Source is `simulation-fixed-525`, never live liquidity.
4. `/invoices/<id>/transitions`, body `{"status":"Routing","route":"split","quoteId":"<quote-id>"}`. Route is one of `direct`, `split`, `multi`; quote must belong to the same tenant/invoice and be unexpired.
5. `/invoices/<id>/transitions`, body `{"status":"Settled","route":"split"}`. Rechecks persisted quote expiry and locked route. Optional route cannot change it. Server writes receipt/output/timestamp and actual=expected demo output. No browser output, timestamp or receipt is accepted.
6. GET `/invoices/<id>` after reload/new authenticated client, then GET its `/activity` and `/settlements`.

A second funding or settlement under a different key returns 409; a replay with its original key returns the original success. The unique payment/settlement constraints and invoice row lock also protect concurrent requests. No transition out of Settled/Failed is allowed. Any nonterminal state can fail only along the documented [state table](BACKEND_ARCHITECTURE.md#state-machine-and-atomicity).

A failed expired quote settlement does not partially update a receipt or append a success event. There is no in-place route replacement after Routing. Mark it Failed; requote/recovery requires future explicit workflow design.

## Units and receipts

Quote `fundingMinor`: BRL cents. Candidate `outputMinor`, `feeMinor`, `minimumOutputMinor`: **illustrative USDG two-decimal units**, not verified ERC-20 decimals. `executionCostMinor: "2"`: illustrative **USD accounting cents**, separate from token output. Rational rate `525/100` is fixed demonstration BRL per USDG. Financial arithmetic is BigInt with documented floors, not floating-point execution math.

Settlement record exposes `expected_minor`, `minimum_minor`, `actual_minor`, locked `route_id`, `status`, timestamps and NULL `transaction_hash`. Receipt `execution.identifier` begins `SIM-`; it is not a transaction hash or proof of a blockchain transfer. See [FINANCIAL_MODEL.md](FINANCIAL_MODEL.md).
