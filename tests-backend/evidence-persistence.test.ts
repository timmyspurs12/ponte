import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { quote } from "../src/lib/quotes";
import {
  EvidencePersistenceError,
  persistPreparedEvidenceCandidate,
  type EvidencePersistenceTestHooks,
  type PersistPreparedEvidenceCandidateInput,
} from "../src/server/evidence/persist-candidate";
import {
  KMS_PROVIDER,
  WRAPPED_DEK_ALGORITHM,
  WRAPPED_DEK_FORMAT,
  type CreatedAndWrappedDek,
  type DekProvider,
  type DekWrappingContext,
} from "../src/server/evidence/kms";
import {
  prepareEvidenceCandidate,
  type PreparedEvidenceCandidate,
} from "../src/server/evidence/prepare-candidate";
import {
  pool,
  readEvidencePreparationSnapshot,
} from "../src/server/repository";

const REGISTRY_ADDRESS = "0x1111111111111111111111111111111111111111";
const FROZEN_SPLIT_SETTLEMENT = Object.freeze({
  expectedMinor: "473904",
  minimumMinor: "471534",
});

class SyntheticDekProvider implements DekProvider {
  readonly provider = KMS_PROVIDER.GCP_CLOUD_KMS;
  calls = 0;

  async createAndWrapDek(
    _context: DekWrappingContext,
  ): Promise<CreatedAndWrappedDek> {
    this.calls += 1;
    return {
      plaintextDek: Buffer.alloc(32, 73),
      wrappedDek: Buffer.from("synthetic-persistence-wrapped-dek-v1"),
      kmsProvider: KMS_PROVIDER.GCP_CLOUD_KMS,
      kmsKeyReference:
        "projects/test/locations/africa-south1/keyRings/test/cryptoKeys/evidence",
      kmsKeyVersion:
        "projects/test/locations/africa-south1/keyRings/test/cryptoKeys/evidence/cryptoKeyVersions/1",
      wrappedDekAlgorithm: WRAPPED_DEK_ALGORITHM.GOOGLE_SYMMETRIC_ENCRYPTION,
      wrappedDekFormat: WRAPPED_DEK_FORMAT.GCP_KMS_ENCRYPT_CIPHERTEXT_V1,
    };
  }
}

interface Context {
  businessId: string;
  actorUserId: string;
  invoiceId: string;
  quoteId: string;
  invoice: Record<string, unknown>;
}

function requestFingerprint(value = "ab"): string {
  return value.repeat(32);
}

function persistenceInput(
  context: Context,
  candidate: PreparedEvidenceCandidate | undefined,
  idempotencyKey = `evidence-${randomUUID()}`,
  fingerprint = requestFingerprint(),
): PersistPreparedEvidenceCandidateInput {
  return {
    businessId: context.businessId,
    actorUserId: context.actorUserId,
    idempotencyKey,
    requestFingerprint: fingerprint,
    candidate,
  };
}

async function createContext(): Promise<Context> {
  const businessId = randomUUID();
  const actorUserId = randomUUID();
  const invoiceId = randomUUID();
  const quoteId = randomUUID();
  const fundingMinor = "2500001";
  const persistedQuote = quote({ fundingMinor });
  const invoice = {
    id: invoiceId,
    reference: `EVIDENCE-PERSIST-${invoiceId}`,
    supplier: "Final evidence persistence test supplier",
    wallet: `0x${"c".repeat(40)}`,
    amount: 25000.01,
    fundingMinor,
    fundingCurrency: "BRL",
    settlementCurrency: "USDG",
    due: "2035-12-20",
    description: "Synthetic final evidence persistence test only",
    status: "Funded",
    created: "2026-11-19",
    quote: persistedQuote,
  };

  await pool.query("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    businessId,
    "Evidence persistence test business",
  ]);
  await pool.query("INSERT INTO users(id,email) VALUES($1,$2)", [
    actorUserId,
    `${actorUserId}@example.invalid`,
  ]);
  await pool.query(
    "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,'admin','active')",
    [businessId, actorUserId],
  );
  await pool.query(
    "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data) VALUES($1,$2,$3,$4,$5,$6)",
    [
      invoiceId,
      businessId,
      invoice.reference,
      fundingMinor,
      invoice.status,
      JSON.stringify(invoice),
    ],
  );
  await pool.query(
    "INSERT INTO quotes(id,business_id,invoice_id,source,simulated,data,expires_at) VALUES($1,$2,$3,'simulation-fixed-525',true,$4,$5)",
    [
      quoteId,
      businessId,
      invoiceId,
      JSON.stringify(persistedQuote),
      "2035-12-20T00:00:00.123Z",
    ],
  );
  return { businessId, actorUserId, invoiceId, quoteId, invoice };
}

