# Phase 2C.3 — Final Source-Code Review Package

Branch: `phase2c3-routing-lock`. Implementation base (verified):
`f7a5bde0d109131e64596dab92879f024719a453` (the merge of
`arena/phase2c2b-r1-20261125`, i.e. HEAD of `main` — still the latest `main`
base at the time of this refresh). The Arena session
tracking name `arena/40fa34c0-ponte` and the earlier shallow-checkout base
`d3dae37f6032fbdea39d1834ef053c5676fb6a43` are historical session context
only — they are **not** the implementation base of this branch's diff.
Status: **pushed to `origin/phase2c3-routing-lock`; PR #21 open and
MERGEABLE; GitHub Actions green (run `45999591684`, conclusion: success) —
not merged, not deployed.**

This package collects every Phase 2C.3 artifact for inspection: the complete
migration SQL, the Phase 1/2 provisioning logic, the application changes, the
two security tests, the R1-contract rewrite summary, the browser-test rewrite
and messaging cleanup that fixed the PR #21 CI failure, and a read-only
self-review of the seven requested review areas.

---

## 1. Migration 008 — `migrations/008_routing_lock_functions.sql` (new, 200 lines)

Complete file content (both SECURITY DEFINER functions and all grants).
Final-review corrections: (a) the temporary
`GRANT CREATE ON SCHEMA public` / `REVOKE ...` pair previously in this file
was removed after verification showed it was a silent no-op — `ponte_owner`
holds schema CREATE without grant option, so the GRANT neither errors nor
changes the schema ACL, and the ownership transfer (performed by the
bootstrap superuser) needs no target-side CREATE privilege; (b) the lock
owner's schema reachability is now granted EXPLICITLY —
`GRANT USAGE ON SCHEMA public TO ponte_routing_lock` runs inside the
`SET LOCAL ROLE NONE` section alongside the ownership transfer, so the
function bodies' `public.` references resolve even where the default PUBLIC
USAGE has been revoked. CREATE is never granted to the lock role:

```sql
-- Phase 2C.3: SECURITY DEFINER row-lock functions for the Routing path.
--
-- Problem this migration solves (see docs/PHASE2C2B_R1_ROUTING_LIMITATION.md):
-- the final persistence transaction takes two row locks — the membership
-- reauthorization and the quote lock — and PostgreSQL requires UPDATE on a
-- table for *every* row-lock mode. Under the Phase 2C.2B privilege model the
-- application identity holds SELECT+INSERT only on `memberships` and `quotes`,
-- so both locks fail closed with 42501 and Routing persistence is dormant.
--
-- The deliberate fix is *not* to widen the application's UPDATE grants. Two
-- SECURITY DEFINER functions carry the locks instead, owned by a dedicated
-- NOLOGIN role (`ponte_routing_lock`) that holds exactly the minimum
-- column-level SELECT and UPDATE privileges the locks need. The application
-- calls the functions (EXECUTE, granted in Phase 2 provisioning); it never
-- touches the locked tables directly.
--
-- DDL names are intentionally unqualified (they resolve through the
-- session search_path, matching migrations 001-007); the function bodies
-- keep `public.`-qualified table refs so the security-definer execution is
-- pinned to the real tables regardless of the caller's search_path.
--
-- Execution context (load-bearing):
--
-- `applyMigrations()` runs this file inside one transaction with
-- `SET LOCAL ROLE ponte_owner`, so the statements that create the functions
-- and the migration-ledger INSERT that follows execute as `ponte_owner`.
-- The file DOES issue its own role switches for the ownership transfer:
-- `SET LOCAL ROLE NONE` drops to the bootstrap superuser for the
-- `ALTER FUNCTION ... OWNER TO` statements, and `SET LOCAL ROLE ponte_owner`
-- restores the runner's role immediately afterwards. Both switches are
-- transaction-scoped (`SET LOCAL`), so the connection is never left
-- elevated and the ledger INSERT still runs as `ponte_owner`.
--
-- `ponte_owner` is a member of `ponte_routing_lock` WITH INHERIT FALSE,
-- SET TRUE (Phase 1 provisioning). This is an explicitly accepted role
-- relationship (the trusted-migrator decision), retained as part of the
-- approved provisioning contract. It is NOT what makes the ownership
-- transfer below possible: the transfer runs as the bootstrap superuser
-- (see step 4), because `ponte_owner` cannot perform the `ALTER OWNER`
-- itself. INHERIT FALSE keeps the owner's privileges from flowing into the
-- lock role and does not grant any object privilege.
--
-- No schema-level CREATE is granted to `ponte_routing_lock` here, and none
-- is needed. `ponte_owner` holds USAGE+CREATE on schema `public` (Phase 1)
-- but WITHOUT grant option — verified empirically: a
-- `GRANT CREATE ON SCHEMA public` issued by `ponte_owner` is a silent no-op
-- (it neither errors nor changes the schema ACL), so such a grant could not
-- make the ownership transfer legal anyway. The transfer is performed by
-- the bootstrap superuser (step 4), which needs no target-side schema
-- privilege. `ponte_routing_lock` therefore never holds CREATE on `public`.
--
-- Schema reachability is granted EXPLICITLY, not relied upon from the
-- default PUBLIC USAGE on `public`: step 4 grants `USAGE ON SCHEMA public`
-- to `ponte_routing_lock` (as the bootstrap superuser, alongside the
-- ownership transfer), so the function bodies' `public.` references resolve
-- even on a database where PUBLIC USAGE has been revoked. Only USAGE is
-- granted — never CREATE.
--
-- Sequence (order is load-bearing):
--
--   1. Create both functions as `ponte_owner`. `ponte_owner` owns them,
--      which is what makes step 2 possible.
--   2. Revoke PUBLIC EXECUTE *while `ponte_owner` still owns the functions*.
--      ACL changes require object ownership; after the transfer in step 4
--      `ponte_owner` could no longer revoke (42501) without SET ROLE.
--   3. Grant the minimum column-level SELECT and UPDATE privileges to
--      `ponte_routing_lock`. SELECT covers the columns the functions read;
--      UPDATE on exactly one column per table is what satisfies
--      PostgreSQL's row-lock privilege check (FOR UPDATE requires UPDATE).
--      The functions never issue UPDATE; the grant exists only to make the
--      lock legal, and it is column-scoped so the write surface stays
--      minimal.
--   4. Grant `ponte_routing_lock` explicit `USAGE ON SCHEMA public` and
--      transfer ownership to it. Both run as the bootstrap superuser
--      (`SET LOCAL ROLE NONE`): as `ponte_owner` the ALTER fails with
--      42501 `permission denied for schema public` (the ALTER OWNER
--      privilege check does not observe schema grants, and the superuser
--      performs the transfer instead). The USAGE grant is permanent and
--      direct — it does not depend on the default PUBLIC USAGE; CREATE is
--      never granted. The superuser runs in the same transaction, so the
--      ledger INSERT after this file still executes as `ponte_owner` once
--      the role context is restored.
--
-- Atomicity: the runner applies this file inside its single migration
-- transaction; any failure rolls back the whole file, so a half-applied
-- migration can never be recorded. The `SET LOCAL` role changes in this
-- file are transaction-scoped and never leak past the transaction.

-- (1) The membership lock. Locks the active membership row for the business
-- and user, returning the role. NULL means no active membership; the caller
-- treats NULL and 'viewer' as denial.
CREATE FUNCTION ponte_lock_routing_membership(
    p_business_id uuid,
    p_user_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  locked_role text;
BEGIN
  SELECT role INTO locked_role
    FROM public.memberships
   WHERE business_id = p_business_id
     AND user_id = p_user_id
     AND status = 'active'
  FOR UPDATE;
  RETURN locked_role;
END $fn$;

-- (1) The quote lock. Locks the exact quote row and returns its persisted
-- fields. The row is locked by identity FIRST, and the expiry predicate is
-- evaluated only AFTER the lock is acquired (a post-lock expiry check). This
-- ordering is load-bearing: a caller that begins waiting for the lock before
-- the quote expires must, on resumption, re-evaluate expiry against the
-- locked row and reject an expired quote — returning zero rows — rather than
-- returning the stale row it scanned before the wait. A missing quote also
-- returns zero rows. In every case the caller fails closed with
-- INVOICE_OR_QUOTE_UNAVAILABLE instead of locking or returning a stale row.
CREATE FUNCTION ponte_lock_routing_quote(
    p_business_id uuid,
    p_invoice_id uuid,
    p_quote_id uuid
) RETURNS TABLE (
    id uuid,
    business_id uuid,
    invoice_id uuid,
    source text,
    simulated boolean,
    data jsonb,
    expires_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  rec record;
BEGIN
  -- Lock the row by identity. The FOR UPDATE lock is acquired here, before
  -- any expiry check, so a concurrent caller blocks on this statement while
  -- the lock is held. A missing quote leaves `rec` all-NULL.
  SELECT q.id, q.business_id, q.invoice_id, q.source, q.simulated, q.data, q.expires_at
    INTO rec
    FROM public.quotes q
   WHERE q.business_id = p_business_id
     AND q.invoice_id = p_invoice_id
     AND q.id = p_quote_id
  FOR UPDATE;

  -- Post-lock expiry check: evaluated AFTER the row lock is acquired. A
  -- quote that expired while this caller waited for the lock is rejected
  -- here — the lock was taken, but no row is returned and the caller fails
  -- closed. `clock_timestamp()` is evaluated at this point, not at scan
  -- time, which is what makes the concurrent wait-then-expire case correct.
  IF rec.id IS NOT NULL AND rec.expires_at > clock_timestamp() THEN
    RETURN QUERY
      SELECT rec.id, rec.business_id, rec.invoice_id, rec.source, rec.simulated, rec.data, rec.expires_at;
  END IF;
END $fn$;

-- (2) Remove the default PUBLIC EXECUTE while `ponte_owner` still owns both
-- functions. Defence in depth: PUBLIC would otherwise hold EXECUTE on every
-- newly created function, and the SECURITY DEFINER surface must not be
-- callable by arbitrary roles.
REVOKE EXECUTE ON FUNCTION ponte_lock_routing_membership(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ponte_lock_routing_quote(uuid, uuid, uuid) FROM PUBLIC;

-- (3) Minimum column-level privileges for the function owner.
--     `memberships`: read the columns the lock predicate and result need;
--     UPDATE (status) is the single column whose mutation would invalidate
--     the lock's meaning, and it is what satisfies the FOR UPDATE check.
--     `quotes`: read the persisted fields the lock returns; UPDATE
--     (expires_at) is the expiry column, same rationale.
GRANT SELECT (business_id, user_id, role, status) ON memberships TO ponte_routing_lock;
GRANT UPDATE (status) ON memberships TO ponte_routing_lock;
GRANT SELECT (id, business_id, invoice_id, source, simulated, data, expires_at) ON quotes TO ponte_routing_lock;
GRANT UPDATE (expires_at) ON quotes TO ponte_routing_lock;

-- (4) Ownership transfer and explicit schema USAGE. The bootstrap superuser
-- performs both statements (`SET LOCAL ROLE NONE`): as `ponte_owner` the
-- ALTER fails with 42501 `permission denied for schema public` (the ALTER
-- OWNER privilege check does not observe schema grants, and `ponte_owner`
-- holds no grant option to grant CREATE to the target anyway). The explicit
-- `GRANT USAGE ON SCHEMA public` gives the lock owner a permanent, direct
-- schema reachability that does not depend on the default PUBLIC USAGE —
-- CREATE is deliberately NOT granted. The superuser runs in the same
-- transaction, so the ledger INSERT after this file still executes as
-- `ponte_owner` once the role context is restored.
SET LOCAL ROLE NONE;

GRANT USAGE ON SCHEMA public TO ponte_routing_lock;

ALTER FUNCTION ponte_lock_routing_membership(uuid, uuid) OWNER TO ponte_routing_lock;
ALTER FUNCTION ponte_lock_routing_quote(uuid, uuid, uuid) OWNER TO ponte_routing_lock;

-- Restore the runner's execution context so subsequent statements in this
-- transaction (the migration-ledger INSERT) run as `ponte_owner`.
SET LOCAL ROLE ponte_owner;
```

