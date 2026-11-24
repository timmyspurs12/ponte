# PONTE Phase 1.2.7 — Evidence preparation and Routing transaction integration audit

**Status:** read-only architecture/design audit. This document was reviewed
against `arena/40fa34c0-ponte` at
`dbe1177e61e6dce59b9d83270f1191e72ab8a171`.

No application code, migration, provider, credential, cloud resource, KMS
request, database evidence/outbox row, Routing behavior, API, worker, chain,
wallet, RPC, Solidity, or Foundry artifact is changed by this phase. Statements
labelled **Verified current fact** describe the checked repository state; those
labelled **Proposed future behavior** are a design requirement, not an enabled
flow. **Decision required** items remain deliberately unresolved.

---

## 1. Scope, invariants, and readiness summary

PONTE remains a simulated lifecycle:

```text
Draft -> Pending payment -> Funded -> Routing -> Settled / Failed
```

The future evidence record is a private, immutable commitment to a simulated
route decision. It is neither a payment, token transfer, settlement, nor an
atomic blockchain/database operation. The frozen registry specification requires
KMS interaction and AES-GCM content encryption to occur outside the final
Routing PostgreSQL transaction. The final transaction atomically creates the
simulated settlement, encrypted evidence record, pending outbox instruction,
invoice Routing state, lifecycle event, and idempotency response. A future
outbox is only a durable post-commit dispatch instruction; it is not atomic with
an Arbitrum transaction.

**Readiness verdict:** **not ready to implement normal-flow evidence creation.**
The application has the required pure cryptographic primitives, persistence
schema, and Phase 1.2.6.1 row-identity checks, but it has no approved registry
address, KMS provider/resource/identity, production authentication model, or
outbox-worker operating model. The current Routing transition also needs a
careful orchestration refactor and a cleanup-safe provider boundary before it can
use those primitives.

The smallest safe next implementation phase is a source-only,
non-Routing **read-model hardening phase**: add non-locking evidence snapshot
helpers and extend the existing locked invoice helper to return authoritative
`status` and generated `funding_currency`, with PostgreSQL integration tests.
It must not call KMS, build production candidates, insert evidence, or edit
`service.ts`.

---

## 2. Verified current Routing transition source map

### 2.1 HTTP entry point, authentication, and errors

| Area                  | Verified current behavior                                                                                                                                                                                                                                 | Source                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Route handler         | Generates `requestId`, calls `execute(request, path)`, wraps `{ data, requestId }`, and maps errors to JSON. Unknown errors are logged with the raw error object.                                                                                         | `src/app/api/v1/[...path]/route.ts:4-48`                               |
| Authentication        | `execute` calls `authenticate` before parsing the invoice route. Production always fails closed with `503 AUTH_NOT_CONFIGURED`; development authentication requires `PONTE_DEV_AUTH`, a token, a configured business/user UUID, and an active membership. | `src/server/service.ts:81-84`; `src/server/auth.ts:7-40`               |
| Tenant/role gate      | The auth query scopes membership by `business_id` and `user_id`; mutations reject `viewer` with `403 FORBIDDEN`.                                                                                                                                          | `src/server/auth.ts:30-40`; `src/server/service.ts:179-181`            |
| Rate limit            | Authentication writes/increments `rate_limits` using the global pool before the Routing transaction.                                                                                                                                                      | `src/server/auth.ts:35-39`                                             |
| Browser-origin gate   | Mutations require `sameOrigin`; it compares browser `Origin` to request `Host`.                                                                                                                                                                           | `src/server/service.ts:179-188`; `src/server/security.ts:4-16`         |
| Current public errors | `ApiError` exposes its stable code/status. Zod errors map to `422 VALIDATION_ERROR`; PostgreSQL `23505` maps to `409 DUPLICATE_REFERENCE`; other errors map to `500 INTERNAL_ERROR` and are passed to `console.error`.                                    | `src/server/errors.ts:1-10`; `src/app/api/v1/[...path]/route.ts:19-46` |

The present auth path is deliberately development-only and must remain fail-closed
in production. A future evidence implementation must not turn development auth
flags into a production authentication policy.

### 2.2 Request parsing and idempotency before Routing logic

For a mutating request, `execute` currently:

1. accepts only `POST`/`PATCH`, blocks viewers, applies same-origin and
   `application/json` checks (`service.ts:179-188`);
2. reads a body with a 16 KiB cap and parses JSON (`service.ts:189-211`);
3. requires `idempotency-key` matching `^[\w-]+$`, length 8–128
   (`service.ts:212-217`); and
4. computes the current fingerprint as SHA-256 of the literal
   `${method}:${url.pathname}:${text}` (`service.ts:218-220`).

**Verified current fact:** semantic-equivalent JSON with different literal bytes
has a different fingerprint. That is the current contract and must not be
silently changed by evidence work.

`repository.transaction` gets one `PoolClient`, issues `BEGIN`, invokes work,
issues `COMMIT`, then releases the client; it rolls back on a thrown error
(`src/server/repository.ts:82-96`). No explicit isolation level is supplied, so
the database default is used.

Inside this transaction the current service takes a transaction-scoped advisory
lock using:

```sql
SELECT pg_advisory_xact_lock(hashtextextended($1,0))
-- $1 = `${ctx.business}:${key}`
```

and then reads `idempotency` by `(business_id, key)`
(`repository.ts:114-117`; `service.ts:221-228`). A stored matching fingerprint
returns its stored JSON response; a different fingerprint throws
`409 IDEMPOTENCY_CONFLICT`. A collision in the advisory-lock hash can at most
serialize unrelated requests; the exact table lookup remains the authority.