async function prepare(
  context: Context,
  fingerprint = requestFingerprint(),
  provider = new SyntheticDekProvider(),
): Promise<{
  candidate: PreparedEvidenceCandidate;
  provider: SyntheticDekProvider;
}> {
  const snapshot = await readEvidencePreparationSnapshot(
    context.businessId,
    context.invoiceId,
    context.quoteId,
  );
  if (snapshot.kind !== "ready")
    assert.fail(`expected preparation snapshot, got ${snapshot.kind}`);
  const candidate = await prepareEvidenceCandidate({
    snapshot,
    selectedRouteId: "split",
    registryAddress: REGISTRY_ADDRESS,
    createdByUserId: context.actorUserId,
    requestFingerprint: fingerprint,
    provider,
  });
  return { candidate, provider };
}

async function counts(context: Context) {
  const result = await pool.query<{
    evidence: string;
    outbox: string;
    settlements: string;
    events: string;
    idempotency: string;
    status: string;
  }>(
    "SELECT (SELECT count(*) FROM route_decision_evidence WHERE business_id=$1)::text AS evidence,(SELECT count(*) FROM evidence_outbox o JOIN route_decision_evidence e ON e.id=o.evidence_record_id WHERE e.business_id=$1)::text AS outbox,(SELECT count(*) FROM settlements WHERE business_id=$1)::text AS settlements,(SELECT count(*) FROM payment_events WHERE business_id=$1)::text AS events,(SELECT count(*) FROM idempotency WHERE business_id=$1)::text AS idempotency,(SELECT status FROM invoices WHERE business_id=$1 AND id=$2) AS status",
    [context.businessId, context.invoiceId],
  );
  return result.rows[0];
}

function isPersistenceError(
  code: EvidencePersistenceError["code"],
): (error: unknown) => boolean {
  return (error) =>
    error instanceof EvidencePersistenceError && error.code === code;
}

after(async () => {
  await pool.end();
});

test("persists one frozen simulated evidence candidate, pending outbox, Routing invoice, event, and response", async () => {
  const context = await createContext();
  const { candidate, provider } = await prepare(context);
  const input = persistenceInput(context, candidate);

  assert.equal(provider.calls, 1, "preparation completed before persistence");
  const result = await persistPreparedEvidenceCandidate(input);
  assert.equal(result.kind, "persisted");
  assert.equal(provider.calls, 1, "persistence made no provider call");
  assert.deepEqual((result.response as { status: string }).status, "Routing");

  const stored = await pool.query<{
    status: string;
    expected_minor: string;
    minimum_minor: string;
    transaction_hash: string | null;
    settlement_status: string;
    event_kind: string;
    previous_state: string | null;
    new_state: string;
    submission_state: string;
    prepared_digest_columns: string;
  }>(
    "SELECT i.status,s.expected_minor,s.minimum_minor,s.transaction_hash,s.status AS settlement_status,ev.kind AS event_kind,ev.previous_state,ev.new_state,o.submission_state,(SELECT count(*)::text FROM information_schema.columns WHERE table_schema='public' AND table_name='route_decision_evidence' AND column_name='prepared_candidate_digest') AS prepared_digest_columns FROM invoices i JOIN settlements s ON s.invoice_id=i.id JOIN route_decision_evidence e ON e.invoice_id=i.id JOIN evidence_outbox o ON o.evidence_record_id=e.id JOIN payment_events ev ON ev.invoice_id=i.id WHERE i.business_id=$1 AND i.id=$2",
    [context.businessId, context.invoiceId],
  );
  assert.equal(stored.rowCount, 1);
  assert.deepEqual(stored.rows[0], {
    status: "Routing",
    expected_minor: FROZEN_SPLIT_SETTLEMENT.expectedMinor,
    minimum_minor: FROZEN_SPLIT_SETTLEMENT.minimumMinor,
    transaction_hash: null,
    settlement_status: "Routing",
    event_kind: "invoice.Routing",
    previous_state: "Funded",
    new_state: "Routing",
    submission_state: "pending",
    prepared_digest_columns: "0",
  });
  assert.deepEqual(await counts(context), {
    evidence: "1",
    outbox: "1",
    settlements: "1",
    events: "1",
    idempotency: "1",
    status: "Routing",
  });
});

