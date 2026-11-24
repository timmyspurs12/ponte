# PONTE Phase 1.2.13.1 — Orchestration Race Closure and Error Compatibility

**Status:** internal future-orchestration hardening only. Normal Routing remains
disconnected and unchanged.

**Baseline:** `arena/40fa34c0-ponte` at
`da6f279152c95d45491f090728a1be1a736a176e`.

This phase closes an idempotency race in the Phase 1.2.13 controlled seam,
restores current Routing error semantics for known pre-preparation state, and
makes read-only repository failure/cleanup behavior safe for future API use. It
does not activate evidence persistence in normal Routing.

## 1. Preflight-to-snapshot idempotency race

### 1.1 The previous seam gap

The Phase 1.2.13 seam first did a short idempotency preflight and, after a
`miss`, read a non-locking invoice/quote snapshot. Another request could commit
the same key and fingerprint between those reads, transition the invoice to
`Routing`, and make the snapshot no longer eligible for preparation. Returning
an immediate stale-state failure in that circumstance would be wrong: a durable
matching replay now exists.

Preflight is deliberately a cost optimization, never replay authority. It must
not return its observed response directly or replace final transaction-local
membership authorization.

### 1.2 Resolution

`routing-orchestration.ts` now performs a candidate-free call to
`persistPreparedEvidenceCandidate()` before returning any known ineligible
snapshot result following a preflight `miss`:

```text
preflight miss
  -> snapshot returns known ineligible state
  -> candidate-free final helper call
      -> matching row: locked membership reauthorization + replay
      -> conflicting row: authoritative IDEMPOTENCY_CONFLICT
      -> no row: CANDIDATE_REQUIRED internal signal
  -> no-row signal: return the original known snapshot error
```

Only the final helper obtains the idempotency advisory lock and makes the
replay/conflict decision. It still locks and reauthorizes active non-viewer
membership before returning a stored response. The candidate-free call has no
provider input and cannot call a provider.

`CANDIDATE_REQUIRED` is consumed only as a private no-durable-row signal after
the final helper has rechecked idempotency and membership. It is never exposed
as an initial Routing result. Any other final-helper result, including
`FORBIDDEN`, `IDEMPOTENCY_CONFLICT`, or a read/persistence error, remains
authoritative and is propagated.

### 1.3 Deterministic race control

The seam adds `afterPreflightMissBeforeSnapshot` to its existing
`RoutingOrchestrationTestHooks`. It is explicitly test-only, has no normal
runtime caller, and has no environment/configuration fallback. It permits a
deterministic PostgreSQL test to commit a simulated ordinary Routing result
between the two reads.

The active service does not import this hook or the seam.

## 2. Initial request semantics versus final candidate staleness

`RoutingEligibilityError` separates known initial request conditions from
final-candidate failures:

| Known condition before preparation                    | HTTP status/code                 |
| ----------------------------------------------------- | -------------------------------- |
| Invoice absent                                        | `404 NOT_FOUND`                  |
| Existing invoice not eligible for `Funded -> Routing` | `409 INVALID_TRANSITION`         |
| Eligible invoice but quote absent or expired          | `409 QUOTE_EXPIRED_OR_MISSING`   |
| Candidate/locked state mismatch after preparation     | `409 EVIDENCE_PREPARATION_STALE` |

The seam now follows the current service's required order:

1. establish invoice existence;
2. establish `Funded -> Routing` eligibility;
3. establish selected quote validity;
4. only then run candidate/provider preparation.

In particular, a non-`Funded` invoice whose quote is missing/expired returns
`INVALID_TRANSITION`, not a quote error. A final `CANDIDATE_MISMATCH` remains a
distinct post-preparation `EVIDENCE_PREPARATION_STALE` response.

## 3. Read-only failure and client lifecycle hardening

### 3.1 Sanitized reads

`readRoutingIdempotencyPreflight()` and
`readEvidencePreparationSnapshot()` now normalize all connection, begin, query,
commit, rollback, and release-path failures into fixed `EvidenceReadError`
categories:

| Read operation                             | Public safe mapping                  |
| ------------------------------------------ | ------------------------------------ |
| Idempotency preflight read failure         | `500 EVIDENCE_PREFLIGHT_READ_FAILED` |
| Evidence preparation snapshot read failure | `500 EVIDENCE_SNAPSHOT_READ_FAILED`  |