### 2.3 Exact current Routing branch

The current Routing request is `POST /invoices/:id/transitions` with strict Zod
body:

```ts
{ status: "Routing", route: "direct" | "split" | "multi", quoteId: UUID }
```

The branch executes as follows.

| Order | Verified current action                       | Source / SQL behavior                                                                                                                                                                                                    |
| ----: | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|     1 | Lock and load the invoice.                    | `get(db, ctx, id, true)` at `service.ts:257`. `findInvoice` selects only JSON `data` for the tenant and appends timestamps, with `FOR UPDATE` when requested (`repository.ts:258-267`).                                  |
|     2 | Parse command and enforce lifecycle graph.    | `change.parse`, then `Funded -> Routing` is the only allowed incoming transition (`service.ts:278-291`).                                                                                                                 |
|     3 | Require route and quote ID.                   | Missing either returns `422 QUOTE_AND_ROUTE_REQUIRED` (`service.ts:312-314`).                                                                                                                                            |
|     4 | Lookup unexpired quote.                       | `findValidQuote` runs `SELECT * FROM quotes WHERE business_id=$1 AND invoice_id=$2 AND id=$3 AND expires_at>clock_timestamp()` (`repository.ts:133-137`; called `service.ts:315-320`). It does **not** use `FOR UPDATE`. |
|     5 | Select submitted route from quote JSON.       | `const r = q.routes.find((r) => r.id === command.route)!` (`service.ts:321-322`).                                                                                                                                        |
|     6 | Insert simulated settlement.                  | `insertSettlement` creates status `Routing` using selected route `outputMinor`/`minimumOutputMinor` (`service.ts:323-331`; SQL at `repository.ts:222-226`).                                                              |
|     7 | Mutate in-memory JSON invoice.                | Sets `i.selectedRoute = command.route` and `i.quote = q` (`service.ts:332-333`).                                                                                                                                         |
|     8 | Save the Routing state.                       | Sets `i.status`, then `UPDATE invoices SET status=$3,data=$4 WHERE business_id=$1 AND id=$2` (`service.ts:367-373`; SQL at `repository.ts:242-246`).                                                                     |
|     9 | Append lifecycle event.                       | Calls `event(..., "invoice.Routing", previousState)`, which inserts `payment_events` with a fresh event ID and the current invoice snapshot (`service.ts:374-381`; SQL at `repository.ts:99-103`).                       |
|    10 | Read response and persist idempotency result. | Re-reads invoice JSON, then inserts `(business_id,key,fingerprint,response)` into `idempotency` (`service.ts:382-409`; SQL at `repository.ts:252-256`).                                                                  |
|    11 | Commit or rollback.                           | All preceding operations use the same callback `PoolClient`; `transaction` commits once or rolls back (`repository.ts:82-96`).                                                                                           |

The existing database constraints reinforce the intended shape:

- `settlements` is unique on `invoice_id`, constrains route ID to
  `direct|split|multi`, and has a `(business_id, invoice_id, quote_id)` foreign
  key to `quotes` (`migrations/001_foundation.sql:9`);
- `idempotency` has primary key `(business_id,key)`
  (`migrations/001_foundation.sql:14`); and
- the evidence table has foreign keys to the same tenant/invoice/quote tuple and
  unique `(business_id,invoice_id)` (`migrations/003_route_decision_evidence.sql:19-62`).

### 2.4 Current assumptions that are not sufficient for evidence

These are observations only; this phase changes none of them.

1. **Unchecked Routing quote cast and route lookup.**
   `const q: PaymentQuote = qr.rows[0].data` and `q.routes.find(...)!` at
   `service.ts:321-322` assume the JSON has the TypeScript shape and includes
   the request route. The Zod enum only proves the request is one of three names;
   it does not prove this persisted row is canonical or contains that route. A
   missing/tampered route becomes a runtime TypeError/500 rather than an
   explicit validation failure. Future evidence must parse/validate the locked
   persisted quote and explicitly find the selected canonical route.

2. **Current invoice read projects only JSON.** `get`/`findInvoice` returns
   `invoices.data`, not `invoices.id`, `business_id`, `funding_minor`, generated
   `funding_currency`, or the authoritative `status` column. It is correct for
   the current UI model but is insufficient for evidence binding.

3. **Current quote lookup is non-locking.** `findValidQuote` checks database
   time but does not lock the quote. The invoice lock serializes normal invoice
   transitions, but a final evidence transaction must independently lock and
   revalidate the persisted quote row.

4. **Other lifecycle non-null/cast assumptions.** `i.fundingMinor!` is used
   while creating a quote (`service.ts:262`) and while forming a settlement
   receipt (`service.ts:350`). The current `Settled` branch also casts
   `row.quote as PaymentQuote` and uses `.routes.find(...)!.name`
   (`service.ts:353-355`). These are outside the future Routing evidence
   insertion point but demonstrate JSON-shape assumptions that evidence code
   must not copy; it must use the locked `funding_minor` column and validated
   quote row instead.

5. **Guarded current row indexing is not a future evidence contract.** Current
   `get`, idempotency replay, valid quote, and settlement paths check `rowCount`
   before using `rows[0]` (`service.ts:52-54,223-227,315-322,336-341`), so those
   particular accesses are guarded today. A future evidence helper must retain
   equally explicit cardinality checks and use typed locked views rather than
   treating a cast or `rows[0]` as persisted-data validation.