test("same-key races serialize into one persistence and an authorized candidate-free replay", async () => {
  const context = await createContext();
  const { candidate } = await prepare(context);
  const key = `race-${randomUUID()}`;
  const input = persistenceInput(context, candidate, key);
  const [first, second] = await Promise.all([
    persistPreparedEvidenceCandidate(input),
    persistPreparedEvidenceCandidate(input),
  ]);

  assert.deepEqual([first.kind, second.kind].sort(), ["persisted", "replay"]);
  assert.deepEqual(first.response, second.response);
  const replay = await persistPreparedEvidenceCandidate(
    persistenceInput(context, undefined, key),
  );
  assert.equal(replay.kind, "replay");
  assert.deepEqual(replay.response, first.response);
  await assert.rejects(
    persistPreparedEvidenceCandidate(
      persistenceInput(context, undefined, key, requestFingerprint("cd")),
    ),
    isPersistenceError("IDEMPOTENCY_CONFLICT"),
  );
  assert.deepEqual(await counts(context), {
    evidence: "1",
    outbox: "1",
    settlements: "1",
    events: "1",
    idempotency: "1",
    status: "Routing",
  });
});

test("final locked rows reject candidate drift and PostgreSQL-time quote expiry before any write", async () => {
  const changed = await createContext();
  const { candidate: changedCandidate } = await prepare(changed);
  await pool.query(
    "UPDATE quotes SET data=jsonb_set(data,'{routes,1,outputMinor}',to_jsonb('1'::text)) WHERE id=$1",
    [changed.quoteId],
  );
  await assert.rejects(
    persistPreparedEvidenceCandidate(
      persistenceInput(changed, changedCandidate),
    ),
    isPersistenceError("CANDIDATE_MISMATCH"),
  );
  assert.deepEqual(await counts(changed), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "0",
    status: "Funded",
  });

  const expired = await createContext();
  const { candidate: expiredCandidate } = await prepare(expired);
  await pool.query(
    "UPDATE quotes SET expires_at=date_trunc('milliseconds',clock_timestamp())-interval '1 millisecond' WHERE id=$1",
    [expired.quoteId],
  );
  await assert.rejects(
    persistPreparedEvidenceCandidate(
      persistenceInput(expired, expiredCandidate),
    ),
    isPersistenceError("INVOICE_OR_QUOTE_UNAVAILABLE"),
  );
  assert.deepEqual(await counts(expired), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "0",
    status: "Funded",
  });
});

test("revoked or viewer memberships cannot persist or disclose a durable replay", async () => {
  const denied = await createContext();
  const { candidate: deniedCandidate } = await prepare(denied);
  await pool.query(
    "UPDATE memberships SET status='disabled' WHERE business_id=$1 AND user_id=$2",
    [denied.businessId, denied.actorUserId],
  );
  await assert.rejects(
    persistPreparedEvidenceCandidate(persistenceInput(denied, deniedCandidate)),
    isPersistenceError("FORBIDDEN"),
  );
  assert.deepEqual(await counts(denied), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "0",
    status: "Funded",
  });

  const replay = await createContext();
  const { candidate: replayCandidate } = await prepare(replay);
  const key = `revoked-replay-${randomUUID()}`;
  await persistPreparedEvidenceCandidate(
    persistenceInput(replay, replayCandidate, key),
  );
  await pool.query(
    "UPDATE memberships SET role='viewer' WHERE business_id=$1 AND user_id=$2",
    [replay.businessId, replay.actorUserId],
  );
  await assert.rejects(
    persistPreparedEvidenceCandidate(persistenceInput(replay, undefined, key)),
    isPersistenceError("FORBIDDEN"),
  );
});

