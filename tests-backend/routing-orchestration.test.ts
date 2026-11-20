import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { quote } from "../src/lib/quotes";
import { mapEvidenceError } from "../src/server/evidence/error-boundary";
import { EvidenceCandidatePreparationError } from "../src/server/evidence/prepare-candidate";
import { EvidencePersistenceError } from "../src/server/evidence/persist-candidate";
import { orchestratePreparedRoutingCandidate } from "../src/server/evidence/routing-orchestration";
import {
  KMS_PROVIDER,
  WRAPPED_DEK_ALGORITHM,
  WRAPPED_DEK_FORMAT,
  type CreatedAndWrappedDek,
  type DekProvider,
  type DekWrappingContext,
} from "../src/server/evidence/kms";
import {
  pool,
  readRoutingIdempotencyPreflight,
} from "../src/server/repository";

// Test fixture only. It is not a deployed registry address or runtime default.
const TEST_ONLY_REGISTRY = "0x1111111111111111111111111111111111111111";
const fingerprint = (seed = "ab") => seed.repeat(32);

interface TestContext {
  businessId: string;
  actorUserId: string;
  invoiceId: string;
  quoteId: string;
}

class ControlledDekProvider implements DekProvider {
  readonly provider = KMS_PROVIDER.GCP_CLOUD_KMS;
  calls = 0;

  constructor(
    private readonly onCreate?: () => void | Promise<void>,
    private readonly failure?: Error,
  ) {}