6. **The authentication non-null assertion is separately guarded.**
   `process.env.PONTE_DEV_TOKEN!` at `auth.ts:26` follows the environment
   existence/format guard at `auth.ts:10-15`; production has already failed
   closed at `auth.ts:8-9`. It is not an evidence input and must neither be
   copied into a production auth design nor weakened for evidence integration.

7. **Quote fields are not evidence-validated today.** Current Routing uses only
   `q.routes`, `r.outputMinor`, and `r.minimumOutputMinor`; it does not validate
   persisted source/simulation fields, rate, asset, decimals, route ordering, or
   exact funding equality before settlement insertion.

8. **Raw unknown-error logging is unsafe for future evidence failures.** The
   route handler currently logs `error` for 500 responses. A future provider,
   cryptographic, or candidate error must be mapped before this point so raw
   provider exceptions, private payloads, salts, DEKs, AAD, or wrapped material
   cannot reach logs.

9. **Commit ambiguity is not currently classified.** The generic transaction
   helper treats any `COMMIT` exception as an ordinary thrown error and attempts
   rollback. A network failure after the server commits cannot be safely
   interpreted as a rollback.

---

## 3. Verified evidence building blocks and persistence boundary

### 3.1 Frozen cryptographic components

| Component                | Verified current fact                                                                                                                                                                                                             | Source                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Route commitments        | `buildRouteDecisionCommitment()` validates persisted quote metadata/routes and derives route hashes, routes hash, quote snapshot hash, selected code, and payload hash. Canonical route IDs/codes are direct=1, split=2, multi=3. | `src/server/evidence/commitment.ts:17-25,197-249,281-310,450-467` |
| AAD V1                   | `buildCanonicalPrivateEvidenceAad()` produces the exact 320-byte ABI encoding binding record UUID, business/invoice/quote UUIDs, public evidence ID, schema, chain 421614, and registry.                                          | `src/server/evidence/aad.ts:37-71,164-240`                        |
| KMS context V1           | `buildKmsWrappingContext()` validates canonical AAD and ABI-encodes the KMS domain, version, and `keccak256(canonicalAad)` into 96 bytes.                                                                                         | `src/server/evidence/aad.ts:242-287`                              |
| Private plaintext        | `buildCanonicalPrivateEvidencePayload()` validates persisted identity cross-binding and authoritative invoice funding, uses the frozen commitment helper, and returns deterministic UTF-8 JSON.                                   | `src/server/evidence/private-payload.ts:47-58,232-293,437-561`    |
| Envelope V1              | `encryptEvidenceEnvelope()` requires non-empty plaintext, 32-byte DEK, non-empty AAD, creates fresh 12-byte nonce, and returns AES-256-GCM ciphertext plus 16-byte tag. It does not clear caller buffers.                         | `src/server/evidence/envelope.ts:19-26,139-180`                   |
| Provider contract        | `DekProvider.createAndWrapDek(context)` returns a 32-byte plaintext DEK, opaque wrapped DEK, and metadata. `assertDekProviderResult` checks the declared provider/result tuple. No provider implementation exists.                | `src/server/evidence/kms.ts:30-70,118-184`                        |
| Best-effort DEK clearing | `clearDekBestEffort` calls `Buffer.fill(0)`; it is not guaranteed Node.js/native secure zeroization.                                                                                                                              | `src/server/evidence/kms.ts:187-194`                              |

### 3.2 Existing evidence/outbox persistence boundary

`route_decision_evidence` already requires all encrypted content and wrapping
metadata: public ID, schema versions, chain/registry, sequence/kind, selected
route code, quote/payload hashes, envelope version/algorithm, ciphertext,
nonce, tag, wrapped DEK, provider, algorithm, format, key reference, key
version, and AAD version. It is immutable. `evidence_outbox` requires a unique
referencing evidence ID and starts pending (`migrations/003...:19-141` and
`004...:12-66`).

Repository methods already exist but are deliberately unused by `service.ts`:

- `insertRouteDecisionEvidence(db, evidence)` inserts the complete required row
  (`repository.ts:170-208`);
- `insertPendingEvidenceOutbox(db, { id, evidenceRecordId })` inserts a pending
  durable instruction (`repository.ts:211-220`); and
- `lockInvoiceForEvidence` / `lockValidQuoteForEvidence` use `FOR UPDATE`
  (`repository.ts:143-167`).

**Verified gap:** `LockedEvidenceInvoiceRow` presently selects identity,
`funding_minor`, and `data`, but not the authoritative `invoices.status` or the
generated `funding_currency` (`repository.ts:14-19,143-151`). The final design
must verify both state and funding currency from locked rows. The current locking
helper must therefore be extended in a later source phase; it must never be held
open while waiting for KMS.

---

## 4. Proposed future behavior — two preparation stages plus one final transaction

### 4.1 Request boundary before Stage 1

A future Routing evidence orchestrator begins only after the existing request
has passed authentication, tenant/role checks, same-origin/content-type/body
checks, strict `change` validation, path UUID parsing, idempotency-key syntax
validation, and exact current fingerprint calculation. It must require:

```text
command.status == "Routing"
command.quoteId is present
command.route is present and one of direct/split/multi
registry address is an explicit approved deployment input
```

The registry address has no default. It must be a nonzero address passed by a
future approved deployment configuration boundary; a test uses only an
explicitly-labelled synthetic address. Chain ID is the frozen
`421614`. No browser-provided registry, KMS metadata, evidence ID, salt, or
ciphertext input is accepted.

### 4.2 Stage 1 — short read-only idempotency preflight and snapshot

