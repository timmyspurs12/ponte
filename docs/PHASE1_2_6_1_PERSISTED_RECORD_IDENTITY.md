# PONTE Phase 1.2.6.1 — Persisted record identity cross-binding

**Status:** server-only validation and repository-read support only. This phase
adds no migration, KMS SDK/client/call, credential, cloud resource, evidence or
outbox insertion path, Routing/service/API integration, wallet/RPC/chain action,
or public private-evidence payload.

This is a narrow hardening amendment to Phase 1.2.6. It binds the existing
canonical private-evidence builder to the actual locked PostgreSQL invoice and
quote records, without changing any AAD, KMS-context, private-payload, or frozen
commitment bytes.

## Persisted source of truth

The existing schema already has every needed field; no schema change is needed.
The future evidence transaction must use the following locked row views.

| Builder value                     | Persisted source                                         | Use                                                                                                                           |
| --------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| AAD/business identity             | `invoices.business_id` and `quotes.business_id`          | Both must match canonical `AAD.businessId`.                                                                                   |
| AAD/invoice identity              | `invoices.id` and `quotes.invoice_id`                    | Both must match canonical `AAD.invoiceId`.                                                                                    |
| AAD/quote identity                | `quotes.id`                                              | Must match canonical `AAD.quoteId`.                                                                                           |
| Invoice funding amount            | `invoices.funding_minor`                                 | Sole authoritative amount; PostgreSQL `bigint` is received as exact text by `node-postgres`.                                  |
| Invoice funding currency          | `invoices.data.fundingCurrency`                          | Must be exactly `BRL`; it is fixed metadata, not an amount authority.                                                         |
| Compatibility invoice JSON amount | `invoices.data.fundingMinor`, when present               | Canonically validate and require equality with `invoices.funding_minor`; never use it as the output/commitment amount source. |
| Quote source/status/expiry        | `quotes.source`, `quotes.simulated`, `quotes.expires_at` | Validate their fixed values and exact persisted expiry.                                                                       |
| Quote data                        | `quotes.data`                                            | Validate the `PaymentQuote` fields and compare `data.fundingMinor` to the invoice column.                                     |

`migrations/001_foundation.sql` defines `invoices.id`, `invoices.business_id`,
`invoices.funding_minor`, `invoices.data`, and all corresponding quote identity
and metadata columns. `migrations/003_route_decision_evidence.sql` already
models the same business/invoice/quote foreign-key tuple for a future evidence
record. Nothing in this phase reads an existing evidence row: the evidence record
ID and public evidence ID remain newly supplied metadata at the future
creation boundary.

## Locked repository views

`src/server/repository.ts` exposes narrowly scoped future-evidence helpers that
accept the intended transaction `PoolClient`:

- `lockInvoiceForEvidence(db, businessId, invoiceId)` selects only
  `id`, `business_id`, `funding_minor`, and `data` from `invoices` with
  `FOR UPDATE`.
- `lockValidQuoteForEvidence(db, businessId, invoiceId, quoteId)` continues to
  require an unexpired quote and `FOR UPDATE`, and now selects the actual
  `id`, `business_id`, and `invoice_id` columns in addition to its existing
  quote metadata/data fields.

The locks are deliberately limited to these future evidence-transaction helpers.
They do not alter ordinary list/read queries and are not called from
`src/server/service.ts` in this phase.

## Required cross-binding

`buildCanonicalPrivateEvidencePayload()` canonicalizes AAD and all persisted
row UUIDs to lowercase hyphenated UUID text, then fails unless all conditions
hold before quote/funding serialization:

```text
AAD.businessId == invoiceRow.business_id
AAD.invoiceId  == invoiceRow.id

AAD.businessId == quoteRow.business_id
AAD.invoiceId  == quoteRow.invoice_id
AAD.quoteId    == quoteRow.id
```

Consequently `quoteRow.business_id` must also equal `invoiceRow.business_id`.
An uppercase equivalent UUID normalizes safely; a different value is never
rewritten into a match. Identity mismatches use the generic error
`persisted record identity does not match canonical AAD` and include no UUID,
salt, public evidence ID, or private plaintext in their message or a log.

The payload continues to use the canonicalized AAD identity. A future caller
must construct AES-GCM AAD from that same validated AAD input with
`buildCanonicalPrivateEvidenceAad()`; no alternate record identity is accepted
by the payload builder.

## Authoritative funding and unchanged serialization

The private payload and `buildRouteDecisionCommitment()` now receive the amount
from `invoiceRow.funding_minor`, not a caller-supplied invoice amount or an
invoice JSON copy. The builder requires:

```text
invoiceRow.data.fundingCurrency == "BRL"
invoiceRow.funding_minor == quoteRow.data.fundingMinor
```

If a persisted JSON `fundingMinor` compatibility field is present, it must also
equal the authoritative column. It is a consistency check only. The builder
continues to validate persisted quote source/simulation/expiry, quote JSON
simulation, `USDG`, decimals `2`, rate `525/100`, execution cost `2`, and
canonical direct/split/multi routes.

No payload field, property order, schema identifier, AAD domain/order, KMS
context domain/order, route commitment preimage, quote commitment preimage,
payload commitment preimage, genesis sequence rule, salt behavior, or private
field exclusion changes. The synthetic Phase 1.2.6 golden AAD (320 bytes), KMS
context (96 bytes), UTF-8 JSON payload, and all frozen commitment hashes remain
byte-for-byte unchanged; regression tests assert this for matching rows and
uppercase-equivalent persisted UUIDs.
