# PONTE Phase 1.2.13 — Routing Orchestration Seam and Safe Error Boundary

**Status:** preparatory internal seam implemented; normal Routing evidence
integration remains deliberately disabled.

**Baseline audited before edits:** `arena/40fa34c0-ponte` at
`a65e9e301a424de648565150519a5e5358d2a002`.

This phase implements the limited preparatory work described in Phase 1.2.12
Sections 5, 9, and 11. It does not activate ordinary Routing evidence creation,
select a provider or registry, change the frozen evidence commitment format, or
add production infrastructure.

## 1. Scope and preserved artifacts

The following artifacts were read and preserved:

- `docs/PHASE1_2_12_NORMAL_ROUTING_INTEGRATION_READINESS_AUDIT.md`
- `docs/PHASE1_2_10_FINAL_TRANSACTION_PERSISTENCE_AUDIT.md`

The Phase 1.2.10 artifact remains unmodified and unstaged. Its required
SHA-256 is:

```text
b2070af07fb293edfe46709dce33e61a13039da7f951679d49a7b0d7ca5ec08d
```

Phase 1.2.12 remains unmodified. Its SHA-256 at the final verification is
recorded in the final phase report.

No Solidity source, ABI, commitment algorithm, golden vector, evidence schema,
or prior migration was changed.

## 2. New internal boundaries

### 2.1 Canonical request compatibility boundary

`src/server/routing-boundary.ts` centralizes two exact compatibility contracts:

- `idempotencyKeySchema`: existing 8–128-character `^[\w-]+$` grammar.
- `createRoutingRequestFingerprint`: lower-case SHA-256 of the literal
  `${method}:${pathname}:${text}`.

`service.ts` now calls these boundary functions for every ordinary mutation.
The raw UTF-8 body text is still read exactly once, parsed exactly once, and is
not normalized or reserialized before fingerprinting. This is a refactor of the
existing fingerprint/key validation only; it creates no second fingerprint.

The module also defines the strict future `routingTransitionSchema` shape. It
is an internal future-orchestration input boundary, not an alternative active
normal Routing endpoint.

### 2.2 Non-authoritative read-only idempotency preflight

`readRoutingIdempotencyPreflight(businessId, idempotencyKey,
requestFingerprint)` in `src/server/repository.ts` uses a dedicated client and
short `BEGIN READ ONLY` transaction. It performs only the existing
business/key idempotency lookup, commits, releases the client, and returns one
of:

| Result     | Meaning                                                           | Authority                                                                                                                 |
| ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `miss`     | No durable row was found during this non-locking read.            | No final decision. Preparation can begin, but final persistence rechecks.                                                 |
| `match`    | A row has the exact fingerprint and includes its stored response. | No direct response disclosure. Final helper performs candidate-free, locked replay with final membership reauthorization. |
| `conflict` | A row exists with a different fingerprint.                        | No direct rejection is authoritative. Final helper repeats the lookup under advisory lock.                                |

The preflight acquires no idempotency advisory lock, invoice lock, or quote
lock. It is released before its promise resolves. It is intentionally a
provider-cost optimization and never substitutes for
`persistPreparedEvidenceCandidate()`.

### 2.3 Explicit controlled future orchestration seam

`src/server/evidence/routing-orchestration.ts` defines
`orchestratePreparedRoutingCandidate(input, hooks?)`. This server-only module
is **not imported by `src/server/service.ts`** and has no normal API route
activation.

The caller must explicitly inject all future-sensitive dependencies:

- trusted `businessId` and `actorUserId`;
- invoice, quote, idempotency key, raw-request fingerprint, and selected route;
- a `DekProvider`; and
- a registry address.

There is no provider default, environment fallback, registry default, cloud
SDK, credential, or production composition root. The test registry literal is
named `TEST_ONLY_REGISTRY` and is strictly a synthetic fixture; it is not
represented as deployed.

The seam has this exact proposed future order:

1. read-only idempotency preflight;
2. for `match` or `conflict`, invoke final persistence without a candidate;
3. for `miss`, obtain `readEvidencePreparationSnapshot()`;
4. reject known missing/expired invoice/quote or non-`Funded` snapshot state
   before provider work;
5. run `prepareEvidenceCandidate()` outside every database transaction;
6. call `persistPreparedEvidenceCandidate()` once with the prepared candidate.