**Purpose:** avoid a needless KMS operation for a durable replay, reject a
known conflict early, and obtain a short-lived persisted snapshot. It is only an
optimization; it is not authoritative.

**Proposed sequence:**

1. Acquire a pool client, issue a short `BEGIN READ ONLY`, and use no advisory
   lock and no `FOR UPDATE`.
2. Query `idempotency` by `(ctx.business, idempotencyKey)`.
   - matching fingerprint: commit/release and return stored response immediately;
     do not create IDs or call KMS;
   - different fingerprint: commit/release and return typed idempotency conflict;
     do not call KMS.
3. If no record exists, read only the snapshot fields needed by preparation:

   ```sql
   SELECT id,business_id,funding_minor,funding_currency,status,data
   FROM invoices
   WHERE business_id=$1 AND id=$2;

   SELECT id,business_id,invoice_id,source,simulated,expires_at,data
   FROM quotes
   WHERE business_id=$1 AND invoice_id=$2 AND id=$3
     AND expires_at > clock_timestamp();
   ```

   The exact implementation may use typed narrow repository helpers, but it
   must not use `lockInvoiceForEvidence` or `lockValidQuoteForEvidence` here.

4. Validate existence, tenant/invoice/quote relationships, `status == Funded`,
   generated/persisted funding currency `BRL`, and quote expiry using database
   time. Commit and release the read transaction before candidate preparation.

No advisory lock, row lock, transaction, pool client, or database connection may
be retained across a provider request. A read snapshot can become stale; that is
expected and must be detected in Stage 3.

**Required future read-model work:** add non-locking snapshot helpers plus
locked counterparts which return the same authoritative fields, including
`invoices.status` and generated `invoices.funding_currency`. The existing
`lockInvoiceForEvidence` cannot by itself prove the final transition state.

### 4.3 Stage 2 — prepare an immutable candidate outside a transaction

All work in this stage uses the validated Stage 1 snapshot and future injected
`DekProvider`; it does not use a database transaction or lock.

1. Generate a fresh evidence record UUID.
2. Generate a fresh nonzero 32-byte public evidence ID.
3. Generate a fresh nonzero 32-byte private salt from a CSPRNG.
4. Validate the frozen simulated quote fields, exact authoritative invoice
   funding, canonical direct/split/multi routes, and selected route against the
   persisted snapshot. Do not recalculate quote economics or source a route
   elsewhere.
5. Call `buildRouteDecisionCommitment()` with the authoritative snapshot,
   selected route, explicit registry address, fresh public ID, V1 sequence,
   zero predecessor, and private salt. Retain only its non-secret outputs.
6. Build canonical AAD V1 with the candidate evidence UUID, persisted
   business/invoice/quote UUIDs, public evidence ID, frozen versions/chain, and
   explicit registry address.
7. Call `buildCanonicalPrivateEvidencePayload()` with the same AAD input,
   persisted rows, selected route, V1 sequence, zero predecessor, private salt,
   and the step-5 commitment as `expectedCommitment`.
8. Build the exact 96-byte KMS wrapping context from that exact AAD.
9. Call the future injected `DekProvider` once to create/wrap a fresh DEK, then
   validate declared-provider/result consistency and metadata allowlist.
10. Encrypt the private payload once with `encryptEvidenceEnvelope`, the exact
    AAD, and the validated 32-byte DEK.
11. In `finally`, best-effort clear caller-owned plaintext payload and plaintext
    DEK buffers on both success and failure. Clear the source salt buffer after
    conversion/use where possible. JavaScript strings/runtime/provider copies
    are not guaranteed zeroizable and must never be logged or persisted.
12. Construct the immutable, non-secret prepared candidate described below.

The current `createAndValidateWrappedDek()` returns only validated results. A
future cleanup-safe orchestrator must still ensure a provider-returned plaintext
DEK is cleared if validation itself rejects its metadata. It may capture the raw
provider result, validate it with `assertDekProviderResult`, and clear its
`plaintextDek` in `finally`, or enhance the boundary without exposing bytes.
It must not leave an invalid provider response's DEK owned only by a throwing
helper.

If provider/KMS or encryption fails, Stage 3 is never started. There is no
Routing, settlement, evidence, outbox, lifecycle, or idempotency write.

### 4.4 Prepared candidate: exact non-secret carrying set

The candidate is an in-memory, immutable object. It contains only values needed
by the final transaction and deliberately excludes `plaintextDek`, private JSON
payload bytes, salt, raw AAD, raw KMS context, and caller-controlled provider
metadata.

```text
PreparedRoutingEvidenceCandidate {
  // request/actor correlation
  requestFingerprint
  createdByUserId
  routingCorrelationId
  outboxId

  // persisted identity and final state intent
  evidenceRecordId
  businessId
  invoiceId
  quoteId
  invoiceFundingMinor                 // exact decimal string from column
  invoiceFundingCurrency              // BRL
  invoiceStatusAtSnapshot             // Funded
  quoteSource                         // simulation-fixed-525
  quoteSimulated                      // true
  quoteExpiresAtUnixMs                // exact decimal string
  canonicalQuoteData                  // only fixed quote fields/routes; no display PII
  selectedRouteId
  selectedRouteCode

  // frozen evidence context
  publicEvidenceId                    // 32-byte value / canonical hex internally
  evidenceSchemaVersion               // 1
  quoteSchemaVersion                  // 1
  aadVersion                          // 1
  chainId                             // 421614
  registryAddress                     // explicit approved address
  sequence                            // 1
  evidenceKind                        // 1
  previousPayloadHash                 // zero bytes32

  // derived, non-secret commitments and AAD binding digest
  routeHashes { direct, split, multi }
  routesHash
  quoteSnapshotHash
  payloadHash
  canonicalAadDigest                  // keccak256(AAD), not raw AAD
  wrappingContextDigest               // digest of the 96-byte context, optional local check

  // encrypted envelope and validated provider result metadata
  envelopeVersion                     // 1
  contentAlgorithm                    // AES-256-GCM
  ciphertext
  nonce
  authenticationTag
  wrappedDek
  kmsProvider
  wrappedDekAlgorithm
  wrappedDekFormat
  kmsKeyReference
  kmsKeyVersion

  // in-memory tamper check only
  preparedCandidateDigest
}
```