  async createAndWrapDek(
    _context: DekWrappingContext,
  ): Promise<CreatedAndWrappedDek> {
    this.calls += 1;
    await this.onCreate?.();
    if (this.failure) throw this.failure;
    return {
      plaintextDek: Buffer.alloc(32, 71),
      wrappedDek: Buffer.from("controlled-routing-orchestration-dek-v1"),
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

async function createContext(): Promise<TestContext> {
  const businessId = randomUUID();
  const actorUserId = randomUUID();
  const invoiceId = randomUUID();
  const quoteId = randomUUID();
  const fundingMinor = "2500001";
  const data = {
    id: invoiceId,
    reference: `ORCHESTRATION-${invoiceId}`,
    supplier: "Routing orchestration test supplier",
    wallet: `0x${"d".repeat(40)}`,
    amount: 25000.01,
    fundingMinor,
    fundingCurrency: "BRL",
    settlementCurrency: "USDG",
    due: "2035-12-20",
    description: "Controlled orchestration test only",
    status: "Funded",
    created: "2026-11-19",
    quote: quote({ fundingMinor }),
  };
  await pool.query("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    businessId,
    "Routing orchestration test business",
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
      data.reference,
      fundingMinor,
      data.status,
      JSON.stringify(data),
    ],
  );
  await pool.query(
    "INSERT INTO quotes(id,business_id,invoice_id,source,simulated,data,expires_at) VALUES($1,$2,$3,'simulation-fixed-525',true,$4,$5)",
    [
      quoteId,
      businessId,
      invoiceId,
      JSON.stringify(data.quote),
      "2035-12-20T00:00:00.123Z",
    ],
  );
  return { businessId, actorUserId, invoiceId, quoteId };
}

function request(
  context: TestContext,
  provider: DekProvider,
  overrides: Partial<{
    idempotencyKey: string;
    requestFingerprint: string;
  }> = {},
) {
  return {
    businessId: context.businessId,
    actorUserId: context.actorUserId,
    invoiceId: context.invoiceId,
    quoteId: context.quoteId,
    idempotencyKey: overrides.idempotencyKey ?? `routing-${randomUUID()}`,
    requestFingerprint: overrides.requestFingerprint ?? fingerprint(),
    selectedRouteId: "split" as const,
    provider,
    registryAddress: TEST_ONLY_REGISTRY,
  };
}

async function counts(context: TestContext) {
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

async function seedIdempotency(
  context: TestContext,
  key: string,
  requestFingerprint: string,
  response: unknown = { replay: true, status: "Routing" },
) {
  await pool.query(
    "INSERT INTO idempotency(business_id,key,fingerprint,response) VALUES($1,$2,$3,$4)",
    [context.businessId, key, requestFingerprint, JSON.stringify(response)],
  );
}

function hasPersistenceError(code: EvidencePersistenceError["code"]) {
  return (error: unknown): boolean =>
    error instanceof EvidencePersistenceError && error.code === code;
}

after(async () => {
  await pool.end();
});

test("read-only idempotency preflight distinguishes miss, matching replay, and conflict", async () => {
  const context = await createContext();
  const key = `routing-${randomUUID()}`;
  const match = fingerprint();

  assert.deepEqual(
    await readRoutingIdempotencyPreflight(context.businessId, key, match),
    { kind: "miss" },
  );
  await seedIdempotency(context, key, match, { replay: "authoritative-later" });
  assert.deepEqual(
    await readRoutingIdempotencyPreflight(context.businessId, key, match),
    { kind: "match", response: { replay: "authoritative-later" } },
  );
  assert.deepEqual(
    await readRoutingIdempotencyPreflight(
      context.businessId,
      key,
      fingerprint("cd"),
    ),
    { kind: "conflict" },
  );
});

test("matching preflight uses candidate-free final replay and reuses no provider", async () => {
  const context = await createContext();
  const key = `routing-${randomUUID()}`;
  const requestFingerprint = fingerprint();
  await seedIdempotency(context, key, requestFingerprint);
  const provider = new ControlledDekProvider(() =>
    assert.fail("matching preflight must not invoke provider"),
  );

  const result = await orchestratePreparedRoutingCandidate(
    request(context, provider, { idempotencyKey: key, requestFingerprint }),
  );

  assert.equal(result.preflight, "match");
  assert.equal(result.kind, "replay");
  assert.equal(provider.calls, 0);
  assert.deepEqual(await counts(context), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "1",
    status: "Funded",
  });
});

test("conflicting preflight is retried authoritatively and cannot produce writes", async () => {
  const context = await createContext();
  const key = `routing-${randomUUID()}`;
  await seedIdempotency(context, key, fingerprint("cd"));
  const provider = new ControlledDekProvider(() =>
    assert.fail("conflicting preflight must not invoke provider"),
  );

  await assert.rejects(
    orchestratePreparedRoutingCandidate(
      request(context, provider, { idempotencyKey: key }),
    ),
    hasPersistenceError("IDEMPOTENCY_CONFLICT"),
  );
  assert.equal(provider.calls, 0);
  assert.deepEqual(await counts(context), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "1",
    status: "Funded",
  });
});

test("controlled preparation starts after read-only work, without final locks, then persists once", async () => {
  const context = await createContext();
  let beforePreparation = false;
  const provider = new ControlledDekProvider(async () => {
    assert.equal(beforePreparation, true);
    const locks = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_locks l LEFT JOIN pg_class c ON c.oid=l.relation WHERE l.pid=pg_backend_pid() AND l.granted AND (l.locktype='advisory' OR (c.relname IN ('invoices','quotes') AND l.mode IN ('RowShareLock','RowExclusiveLock','ShareLock','ExclusiveLock','AccessExclusiveLock')))",
    );
    assert.equal(locks.rows[0].count, "0");
    const transactions = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_stat_activity WHERE pid=pg_backend_pid() AND state='idle in transaction'",
    );
    assert.equal(transactions.rows[0].count, "0");
  });

  const result = await orchestratePreparedRoutingCandidate(
    request(context, provider),
    {
      beforePreparation: () => {
        beforePreparation = true;
        assert.ok(
          pool.idleCount >= 1,
          "snapshot client was released to the pool",
        );
      },
    },
  );

  assert.equal(result.preflight, "miss");
  assert.equal(result.kind, "persisted");
  assert.equal(provider.calls, 1);
  assert.deepEqual(await counts(context), {
    evidence: "1",
    outbox: "1",
    settlements: "1",
    events: "1",
    idempotency: "1",
    status: "Routing",
  });
});