**Catalogue verification of the migration** is asserted by
`tests-backend/routing-lock-provisioning.test.ts` → `"migration 008 applies
through the real runner and leaves the approved catalogue"`: owner,
SECURITY DEFINER flag, pinned `search_path`, PUBLIC EXECUTE revoked, and the
column-level grants are checked field by field against the catalogue.

---

## 2. Phase 1 — role creation, reconciliation and membership

`src/server/database-provisioning.ts` — `provisionDatabasePhase1()`.

**New constants:**

```ts
export const ROUTING_LOCK_ROLE = "ponte_routing_lock";

export const ROUTING_LOCK_MEMBERSHIP_ARGS = "p_business_id uuid, p_user_id uuid";
export const ROUTING_LOCK_QUOTE_ARGS =
  "p_business_id uuid, p_invoice_id uuid, p_quote_id uuid";
export const ROUTING_LOCK_MEMBERSHIP_RESULT = "text";
export const ROUTING_LOCK_QUOTE_RESULT =
  "TABLE(id uuid, business_id uuid, invoice_id uuid, source text, simulated boolean, data jsonb, expires_at timestamp with time zone)";
export const ROUTING_LOCK_SEARCH_PATH = "search_path=pg_catalog, public, pg_temp";

export const ROUTING_LOCK_FUNCTIONS = [
  { name: "ponte_lock_routing_membership", args: ROUTING_LOCK_MEMBERSHIP_ARGS, result: ROUTING_LOCK_MEMBERSHIP_RESULT },
  { name: "ponte_lock_routing_quote", args: ROUTING_LOCK_QUOTE_ARGS, result: ROUTING_LOCK_QUOTE_RESULT },
] as const;
```

**Role creation (step 3b):** the lock-owner role is created `NOLOGIN` with
`ROLE_HARDENING_ATTRIBUTES` (no superuser, CREATEDB, CREATEROLE, REPLICATION,
BYPASSRLS), identical to every other managed role.

**Reconciliation (step 3c):** unlike the other managed roles — whose
attribute drift is repaired in place — an existing `ponte_routing_lock` is
never silently altered, dropped, or recreated. A `DO` block raises an
explicit exception when the role exists with any of:

- `rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls` → `"ponte_routing_lock exists with dangerous attributes (LOGIN/superuser/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS); reconcile the role manually"`;
- any member other than `ponte_owner` → `"ponte_routing_lock has unexpected members; reconcile the role manually"`;
- any parent membership → `"ponte_routing_lock must be a leaf role with no parent memberships; reconcile the role manually"`.

The expected `ponte_owner` membership is deliberately **not** checked in
reconciliation: its options are re-stated by the grant below, which corrects
drift without failing.

**Session-role defence in depth (step 3d):** `ALTER ROLE ponte_routing_lock RESET ROLE`.

**Membership (step, alongside the existing `membership:migrator`):**

```sql
GRANT ponte_routing_lock TO ponte_owner WITH INHERIT FALSE, SET TRUE;
```

`INHERIT FALSE` keeps the owner's privileges out of the lock role. This
membership is an explicitly accepted role relationship under the
trusted-migrator decision, retained as part of the approved provisioning
contract — it is NOT what makes migration 008's ownership transfer possible:
that transfer runs as the bootstrap superuser (`SET LOCAL ROLE NONE`),
because `ponte_owner` cannot perform the `ALTER FUNCTION ... OWNER TO`
itself. `admin_option=false` is intentional (a plain `GRANT` defaults to
false and no administrative membership is needed). The report and
`scripts/provision-roles.ts` now read and display all three options
(`INHERIT`, `SET`, `ADMIN`).