`routingCorrelationId` and `outboxId` are non-secret UUIDs. They may be made in
Stage 2 so the evidence record, outbox, and lifecycle event have a prepared,
consistent correlation. The final transaction may generate a settlement UUID;
it is not a cryptographic preimage.

**Prepared digest design.** A future implementation should calculate
`preparedCandidateDigest` with SHA-256 over a length-prefixed deterministic
binary encoding of every non-secret candidate field above, including the
ciphertext/envelope and provider metadata, with a fixed internal domain label.
It is an in-memory mutation detector only: it is not a new registry commitment,
not public, and not persisted without separate approval. The final transaction
recomputes it immediately before inserts.

The final transaction can fully reconstruct and compare the persisted quote
snapshot, route hashes, selected code, AAD digest, and all envelope/provider
metadata. It cannot recompute `payloadHash` from locked rows alone because the
private salt is intentionally gone. It therefore must compare the immutable
candidate digest and the payload hash produced during preparation, never attempt
to recover/log the salt or decrypt the payload in the transaction.

### 4.5 Stage 3 — final authoritative PostgreSQL transaction

This is the only stage allowed to write. Every statement uses the same
`PoolClient` and one `BEGIN`/`COMMIT` scope.

1. Begin a transaction using one client.
2. Acquire the existing business-scoped idempotency advisory lock.
3. Re-read `(business_id,key)` from `idempotency` after the lock.
   - matching fingerprint: return the stored response, insert nothing, and
     discard the already-cleared prepared candidate;
   - mismatched fingerprint: throw idempotency conflict, insert nothing.
4. Lock the authoritative invoice row with `FOR UPDATE`, selecting identity,
   `funding_minor`, generated `funding_currency`, status, and data.
5. Lock the exact quote row with `FOR UPDATE` and
   `expires_at > clock_timestamp()`. This rechecks expiry against database time.
6. Revalidate all relationships: business/invoice/quote IDs; quote invoice and
   business IDs; candidate AAD identities; `Funded` invoice status; BRL funding
   currency; exact invoice-column/quote-data funding equality; persisted
   source/simulation/expiry; quote-data simulation/asset/decimals/rate/cost; and
   direct/split/multi canonical route order.
7. Explicitly locate the candidate selected route in the locked canonical list,
   require exactly its frozen code, and reject an absent/mismatched route before
   any settlement insert.
8. Rebuild `quoteSnapshotCommitment`/route hashes from locked rows and compare
   route hashes, routes hash, quote snapshot hash, selected route ID/code,
   fixed versions, chain, registry, public evidence ID shape, and zero
   predecessor with the candidate. Rebuild AAD locally from candidate identity
   and compare only `keccak256(AAD)` to `canonicalAadDigest`; do not log or
   persist that raw AAD.
9. Recompute `preparedCandidateDigest`; require exact candidate integrity.
   Revalidate provider metadata with a metadata-only future helper plus existing
   database allowlist/format constraints. Validate envelope lengths/versions and
   compare its candidate fields exactly; do not decrypt it.
10. Insert the simulated `settlements` row from the locked selected route.
11. Insert the complete immutable encrypted `route_decision_evidence` row from
    candidate fields, using the authorized `ctx.user` and prepared correlation.
12. Insert the candidate's pending `evidence_outbox` row.
13. Update the locked invoice to `Routing`, with the route/quote reflected in
    the normal invoice JSON snapshot while preserving the authoritative SQL
    columns and snapshot constraints.
14. Append `invoice.Routing` using the same routing correlation ID.
15. Form the normal response from the locked/updated invoice and insert it as
    the idempotency response.
16. Commit once.

Any failed validation or write rolls back the entire transaction. No transaction
is atomic with a future blockchain submission; outbox dispatch begins only after
commit.

---

## 5. Snapshot/final SQL and repository requirements

### 5.1 Required helper categories

| Helper category                     | Locking                           | Required fields                                                  | Purpose                                                       |
| ----------------------------------- | --------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| `findIdempotencyPreflight`          | none; short read-only transaction | fingerprint, response                                            | Optimization only; avoid a second KMS call on durable replay. |
| `readInvoiceForEvidenceSnapshot`    | none                              | id, business_id, funding_minor, funding_currency, status, data   | Stage 1 snapshot.                                             |
| `readValidQuoteForEvidenceSnapshot` | none                              | id, business_id, invoice_id, source, simulated, expires_at, data | Stage 1 snapshot, with `expires_at > clock_timestamp()`.      |
| `lockInvoiceForEvidence` (extended) | `FOR UPDATE`                      | same authoritative invoice fields                                | Stage 3 state/funding/identity authority.                     |
| `lockValidQuoteForEvidence`         | `FOR UPDATE`                      | existing full evidence quote identity/metadata fields            | Stage 3 exact quote/expiry authority.                         |
| existing insert helpers             | transaction client only           | settlement/evidence/outbox/event/idempotency fields              | Stage 3 writes only.                                          |