The original PostgreSQL error is not attached to the typed error. The API error
boundary therefore cannot expose SQLSTATEs, query values, constraints, details,
or database metadata. It also recognizes these typed errors before the API
route's existing generic raw unknown-error logging path. Unrelated application
error logging is unchanged.

A known no-row, expired-quote, or invalid-state snapshot result is not a read
failure and retains the compatibility mapping in Section 2.

### 3.2 Read-only cleanup rules

Both helpers share `withReadOnlyTransaction()`, backed by a narrowly exported
`__testOnlyRunReadOnlyTransaction()` controlled-client seam. Production callers
cannot configure a client; normal helper calls always acquire their own pool
client.

The shared lifecycle is:

```text
BEGIN READ ONLY
  -> work query
  -> COMMIT
  -> release healthy client
```

On a work-query failure, a successful rollback keeps the client reusable and
the original query failure remains primary. On rollback failure, the client is
released with destruction enabled. A failed `COMMIT` acknowledgement marks the
client uncertain and destroys it even if a best-effort rollback succeeds. A
release failure never masks a previous operation error and cannot create a
false success.

Generic `transaction()` and evidence-only
`transactionWithCommitOutcome()` are unchanged.

## 4. PostgreSQL and controlled-client evidence

`tests-backend/routing-orchestration.test.ts` now verifies all of the following:

- preflight `miss`, `match`, and `conflict` results with real PostgreSQL;
- matching ordinary Routing state/idempotency commit between preflight miss and
  snapshot produces authoritative candidate-free replay, zero provider calls,
  and no duplicate settlement/evidence/outbox/event/idempotency rows;
- conflicting fingerprint committed in that window produces final-helper
  `IDEMPOTENCY_CONFLICT`, zero provider calls, and no duplicate writes;
- stale snapshot with no durable idempotency row returns the original
  `INVALID_TRANSITION` result;
- matching preflight and matching commit during provider preparation retain
  candidate-free/authoritative replay behavior;
- normal initial missing invoice, missing/expired quote, and non-Funded before
  missing quote outcomes;
- final candidate state change after preparation returns only final stale
  candidate semantics and no partial writes;
- all preparation, read, initial eligibility, and persistence error categories
  map to fixed safe status/code pairs, including `COMMIT_OUTCOME_UNKNOWN`;
- read-only work-query failures preserve their original internal error after a
  successful rollback and release the client normally;
- rollback or commit-cleanup failure destroys the controlled client while
  preserving the original failure; and
- repository read failures become fixed `EvidenceReadError` instances without
  embedding the raw controlled SQL message.

The controlled provider is a test double only. The test-only registry string is
synthetic and does not assert a registry deployment, KMS integration, or chain
operation.

## 5. Compatibility and non-activation guarantees

This phase leaves the active service untouched with respect to normal Routing:

- `service.ts` does not import or invoke `routing-orchestration.ts`;
- the active `Funded -> Routing` generic transaction remains the only ordinary
  Routing writer;
- ordinary Routing still writes its existing simulated settlement, invoice
  state, lifecycle event, response, and idempotency row without evidence or
  outbox rows;
- method/path/body validation, trusted authentication context, role/origin/body
  protection, rate limiting, raw request fingerprint, tenant isolation, and
  response envelope remain unchanged; and
- no automatic UI retry is added. A future client must retain the exact original
  idempotency key and serialized request bytes after
  `COMMIT_OUTCOME_UNKNOWN`.

## 6. Deferred requirements before normal Routing integration

The hardening work does not approve or provide:

- a concrete KMS provider, cloud SDK, credentials, resource configuration, or
  production key-management policy;
- registry deployment/address, attestor/signer custody, RPC, wallet, chain
  submission, confirmation, or reconciliation;
- production authentication/tenant lifecycle or worker/outbox operations;
- a schema migration, global Routing/evidence invariant, or deployment; or
- activation of this controlled seam from normal service code.

A separately authorized integration phase must still review provider injection,
registry configuration, production identity and logging operations, client
ambiguous-outcome retries, worker/reconciliation design, and any required
migration strategy.

## 7. Final decision

Phase 1.2.13.1 closes the preflight-to-snapshot replay race without adding a
second idempotency authority, restores current known Routing error compatibility,
and ensures read-only orchestration failures are sanitized and safely cleaned
up. The normal Routing evidence integration remains explicitly deferred.
