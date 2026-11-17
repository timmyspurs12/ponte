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
| GET `/activity?limit=50&offset=0&type=invoice.Funded` | limit 1–100, offset 0–100000, optional exact event type | Business-wide tenant-scoped event history, newest first |
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
| GET `/invoices/:id/settlements` | — | Array, zero/one locked settlement record with server-owned `simulated: true` |
| GET `/invoices/:id/activity` | — | Append-only correlated event history |

Invoice-scoped history endpoints return that invoice's complete history in this foundation. Pagination applies to the top-level invoice collection and business-wide activity; a production history-retention/cursor strategy remains a scaling gate. Same-timestamp event ordering is not a sequence-number guarantee.

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

Response includes `fundingMinor`, canonical `status`, UUID, precise database `createdAt`/`updatedAt` timestamps and server-created date, plus a persisted server-generated illustrative `quote` for display. `amount: 25000.01` and `payment.amount` remain backward-compatible **display-only** fields for approved visual components; they are never accepted as authority by the server. Funding currency is fixed BRL, illustrative settlement asset USDG. Actual token base units are unknown and not used.

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

Each settlement-history record exposes `expected_minor`, `minimum_minor`, `actual_minor`, locked `route_id`, `status`, timestamps, NULL `transaction_hash`, and **`simulated: true`**. The server adds this boolean when returning settlement history; it is not supplied or controlled by the client. The current lifecycle and schema support only simulated payments and quotes, and settlement records reference those quotes. Therefore all existing records, including records created before this response field existed and records in Routing, Failed, or Settled state, receive the same flag without a database migration or backfill. Other history resources are unchanged.

The flag identifies simulation provenance; it is **not proof of payment, blockchain settlement, or any transfer**. `Settled` and `actual_minor` describe a completed demo state, not a real financial outcome. Receipt `execution.identifier` begins `SIM-`; it is not a transaction hash or proof of a blockchain transfer. If real settlement is ever introduced, this response must first be redesigned around independently verified, persisted provenance; it must not label unknown or real records by assuming this simulation-only invariant. See [FINANCIAL_MODEL.md](FINANCIAL_MODEL.md).

## Relational audit metadata

The forward `002_audit_metadata` migration adds created/updated timestamps to businesses, users and memberships, and a DB-maintained invoice update time. Invoice descriptive fields, currencies, asset and due date are generated relational columns from one snapshot, so they cannot be edited independently into inconsistent copies. A CHECK requires the snapshot's ID/reference/status/funding/display amount to agree with authoritative relational columns (including rejecting JSON null). API timestamp values are hydrated from columns, never accepted from clients or saved as stale snapshot timestamps.

Payments expose fixed `funding_currency: "BRL"`, `status: "Confirmed"`, creation time and `received_at` as the authoritative confirmation time. Settlements expose fixed `settlement_asset: "USDG"` and update time; Settled requires non-null actual output and completion time.

Events expose `previous_state` (null for creation) and `new_state`. Quote and Draft-edit events keep the same state on both sides; only lifecycle events advance it. `/activity` returns only the authenticated business's events with the same no-store/error/rate-limit boundary as invoices. The overview uses this endpoint for real workspace activity rather than presenting invoice creation dates as an event feed.

For pre-migration business/user/membership records that had no historical timestamps, added metadata reflects migration time, not a recovered original time. Existing invoice created time and all financial records are preserved. Event state history is backfilled in chronological order and the immutable-event trigger is restored in the same migration transaction.

## Phase 2A.2 interface consistency

Failed remains terminal. The invoice screen offers **Create replacement invoice** (`/app/invoices/new`) rather than an unsupported Failed → Pending payment retry. Merely opening the replacement form performs no financial mutation; the original invoice and audit events remain unchanged. Creating a replacement is a new invoice operation, not resetting or resuming the original.

The copied `/pay/:id` URL is **workspace-restricted**, for internal demonstrations. Readers must already be authenticated with access to that invoice's workspace. External supplier access has not been implemented. The URL is not a public checkout capability, and its data is not a browser-local store. Anonymous invoice API reads return 401 without invoice data; authorized workspace reads return 200, while cross-tenant reads remain excluded. The HTML application shell can load without authentication, but it does not expose invoice details. No authentication or tenant enforcement was relaxed for these interface fixes. Both languages explain the restriction beside the copy-link action.