The current lock helpers are intentionally not Stage 1 helpers. A `FOR UPDATE`
lock held while a provider waits would block invoice work, consume a client, and
violate the frozen transaction boundary.

### 5.2 What must be reconstructed from locked rows

| Value                         | Final source of truth / comparison                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Business, invoice, quote IDs  | Locked `invoices.id/business_id` and `quotes.id/business_id/invoice_id`; compare to candidate and rebuilt AAD identity.                                                  |
| Invoice amount/currency/state | Locked `funding_minor`, generated `funding_currency`, and `status`; validate invoice JSON compatibility only as required by existing snapshot constraints.               |
| Quote semantics               | Locked source/simulated/expiry/data; canonicalize the fixed data and all route fields.                                                                                   |
| Selected route                | Authorized command/candidate ID must be found exactly once in locked canonical routes; derive frozen code from `buildRouteDecisionCommitment`, never trust client code.  |
| Commitment fields             | Recompute route/routing/quote snapshot values from locked rows and compare candidate; compare candidate payload hash and internal prepared digest without salt recovery. |
| AAD/context binding           | Rebuild canonical AAD locally from candidate/persisted identities and explicit registry; compare AAD digest and context-derived digest only.                             |
| Provider/envelope metadata    | Candidate values, metadata allowlist/format checks, persistence constraints, and candidate digest.                                                                       |

### 5.3 Values immutable from preparation

The final transaction does not invent or accept request-controlled values for:

- evidence record ID, public evidence ID, selected route, commitment hashes,
  ciphertext, nonce, tag, wrapped DEK, or provider key metadata;
- schema/quote/AAD/envelope versions, chain, kind, V1 sequence, or predecessor;
- registry address; or
- provider algorithm/format/provider identifiers.

It may allocate only normal non-cryptographic final-row IDs if not already held
by the candidate, such as the simulated settlement ID. It must never generate a
replacement salt, public evidence ID, private payload, DEK, or commitment in
Stage 3.

---

## 6. Idempotency and concurrency matrix

All references to “clear” mean best-effort clearing of available
caller-owned plaintext payload/DEK buffers. Candidate creation never logs raw
AAD, private plaintext, salt, DEK, wrapped key bytes, or provider exceptions.

| Scenario                                                | KMS / writes                                                                                                                                                                                         | Result and cleanup                                                                                                  | Retry / duplicate prevention                                                                                                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Concurrent same key, same fingerprint                | Both may pass unlocked preflight and prepare, so both may call KMS. Exactly one final transaction writes. The second waits on advisory lock, sees matching idempotency response, and writes nothing. | First returns normal result; second returns replay. Both prepared plaintext/DEKs are cleared.                       | Replay causes no new IDs/KMS. Advisory lock plus idempotency primary key prevents duplicate evidence/settlement; invoice/evidence uniqueness is defense in depth.  |
| 2. Same key, different fingerprint                      | Existing record discovered in preflight means no KMS. In a race before any record, both may prepare/KMS; final lock admits one and rejects the other.                                                | Typed `IDEMPOTENCY_CONFLICT`; losing candidate has no writes and is discarded after cleanup.                        | Same conflicting key never receives a replacement candidate. Caller must use a new valid key/request.                                                              |
| 3. Different keys, same invoice                         | Both may prepare/KMS. One final transaction locks invoice, writes Routing/evidence/settlement, and commits. The other waits then sees non-Funded state or mismatch.                                  | Winner succeeds; loser gets stale/invalid-transition failure and no writes. Buffers were cleared after preparation. | Settlement/evidence unique invoice constraints and row lock prevent duplicates. A retry of winner's key replays; a loser retry preflight rejects state before KMS. |
| 4. Quote expires during KMS                             | KMS may have succeeded, but final locked quote query uses database time and finds no valid row.                                                                                                      | No writes; typed stale/expired candidate; discard encrypted artifact.                                               | Retry may create new IDs/salt only if a new valid quote is selected; expired same quote is rejected before KMS.                                                    |
| 5. Invoice changes during KMS                           | KMS may occur. Final locked row differs in status/funding/identity or no longer qualifies.                                                                                                           | No writes; typed stale candidate; prepared buffers already cleared.                                                 | A new attempt may create fresh IDs/salt only after a fresh eligible snapshot. Invoice lock/state check prevents duplicate settlement/evidence.                     |
| 6. Quote data changes during KMS                        | KMS may occur. Final locked quote differs in source/simulation/expiry/data/routes/commitments.                                                                                                       | No writes; typed stale candidate; artifact discarded.                                                               | Reprepare only from a fresh valid quote; final canonical comparisons prevent binding stale economics.                                                              |
| 7. KMS succeeds, final check is stale                   | One KMS/wrapping operation may be spent, but no database data is durable.                                                                                                                            | No writes; discard wrapped bytes and encrypted envelope; clear any available plaintext/DEK.                         | New preparation can use fresh IDs/salt. No evidence/settlement exists because final transaction rolled back.                                                       |
| 8. KMS timeout                                          | No final transaction and no database writes. Provider may have an unknown-side-effect operation, but no returned material is persisted.                                                              | Typed KMS-unavailable/timeout failure; clear payload/DEK if one became available.                                   | Retry is a new preparation attempt after provider policy; new IDs/salt allowed because no durable idempotency record exists.                                       |
| 9. Commit succeeds but connection fails before response | KMS has occurred; all Stage-3 writes may have committed.                                                                                                                                             | Return `COMMIT_OUTCOME_UNKNOWN`, not “rolled back.” Plaintext/DEK were already cleared.                             | Caller retries the same key/fingerprint; Stage 1/final idempotency returns stored response without KMS or duplicate writes.                                        |
| 10. Retry after ambiguous commit                        | Preflight sees stored matching response if commit reached server; otherwise it sees no record.                                                                                                       | Replay if stored. If no record, normal preparation resumes only after current state/preflight checks.               | Same key is authoritative. If the original committed, primary key/replay prevents new IDs. If it did not, a new candidate may use fresh IDs/salt.                  |
| 11. KMS unavailable                                     | Preparation stops before final transaction.                                                                                                                                                          | Typed KMS-unavailable failure, no writes, no idempotency response, no Routing/settlement/event/outbox.              | A later request with same key can prepare fresh non-durable IDs/salt after KMS recovery.                                                                           |
| 12. AES-GCM fails after wrapping                        | Provider may have succeeded, but encryption stops before final transaction.                                                                                                                          | Typed encryption-operation failure, no writes; clear payload and DEK; never persist wrapped material alone.         | Retry may generate fresh IDs/salt/DEK. No duplicate can exist because no database row was written.                                                                 |