test("a matching record committed during preparation becomes final authoritative replay", async () => {
  const context = await createContext();
  const key = `routing-${randomUUID()}`;
  const requestFingerprint = fingerprint();
  const provider = new ControlledDekProvider(async () => {
    await seedIdempotency(context, key, requestFingerprint, {
      replay: "committed-during-preparation",
    });
  });

  const result = await orchestratePreparedRoutingCandidate(
    request(context, provider, { idempotencyKey: key, requestFingerprint }),
  );

  assert.equal(result.preflight, "miss");
  assert.equal(result.kind, "replay");
  assert.equal(provider.calls, 1);
  assert.deepEqual(await counts(context), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "1",
    status: "Funded",
  });
});

test("provider failure prevents final persistence and stale final state rolls back", async () => {
  const providerFailureContext = await createContext();
  const unavailable = new ControlledDekProvider(
    undefined,
    new Error("controlled provider outage"),
  );
  await assert.rejects(
    orchestratePreparedRoutingCandidate(
      request(providerFailureContext, unavailable),
    ),
    (error: unknown) =>
      error instanceof EvidenceCandidatePreparationError &&
      error.code === "PROVIDER_FAILURE",
  );
  assert.deepEqual(await counts(providerFailureContext), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "0",
    status: "Funded",
  });

  const staleContext = await createContext();
  const staleProvider = new ControlledDekProvider(async () => {
    await pool.query(
      "UPDATE invoices SET status='Failed',data=jsonb_set(data,'{status}','\"Failed\"'::jsonb) WHERE business_id=$1 AND id=$2",
      [staleContext.businessId, staleContext.invoiceId],
    );
  });
  await assert.rejects(
    orchestratePreparedRoutingCandidate(request(staleContext, staleProvider)),
    hasPersistenceError("CANDIDATE_MISMATCH"),
  );
  assert.deepEqual(await counts(staleContext), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "0",
    status: "Failed",
  });
});

test("safe evidence error mapping keeps ambiguous commit indeterminate", () => {
  const cases: Array<[Error, number, string]> = [
    [
      new EvidenceCandidatePreparationError("INVALID_INPUT"),
      409,
      "EVIDENCE_PREPARATION_STALE",
    ],
    [
      new EvidenceCandidatePreparationError("PROVIDER_FAILURE"),
      503,
      "EVIDENCE_PROVIDER_UNAVAILABLE",
    ],
    [
      new EvidenceCandidatePreparationError("PROVIDER_RESULT_INVALID"),
      500,
      "EVIDENCE_PROVIDER_RESULT_INVALID",
    ],
    [
      new EvidenceCandidatePreparationError("ENCRYPTION_FAILED"),
      500,
      "EVIDENCE_ENCRYPTION_FAILED",
    ],
    [new EvidencePersistenceError("FORBIDDEN"), 403, "FORBIDDEN"],
    [
      new EvidencePersistenceError("IDEMPOTENCY_CONFLICT"),
      409,
      "IDEMPOTENCY_CONFLICT",
    ],
    [
      new EvidencePersistenceError("CANDIDATE_INVALID"),
      500,
      "EVIDENCE_INTERNAL_CANDIDATE_INVALID",
    ],
    [
      new EvidencePersistenceError("PERSISTENCE_FAILED"),
      500,
      "EVIDENCE_PERSISTENCE_FAILED",
    ],
    [
      new EvidencePersistenceError("COMMIT_OUTCOME_UNKNOWN"),
      503,
      "COMMIT_OUTCOME_UNKNOWN",
    ],
  ];
  for (const [error, status, code] of cases) {
    const mapped = mapEvidenceError(error);
    assert.equal(mapped?.status, status);
    assert.equal(mapped?.code, code);
  }
});

test("ordinary Routing remains disconnected from the controlled orchestration seam", async () => {
  const service = await readFile("src/server/service.ts", "utf8");
  assert.doesNotMatch(service, /routing-orchestration/);
  assert.match(service, /return transaction\(async \(db\) =>/);
});