**ProvisioningReport additions** read back from the catalogue:
`routingLock` (role attributes), `routingLockMemberships` (both directions
from `pg_auth_members`), and `lockFunctions` (signature + security
properties).

---

## 3. Phase 2 — function grants and catalogue verification

`src/server/database-provisioning.ts` — `provisionDatabasePhase2()`.

**Step (11) — restore the allowlisted EXECUTE.** Phase 2's drift revocations
remove every function privilege from the application, including any grant on
the lock functions, so the approved call surface is re-applied afterwards —
exactly these two functions, to the `ponte_app` group only:

```sql
GRANT EXECUTE ON FUNCTION ponte.ponte_lock_routing_membership(p_business_id uuid, p_user_id uuid) TO <ponte_app>;
GRANT EXECUTE ON FUNCTION ponte.ponte_lock_routing_quote(p_business_id uuid, p_invoice_id uuid, p_quote_id uuid) TO <ponte_app>;
```

**Step (12) — exact-signature and security-property verification.** A `DO`
block reads both functions from `pg_proc` and fails explicitly on any of:
wrong identity arguments, wrong return type, wrong owner (must be
`ponte_routing_lock`), missing `SECURITY DEFINER`, an `proconfig` that is
not EXACTLY the approved security configuration (`proconfig =
ARRAY['search_path=pg_catalog, public, pg_temp']` — equality, not mere
containment), PUBLIC still holding EXECUTE, or `ponte_app` missing EXECUTE —
plus exactly two lock functions found, the membership graph in both
directions with the member options asserted EXACTLY (`ponte_owner` as the
only member, INHERIT FALSE, SET TRUE, ADMIN FALSE, no parents), and the
lock owner's effective schema privileges (`USAGE` required, `CREATE`
forbidden via `has_schema_privilege`).

**`verifyExpectedObjects()`** now matches the two lock functions by exact
signature (identity arguments + return type), not by name: a function with
the right name but the wrong signature is reported as missing, giving the
explicit early failure the two-phase design promises.

**Coverage tests:** `tests-backend/routing-lock-provisioning.test.ts` →
`"Phase 2 grants app EXECUTE and verifies the exact lock-function signature
and security properties"` and `"the application identity can EXECUTE the lock
functions but holds no direct table privileges"` (the app login can call the
functions but still cannot `SELECT ... FOR UPDATE` / `UPDATE` either locked
table directly).

---

## 4. Application changes — `src/server/repository.ts` and `src/server/evidence/persist-candidate.ts`

### `repository.ts` — `lockValidQuoteForEvidence()`

```diff
-  return db.query<LockedEvidenceQuoteRow>(
-    "SELECT id,business_id,invoice_id,source,simulated,expires_at,data FROM quotes WHERE business_id=$1 AND invoice_id=$2 AND id=$3 AND expires_at>clock_timestamp() FOR UPDATE",
-    [businessId, invoiceId, quoteId],
-  );
+  return db.query<LockedEvidenceQuoteRow>(
+    "SELECT id,business_id,invoice_id,source,simulated,expires_at,data FROM public.ponte_lock_routing_quote($1,$2,$3)",
+    [businessId, invoiceId, quoteId],
+  );
```

The row lock moved into the SECURITY DEFINER function; the helper, its
signature and its return shape are unchanged. The function's expiry
semantics: a missing quote locks nothing and returns zero rows; a valid
quote is locked and then returned; an expired quote is locked first,
rejected by the post-lock expiry check, and returns zero rows.

### `persist-candidate.ts` — `assertActiveMutationMembership()`

```diff
-  const membership = await db.query<{ role: string }>(
-    "SELECT role FROM memberships WHERE business_id=$1 AND user_id=$2 AND status='active' FOR UPDATE",
-    [context.businessId, context.actorUserId],
-  );
-  if (!membership.rowCount || membership.rows[0].role === "viewer")
-    fail("FORBIDDEN");
+  const membership = await db.query<{ role: string | null }>(
+    "SELECT public.ponte_lock_routing_membership($1,$2) AS role",
+    [context.businessId, context.actorUserId],
+  );
+  const role = membership.rows[0]?.role ?? null;
+  if (role === null || role === "viewer") fail("FORBIDDEN");
```

Semantics are unchanged: no active membership (NULL) or a `viewer` role →
`FORBIDDEN`. The row lock is now taken inside the function.

### `persist-candidate.ts` — post-lock quote-expiry re-assertion

```ts
  if (quote.expires_at.getTime() <= Date.now())
    fail("INVOICE_OR_QUOTE_UNAVAILABLE");
```

The function locks the quote row first and evaluates expiry only after the
lock is acquired (missing quote: nothing locked, zero rows; valid quote:
locked then returned; expired quote: locked first, rejected by the
post-lock check, zero rows). The function's own post-lock check is
authoritative (database time); this call-site assertion re-asserts the
invariant against the locked row's own timestamp and fails closed in the
other direction too (both checks fail closed, so clock skew between app and
database cannot produce a stale lock).

### `persist-candidate.ts` — error handling

```ts
    // An invalid UUID that reaches a lock function raises 22P02
    // (invalid_text_representation). That is a request-context defect, not an
    // internal persistence failure: map it explicitly instead of folding it
    // into PERSISTENCE_FAILED.
    if ((error as { code?: string }).code === "22P02")
      return fail("INVALID_CONTEXT");
```

All failures flow through the same `fail()` helper (throws
`EvidencePersistenceError`); no raw database error text is exposed.

---

## 5. Membership-before-fingerprint replay implementation

`src/server/evidence/persist-candidate.ts` — `persistPreparedEvidenceCandidate()`,
the existing-idempotency-key branch:

```ts
      if (existing.rowCount) {
        // Phase 2C.3: membership is re-authorized against the locked row
        // BEFORE the fingerprint is compared. A replay discloses a durable
        // response only to an actor whose membership is active at this
        // moment: a revoked or viewer membership fails with FORBIDDEN even
        // when the fingerprint matches, and before a mismatch can be
        // reported as a conflict.
        await assertActiveMutationMembership(db, context);
        if (existing.rows[0].fingerprint !== context.requestFingerprint)
          fail("IDEMPOTENCY_CONFLICT");
        return { kind: "replay", response: existing.rows[0].response };
      }
```

The membership check was moved **ahead of** the fingerprint comparison (it
previously ran after it). Authorization is therefore re-checked against the
row locked by `ponte_lock_routing_membership` on every replay path, before
any fingerprint comparison or disclosure can happen.

---

## 6. Complete new concurrency test

