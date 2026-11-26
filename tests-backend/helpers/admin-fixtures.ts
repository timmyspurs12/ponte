/**
 * Administrative fixture support.
 *
 * Everything the application identity is *not* allowed to do, in one place:
 *
 * - Destroy fixtures (`TRUNCATE`).
 * - Prime outbox state (`submitted`), which is otherwise unreachable.
 * - Read the private evidence metadata (`wrapped_dek`, `attempt_count`), which
 *   is B4's post-commit assertion and is denied to the application by privilege.
 * - Tamper with a constraint *as the owner*, so the constraint's own SQLSTATE
 *   is observable instead of being masked by `42501`.
 *
 * Nothing here is imported by the application runtime. The seeder keeps its own
 * application-identity path; only reset and assertion moved here.
 */

import type { Pool } from "pg";
import { adminRead, adminWrite, type AdminPool } from "./admin-database";

/**
 * Tables truncated between suites, in foreign-key-safe order.
 *
 * `businesses`, `users` and `memberships` are deliberately *not* truncated:
 * every suite authenticates as the seeded development administrator, so the
 * identity rows must survive. `external_identities` is optional because it only
 * exists after migration 006.
 */
export const FIXTURE_TABLES = [
  "idempotency",
  "payment_events",
  "evidence_outbox",
  "route_decision_evidence",
  "settlements",
  "quotes",
  "payments",
  "invoices",
  "rate_limits",
] as const;

export type FixtureResetResult = {
  truncated: string[];
  /** True when `external_identities` existed and was truncated too. */
  externalIdentities: boolean;
};

/**
 * Destroys every fixture row the suites create.
 *
 * Unconditional: a caller must be able to fail here rather than continue from a
 * partially cleaned database. `external_identities` carries an immutability
 * trigger that blocks `DELETE`; `TRUNCATE` does not fire row triggers, so it is
 * both faster and the only correct tool for that table.
 */
export function resetFixturesAdmin(
  pool: AdminPool | undefined,
): Promise<FixtureResetResult> {
  return adminWrite(pool, async ({ db }) => {
    const exists = await db.query<{ relation: string | null }>(
      "SELECT to_regclass('public.external_identities')::text AS relation",
    );
    const tables: string[] = [...FIXTURE_TABLES];
    const externalIdentities = Boolean(exists.rows[0]?.relation);
    if (externalIdentities) tables.push("external_identities");
    await db.query(`TRUNCATE ${tables.join(",")}`);
    return { truncated: tables, externalIdentities };
  });
}

/**
 * Priming `submission_state` is administrative work.
 *
 * The application holds `INSERT (id, evidence_record_id)` and no `UPDATE` at
 * all, so `'submitted'` is genuinely unreachable for it. A fixture that needs a
 * submitted row says so here, in an elevated transaction, rather than widening
 * the application grant.
 */
export function markOutboxSubmitted(
  pool: AdminPool | undefined,
  outboxId: string,
): Promise<{ rowCount: number }> {
  return adminWrite(pool, async ({ db }) => {
    const result = await db.query(
      "UPDATE evidence_outbox SET submission_state='submitted' WHERE id=$1 AND submission_state='pending'",
      [outboxId],
    );
    return { rowCount: result.rowCount ?? 0 };
  });
}

/** Reads the current submission state without exposing private columns. */
export function outboxSubmissionState(
  pool: AdminPool | undefined,
  outboxId: string,
): Promise<string | null> {
  return adminRead(pool, async ({ db }) => {
    const result = await db.query<{ submission_state: string }>(
      "SELECT submission_state FROM evidence_outbox WHERE id=$1",
      [outboxId],
    );
    return result.rows[0]?.submission_state ?? null;
  });
}

/**
 * The private metadata projection, asserted **after** the application
 * transaction has committed.
 *
 * Nine columns, six of which the application cannot read at all. That is what
 * makes Decision B structural rather than a convention: an application-side
 * read of this projection fails at parse time with `42501`.
 */
export type PrivateEvidenceMetadata = {
  publicEvidenceId: Buffer;
  wrappedDek: Buffer;
  kmsProvider: string;
  wrappedDekAlgorithm: string;
  wrappedDekFormat: string;
  kmsKeyReference: string;
  kmsKeyVersion: string;
  submissionState: string;
  attemptCount: number;
};

export function readPrivateEvidenceMetadata(
  pool: AdminPool | undefined,
  evidenceId: string,
): Promise<PrivateEvidenceMetadata | null> {
  return adminRead(pool, async ({ db }) => {
    const result = await db.query<{
      public_evidence_id: Buffer;
      wrapped_dek: Buffer;
      kms_provider: string;
      wrapped_dek_algorithm: string;
      wrapped_dek_format: string;
      kms_key_reference: string;
      kms_key_version: string;
      submission_state: string;
      attempt_count: number;
    }>(
      `SELECT e.public_evidence_id, e.wrapped_dek, e.kms_provider,
              e.wrapped_dek_algorithm, e.wrapped_dek_format,
              e.kms_key_reference, e.kms_key_version,
              o.submission_state, o.attempt_count
         FROM route_decision_evidence e
         JOIN evidence_outbox o ON o.evidence_record_id = e.id
        WHERE e.id = $1`,
      [evidenceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      publicEvidenceId: row.public_evidence_id,
      wrappedDek: row.wrapped_dek,
      kmsProvider: row.kms_provider,
      wrappedDekAlgorithm: row.wrapped_dek_algorithm,
      wrappedDekFormat: row.wrapped_dek_format,
      kmsKeyReference: row.kms_key_reference,
      kmsKeyVersion: row.kms_key_version,
      submissionState: row.submission_state,
      attemptCount: row.attempt_count,
    };
  });
}

/**
 * Runs a statement as the **owner**, for constraint-tamper assertions.
 *
 * As the application identity these statements would fail with `42501`, which
 * would hide the constraint's own error. The owner sees `23514` (check
 * violation) or `428C9` (generated column) and the assertion stays meaningful.
 */
export function tamperAsOwner(
  pool: AdminPool | undefined,
  statement: string,
  values: unknown[],
): Promise<void> {
  return adminWrite(pool, async ({ db }) => {
    await db.query(statement, values);
  });
}

/** Convenience for suites that hold a plain pool rather than an admin pool. */
export type { AdminPool };
export type AdminFixturePool = Pool;
