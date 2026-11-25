# Phase 2C.2B — Database privilege model

This document is the authoritative description of the role separation and the
application's database privileges introduced by Phase 2C.2B. The machine-readable
source of truth is `src/server/database-provisioning.ts`; `npm run db:provision`
applies it (additively and idempotently) and reads the result back from the
catalogue. The behavioural consequence of this model — Routing persistence
being dormant — is described in
[`PHASE2C2B_R1_ROUTING_LIMITATION.md`](./PHASE2C2B_R1_ROUTING_LIMITATION.md).

## Roles

| Role | LOGIN | Purpose |
| --- | --- | --- |
| `ponte_owner` | NOLOGIN | Owns every object created by a migration. The single elevation target. |
| `ponte_app` | NOLOGIN | The privilege group the application inherits. |
| `ponte_migrator` | LOGIN NOINHERIT | Administrative login. Elevates to `ponte_owner` inside a transaction. |
| `ponte_app_login` | LOGIN | The application identity. Inherits `ponte_app`. |

## Memberships (stated on every provisioning run)

- `ponte_app` → `ponte_app_login` **WITH INHERIT TRUE, SET FALSE** — the
  application login inherits the group's privileges but cannot `SET ROLE`.
- `ponte_owner` → `ponte_migrator` **WITH INHERIT FALSE, SET TRUE** — the
  administrative login has **no** privileges until a transaction explicitly
  elevates with `SET LOCAL ROLE ponte_owner`, and the elevation ends with that
  transaction.

`SET LOCAL ROLE` is transaction-scoped, so a pooled connection returned to the
pool is never left elevated. No code path issues a session-level `SET ROLE`.

## Schema and database ACL

- `ponte_owner` owns the schema and every object; `GRANT USAGE, CREATE ON SCHEMA`
  to the owner. The application gets `GRANT USAGE ON SCHEMA`.
- `REVOKE ALL ON DATABASE … FROM PUBLIC`; `CONNECT` is granted explicitly to
  `ponte_app_login` and `ponte_migrator` only. `CREATE ON DATABASE` is granted
  to `ponte_owner` **only** under the `--test` flag (for the scratch schemas
  `test:migrations` creates); production omits it.

## Application table privileges

Every entry is derived from the SQL the application actually issues. Tables
absent from the update map get **no `UPDATE` at all**.

### Read-only

`businesses` — `SELECT` only.

### Append-only (`SELECT, INSERT`, never `UPDATE`)

`users`, `memberships`, `external_identities`, `payments`, `quotes`,
`payment_events`, `idempotency`.

Table-level `SELECT` is required because the application issues `SELECT *`
against `idempotency`, `quotes`, `payments`, `settlements` and
`payment_events`.

> **R1 root cause.** `quotes` and `memberships` are append-only. PostgreSQL
> requires `UPDATE` on a table for every row-lock mode, so the application's
> two `FOR UPDATE` locks — the quote lock in `lockValidQuoteForEvidence` and
> the membership lock in `assertActiveMutationMembership` — fail with `42501`.
> This is the deliberate fail-closed boundary described in the R1 limitation
> document.

### Column-scoped `UPDATE`

| Table | Columns |
| --- | --- |
| `invoices` | `status`, `data`, `reference`, `funding_minor` |
| `settlements` | `status`, `actual_minor`, `settled_at` |
| `rate_limits` | `hits`, `window_start` |

`invoices`, `settlements` and `rate_limits` also receive `SELECT, INSERT`.

### Evidence projection (`route_decision_evidence`)

- **Read** (`EVIDENCE_READ_COLUMNS`, 13): the public-commitment projection.
  Sensitive envelope and KMS columns (`wrapped_dek`, KMS references,
  `ciphertext`, …) are absent — the application writes them on `INSERT` and
  must never read them back.
- **Insert** (`EVIDENCE_INSERT_COLUMNS`, 29): the full envelope. `INSERT` on a
  sensitive column conveys no read ability, so granting these does not widen
  the read projection.

### Outbox projection (`evidence_outbox`)

- **Read** (`OUTBOX_READ_COLUMNS`, 3): `id`, `evidence_record_id`,
  `submission_state`. The confirmation columns (`transaction_hash`,
  `confirmed_at`, `confirmed_block_*`, `attestor_address`, `last_failure_*`)
  and `attempt_count` are absent, so the application cannot observe or forge
  confirmation state.
- **Insert** (`OUTBOX_INSERT_COLUMNS`, 2): `id`, `evidence_record_id`.
  `submission_state` is **not** granted. Migration `007` supplies the
  `'pending'` default, so the application never names the column; because a
  column-level `INSERT` grant cannot restrict *which value* is written,
  omitting the grant makes `'submitted'` / `'confirmed'` unreachable for the
  application identity by privilege, not by discipline.

### Rate limits (`rate_limits`)

All columns are app-owned and app-read: `identity`, `window_start`, `hits`.

## Trigger-function hardening

`PUBLIC` holds `EXECUTE` on every new function by default. Four trigger
functions have `REVOKE EXECUTE ON FUNCTION … FROM PUBLIC` so that only the
owner (via a trigger) can fire them:

- `touch_updated_at()`
- `deny_event_mutation()`
- `deny_route_decision_evidence_mutation()`
- `deny_external_identity_remap()`

The provisioning report reads `has_function_privilege('public', …, 'EXECUTE')`
back from the catalogue and fails if any trigger function is still
`PUBLIC EXECUTE`.

## Drift repair

`GRANT` is additive; only an explicit `REVOKE` repairs drift. On every run,
before granting, provisioning revokes `ALL` on tables, sequences and functions
in the schema from the application, then re-grants the exact column-scoped set
above. This makes a previously-wider grant self-correcting on the next run.

## Who uses which identity

| Operation | Identity | How |
| --- | --- | --- |
| Ordinary application queries, `42501` assertions | `ponte_app_login` | `DATABASE_URL` |
| `TRUNCATE`, `DELETE`, private metadata reads, fixture priming | `ponte_migrator` → `ponte_owner` | `adminWrite` / `adminRead` (`tests-backend/helpers/admin-database.ts`) |
| `db:provision`, `db:migrate`, `db:seed`, `test:migrations` | bootstrap superuser → `ponte_owner` | `SET LOCAL ROLE ponte_owner` in `scripts/migrate.ts`; run with the bootstrap URL |
| Operator bootstrap CLIs (`bootstrap-production-business`, `bootstrap-public-demo`) | `ponte_migrator` → `ponte_owner` | `PONTE_OPERATOR_DATABASE_URL` + `adminDatabaseTransport`, `SET LOCAL ROLE` |
| `seed-fixtures.ts` | `ponte_app_login` | deliberately stays on the application identity via the `execute()` service path |

The application privilege matrix is **unchanged** by Phase 2C.2B: no grant was
widened. The only application-code change in this area is a tightening —
`insertPendingEvidenceOutbox` no longer names `submission_state`, relying on
the migration-007 default so the app's column grant cannot be used to write a
non-`pending` state.