`tests-backend/routing-lock-provisioning.test.ts` → **"a quote that expires
while a concurrent session blocks on the lock yields zero rows on resumption"**
(the file's 9th and final test; all 9 tests pass). Full test body:

```ts
  test("a quote that expires while a concurrent session blocks on the lock yields zero rows on resumption", async () => {
    const businessId = randomUUID();
    const invoiceId = randomUUID();
    const quoteId = randomUUID();

    await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
      businessId,
      "lock expiry tenant",
    ]);
    await fixtures(
      "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data) VALUES($1,$2,$3,1000,'Funded',$4)",
      [invoiceId, businessId, `QE-${invoiceId}`, invoiceData(invoiceId, `QE-${invoiceId}`, "Funded")],
    );
    // The quote expires on its own three seconds in. Expiring it by UPDATE
    // is impossible while session A holds the row lock (the UPDATE would
    // block on the same lock), so the natural deadline is the deterministic
    // way to make the row expire while it is still locked.
    await fixtures(
      "INSERT INTO quotes(id,business_id,invoice_id,source,simulated,data,expires_at) VALUES($1,$2,$3,'simulation-fixed-525',true,$4,date_trunc('milliseconds',now())+interval '3 seconds')",
      [quoteId, businessId, invoiceId, JSON.stringify({})],
    );

    // Both client lifecycles are managed unconditionally: both clients are
    // acquired INSIDE the protected try/finally, Transaction A is rolled
    // back if an assertion fails before its commit, and both clients are
    // destroyed (never returned to the pool) even on failure. If the
    // rollback itself fails, A's backend is terminated so the server
    // releases the row lock; B's backend is terminated as a fallback to
    // cancel its blocked query, and every wait on B is bounded so the
    // cleanup can never hang the suite indefinitely.
    let sessionA: PoolClient | undefined;
    let sessionB: PoolClient | undefined;
    let backendA: number | undefined;
    let backendB: number | undefined;
    let committedA = false;
    let txnOpen = false;
    let settledB = false;
    let lockB: Promise<unknown> | undefined;
    try {
      sessionA = await app!.connect();
      // A's backend PID is tracked as soon as the connection is
      // established, so the cleanup path can terminate A itself if the
      // rollback fails — terminating A releases the row lock at the
      // server, which is the lock B is waiting on.
      backendA = (
        await sessionA.query("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid;
      sessionB = await app!.connect();
      backendB = (
        await sessionB.query("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid;

      // Locals for the body: the outer variables stay optional because the
      // cleanup path must tolerate them being untracked.
      const backendAId = backendA;
      const backendBId = backendB;
      assert.ok(backendAId, "session A backend PID must be tracked");
      assert.ok(backendBId, "session B backend PID must be tracked");

      // (1) Transaction A acquires the row lock on a valid quote and holds it.
      await sessionA.query("BEGIN");
      txnOpen = true;
      const lockedA = await sessionA.query(
        `SELECT * FROM ${PONTE_SCHEMA}.ponte_lock_routing_quote($1,$2,$3)`,
        [businessId, invoiceId, quoteId],
      );
      assert.equal(lockedA.rowCount, 1, "session A must lock the valid quote");

      // (2) Transaction B calls the actual quote-lock function BEFORE expiry.
      // It blocks on A's row lock. The block is proven at the PostgreSQL level,
      // not only by a JavaScript promise remaining unsettled: `pg_locks` and
      // `pg_stat_activity` are queried to show B holds an ungranted lock
      // request while A holds the granted lock, and B's wait_event_type is
      // "Lock" — the server itself is reporting B is waiting on a lock.
      // (Both backend PIDs were tracked when the connections were
      // established above.)
      lockB = sessionB
        .query(
          `SELECT * FROM ${PONTE_SCHEMA}.ponte_lock_routing_quote($1,$2,$3)`,
          [businessId, invoiceId, quoteId],
        )
        .then((result) => {
          settledB = true;
          return result;
        });

      // Bounded polling for the actual lock-wait state — not a fixed delay.
      // The loop waits until the database itself reports B blocked on A's
      // backend (pg_blocking_pids includes A's PID) while B's promise is
      // still unsettled, bounded at 4 s.
      let blocked = false;
      let lastBlockers: number[] = [];
      const pollDeadline = Date.now() + 4000;
      while (Date.now() < pollDeadline) {
        const blockerProbe = await superuser(
          bootstrap,
          `SELECT unnest(pg_blocking_pids($1)) AS pid`,
          [backendBId],
        );
        lastBlockers = (blockerProbe.rows as { pid: number }[])
          .map((row) => Number(row.pid));
        if (!settledB && lastBlockers.includes(backendAId)) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(
        blocked,
        `session B must be waiting on session A's row lock (pg_blocking_pids must include A's backend PID ${backendAId}); last probe: ${JSON.stringify(lastBlockers)}`,
      );

      // Prove B is genuinely waiting on a PostgreSQL lock held by A. The
      // `pg_locks` view shows B's ungranted lock request (the lock B is
      // waiting for), and `pg_stat_activity` reports B's wait_event_type as
      // "Lock". A holds the same lock type as granted, confirming the two
      // backends are contending for the same lock.
      const bLocks = await superuser(
        bootstrap,
        `SELECT granted, locktype
           FROM pg_locks
          WHERE pid = $1
          ORDER BY granted`,
        [backendBId],
      );
      const bLockRows = bLocks.rows as { granted: boolean; locktype: string }[];
      assert.ok(
        bLockRows.some((row) => row.granted === false),
        `session B must hold an ungranted (waiting) lock request; got ${JSON.stringify(bLockRows)}`,
      );

      const bActivity = await superuser(
        bootstrap,
        `SELECT wait_event_type, wait_event, state
           FROM pg_stat_activity
          WHERE pid = $1`,
        [backendBId],
      );
      const bActRow = bActivity.rows[0] as {
        wait_event_type: string | null;
        wait_event: string | null;
        state: string;
      };
      assert.equal(
        bActRow.wait_event_type,
        "Lock",
        `session B's wait_event_type must be "Lock" (waiting on a PostgreSQL lock), got ${bActRow.wait_event_type}`,
      );
      assert.equal(
        bActRow.state,
        "active",
        "session B must be in active state while waiting for the lock",
      );

      // A holds the granted lock that B is waiting on.
      const aLocks = await superuser(
        bootstrap,
        `SELECT granted, locktype
           FROM pg_locks
          WHERE pid = $1
          ORDER BY granted`,
        [backendAId],
      );
      const aLockRows = aLocks.rows as { granted: boolean; locktype: string }[];
      const waitingType = bLockRows.find((row) => row.granted === false)!.locktype;
      assert.ok(
        aLockRows.some(
          (row) => row.granted === true && row.locktype === waitingType,
        ),
        `session A must hold the granted ${waitingType} lock that B is waiting on; got ${JSON.stringify(aLockRows)}`,
      );

      assert.equal(
        settledB,
        false,
        "session B must still be blocked on session A's row lock before expiry",
      );

      // (3) The quote expires naturally while B is still waiting. Wait for
      // the natural deadline with bounded polling (no fixed sleep), then
      // Transaction A commits without modifying the quote, releasing the lock.
      let expired = false;
      const expiryDeadline = Date.now() + 6000;
      while (Date.now() < expiryDeadline) {
        const expiryProbe = await superuser(
          bootstrap,
          `SELECT expires_at <= clock_timestamp() AS expired
             FROM ${PONTE_SCHEMA}.quotes
            WHERE id = $1`,
          [quoteId],
        );
        if (expiryProbe.rows[0]?.expired) {
          expired = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(expired, "the quote must expire naturally while session B waits");
      await sessionA.query("COMMIT");
      committedA = true;

      // (4) Transaction B resumes. The post-lock expiry check (evaluated after
      // the lock is acquired, not at scan time) must reject the now-expired
      // quote: B returns zero rows, not the stale row it would have scanned
      // before the wait.
      const resultB = (await lockB) as { rowCount: number };
      assert.equal(
        settledB,
        true,
        "session B must resume after session A commits",
      );
      assert.equal(
        resultB.rowCount,
        0,
        "a quote that expired while B waited for the lock must yield zero rows on resumption",
      );
    } finally {
      // Unconditional cleanup. Transaction A is rolled back if the commit
      // never happened (an assertion failed mid-test). If the rollback itself
      // fails, A's backend is terminated so the server releases the row lock
      // that B is waiting on. B's backend is terminated as a fallback to
      // cancel its blocked query, and every wait on B is bounded so a
      // termination failure cannot hang the suite indefinitely. Both clients
      // are destroyed rather than released: after a failed rollback or a
      // terminated backend they may hold an aborted transaction or a dead
      // socket, and returning them to the pool would poison other tests.
      if (sessionA && !committedA && txnOpen) {
        try {
          await sessionA.query("ROLLBACK");
        } catch {
          if (backendA !== undefined) {
            await superuser(
              bootstrap,
              `SELECT pg_terminate_backend($1)`,
              [backendA],
            ).catch(() => {});
          }
        }
      }
      if (lockB) {
        if ((await settleWithTimeout(lockB, 5000)) === "timeout" && !settledB) {
          // A's termination may have failed and the row lock may still be
          // held: cancel B's blocked query as the fallback.
          if (backendB !== undefined) {
            await superuser(
              bootstrap,
              `SELECT pg_terminate_backend($1)`,
              [backendB],
            ).catch(() => {});
          }
          await settleWithTimeout(lockB, 5000);
        }
      }
      destroyClient(sessionB);
      destroyClient(sessionA);
    }
  });
