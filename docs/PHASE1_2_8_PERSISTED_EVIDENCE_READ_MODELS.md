# PONTE Phase 1.2.8 — Persisted evidence read models

**Status:** server-side PostgreSQL read-model support only. This phase adds no
migration, KMS client/provider/call, credential, evidence generation, Routing
integration, outbox write, worker, wallet/RPC/chain operation, or payment and
settlement behavior.

This phase implements the small read-model foundation identified in
[Phase 1.2.7](./PHASE1_2_7_EVIDENCE_PREPARATION_AND_ROUTING_AUDIT.md). It does
not make PONTE ready for normal-flow evidence creation.

## Preparation snapshot API

`src/server/repository.ts` exports:

```ts
readEvidencePreparationSnapshot(
  businessId: string,
  invoiceId: string,
  quoteId: string,
): Promise<EvidencePreparationSnapshot>
```

The result is deliberately explicit:

```ts
type EvidencePreparationSnapshot =
  | {
      kind: "ready";
      invoice: EvidencePreparationInvoiceRow;
      quote: EvidencePreparationQuoteRow;
    }
  | { kind: "invoice_missing" }
  | {
      kind: "quote_missing_or_expired";
      invoice: EvidencePreparationInvoiceRow;
    };
```

`ready` is the only result that includes the exact valid quote. The final two
outcomes intentionally do not disclose whether a requested quote did not exist
or had expired. That matches the current Routing valid-quote semantics, which
uses one `QUOTE_EXPIRED_OR_MISSING` outcome for both cases. A future preparation
orchestration must still apply its typed request/error mapping; this read-model
phase does not add public API behavior.

The helper obtains its own `PoolClient`, starts a short `BEGIN READ ONLY`
transaction, runs one invoice-to-quote `LEFT JOIN` query, commits, and releases
the client in `finally` before its promise resolves. The join connects quote
business/invoice identities to the actual selected invoice row and returns SQL
columns, not the lookup arguments, for every persisted identity.

The query has no `FOR UPDATE`, advisory lock, mutation, or write. PostgreSQL's
statement snapshot makes the returned invoice/quote pair coherent for that one
query. It is intentionally only a preparation snapshot: a later final evidence
transaction must re-lock and revalidate it. Since this helper has no callback or
open-client result, future KMS/AES/network work can begin only after its
read-only transaction has committed and its connection has been released.

## Returned persisted fields and authority

The preparation invoice view returns:

| Field                  | Persisted source         | Authority                                                                                         |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| `id`                   | `invoices.id`            | Actual invoice identity                                                                           |
| `business_id`          | `invoices.business_id`   | Actual tenant identity                                                                            |
| `status`               | `invoices.status`        | Relational lifecycle state                                                                        |
| `funding_minor`        | `invoices.funding_minor` | Sole authoritative funding amount; node-postgres exposes `int8` as an exact decimal string        |
| `data.fundingCurrency` | `invoices.data` JSONB    | Fixed simulated metadata; it must be exactly `BRL`                                                |
| `data.fundingMinor`    | `invoices.data` JSONB    | Compatibility value only; future validation must require equality with relational `funding_minor` |

The snapshot quote view returns:

| Field         | Persisted source                           |
| ------------- | ------------------------------------------ |
| `id`          | `quotes.id`                                |
| `business_id` | `quotes.business_id`                       |
| `invoice_id`  | `quotes.invoice_id`                        |
| `source`      | `quotes.source`                            |
| `simulated`   | `quotes.simulated`                         |
| `expires_at`  | `quotes.expires_at`                        |
| `data`        | `quotes.data` JSONB `PaymentQuote` payload |

`invoices.status` and `invoices.funding_minor` are the read model's relational
authorities. Funding currency is not introduced as an independently authored
relational value by this phase: the narrow row model retains it as
`data.fundingCurrency` JSONB metadata. The repository does not invent a
migration or a new funding-currency authority. Existing schema projections do
not change this future evidence rule: the frozen payload contract validates the
persisted JSONB metadata as `BRL` and uses `funding_minor` for the amount.

The row model returns quote `source`, persisted `simulated`, and quote JSON
separately. It does not claim that a TypeScript cast validates simulation data.
A later candidate builder must retain the frozen checks for source
`simulation-fixed-525`, both simulation markers, BRL/amount equality, `USDG`,
decimals, rate, execution cost, canonical routes, and selected route.

## Expiry and timestamp precision

The joined quote condition is:

```sql
q.expires_at > clock_timestamp()
```

Thus database time, not process time, determines whether a quote participates in
a ready snapshot. `migrations/003_route_decision_evidence.sql` requires quote
expiry to be exactly millisecond-aligned. node-postgres returns `timestamptz` as
a `Date`, which preserves that supported millisecond precision; the integration
fixture proves `2027-12-20T00:00:00.123Z` returns unchanged. No expiry is
recomputed, rounded, or substituted.

## Final authoritative locked reads

The existing final-transaction helpers remain separate and require the caller's
transaction `PoolClient`:

- `lockInvoiceForEvidence(db, businessId, invoiceId)` now returns `id`,
  `business_id`, relational `status`, relational `funding_minor`, and JSONB
  metadata `data`, using `FOR UPDATE`.
- `lockValidQuoteForEvidence(db, businessId, invoiceId, quoteId)` remains the
  locked quote helper. It returns the actual quote identities/metadata/data,
  requires `expires_at > clock_timestamp()`, and uses `FOR UPDATE`.

Neither helper starts a transaction or acquires a connection. A later final
Routing transaction owns their short lock window. Neither helper is used by
normal Routing in this phase.

## PostgreSQL integration coverage

`tests-backend/evidence-foundation.test.ts` runs against the isolated local
PostgreSQL test database and establishes that:

1. a ready snapshot returns persisted invoice identity, relational status,
   exact `funding_minor`, JSONB metadata, persisted quote identity/metadata,
   quote JSON, and exact supported expiry;
2. cross-tenant and cross-invoice quote requests cannot return another row;
3. missing invoice, missing quote, and expired quote outcomes are explicit;
4. the locked invoice view includes relational status and the locked quote view
   retains actual identities and expiry;
5. attempted stale JSON compatibility funding and non-BRL currency updates are
   rejected by existing schema constraints, while the read model continues to
   expose relational `funding_minor` and JSONB `BRL` metadata;
6. a snapshot read returns while a separate transaction continues to hold
   `FOR UPDATE` on that invoice. The test has a five-second node-test bound and
   rolls the locker transaction back in `finally`; it does not rely on an
   elapsed-time threshold; and
7. a snapshot leaves invoice, quote, evidence, outbox, settlement, event, and
   idempotency counts/rows unchanged. Existing synthetic evidence/outbox insert
   coverage is retained.

These tests do not validate a KMS provider, plaintext/evidence candidate,
AES-GCM envelope, AAD, commitment reconstruction, final transactional
revalidation, idempotency orchestration, outbox worker, or chain submission.
They neither generate production evidence nor prove a future snapshot remains
valid after it is read.

## Remaining gap

The next candidate-preparation phase must consume only the returned persisted
values, validate the frozen evidence contract, construct a non-secret candidate,
and complete any KMS/AES work with no database connection/lock held. A separate
final transaction must still take the idempotency advisory lock, re-read replay
state, lock/revalidate invoice and quote rows, compare the prepared candidate,
and atomically persist normal Routing state plus evidence/outbox records. The
operational prerequisites, provider decision, registry address, production
authentication model, and outbox/chain design remain unresolved.