The idempotency preflight is never authoritative. Every replay/conflict decision
that controls writes occurs in Stage 3 after the transaction-scoped advisory
lock.

---

## 7. Failure taxonomy and HTTP/logging rules

### 7.1 Proposed non-sensitive categories

| Category                        | Example stable HTTP code/status                                                           | Database/KMS rule                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Request/input validation        | `422 VALIDATION_ERROR` or a specific existing validation code                             | No KMS; no final transaction.                                                             |
| Tenant authorization            | Existing `401 UNAUTHENTICATED`, `403 FORBIDDEN`, or fail-closed `503 AUTH_NOT_CONFIGURED` | Preserve current auth behavior; no KMS.                                                   |
| Idempotency conflict            | `409 IDEMPOTENCY_CONFLICT`                                                                | No new write; no KMS if known in preflight, though race preparation may already have run. |
| Invalid/expired quote or route  | `409 QUOTE_EXPIRED_OR_MISSING` / future explicit route-invalid code                       | No final writes; no KMS when detected preflight.                                          |
| Stale prepared candidate        | `409 EVIDENCE_PREPARATION_STALE`                                                          | KMS may already have run; final transaction rolls back entirely.                          |
| KMS unavailable/timeout         | `503 EVIDENCE_KMS_UNAVAILABLE`                                                            | No final transaction or write.                                                            |
| KMS invalid/mismatched response | `502 EVIDENCE_KMS_RESPONSE_INVALID` or internal non-retryable provider category           | No final transaction or write; clear captured DEK.                                        |
| AES-GCM operation failure       | `503 EVIDENCE_ENCRYPTION_FAILED`                                                          | No final transaction or write; clear buffers.                                             |
| Database transaction failure    | `500 EVIDENCE_TRANSACTION_FAILED` unless mapped to a known conflict                       | Roll back all Stage-3 writes.                                                             |
| Ambiguous commit outcome        | `503 COMMIT_OUTCOME_UNKNOWN`                                                              | Do not claim rollback; instruct client to retry the same idempotency key.                 |

The exact public code names require API review, but no public response may
contain private payload bytes, salt, DEK, raw AAD, commitment preimage, wrapped
key bytes, provider resource internals, or raw provider exception text.

### 7.2 Required API/logging hardening before integration

The current handler logs all unknown 500 errors with `console.error(..., error)`
(`src/app/api/v1/[...path]/route.ts:37`). Before a provider/candidate flow is
wired into it, typed evidence errors must be recognized and converted to stable
`ApiError`-like public responses. Logging must retain only request ID, stable
failure category, safe operation phase, and approved non-secret observability
metadata. It must not log the original error object for KMS/encryption/candidate
classes.

A commit-aware future transaction wrapper must distinguish:

- failure before a successful `COMMIT` acknowledgement, where rollback is
  attempted; from
- an exception during/after COMMIT where server outcome is unknown.

In the latter case it returns only the ambiguous-outcome category. The same-key
idempotency replay is the recovery protocol; no compensating delete, duplicate
settlement, or fresh evidence is attempted.

---

## 8. Route and commitment consistency rules

The authorized Routing request supplies only `selectedRouteId`, never quote
economics, route code, output, tolerance, fee, or a commitment. The persisted
quote is the sole route-data source.

1. Validate the request route as one of `direct`, `split`, `multi`.
2. Load the exact tenant/invoice/quote row.
3. Require exactly three persisted route candidates in direct/split/multi order.
4. Explicitly find the selected ID; reject if absent. Do not use
   `q.routes.find(...)!`.
5. Derive code through the frozen mapping in
   `buildRouteDecisionCommitment()` (`direct=1`, `split=2`, `multi=3`), not from
   a client field.
6. Use the locked selected route's `outputMinor` and `minimumOutputMinor` for
   the simulated settlement.
7. Use the same locked rows/selected ID with `buildRouteDecisionCommitment()`,
   AAD V1, private payload V1, AES-GCM envelope V1, and validated provider
   metadata contract.
8. In the final transaction, rebuild quote/route commitments from locked rows
   and compare them to the prepared candidate before writing.