```

`superuser(pool, sql, values)` is a local helper that checks a statement out
of the bootstrap superuser pool, runs it, and releases the client in a
`finally` block.

**Why this satisfies the acceptance criterion:** B is proven blocked by the
database itself (`pg_locks` ungranted lock request; `pg_stat_activity`
`wait_event_type = "Lock"`), A is proven to hold the granted lock of the same
type, and B's promise is still unsettled — then, after the quote expires
naturally and A commits without modifying it, B resumes and returns exactly
zero rows.

---

## 7. Hardened-schema regression test

`tests-backend/routing-lock-provisioning.test.ts` → **"a hardened schema
(PUBLIC USAGE revoked before provisioning) still provisions and both lock
functions execute through the app identity"** (the file's 6th test, in the
provisioning describe). In an isolated disposable database the default
`PUBLIC USAGE` on the schema is revoked *before* any provisioning step; the
full lifecycle (Phase 1 → migrations → seed → Phase 2) must then succeed, the
lock role must hold effective USAGE without CREATE, and both SECURITY
DEFINER functions must execute through the application identity. The
disposable database is dropped in a `finally` block on every path. The
privilege model itself is untouched — the test proves the explicit USAGE
grant, it does not relax anything to pass. Full test body:

```ts
  test(
    "a hardened schema (PUBLIC USAGE revoked before provisioning) still provisions and both lock functions execute through the app identity",
    {
      skip: !appUrl
        ? "DATABASE_URL (application identity) not configured"
        : false,
    },
    async () => {
      const { name, pool } = await freshDatabase("hardened");
      let appClient: Client | undefined;
      try {
        // HARDEN: remove the default PUBLIC USAGE on the schema BEFORE any
        // provisioning step. ponte_routing_lock is not the schema owner, so
        // its reachability now depends solely on the explicit USAGE grant
        // made by migration 008 — exactly the property under test. The
        // revocation must be in place before Phase 1, not applied as a
        // fix-up afterwards.
        await superuser(
          pool,
          `REVOKE USAGE ON SCHEMA ${PONTE_SCHEMA} FROM PUBLIC`,
        );
        const revoked = await superuser(
          pool,
          `SELECT has_schema_privilege('public', $1::regnamespace, 'USAGE') AS can`,
          [PONTE_SCHEMA],
        );
        assert.equal(
          (revoked.rows[0] as { can: boolean }).can,
          false,
          "the PUBLIC USAGE revocation must be effective before provisioning",
        );

        // Full provisioning lifecycle: Phase 1 → migrations → seed → Phase 2.
        const phase1 = await provisionDatabasePhase1(pool, {
          allowScratchSchemaCreates: true,
        });
        assert.equal(phase1.phase, "phase1");

        const applied = await applyMigrations(pool);
        assert.ok(
          applied.applied.includes("008_routing_lock_functions"),
          `migration 008 must run on the hardened schema; got ${applied.applied.join(", ")}`,
        );

        await seedLocalData(pool);

        const report = await provisionDatabasePhase2(pool, {
          allowScratchSchemaCreates: true,
        });
        assert.equal(report.phase, "phase2");

        // The lock role has effective USAGE but no CREATE on the schema.
        const privileges = await superuser(
          pool,
          `SELECT has_schema_privilege($1::regrole, $2, 'USAGE') AS usage,
                  has_schema_privilege($1::regrole, $2, 'CREATE') AS create`,
          [ROUTING_LOCK_ROLE, PONTE_SCHEMA],
        );
        const privRow = privileges.rows[0] as {
          usage: boolean;
          create: boolean;
        };
        assert.equal(
          privRow.usage,
          true,
          "ponte_routing_lock must have USAGE on the hardened schema",
        );
        assert.equal(
          privRow.create,
          false,
          "ponte_routing_lock must not have CREATE on the hardened schema",
        );

        // The Phase 2 report carries the same schema-privilege verification.
        assert.equal(
          report.routingLockSchema.usage,
          true,
          "the report must confirm USAGE on the hardened schema",
        );
        assert.equal(
          report.routingLockSchema.create,
          false,
          "the report must confirm the absence of CREATE on the hardened schema",
        );

        // Both SECURITY DEFINER functions execute through the application
        // identity — the identity that holds no direct table privileges.
        appClient = new Client({
          connectionString: appUrl!.replace(/\/[^/]*$/, `/${name}`),
        });
        await appClient.connect();

        const membership = await appClient.query<{ role: string | null }>(
          `SELECT ${PONTE_SCHEMA}.ponte_lock_routing_membership($1,$2) AS role`,
          [LOCAL_SEED_BUSINESS_ID, LOCAL_SEED_USER_ID],
        );
        assert.equal(membership.rows[0].role, "admin");

        // A quote row for the quote-lock function; the seed covers only the
        // membership case. The fixture rows are inserted by the superuser
        // because the app identity holds no direct table privileges.
        const invoiceId = randomUUID();
        const quoteId = randomUUID();
        await superuser(
          pool,
          `INSERT INTO invoices(id,business_id,reference,funding_minor,status,data) VALUES($1,$2,$3,1000,'Funded',$4)`,
          [
            invoiceId,
            LOCAL_SEED_BUSINESS_ID,
            `HQ-${invoiceId}`,
            invoiceData(invoiceId, `HQ-${invoiceId}`, "Funded"),
          ],
        );
        await superuser(
          pool,
          `INSERT INTO quotes(id,business_id,invoice_id,source,simulated,data,expires_at) VALUES($1,$2,$3,'simulation-fixed-525',true,$4,date_trunc('milliseconds',now())+interval '1 hour')`,
          [quoteId, LOCAL_SEED_BUSINESS_ID, invoiceId, JSON.stringify({})],
        );

        const quote = await appClient.query(
          `SELECT * FROM ${PONTE_SCHEMA}.ponte_lock_routing_quote($1,$2,$3)`,
          [LOCAL_SEED_BUSINESS_ID, invoiceId, quoteId],
        );
        assert.equal(
          quote.rowCount,
          1,
          "the quote-lock function must return the quote through the app identity",
        );
      } finally {
        // Unconditional cleanup on every path, including failures: end the
        // app client, close the superuser pool, and drop the disposable
        // database (WITH (FORCE) terminates any lingering connection).
        await appClient?.end().catch(() => {});
        await pool.end().catch(() => {});
        await dropDatabase(name);
      }
    },
  );
