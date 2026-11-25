import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { quote } from "../src/lib/quotes";
import { mapEvidenceError } from "../src/server/evidence/error-boundary";
import {
  EvidenceCandidatePreparationError,
  EvidencePersistenceError,
  EvidenceReadError,
  RoutingEligibilityError,
} from "../src/server/evidence/errors";
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
  __testOnlyRunReadOnlyTransaction,
  pool,
  readEvidencePreparationSnapshot,
  readRoutingIdempotencyPreflight,
  transaction,
} from "../src/server/repository";
import type { PoolClient } from "pg";
import { fixtures } from "./helpers/fixtures";

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
  readonly provider = KMS_PROVIDER.LOCAL_TEST_ONLY;
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
      kmsProvider: KMS_PROVIDER.LOCAL_TEST_ONLY,
      kmsKeyReference: "local-test-only/orchestration/evidence",
      kmsKeyVersion: "local-test-only/orchestration/v1",
      wrappedDekAlgorithm: WRAPPED_DEK_ALGORITHM.LOCAL_TEST_RANDOM_BYTES_V1,
      wrappedDekFormat: WRAPPED_DEK_FORMAT.LOCAL_TEST_RANDOM_BYTES_V1,
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
  await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    businessId,
    "Routing orchestration test business",
  ]);
  await fixtures("INSERT INTO users(id,email) VALUES($1,$2)", [
    actorUserId,
    `${actorUserId}@example.invalid`,
  ]);
  await fixtures(
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
    resolvePreparationDependencies: () => ({
      provider,
      registryAddress: TEST_ONLY_REGISTRY,
    }),
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

async function commitSyntheticNormalRouting(
  context: TestContext,
  key: string,
  requestFingerprint: string,
  response: unknown,
): Promise<void> {
  await transaction(async (db) => {
    await db.query(
      "INSERT INTO settlements(id,business_id,invoice_id,quote_id,route_id,expected_minor,minimum_minor,status) VALUES($1,$2,$3,$4,'split','473904','471534','Routing')",
      [randomUUID(), context.businessId, context.invoiceId, context.quoteId],
    );
    await db.query(
      "UPDATE invoices SET status='Routing',data=jsonb_set(jsonb_set(data,'{status}','\"Routing\"'::jsonb),'{selectedRoute}','\"split\"'::jsonb) WHERE business_id=$1 AND id=$2",
      [context.businessId, context.invoiceId],
    );
    await db.query(
      "INSERT INTO payment_events(id,business_id,invoice_id,actor_id,correlation_id,kind,data,previous_state,new_state) VALUES($1,$2,$3,$4,$5,'invoice.Routing',$6,'Funded','Routing')",
      [
        randomUUID(),
        context.businessId,
        context.invoiceId,
        context.actorUserId,
        randomUUID(),
        JSON.stringify({
          status: "Routing",
          selectedRoute: "split",
          fundingMinor: "2500001",
          simulated: true,
        }),
      ],
    );
    await db.query(
      "INSERT INTO idempotency(business_id,key,fingerprint,response) VALUES($1,$2,$3,$4)",
      [context.businessId, key, requestFingerprint, JSON.stringify(response)],
    );
  });
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

test("a conflicting commit between preflight miss and snapshot is decided by final persistence", async () => {
  const context = await createContext();
  const key = `routing-${randomUUID()}`;
  const provider = new ControlledDekProvider(() =>
    assert.fail("candidate-free conflict arbitration must not invoke provider"),
  );

  await assert.rejects(
    orchestratePreparedRoutingCandidate(
      request(context, provider, { idempotencyKey: key }),
      {
        afterPreflightMissBeforeSnapshot: () =>
          commitSyntheticNormalRouting(context, key, fingerprint("cd"), {
            replay: "different-fingerprint",
            status: "Routing",
          }),
      },
    ),
    hasPersistenceError("IDEMPOTENCY_CONFLICT"),
  );
  assert.equal(provider.calls, 0);
  assert.deepEqual(await counts(context), {
    evidence: "0",
    outbox: "0",
    settlements: "1",
    events: "1",
    idempotency: "1",
    status: "Routing",
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
    [
      new EvidenceCandidatePreparationError("PREPARATION_FAILED"),
      500,
      "EVIDENCE_PREPARATION_FAILED",
    ],
    [
      new EvidenceReadError("PREFLIGHT_READ_FAILED"),
      500,
      "EVIDENCE_PREFLIGHT_READ_FAILED",
    ],
    [
      new EvidenceReadError("SNAPSHOT_READ_FAILED"),
      500,
      "EVIDENCE_SNAPSHOT_READ_FAILED",
    ],
    [new RoutingEligibilityError("INVOICE_NOT_FOUND"), 404, "NOT_FOUND"],
    [
      new RoutingEligibilityError("INVALID_TRANSITION"),
      409,
      "INVALID_TRANSITION",
    ],
    [
      new RoutingEligibilityError("QUOTE_EXPIRED_OR_MISSING"),
      409,
      "QUOTE_EXPIRED_OR_MISSING",
    ],
    [
      new EvidencePersistenceError("INVALID_CONTEXT"),
      500,
      "EVIDENCE_INTERNAL_CONTEXT_INVALID",
    ],
    [new EvidencePersistenceError("FORBIDDEN"), 403, "FORBIDDEN"],
    [
      new EvidencePersistenceError("IDEMPOTENCY_CONFLICT"),
      409,
      "IDEMPOTENCY_CONFLICT",
    ],
    [
      new EvidencePersistenceError("CANDIDATE_REQUIRED"),
      500,
      "EVIDENCE_INTERNAL_CONTEXT_INVALID",
    ],
    [
      new EvidencePersistenceError("CANDIDATE_INVALID"),
      500,
      "EVIDENCE_INTERNAL_CANDIDATE_INVALID",
    ],
    [
      new EvidencePersistenceError("CANDIDATE_MISMATCH"),
      409,
      "EVIDENCE_PREPARATION_STALE",
    ],
    [
      new EvidencePersistenceError("INVOICE_OR_QUOTE_UNAVAILABLE"),
      409,
      "QUOTE_EXPIRED_OR_MISSING",
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

interface ControlledReadOnlyClient {
  readonly queries: string[];
  readonly releases: boolean[];
  readonly client: Pick<PoolClient, "query" | "release">;
}

function controlledReadOnlyClient(
  failures: Partial<
    Record<"BEGIN READ ONLY" | "SELECT" | "COMMIT" | "ROLLBACK", Error>
  > = {},
): ControlledReadOnlyClient {
  const queries: string[] = [];
  const releases: boolean[] = [];
  const client = {
    query: async (query: string) => {
      queries.push(query);
      const failure = Object.entries(failures).find(([operation]) =>
        query.startsWith(operation),
      )?.[1];
      if (failure) throw failure;
      return { rowCount: 0, rows: [] };
    },
    release: (destroy?: boolean) => {
      releases.push(destroy === true);
    },
  } as unknown as Pick<PoolClient, "query" | "release">;
  return { client, queries, releases };
}

async function withFakePoolClient<T>(
  client: Pick<PoolClient, "query" | "release">,
  work: () => Promise<T>,
): Promise<T> {
  const mutablePool = pool as unknown as {
    connect: typeof pool.connect;
  };
  const originalConnect = mutablePool.connect;
  mutablePool.connect = async () => client as PoolClient;
  try {
    return await work();
  } finally {
    mutablePool.connect = originalConnect;
  }
}

test("read-only cleanup preserves original errors and discards uncertain clients", async () => {
  const beginFailure = new Error("begin acknowledgement failure");
  const failedBegin = controlledReadOnlyClient({
    "BEGIN READ ONLY": beginFailure,
  });
  let workCalls = 0;
  await assert.rejects(
    __testOnlyRunReadOnlyTransaction(failedBegin.client, async () => {
      workCalls += 1;
      return "must not run";
    }),
    (error: unknown) => error === beginFailure,
  );
  assert.equal(workCalls, 0);
  assert.deepEqual(failedBegin.queries, ["BEGIN READ ONLY"]);
  assert.deepEqual(failedBegin.releases, [true]);

  const operationFailure = new Error("read query failure");
  const healthyRollback = controlledReadOnlyClient({
    SELECT: operationFailure,
  });
  await assert.rejects(
    __testOnlyRunReadOnlyTransaction(healthyRollback.client, async (db) => {
      await db.query("SELECT fail");
      return "unreachable";
    }),
    (error: unknown) => error === operationFailure,
  );
  assert.deepEqual(healthyRollback.queries, [
    "BEGIN READ ONLY",
    "SELECT fail",
    "ROLLBACK",
  ]);
  assert.deepEqual(healthyRollback.releases, [false]);

  const rollbackFailure = new Error("rollback failure");
  const failedRollback = controlledReadOnlyClient({
    SELECT: operationFailure,
    ROLLBACK: rollbackFailure,
  });
  await assert.rejects(
    __testOnlyRunReadOnlyTransaction(failedRollback.client, async (db) => {
      await db.query("SELECT fail");
      return "unreachable";
    }),
    (error: unknown) => error === operationFailure,
  );
  assert.deepEqual(failedRollback.releases, [true]);

  const commitFailure = new Error("commit acknowledgement failure");
  const failedCommit = controlledReadOnlyClient({ COMMIT: commitFailure });
  await assert.rejects(
    __testOnlyRunReadOnlyTransaction(failedCommit.client, async () => "done"),
    (error: unknown) => error === commitFailure,
  );
  assert.deepEqual(failedCommit.queries, [
    "BEGIN READ ONLY",
    "COMMIT",
    "ROLLBACK",
  ]);
  assert.deepEqual(failedCommit.releases, [true]);
});

test("read-only repository errors are sanitized before the API boundary", async () => {
  const preflightFailure = new Error(
    "raw preflight SQL detail must not escape",
  );
  const preflightClient = controlledReadOnlyClient({
    SELECT: preflightFailure,
  });
  await assert.rejects(
    withFakePoolClient(preflightClient.client, () =>
      readRoutingIdempotencyPreflight(
        randomUUID(),
        "routing-test-key",
        fingerprint(),
      ),
    ),
    (error: unknown) =>
      error instanceof EvidenceReadError &&
      error.code === "PREFLIGHT_READ_FAILED" &&
      !error.message.includes("raw preflight SQL detail"),
  );
  assert.deepEqual(preflightClient.releases, [false]);

  const snapshotFailure = new Error("raw snapshot SQL detail must not escape");
  const snapshotClient = controlledReadOnlyClient({ SELECT: snapshotFailure });
  await assert.rejects(
    withFakePoolClient(snapshotClient.client, () =>
      readEvidencePreparationSnapshot(randomUUID(), randomUUID(), randomUUID()),
    ),
    (error: unknown) =>
      error instanceof EvidenceReadError &&
      error.code === "SNAPSHOT_READ_FAILED" &&
      !error.message.includes("raw snapshot SQL detail"),
  );
  assert.deepEqual(snapshotClient.releases, [false]);
});

test("ordinary Routing delegates eligible commands without wrapping final persistence", async () => {
  const service = await readFile("src/server/service.ts", "utf8");
  assert.match(service, /orchestratePreparedRoutingCandidate/);
  assert.match(service, /routingTransitionSchema\.safeParse\(body\)/);
  assert.doesNotMatch(
    service,
    /persist-candidate|persistPreparedEvidenceCandidate|insertSettlement/,
  );
  assert.match(service, /return transaction\(async \(db\) =>/);
});