For `match`, the final helper returns an authorized durable replay without any
provider call. For `conflict`, the final helper re-arbitrates under its advisory
lock and throws only if the conflict is still durable. For a preflight miss
where another request commits during preparation, the final helper returns an
authorized replay and writes no duplicate lifecycle rows.

The seam does not duplicate final authority. The existing final persistence
helper continues to own advisory locking, idempotency replay/conflict,
transaction-local membership authorization, invoice/quote locks, final state
comparison, settlement/evidence/outbox/Routing/event/idempotency writes, and
commit acknowledgement classification.

### 2.4 Safe evidence error boundary

`src/server/evidence/error-boundary.ts` maps only fixed evidence preparation
and persistence error categories to `ApiError`. The shared error types live in
`src/server/evidence/errors.ts`, so the ordinary API route does not import
candidate preparation or final persistence logic. The mapper deliberately
discards the original error object and contains no candidate, ciphertext,
wrapped DEK, plaintext DEK, salt, AAD, KMS context, private payload, raw
provider cause, or raw SQL value.

`src/app/api/v1/[...path]/route.ts` applies this mapping before its existing
unknown-error branch. A mapped evidence error does not reach the generic raw
`console.error` path. Logging behavior for unrelated exceptions is unchanged.
The response envelope remains exactly:

```json
{ "error": { "code": "<safe-code>" }, "requestId": "<uuid>" }
```

with `Cache-Control: no-store` and existing `Retry-After` behavior for 429.

| Internal category                    | Safe HTTP result | Public code                                                                  |
| ------------------------------------ | ---------------: | ---------------------------------------------------------------------------- |
| Preparation stale/invalid input      |              409 | `EVIDENCE_PREPARATION_STALE`                                                 |
| Provider unavailable/failure         |              503 | `EVIDENCE_PROVIDER_UNAVAILABLE`                                              |
| Invalid provider output              |              500 | `EVIDENCE_PROVIDER_RESULT_INVALID`                                           |
| Encryption failure                   |              500 | `EVIDENCE_ENCRYPTION_FAILED`                                                 |
| Other preparation failure            |              500 | `EVIDENCE_PREPARATION_FAILED`                                                |
| Final stale candidate/state mismatch |              409 | `EVIDENCE_PREPARATION_STALE`                                                 |
| Final invoice/quote unavailable      |              409 | `QUOTE_EXPIRED_OR_MISSING`                                                   |
| Final membership failure             |              403 | `FORBIDDEN`                                                                  |
| Durable idempotency conflict         |              409 | `IDEMPOTENCY_CONFLICT`                                                       |
| Invalid candidate/context            |              500 | `EVIDENCE_INTERNAL_CANDIDATE_INVALID` or `EVIDENCE_INTERNAL_CONTEXT_INVALID` |
| Definite persistence failure         |              500 | `EVIDENCE_PERSISTENCE_FAILED`                                                |
| Ambiguous COMMIT acknowledgement     |              503 | `COMMIT_OUTCOME_UNKNOWN`                                                     |

`COMMIT_OUTCOME_UNKNOWN` remains explicitly indeterminate. It never claims
that PostgreSQL rolled back or committed. Future clients must retain the exact
serialized request bytes and original idempotency key, then retry that same
request until an acknowledged outcome or durable replay is returned. No UI
automatic retry behavior was added in this phase.

## 3. Transaction ownership and concurrency guarantees

The ordinary generic `repository.transaction()` remains unchanged and continues
to own every current normal mutation, including normal `Funded -> Routing`.
The new seam is disconnected from that path. It does not nest
`persistPreparedEvidenceCandidate()` inside the generic transaction.

The two read-only phases each commit and release before controlled provider
preparation:

```text
readRoutingIdempotencyPreflight: BEGIN READ ONLY -> SELECT idempotency -> COMMIT -> release
readEvidencePreparationSnapshot: BEGIN READ ONLY -> SELECT snapshot -> COMMIT -> release
provider/candidate preparation: no repository transaction, no final locks
persistPreparedEvidenceCandidate: one independent authoritative final transaction
```

The new PostgreSQL integration test observes, at provider preparation time:

- the orchestration hook runs only after the snapshot function returns;
- the pool has an idle client, confirming released snapshot ownership;
- the provider-side database observation holds no advisory lock and no
  invoice/quote final relation lock on its backend; and
- its backend is not idle in transaction.