```

The cleanup guarantees of the concurrency test (§6) are equally enforced
here: the app client and the superuser pool are ended and the disposable
database is dropped unconditionally, including on failure.

---

## 8. Exact disabled-member / mismatched-fingerprint regression test

`tests-backend/evidence-persistence-r1-contract.test.ts` → **"revoked or
viewer memberships cannot persist or disclose a durable replay"**. Full
body (the middle case is the one required by the acceptance criteria):

```ts
test("revoked or viewer memberships cannot persist or disclose a durable replay", async () => {
  // Phase 2C.3 semantics: authorization is re-checked against the membership
  // row locked by `ponte_lock_routing_membership` on EVERY path. A revoked or
  // viewer membership fails with FORBIDDEN for both a new persistence and a
  // durable replay — including when the replay fingerprint matches, which
  // proves membership is checked before the fingerprint is compared.
  const context = await createContext();
  const idempotencyKey = `revoked-replay-${randomUUID()}`;
  const fingerprint = requestFingerprint();
  const { candidate } = await prepare(context, fingerprint);

  // The admin persists successfully first, creating the durable record.
  const first = await persistPreparedEvidenceCandidate(
    persistenceInput(context, candidate, idempotencyKey, fingerprint),
  );
  assert.equal(first.kind, "persisted");

  // A member whose membership is disabled replays the same key and
  // fingerprint: FORBIDDEN, not a durable disclosure.
  const revokedActor = await createSecondMutationActor(context);
  await fixtures(
    "UPDATE memberships SET status='disabled' WHERE business_id=$1 AND user_id=$2",
    [context.businessId, revokedActor],
  );
  await assert.rejects(
    persistPreparedEvidenceCandidate(
      persistenceInput(
        { ...context, actorUserId: revokedActor },
        undefined,
        idempotencyKey,
        fingerprint,
      ),
    ),
    isPersistenceError("FORBIDDEN"),
  );

  // A disabled member retrying the same key with a MISMATCHED fingerprint is
  // still FORBIDDEN, never IDEMPOTENCY_CONFLICT: the membership check runs
  // before the fingerprint comparison, so the disabled status short-circuits
  // the replay before the conflict is ever evaluated.
  await assert.rejects(
    persistPreparedEvidenceCandidate(
      persistenceInput(
        { ...context, actorUserId: revokedActor },
        undefined,
        idempotencyKey,
        requestFingerprint("ef"),
      ),
    ),
    isPersistenceError("FORBIDDEN"),
  );

  // A viewer member replaying with a CONFLICTING fingerprint is also FORBIDDEN,
  // not IDEMPOTENCY_CONFLICT: authorization precedes fingerprint comparison.
  const viewerActor = await createSecondMutationActor(context);
  await fixtures(
    "UPDATE memberships SET role='viewer' WHERE business_id=$1 AND user_id=$2",
    [context.businessId, viewerActor],
  );
  await assert.rejects(
    persistPreparedEvidenceCandidate(
      persistenceInput(
        { ...context, actorUserId: viewerActor },
        undefined,
        idempotencyKey,
        requestFingerprint("ef"),
      ),
    ),
    isPersistenceError("FORBIDDEN"),
  );

  assert.deepEqual(await counts(context), FULL_PERSISTED_COUNTS);
});
```

Executed through `persistPreparedEvidenceCandidate()` itself. Authorized
replay and authorized fingerprint conflict remain covered by
`"same-key races serialize into one persistence and an authorized
candidate-free replay"` in the same file, and the two `IDEMPOTENCY_CONFLICT`
tests in `routing-orchestration-r1-contract.test.ts` and
`normal-routing-evidence-r1-contract.test.ts`.

---

## 9. Summary of the three rewritten R1 contract test files

All three files were rewritten in Phase 2C.3 from R1 **fail-closed**
contracts (asserting the 42501/`PERSISTENCE_FAILED` dormancy of Phase
2C.2B) back to their **original successful-persistence** semantics, now
against the SECURITY DEFINER lock functions. **Every test name is
preserved — no scenario was dropped or renamed.**

### `tests-backend/evidence-persistence-r1-contract.test.ts` (10 tests, all retained)

| Test | Original (pre-R1) behaviour retained |
|---|---|
| persists one frozen simulated evidence candidate, pending outbox, Routing invoice, event, and response | Full persistence of one candidate with outbox, invoice, event and response. |
| same-key races serialize into one persistence and an authorized candidate-free replay | Authorized replay returns the durable response without a second write. |
| different idempotency keys and actors racing the same invoice leave one routed persistence and no loser writes | Cross-key races produce one persistence, no loser writes. |
| final locked rows reject persisted invoice, quote, economics, and route drift before any write | Drift on the locked rows fails the transaction before any write. |
| PostgreSQL-time quote expiry rejects the candidate before any write | DB-time expiry (expired quote) fails the write. |
| revoked or viewer memberships cannot persist or disclose a durable replay | Disabled/viewer members get `FORBIDDEN` on replay — now including disabled + mismatched fingerprint. |
| final membership authorization locks the active membership row | Membership row lock under the final path. |
| every post-write failure boundary rolls back all final-persistence effects | Post-write failure rollback. |
| candidate mutation is rejected without exposing candidate bytes or leaving a write | Tampered candidates are rejected with no disclosure/write. |
| lost COMMIT acknowledgement destroys certainty and only same-key replay recovers the durable result | COMMIT-uncertainty recovery via same-key replay. |

The file now builds real encrypted candidates again (`SyntheticDekProvider`
implementing the production `DekProvider` interface, `prepareEvidenceCandidate`,
`readEvidencePreparationSnapshot`, `quote`) rather than the R1 candidate-free
context.

### `tests-backend/normal-routing-evidence-r1-contract.test.ts` (4 tests, all retained)

| Test | Original behaviour retained |
|---|---|
| normal Routing endpoint atomically persists simulated settlement, encrypted evidence, pending outbox, event, and replay | End-to-end successful persistence through the normal Routing endpoint. |
| final locked-row validation failure rolls back all normal Routing writes | Locked-row validation failure rolls back every write. |
| concurrent identical normal Routing requests commit one operation and return a durable replay | Concurrent identical requests serialize to one commit + replay. |
| normal Routing rejects a same-key conflicting payload without a second write | Same-key conflicting fingerprint → `IDEMPOTENCY_CONFLICT`, no second write (authorized actor). |

### `tests-backend/routing-orchestration-r1-contract.test.ts` (8 tests, all retained)

| Test | Original behaviour retained |
|---|---|
| matching preflight uses candidate-free final replay and reuses no provider | Preflight match replays the final durable result without provider reuse. |
| matching preflight still reauthorizes membership in the final helper | Membership re-authorization on the final path. |
| a matching normal Routing commit between preflight miss and snapshot replays authoritatively | Interleaved commit becomes the authoritative replay. |
| a stale snapshot without a concurrent idempotency row preserves invalid transition semantics | Stale snapshot → invalid transition semantics. |
| initial snapshot failures preserve invoice, transition, and quote API semantics | Snapshot-failure API semantics preserved. |
| controlled preparation starts after read-only work, without final locks, then persists once | Preparation ordering and single final persistence. |
| a matching record committed during preparation becomes final authoritative replay | Commit-during-preparation replay. |
| provider failure prevents final persistence and stale final state rolls back | Provider failure rolls back stale final state (same-key conflicting fingerprint → `IDEMPOTENCY_CONFLICT` in the authorized case). |

Related re-pointing (same Phase 2C.3 scope): `foundation.test.ts` and
`evidence-foundation.test.ts` — the quote-lock test now asserts the lock
succeeds through the function (`rowCount === 1`, correct row returned) and a
missing/foreign quote lock returns zero rows instead of raising 42501;
`privilege-boundary.test.ts` — the L1/L2 boundaries re-pointed to the
function-based lock path (app identity holds EXECUTE but no direct table
UPDATE).

### Browser-test rewrite and messaging cleanup (PR #21 CI fix)

CI run `45988744382` failed in `npm test`: 20/23 browser tests passed, and
three timed out after 90 s waiting for a `POST
/api/v1/invoices/:id/transitions` response with `status >= 500`
(`tests/frontend.spec.ts` lines 11 and 302, `tests/localization.spec.ts`
line 9). Root cause confirmed by local reproduction against the CI-equivalent
environment: the three tests still asserted the superseded Phase 2C.2B
fail-closed behaviour, while under the CI test configuration the Routing
transition **succeeds** — the POST returns **200** with
`{data:{status:"Routing", selectedRoute}}` and `GET /evidence` returns
`200` with `state:"persisted"` (synthetic `local-test-only` provider). The
`waitForResponse(status >= 500)` predicate could therefore never resolve.

