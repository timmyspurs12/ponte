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
-- `SET LOCAL ROLE ponte_owner`, so every statement below executes as
-- `ponte_owner` and the migration-ledger INSERT that follows also runs as
-- `ponte_owner`. The file deliberately issues no `SET ROLE` of its own, so
-- the runner's role is never lost and the ledger insert is trivially
-- restored to `ponte_owner`.
--
-- `ponte_owner` is a member of `ponte_routing_lock` WITH INHERIT FALSE,
-- SET TRUE (Phase 1 provisioning). The membership is what a *ponte_owner*
-- execution of the ownership transfer would need; this migration performs
-- the transfer as the bootstrap superuser instead (see step 4), so the
-- membership is not exercised by this file. INHERIT FALSE is irrelevant to
-- the transfer and does not grant any object privilege.
--
-- No schema-level CREATE is granted to `ponte_routing_lock` here, and none
-- is needed. `ponte_owner` holds USAGE+CREATE on schema `public` (Phase 1)
-- but WITHOUT grant option — verified empirically: a
-- `GRANT CREATE ON SCHEMA public` issued by `ponte_owner` is a silent no-op
-- (it neither errors nor changes the schema ACL), so such a grant could not
-- make the ownership transfer legal anyway. The transfer is performed by
-- the bootstrap superuser (step 4), which needs no target-side schema
-- privilege. `ponte_routing_lock` therefore never holds CREATE on `public`;
-- its schema reachability is the default PUBLIC USAGE on `public` (verified
-- effective), which is exactly what the function bodies' `public.`
-- references need.
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
--   4. Transfer ownership to `ponte_routing_lock`. This runs as the
--      bootstrap superuser (`SET LOCAL ROLE NONE`): as `ponte_owner` this
--      ALTER fails with 42501 `permission denied for schema public`
--      (the ALTER OWNER privilege check does not observe schema grants, and
--      the superuser performs the transfer instead). The superuser runs in
--      the same transaction, so the ledger INSERT after this file still
--      executes as `ponte_owner` once the role context is restored.
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

-- (4) Ownership transfer. The bootstrap superuser performs the transfer
-- (`SET LOCAL ROLE NONE`): as `ponte_owner` this ALTER fails with
-- 42501 `permission denied for schema public` (the ALTER OWNER privilege
-- check does not observe schema grants, and `ponte_owner` holds no grant
-- option to grant CREATE to the target anyway). The superuser runs in the
-- same transaction, so the ledger INSERT after this file still executes as
-- `ponte_owner` once the role context is restored.
SET LOCAL ROLE NONE;

ALTER FUNCTION ponte_lock_routing_membership(uuid, uuid) OWNER TO ponte_routing_lock;
ALTER FUNCTION ponte_lock_routing_quote(uuid, uuid, uuid) OWNER TO ponte_routing_lock;

-- Restore the runner's execution context so subsequent statements in this
-- transaction (the migration-ledger INSERT) run as `ponte_owner`.
SET LOCAL ROLE ponte_owner;