test(
  "final membership authorization locks the active membership row",
  { timeout: 5000 },
  async () => {
    const context = await createContext();
    const { candidate } = await prepare(context);
    const locker = await pool.connect();
    let open = false;
    try {
      await locker.query("BEGIN");
      open = true;
      await locker.query(
        "SELECT role FROM memberships WHERE business_id=$1 AND user_id=$2 FOR UPDATE",
        [context.businessId, context.actorUserId],
      );

      let settled = false;
      const attempt = persistPreparedEvidenceCandidate(
        persistenceInput(context, candidate),
      ).then((result) => {
        settled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.equal(
        settled,
        false,
        "membership FOR UPDATE blocks final authorization",
      );
      await locker.query("ROLLBACK");
      open = false;
      assert.equal((await attempt).kind, "persisted");
    } finally {
      if (open) await locker.query("ROLLBACK");
      locker.release();
    }
  },
);

test("every post-write failure boundary rolls back all final-persistence effects", async () => {
  const steps: Array<
    Parameters<NonNullable<EvidencePersistenceTestHooks["afterWrite"]>>[0]
  > = ["settlement", "evidence", "outbox", "invoice", "event", "idempotency"];

  for (const step of steps) {
    const context = await createContext();
    const { candidate } = await prepare(context);
    await assert.rejects(
      persistPreparedEvidenceCandidate(persistenceInput(context, candidate), {
        afterWrite: (observed) => {
          if (observed === step) throw new Error("synthetic rollback boundary");
        },
      }),
      isPersistenceError("PERSISTENCE_FAILED"),
      step,
    );
    assert.deepEqual(await counts(context), {
      evidence: "0",
      outbox: "0",
      settlements: "0",
      events: "0",
      idempotency: "0",
      status: "Funded",
    });
  }
});

test("candidate mutation is rejected without exposing candidate bytes or leaving a write", async () => {
  const context = await createContext();
  const { candidate } = await prepare(context);
  const sensitive = candidate.ciphertext.toString("hex");
  candidate.ciphertext[0] ^= 0xff;
  const result = await Promise.allSettled([
    persistPreparedEvidenceCandidate(persistenceInput(context, candidate)),
  ]);
  assert.equal(result[0].status, "rejected");
  const reason = result[0].status === "rejected" ? result[0].reason : undefined;
  assert.equal(isPersistenceError("CANDIDATE_INVALID")(reason), true);
  assert.equal(String((reason as Error).stack).includes(sensitive), false);
  assert.deepEqual(await counts(context), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "0",
    status: "Funded",
  });
});

test("lost COMMIT acknowledgement destroys certainty and only same-key replay recovers the durable result", async () => {
  const context = await createContext();
  const { candidate } = await prepare(context);
  const key = `lost-commit-${randomUUID()}`;
  const input = persistenceInput(context, candidate, key);
  const originalConnect = pool.connect.bind(pool);
  let commitAcknowledgementLost = false;
  (pool as unknown as { connect: typeof pool.connect }).connect = (async () => {
    const client = await originalConnect();
    const originalQuery = client.query.bind(client);
    const wrapped = client as unknown as {
      query: (...args: unknown[]) => Promise<unknown>;
    };
    wrapped.query = async (...args: unknown[]) => {
      const command =
        typeof args[0] === "string"
          ? args[0]
          : (args[0] as { text?: string } | undefined)?.text;
      const result = await originalQuery(...(args as [string]));
      if (command === "COMMIT" && !commitAcknowledgementLost) {
        commitAcknowledgementLost = true;
        const error = Object.assign(
          new Error("simulated acknowledgement loss"),
          {
            code: "08006",
          },
        );
        throw error;
      }
      return result;
    };
    return client;
  }) as typeof pool.connect;

  try {
    await assert.rejects(
      persistPreparedEvidenceCandidate(input),
      isPersistenceError("COMMIT_OUTCOME_UNKNOWN"),
    );
  } finally {
    (pool as unknown as { connect: typeof pool.connect }).connect =
      originalConnect as typeof pool.connect;
  }

  assert.equal(commitAcknowledgementLost, true);
  assert.deepEqual(await counts(context), {
    evidence: "1",
    outbox: "1",
    settlements: "1",
    events: "1",
    idempotency: "1",
    status: "Routing",
  });
  await assert.rejects(
    persistPreparedEvidenceCandidate(
      persistenceInput(context, undefined, key, requestFingerprint("cd")),
    ),
    isPersistenceError("IDEMPOTENCY_CONFLICT"),
  );
  const replay = await persistPreparedEvidenceCandidate(
    persistenceInput(context, undefined, key),
  );
  assert.equal(replay.kind, "replay");
  assert.equal((replay.response as { status: string }).status, "Routing");
});

test("persistence remains server-only and unreachable from ordinary Routing/API/client imports", async () => {
  const [persistence, service, appRoute, clientService] = await Promise.all([
    readFile("src/server/evidence/persist-candidate.ts", "utf8"),
    readFile("src/server/service.ts", "utf8"),
    readFile("src/app/[[...path]]/page.tsx", "utf8"),
    readFile("src/lib/services.ts", "utf8"),
  ]);
  assert.match(persistence, /^import "server-only";/m);
  for (const source of [service, appRoute, clientService])
    assert.doesNotMatch(
      source,
      /persist-candidate|persistPreparedEvidenceCandidate/,
    );
  assert.doesNotMatch(
    persistence,
    /assertDekProviderResult|prepareEvidenceCandidate/,
  );
});