The three tests were rewritten to assert the intended Phase 2C.3 successful
flow: exact HTTP 200 plus the documented response body, the invoice reaching
Routing with its selected route, the evidence panel reflecting persisted
evidence with the local-test-provider disclosure, persisted state surviving a
reload, and settlement exercised on the newly routed invoice (the
admin-primed Routing fixture settlement is retained as pre-existing-state
coverage). The complete-5xx-response-list assertions now expect an empty
list, and the expected-500 console allowance was removed. The
provider-unavailable test (controlled 503 intercept → safe translated UI
message, invoice stays Funded) is retained unchanged. Stale R1 fail-closed
comments in `tests/setup-database.ts` and `tests/evidence-status.spec.ts`
were updated.

Final messaging cleanup (same round): the user-facing
`EVIDENCE_PERSISTENCE_FAILED` message in `src/components/invoice-detail.tsx`
was rewritten from the stale "evidence persistence is dormant and
fail-closed" wording to accurate wording that communicates the Routing
attempt failed because the evidence could not be persisted and the invoice
remains Funded (Portuguese translation updated; the provider-unavailable
message and its translations are unchanged), and the stale comment in
`src/server/evidence/persist-candidate.ts` claiming
`persistPreparedEvidenceCandidate()` is unreachable from normal
Routing/API flows was corrected: it is the final state authority for Routing
persistence, invoked by `orchestratePreparedRoutingCandidate()` (the normal
Routing/API flow used by the service entrypoint) and by the candidate-free
replay recheck.

**Result:** full browser suite **23/23 pass**; follow-up GitHub Actions run
**`45999591684` — conclusion: success**. No backend behaviour or database
privilege model was changed to silence the tests.

---

## 10. Diff statistics and final Git status

**Complete implementation diff against the starting commit
`f7a5bde0d109131e64596dab92879f024719a453` (23 files, 4799 insertions,
1378 deletions; the review patch file itself is excluded to avoid
recursive inclusion):**

```
 docs/PHASE2C2B_R1_ROUTING_LIMITATION.md            |   29 +-
 docs/PHASE2C3_ROUTING_LOCK.md                      |  148 +++
 docs/PHASE2C3_SOURCE_REVIEW_PACKAGE.md             | 1329 ++++++++++++++++++++
 migrations/008_routing_lock_functions.sql          |  200 +++
 scripts/provision-roles.ts                         |    2 +-
 scripts/test-migrations.ts                         |    1 +
 src/components/invoice-detail.tsx                  |   11 +-
 src/lib/i18n/pt-BR.ts                              |    4 +-
 src/server/database-provisioning.ts                |  480 ++++++-
 src/server/evidence/persist-candidate.ts           |   56 +-
 src/server/repository.ts                           |   17 +-
 tests-backend/evidence-foundation.test.ts          |   65 +-
 .../evidence-persistence-r1-contract.test.ts       | 1010 ++++++++-------
 tests-backend/foundation.test.ts                   |   72 +-
 .../normal-routing-evidence-r1-contract.test.ts    |  474 +++----
 tests-backend/privilege-boundary.test.ts           |   80 +-
 tests-backend/provisioning.test.ts                 |    4 +-
 tests-backend/routing-lock-provisioning.test.ts    | 1115 ++++++++++++++++
 .../routing-orchestration-r1-contract.test.ts      |  746 +++++------
 tests/evidence-status.spec.ts                      |    8 +-
 tests/frontend.spec.ts                             |  200 ++-
 tests/localization.spec.ts                         |  113 +-
 tests/setup-database.ts                            |   13 +-
 23 files changed, 4799 insertions(+), 1378 deletions(-)
```

**Final Git status (`git status --short --branch`):**

```
## phase2c3-routing-lock
```

Clean working tree: every Phase 2C.3 change (implementation, tests, this
package and the review patch) is committed on `phase2c3-routing-lock` and
pushed to `origin`. `git diff --check` is clean. The branch is open as PR
**#21** (`https://github.com/timmyspurs12/ponte/pull/21`) and is MERGEABLE;
GitHub Actions run `45999591684` passed. Nothing is merged or deployed.

---

## 11. Known risks and limitations

1. **PostgreSQL 16 runtime validation not performed.** No PG 16 server is
   available in the verification environment; every empirical result
   (migrations, provisioning, tests) was produced on PostgreSQL 18.6. The
   version guard covers 16+ syntax (`GRANT ... WITH INHERIT/SET`), but
   PG-16-specific behaviour is unverified.
2. **Browser validation: local fallback Chromium and CI standard Chromium
   both pass.** The local Arena sandbox cannot download the standard
   Playwright Chromium (CDN blocked), so local validation ran on an explicit
   Linux fallback Chromium (`PONTE_BROWSER_FALLBACK=1` →
   `PONTE_CHROMIUM_EXECUTABLE`) — **23/23 browser tests pass**. On GitHub
   Actions, standard Playwright Chromium was installed successfully and the
   full `npm test` suite completed on run `45999591684` (conclusion:
   success), providing independent standard-browser validation. Both
   validations agree; neither involves real payment or settlement
   infrastructure (the Routing path is synthetic throughout).
3. **Clock skew between application and database** affects the call-site
   post-lock expiry re-assertion (`Date.now()` in JS vs `clock_timestamp()`
   in the function). Both checks fail closed, so skew can only cause a
   conservative rejection, never a stale lock — but a strict deployment
   should keep the two clocks close.
4. **The Routing path remains a simulation** (synthetic envelopes, pinned
   quote source, no real Pix/USDG/on-chain settlement). Phase 2C.3 changes
   only who holds the row locks, not what the persistence path writes.
5. **`admin_option=false` on the routing-lock membership is intentional**
   and must not be "fixed" — no administrative membership is required for
   the ownership transfer (performed by the bootstrap superuser).
6. **Column-scoped `UPDATE` grants are load-bearing, not write surface.**
   `ponte_routing_lock` holds `UPDATE (status)` on `memberships` and
   `UPDATE (expires_at)` on `quotes` solely to satisfy PostgreSQL's
   FOR UPDATE privilege check; neither function ever issues an `UPDATE`.
   If the functions are ever modified to write, these grants must be
   revisited with the same scrutiny.
7. **Schema USAGE is granted explicitly, not via PUBLIC.** Migration 008
   grants `ponte_routing_lock` `USAGE ON SCHEMA public` directly (as the
   bootstrap superuser) so the function bodies resolve even where the
   default PUBLIC USAGE has been revoked; CREATE is never granted. Both
   effective privileges are asserted by the Phase 2 verification step and
   surfaced in the provisioning report (`routingLockSchema`), and the
   hardened-schema scenario (PUBLIC USAGE revoked before provisioning) is
   verified end-to-end.

---

## 12. Read-only self-review

### (a) Privilege escalation — no path found

- The only SECURITY DEFINER surface is the two functions, both `EXECUTE`
  granted solely to `ponte_app`; **PUBLIC EXECUTE is revoked** while the
  owner still holds the functions (ACL changes require ownership, hence the
  ordering in the migration), and Phase 2 verification fails if PUBLIC
  regains EXECUTE.
- The functions contain **no dynamic SQL**; callers pass only `uuid`
  arguments and cannot influence the SQL text. The bodies' table
  references are explicitly `public.`-qualified and the `search_path` is
  pinned (`pg_catalog, public, pg_temp`), so a caller's `search_path` or
  temp objects cannot redirect name resolution.
- `ponte_routing_lock` is **NOLOGIN**, hardened (no superuser-class
  attributes), a **leaf** (no parent memberships — enforced by Phase 1
  reconciliation and Phase 2 verification), and holds only column-scoped
  SELECT + one-column UPDATE per table plus explicit schema USAGE (no
  CREATE). Its privileges are reachable only through the two functions'
  fixed SQL; the effective schema privileges (USAGE true, CREATE false)
  are verified by the Phase 2 step and surfaced in the report.