The existing final-helper PostgreSQL tests continue to cover advisory-lock
same-key serialization, distinct-key same-invoice locking, quote expiry, final
membership locking/revocation, row comparison, all post-write rollback
boundaries, and ambiguous COMMIT replay recovery.

## 4. Compatibility guarantees

This phase preserves all of the following current behavior:

- endpoint/method shape, including `POST /api/v1/invoices/:id/transitions`;
- strict ordinary body schemas and existing `422 QUOTE_AND_ROUTE_REQUIRED`;
- exact body-size, content-type, JSON, origin, tenant, role, and rate-limit
  checks and their order in the ordinary service;
- raw-text method/path/body fingerprint semantics and idempotency header
  grammar;
- response envelope, invoice response shape, success statuses, and existing
  error behavior for non-evidence operations;
- all generic transaction behavior for invoice creation, drafts, payments,
  quotes, settlement, list/history/activity, and the active normal Routing
  branch; and
- normal Routing's existing one-transaction simulated settlement, invoice
  update, `invoice.Routing` event, idempotency response, and lack of evidence
  or outbox writes.

Specifically, `service.ts` has no import of the controlled orchestration seam.
The normal `Funded -> Routing` writer remains the active generic transaction
branch and does **not** create evidence or invoke a provider.

## 5. Test evidence

### 5.1 New real PostgreSQL test coverage

`tests-backend/routing-orchestration.test.ts` uses a controlled in-process
`DekProvider` test double and a synthetic test-only registry string. It is not
a live KMS test. The test file verifies:

1. real PostgreSQL preflight `miss`, `match`, and `conflict` results;
2. matching preflight calls the final helper candidate-free and does not invoke
   the provider;
3. conflicting fingerprints are rechecked authoritatively and produce no
   evidence/settlement/outbox/event duplicate writes;
4. snapshot release/no final lock spans before provider preparation, followed
   by one successful final persistence;
5. a durable matching idempotency row inserted during provider preparation is
   returned by the final helper as replay, with no duplicate writes;
6. controlled provider failure prevents every final persistence write;
7. changed final invoice state yields stale rejection with no partial writes;
8. all required evidence error mappings, including explicit ambiguous COMMIT
   indeterminacy; and
9. the ordinary service still lacks an orchestration import and retains its
   generic transaction path.

### 5.2 Required commands

The completed-phase validation sequence is recorded in the final report. It
includes TypeScript, lint, Prettier check, evidence unit tests, backend/API and
PostgreSQL integration tests, migration validation, production build, and
`git diff --check`.

An initial backend test attempt found local PostgreSQL was not running and
failed with `ECONNREFUSED`; no behavioral assertion was inferred from that
attempt. The local embedded PostgreSQL test service was then started and the
migration plus full backend/API suite passed. This is a local test database
only, not a production database or external resource.

## 6. Deferred activation and blockers

This phase intentionally does not authorize or implement:

- normal Routing invocation of the new seam;
- concrete KMS provider adapters, cloud SDKs, credentials, resource names, or
  provider configuration;
- an approved/deployed registry address, attestor, signer, ABI change, RPC, or
  chain submission;
- production authentication, tenant/membership lifecycle, or production
  security logging/operations;
- outbox worker, lease/retry/reconciliation/confirmation/reorganization logic;
- migrations, global Routing/evidence invariants, or schema changes; or
- deployment or automatic client retries.

Before a separately authorized activation phase, the project still needs:

1. approved production identity and tenant/membership/revocation operations;
2. approved KMS provider adapter, key/resource/credential/rotation/recovery and
   outage policies;
3. approved registry deployment/address, signer custody, RPC/finality and
   reconciliation plans;
4. approved worker and outbox operating model;
5. service-level integration review proving the exact normal HTTP response
   compatibility and safe typed errors through the live path;
6. a client retry design that retains the original idempotency key and exact raw
   serialized body after `COMMIT_OUTCOME_UNKNOWN`; and
7. separate migration review before any global evidence/outbox/Routing
   invariants are enforced.

## 7. Final decision

Phase 1.2.13 provides reusable request compatibility primitives, a released
read-only preflight, an explicit controlled orchestration seam, and safe
future evidence error mapping. These are preparation boundaries only.

**Normal Routing evidence creation remains disabled.** The existing normal
`Funded -> Routing` generic transaction remains the sole active production
behavior until a separately approved integration phase satisfies the remaining
security, provider, registry, worker, and operational blockers.
