# Phase 2C.2B R1 — Routing persistence is dormant (fail-closed)

Status: **implemented and intentional**. This document records why
`POST /api/invoices/[id]/route` (the Routing transition) cannot activate
`persistPreparedEvidenceCandidate()` under the Phase 2C.2B role separation, and
how the behaviour is verified.

## What is dormant

Routing evidence persistence — the path that freezes a simulated evidence
candidate, writes the pending outbox row, moves the invoice to `Routing`, and
creates the settlement — is **unreachable from the application identity**. The
final state authority, `persistPreparedEvidenceCandidate()`
(`src/server/evidence/persist-candidate.ts`), fails closed before it writes
anything.

This is not a bug and not a temporary outage. It is the direct consequence of
the privilege model in [`PHASE2C2B_PRIVILEGE_MODEL.md`](./PHASE2C2B_PRIVILEGE_MODEL.md):
the application identity holds **no `UPDATE` grant on `quotes` or
`memberships`**, and PostgreSQL requires `UPDATE` on a table for *every* row-lock
mode (`FOR UPDATE`, `FOR SHARE`, `FOR NO KEY UPDATE`, `FOR KEY SHARE`). The
first row-lock statement the persistence path issues therefore fails with
`42501` — and that first statement is the **membership** lock, not the quote
lock.

## The two dormancy layers

Routing cannot reach persistence through either of its two entry points:

1. **The local evidence provider is disabled by default.**
   `resolveLocalRoutingEvidencePreparationDependencies()`
   (`src/server/evidence/local-routing-config.ts`) returns a synthetic
   provider only when *every* guard passes: `NODE_ENV` is `development` or
   `test`, `PONTE_DEV_AUTH=1`, `DATABASE_URL` is a loopback host,
   `PONTE_LOCAL_EVIDENCE_TEST_PROVIDER=1`, and a valid, non-zero
   `PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS` is set. Any other runtime —
   production, preview, staging, a non-loopback database, a missing opt-in, or
   an absent/invalid registry address — fails closed with
   `PROVIDER_FAILURE`, mapped to a sanitised `503 EVIDENCE_PROVIDER_UNAVAILABLE`.

2. **The final persistence lock is denied by privilege even when a provider is
   available.** `persistPreparedEvidenceCandidate()` issues two row locks: the
   membership reauthorization (`assertActiveMutationMembership`,
   `src/server/evidence/persist-candidate.ts`) and, later, the quote lock
   (`lockValidQuoteForEvidence`, `src/server/repository.ts`).
   **`assertActiveMutationMembership` runs first**, so the membership lock is the
   first runtime denial — it is the statement whose `42501` aborts the
   transaction, and the quote lock is never reached. Both `memberships` and
   `quotes` are append-only for the application identity, so each lock would
   deny on its own; the membership lock is simply the one that fires first. The
   quote lock is nonetheless probed **independently** as an app-role permission
   probe (`privilege-boundary.test.ts`, L1), so both tables' `42501` boundaries
   are verified directly rather than only inferred through the persistence path.

Either layer alone is sufficient to stop persistence; both are fail-closed.

## The error is sanitised

The raw PostgreSQL `42501` never reaches the client. The orchestration wraps the
denial in an `EvidencePersistenceError` with code `PERSISTENCE_FAILED`, and
`mapEvidenceError()` (`src/server/evidence/error-boundary.ts`) maps it to a
stable, non-sensitive `500 EVIDENCE_PERSISTENCE_FAILED`. The boundary contains
no original cause, candidate, envelope, provider, KMS, or SQL value.

Note: because the membership reauthorization lock precedes the snapshot
recheck, quote-expired and stale-snapshot Routing requests also surface as
`EVIDENCE_PERSISTENCE_FAILED` rather than `QUOTE_EXPIRED_OR_MISSING`. This
collapse of Routing diagnostics is expected under R1.

## What still works

Settlement is **not** blocked. `settlements` carries an application
`UPDATE (status, actual_minor, settled_at)` grant, so once an invoice is in a
`Routing` state, the `Settled` transition, receipts, replay, and history all
run on the application identity and are exercised as real application
behaviour.

Routing state is reached **administratively**, not through the application
identity: tests prime a `Routing` settlement row, invoice state, and event with
`primeRoutedState()` (`tests-backend/helpers/routed-fixture.ts`) using the
administrative helper. From that primed state, `POST /transitions
{status:"Settled", route:"split"}` succeeds with the exact expected output
(`amountMinor` `473904`, `costMinor` `2`) and an identical idempotent replay.

## How this is verified

The 21 original successful-persistence tests were replaced by 22 fail-closed
contract tests in three new files (see the test-replacement mapping in the
Phase 2C.2B review report). Each contract test asserts three things, not a bare
`42501`:

- the denial is `PERSISTENCE_FAILED` (sanitised),
- a **zero-write** snapshot — `evidence`, `outbox`, `settlements`, `events`,
  `idempotency` all `"0"` and the invoice status unchanged — proving no partial
  write survives,
- the **exact construct** that denies the request: the membership lock
  `FROM memberships WHERE business_id=$1 AND user_id=$2 AND status='active'
  FOR UPDATE` — the first row-lock statement in the persistence path, which is
  where the denial actually fires.

The quote lock is not asserted through the persistence path (it is never
reached there); it is asserted **independently** as an app-role permission probe
in `privilege-boundary.test.ts` (L1: `lockValidQuoteForEvidence` fails closed
with `42501`), and L2 probes the membership lock the same way.

The full backend suite exits `0` (218 tests / 208 pass / 0 fail / 10 skipped).

## Re-enabling Routing persistence

Routing becomes reachable only when the privilege model is widened deliberately:
grant the application identity `UPDATE` on `quotes` and `memberships` (or move
the row locks to tables the application may update). That is a separate,
security-reviewed change — it expands the application's write surface and must
not be bundled with this limitation. Until then, Routing persistence remains
dormant and fail-closed by design.