- `ponte_owner`'s membership carries **INHERIT FALSE**, so the owner's
  privileges do not flow into the lock role; the lock role inherits nothing
  from anyone.
- Information disclosure is unchanged: the functions read exactly the
  columns the application could already read (`SELECT` on `memberships` and
  `quotes` was already granted to `ponte_app`), and the quote function is
  tenant-scoped (`business_id` + `invoice_id` + `id` all required).

### (b) Accidental weakening of authorization — none; ordering strengthened

- The membership check moved from **after** the fingerprint comparison to
  **before** it. This is a strict strengthening: a disabled/revoked member
  now receives `FORBIDDEN` before a conflicting fingerprint can be reported
  as `IDEMPOTENCY_CONFLICT` (previously the mismatch would have been
  surfaced first). Verified by the regression test's three sub-cases.
- `assertActiveMutationMembership` semantics are preserved exactly:
  no active membership (function returns NULL) or `viewer` → `FORBIDDEN`.
- The `status = 'active'` predicate remains inside the lock statement, so a
  disabled row is never locked or returned.
- No error path discloses database detail: all failures go through
  `fail()`/`EvidencePersistenceError` with application-level codes; the new
  `22P02 → INVALID_CONTEXT` mapping keeps request-context defects out of
  `PERSISTENCE_FAILED` without exposing internals.

### (c) Incorrect role reconciliation — none

- Reconciliation fails **explicitly** (never silently repairs) on:
  dangerous role attributes, unexpected members of `ponte_routing_lock`,
  and any parent membership of the lock role.
- The expected `ponte_owner` membership is intentionally not checked in
  reconciliation; the `GRANT ... WITH INHERIT FALSE, SET TRUE` statement
  re-states it on every run, correcting option drift without failing.
- Both directions are verified in Phase 2: exactly `ponte_owner` as member,
  no parents. The Phase 1 report reads both directions so a CI gate can
  assert the exact set.
- The reconciliation tests (`"existing-role reconciliation fails explicitly
  on dangerous attributes, unexpected members and parent memberships"`)
  prove each drift case fails and each drift is restored in `finally`.

### (d) Migration rollback problems — none found

- The entire file runs inside the migration runner's **single transaction**
  (`applyMigrations()`), so any failure rolls back every statement —
  functions, grants, and the ownership transfer together. The `SET LOCAL
  ROLE NONE` / `SET LOCAL ROLE ponte_owner`
  context switches are transaction-scoped and never leak.
- The ledger `INSERT` runs as `ponte_owner` after the role context is
  restored, so the ledger can never be recorded for a rolled-back file.
- `"a forced failure in migration 008 rolls back the whole batch"` proves
  the rollback: a pre-created conflicting function makes migration 008 fail
  mid-file (42723 — note relations and functions live in separate namespaces,
  so the blocker must be a function, not a table), and the test asserts no
  ledger entry and no partial function definitions remain. Rollback was
  also exercised end-to-end on a fresh disposable database.

### (e) Missing error handling — none found

- Both functions fail closed: missing quote → zero rows (all-NULL `rec`);
  expired quote → zero rows via the post-lock check. Callers map zero rows
  to `INVOICE_OR_QUOTE_UNAVAILABLE`.
- `lockValidQuoteForEvidence` callers check `rowCount !== 1` and fail.
- The `catch` block in `persistPreparedEvidenceCandidate` re-throws
  `EvidencePersistenceError` unchanged, maps `CommitOutcomeUnknownError`
  and `22P02`, and folds everything else into `PERSISTENCE_FAILED` —
  no raw error text escapes, and cleanup helpers (`clearBufferBestEffort`)
  never mask a transaction outcome.
- The concurrency test destroys both clients (never returns them to the
  pool) unconditionally after resume or failure, with a bounded wait on the
  blocked session so cleanup can never hang; the suite's `after()` closes
  pools and restores any cluster-wide drift.

### (f) Test coverage lost during the R1 contract rewrites — none

- **All 22 test names across the three rewritten files are preserved**
  (10 + 4 + 8), verified by comparing the `test(` headers at HEAD against
  the current files. The rewrites converted R1 fail-closed assertions back
  to the original successful-persistence assertions; every original case
  (persistence, races, drift rejection, expiry, membership, rollback,
  conflict, preflight/orchestration semantics) remains explicitly covered.
- The R1-era assertions that the rewrites replaced (42501 dormancy) are
  still covered where they remain true: `privilege-boundary.test.ts`
  asserts the app identity still cannot `SELECT ... FOR UPDATE` / `UPDATE`
  the locked tables **directly** — only the functions carry the locks.
- New coverage added beyond the originals: migration/rollback/catalogue
  tests, provisioning idempotency and reconciliation tests, the
  app-login privilege boundary, membership cases, the concurrency test
  (§6), and the strengthened replay-authorization case (§7).

### (g) Unintended changes outside Phase 2C.3 — none

- Every modified file is in the Phase 2C.3 scope: the migration,
  `database-provisioning.ts` (role/function provisioning),
  `repository.ts` + `persist-candidate.ts` (lock call sites and replay
  ordering), `scripts/test-migrations.ts` (expected-migration list),
  `scripts/provision-roles.ts` (report display of the new
  `admin_option`), the design/limitation docs, and the six test files
  (three R1-contract rewrites + three re-pointed suites).
- No production code outside the two lock call sites was touched; no
  route, handler, schema, or seed data changed; no dependency, config, or
  build-file changes. The `UPDATABLE_COLUMNS` map (which deliberately
  withholds `UPDATE` from `quotes`/`memberships`) is unchanged — the
  application's write surface is exactly what it was before Phase 2C.3.

---

## Verification status (final)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Pass (exit 0) |
| `npx eslint` (all changed files) | Pass (exit 0) |
| Full browser suite (`npm test`) | **23/23 pass** — locally on the sandbox fallback Chromium (`PONTE_BROWSER_FALLBACK=1`) and independently on GitHub Actions with standard Playwright Chromium (run `45999591684`); incl. the three rewritten Routing-persistence tests and the retained provider-unavailable test |
| Full backend suite (`scripts/run-backend-tests.mjs`) | **240 tests, 230 pass, 0 fail, 10 skipped** (exit 0) |
| `npm run test:migrations` | Pass (exit 0; run with `DATABASE_URL=$PONTE_BOOTSTRAP_DATABASE_URL` exactly as CI does — the app-login role holds only CONNECT after provisioning) |
| Production build (`npm run build`) | Pass — compiled successfully; TypeScript checks in the build pass |
| Fresh disposable DB: Phase 1 → migrate → seed → Phase 2 | All four steps exit 0 |
| Hardened-schema scenario (PUBLIC USAGE on `public` revoked before provisioning) | Full sequence exits 0; `ponte_routing_lock` USAGE=true / CREATE=false; both functions execute via the app identity; disposable DB dropped |
| Routing-lock suite (`routing-lock-provisioning.test.ts`) | 9/9 pass (incl. the hardened-schema regression test) |
| Concurrency-test failure-path cleanup (ad-hoc probe) | B blocked on A (`pg_blocking_pids`); A's backend terminated → rollback fails → cleanup terminates A → B settles in 2 ms; no hang |
| Shared `ponte` database | Untouched (7 baseline `schema_migrations` rows) |
| Playwright | **Pass** — 23/23 browser tests: local fallback Chromium (`PONTE_BROWSER_FALLBACK=1`) **and** standard Playwright Chromium installed and executed in GitHub Actions (run `45999591684`) |
| GitHub Actions (PR #21) | Run `45999591684` — **conclusion: success** (previously failing run `45988744382` superseded) |
| PostgreSQL 16 | Unavailable (no server) — PG 18.6 results only |

**Branch left unmerged and ready for maintainer review.**
