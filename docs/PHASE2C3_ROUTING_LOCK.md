# Phase 2C.3 — SECURITY DEFINER routing row-lock functions

Status: **implemented**. This document records how Phase 2C.3 lifts the
Routing dormancy described in
[`PHASE2C2B_R1_ROUTING_LIMITATION.md`](./PHASE2C2B_R1_ROUTING_LIMITATION.md)
without widening the application identity's table privileges, and how the
result is verified.

## The problem this solves

The final persistence transaction takes two row locks — the membership
reauthorization and the quote lock — and PostgreSQL requires `UPDATE` on a
table for *every* row-lock mode. Under the Phase 2C.2B privilege model the
application identity holds `SELECT`+`INSERT` only on `memberships` and
`quotes`, so both locks fail closed with `42501` and Routing persistence is
dormant (see the R1 limitation doc).

The deliberate fix is **not** to widen the application's `UPDATE` grants.
Two `SECURITY DEFINER` functions carry the locks instead, owned by a
dedicated `NOLOGIN` role (`ponte_routing_lock`) that holds exactly the
minimum column-level `SELECT` and `UPDATE` privileges the locks need. The
application calls the functions (`EXECUTE`, granted in Phase 2 provisioning);
it never touches the locked tables directly.

## The two lock functions

Both are created by migration `008_routing_lock_functions.sql`, which runs
inside the migration runner's single transaction as `ponte_owner`.

### `ponte_lock_routing_membership(uuid, uuid) RETURNS text`

Locks the active membership row for the business and user and returns the
role. `NULL` means no active membership; the caller treats `NULL` and
`'viewer'` as denial. The `status = 'active'` predicate is part of the lock
statement, so a disabled row is never locked.

### `ponte_lock_routing_quote(uuid, uuid, uuid) RETURNS TABLE (...)`

Locks the exact quote row by identity and returns its persisted fields. The
row is locked first, and the expiry check (`expires_at > clock_timestamp()`)
is evaluated only **after** the lock is acquired:

- a **missing** quote locks nothing and returns zero rows;
- a **valid** quote is locked and then returned;
- an **expired** quote is locked first, rejected by the post-lock expiry
  check, and returns zero rows.

In the zero-row cases the caller fails closed with
`INVOICE_OR_QUOTE_UNAVAILABLE` instead of locking or returning a stale row.

## Security properties (all verified against the catalogue)

- **Ownership**: both functions are owned by `ponte_routing_lock`, a
  `NOLOGIN` role with no superuser-class attributes.
- **SECURITY DEFINER**: `prosecdef = true` on both.
- **Pinned search_path**: both carry
  `SET search_path = pg_catalog, public, pg_temp`, so the function bodies'
  `public.`-qualified table refs resolve deterministically regardless of the
  caller's `search_path`. The `public.` qualification inside the bodies is
  load-bearing; the DDL object names in the migration are intentionally
  unqualified so the file relocates correctly when the migration runner
  applies it into a scratch schema (matching migrations 001–007).
- **PUBLIC EXECUTE revoked**: `REVOKE EXECUTE ... FROM PUBLIC` runs while
  `ponte_owner` still owns the functions (ACL changes require object
  ownership). The catalogue ACL contains only
  `{ponte_routing_lock=X/ponte_routing_lock}` before Phase 2 and
  `{ponte_routing_lock=X/..., ponte_app=X/...}` after it — never a PUBLIC
  grant.
- **Minimum column grants**: `ponte_routing_lock` holds column-level
  `SELECT`/`UPDATE` on exactly the columns the locks read and the single
  column per table whose mutation would invalidate the lock's meaning
  (`memberships.status`, `quotes.expires_at`). It never holds a schema
  `CREATE` on `public`: no temporary schema grant exists in the migration at
  all. (Verified during final review: `ponte_owner` holds USAGE+CREATE on
  `public` without grant option, so a `GRANT CREATE ON SCHEMA` issued by it
  is a silent no-op — it neither errors nor changes the schema ACL. The
  ownership transfer needs no target-side schema privilege, so the grant
  pair was removed from the migration.)
- **Ownership transfer**: performed by the bootstrap superuser
  (`SET LOCAL ROLE NONE`), because `ponte_owner` cannot perform the ALTER
  (42501 `permission denied for schema public`): the `ALTER OWNER`
  privilege check does not observe schema grants, and `ponte_owner` holds
  no grant option for schema `CREATE` anyway. The runner's role is restored to
  `ponte_owner` immediately afterwards so the ledger insert still runs as
  `ponte_owner`. `ponte_owner`'s membership in `ponte_routing_lock` is
  `INHERIT FALSE, SET TRUE` (Phase 1); `SET TRUE` is the option that matters
  for the transfer, and `admin_option` stays `FALSE` by design.

## Replay authorization order