No new quote engine, route lookup, or quote-economics calculation is permitted.
`executionCostMinor` remains a fixed validated quote-data field and does not
change the selected-route output arithmetic.

---

## 9. Rollback, outbox, and post-commit behavior

The final transaction has one rollback domain:

```text
settlement
+ encrypted evidence
+ pending outbox row
+ invoice Routing update
+ lifecycle event
+ idempotency response
```

A failure in any member rolls back all members. An encrypted evidence row cannot
survive without the settlement/state/event/idempotency record, and a committed
Routing transition cannot lack its pending outbox row.

The outbox is not a blockchain transaction. Only after commit may a future
worker claim it, submit the immutable already-prepared payload commitment, and
perform receipt/event reconciliation. It must not generate a replacement public
evidence ID, salt, quote, route, sequence, predecessor, or payload hash. A
submission transaction hash must never be stored as the simulated settlement's
`transaction_hash`, which the schema intentionally constrains to `NULL` for this
model (`PHASE0_1`, section 8.3).

---

## 10. Registry and operational blockers

None of the following may be defaulted from a synthetic fixture or provisioned by
this project phase.

| Blocker / decision                                    | Required owner decision                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approved production host/region and commercial budget | Product, security, finance, and operations approve hosting/residency/cost.                                                                                                |
| Cloud account/project/organization                    | Organization owner approves account/project and billing boundary.                                                                                                         |
| KMS provider and managed-key ownership                | Security selects provider, key lifecycle owner, rotation/recovery/retention policy, and approved resource identifiers.                                                    |
| Workload identity and least-privilege IAM             | Security/platform define workload principal, encrypt/decrypt permissions, audit, and break-glass controls.                                                                |
| Production authentication and tenant isolation        | Security/product approve production identity, session/token model, authorization, audit, and rate-limit policy; development auth remains disabled.                        |
| Registry deployment                                   | Legal/product/security approve an eligible Arbitrum network, deployment process, bytecode verification, and administration.                                               |
| Actual registry address                               | Deployment owner supplies a verified nonzero deployed address; no test address becomes a default.                                                                         |
| Attestor signer custody                               | Security defines hardware/software custody, separation from admin, rotation, revocation, incident recovery, and approval workflow.                                        |
| Sepolia RPC provider/failover                         | Platform approves endpoint vendor, rate limits, authentication, health checks, archival needs, and failover.                                                              |
| Worker ownership and transaction operations           | Operations define worker runner, nonce ownership, replacement policy, receipt reconciliation, confirmation threshold, reorg handling, alerting, and dead-letter controls. |
| Audit retention/recovery/incident response            | Security/legal define evidence retention, KMS key recovery, deletion boundaries, breach response, and audit access.                                                       |

Until these are approved, a registry address is an explicit missing prerequisite,
not an environment default; synthetic registry values remain tests only.

---

## 11. Phased future implementation plan and test gates

### Phase 1.2.7.1 — persisted read model only (smallest safe next phase)

**Allowed scope:** add non-locking snapshot helpers and extend locked evidence
row helpers with authoritative `status`/`funding_currency`; no service change,
provider, encryption orchestration, evidence insertion, or normal-flow behavior.

**Required tests:** PostgreSQL integration assertions for selected columns,
tenant scope, read-only/non-locking behavior, `FOR UPDATE` helpers, database-time
expiry, exact `int8` funding representation, and no normal Routing regression.

### Phase 1.2.7.2 — pure prepared-candidate construction

**Allowed scope:** server-only pure candidate types/builders and fake in-memory
provider tests. No KMS SDK/network, no repository writes, no service route.

**Required tests:** fixed input produces Phase 1.2.6 goldens; no default
registry; provider metadata tuple validation; provider mismatch; ciphertext/AAD
binding; all success/failure cleanup paths including invalid provider response;
candidate contains no DEK/payload/salt/raw AAD; prepared-digest tampering;
non-disclosure/no-log tests.

### Phase 1.2.7.3 — final transaction helper in isolation

**Allowed scope:** transaction-local helper invoked only by integration tests or
a non-public internal harness until the orchestration review approves service
wiring. No real KMS/RPC/worker.

**Required tests:** all Stage-3 revalidation mismatches; quote expiry between
stages; invoice/quote mutation between stages; same/different idempotency key
concurrency; all-or-nothing rollback after each individual write; evidence/outbox
foreign-key and uniqueness behavior; candidate digest checks; replay/no duplicate
writes; explicit route-missing validation.

### Phase 1.2.7.4 — reviewed Routing orchestration

**Preconditions:** approved registry configuration injection, KMS implementation
review, production auth decision, commit-outcome handling, and security logging
review. This is the first phase that may propose a narrowly reviewed
`service.ts` integration.

**Required tests:** preflight replay avoids KMS; conflict avoids KMS; no lock or
connection is held during a delayed provider; KMS/encryption failures leave no
Routing-related writes; ambiguous commit recovery by same-key replay; response
compatibility; tenant/isolation behavior; browser/API regression tests.

### Phase 1.2.7.5 — outbox worker and chain operations

**Preconditions:** all operational blockers above are resolved and separately
approved.

**Required tests:** immutable dispatch input; lease/claim concurrency; nonce and
replacement rules; RPC outage; receipt and `EvidenceAnchored` field matching;
confirmation/reorg reconciliation; reconciliation conflict; no settlement
transaction-hash reuse; incident/runbook exercises.

No phase may skip the final idempotency decision under its advisory lock, hold a
database lock while awaiting a provider, or substitute synthetic deployment/KMS
configuration for an approved operational decision.