`persistPreparedEvidenceCandidate()` checks the mutation membership **before**
comparing the existing idempotency-key fingerprint. A replay with a revoked
membership is rejected with `FORBIDDEN` even when the fingerprint matches —
authorization is never skipped for a replay. The regression test drives this
through the real `persistPreparedEvidenceCandidate()` path.

## Phase 1 / Phase 2 provisioning

- **Phase 1** creates `ponte_routing_lock` (NOLOGIN, hardened), reconciles
  an existing role **explicitly** (it never silently drops, recreates, or
  alters one): a role with `LOGIN` or any superuser-class attribute, an
  unexpected member, or a parent membership fails the run with an explicit
  message for manual reconciliation. It grants `ponte_owner` membership in
  `ponte_routing_lock` `WITH INHERIT FALSE, SET TRUE` and re-states the
  options on every run (a bare `GRANT` leaves stored options untouched).
- **Phase 2** grants `EXECUTE` on both lock functions to `ponte_app` (which
  `ponte_app_login` inherits), then runs an exact-signature and
  security-property verification: existence, identity arguments, return
  type, owner, `SECURITY DEFINER`, `search_path`, and both ACL checks
  (`PUBLIC` must be false, `ponte_app` must be true). Any mismatch fails the
  run explicitly.

## PostgreSQL version note

The `GRANT ... WITH INHERIT/SET` syntax requires PostgreSQL 16+; a version
guard in Phase 1 fails explicitly on older servers.

**Runtime validation was completed for both supported versions via the
Phase 2D.1.1 CI matrix** (PR #23, final corrected implementation at
commit `e65a9638`, workflow
[`frontend.yml`](../.github/workflows/frontend.yml)):

- **PostgreSQL 16** — full quality suite run against a `postgres:16`
  service container: Phase 1 and 2 provisioning, migrations, seed,
  migration tests, the complete backend suite, lint, typecheck,
  production build and Playwright. **All green.** Locally reproduced on
  a real PostgreSQL **16.16** server with the identical suite:
  230 backend tests passed, 0 failed.
- **PostgreSQL 18** — the same full suite run against a `postgres:18`
  service container. **All green.**
- **PostgreSQL 15 guard** — an isolated job runs only the Phase 1
  provisioning command against `postgres:15` and asserts it exits
  non-zero with the explicit `PostgreSQL 16+ required` error. The guard
  is the first statement of the Phase 1 plan and the plan executes
  statement by statement, so no PostgreSQL 16-only SQL is parsed or
  executed before the rejection. The full application suite
  intentionally never runs on PostgreSQL 15. **Assertion green.**

Workflow run evidence: [run #90](https://github.com/timmyspurs12/ponte/actions/runs/46115390304)
validated the final corrected implementation, including the numeric
`server_version_num >= 160000` assertion, and passed all three jobs:
`quality (16)`, `quality (18)`, and `pg15-version-guard`. (The earlier
runs #87–#89 preceded the final correction and are not the validated
final-head run.)

One incidental assertion was adjusted for the matrix: the foundation
test previously matched `/PostgreSQL 18/` against `version()`, hard-coding
the CI version. It now asserts the declared minimum numerically: it parses
`server_version_num` once with `Number(...)` and requires
`Number.isInteger(serverVersionNum) && serverVersionNum >= 160000`, with no
artificial upper bound on the server version. All other tests in the suite
are unchanged and run identically on 16 and 18.

## Verification

- `scripts/test-migrations.ts` applies every migration (including 008) into
  a scratch schema through the real runner and asserts the ledger.
- `tests-backend/routing-lock-provisioning.test.ts` covers: migration 008
  through the real `applyMigrations()`; rollback after a forced failure;
  role provisioning and repeated provisioning; existing-role reconciliation
  (dangerous attributes, unexpected members, parent memberships); function
  ownership/ACL verification; app-login `EXECUTE` plus denial of direct
  table privileges; membership missing/disabled/viewer/admin cases; and
  quote expiry after a concurrent lock wait.
- `tests-backend/privilege-boundary.test.ts` L1/L2 assert both halves of the
  privilege contract: the application identity can `EXECUTE` the lock
  functions and obtain the locked rows, and still cannot take a raw
  `FOR UPDATE` on `quotes` or `memberships` directly.
- The three `*-r1-contract.test.ts` files drive the full
  `persistPreparedEvidenceCandidate()` path (persist, replay, conflict,
  rollback) through the lock functions.

## Still simulated

The Routing path remains a **simulation**: the quote source is pinned to
`simulation-fixed-525`, evidence envelopes are synthetic
(`LOCAL_TEST_RANDOM_BYTES_V1`), and there is no real Pix processing, live
USDG transfer, or on-chain settlement. Phase 2C.3 changes only **who holds
the row locks**, not what the persistence path writes.
