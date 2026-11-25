import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { quote } from "../src/lib/quotes";
import {
  assertPreparedCandidateMatchesLockedRows,
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
import { fixtures } from "./helpers/fixtures";

const REGISTRY_ADDRESS = "0x1111111111111111111111111111111111111111";
const FROZEN_SPLIT_SETTLEMENT = Object.freeze({
  expectedMinor: "473904",
  minimumMinor: "471534",
});

class SyntheticDekProvider implements DekProvider {
  readonly provider = KMS_PROVIDER.LOCAL_TEST_ONLY;
  calls = 0;

  async createAndWrapDek(
    _context: DekWrappingContext,
  ): Promise<CreatedAndWrappedDek> {
    this.calls += 1;
    return {
      plaintextDek: Buffer.alloc(32, 73),
      wrappedDek: Buffer.from("synthetic-persistence-wrapped-dek-v1"),
      kmsProvider: KMS_PROVIDER.LOCAL_TEST_ONLY,
      kmsKeyReference: "local-test-only/persistence/evidence",
      kmsKeyVersion: "local-test-only/persistence/v1",
      wrappedDekAlgorithm: WRAPPED_DEK_ALGORITHM.LOCAL_TEST_RANDOM_BYTES_V1,
      wrappedDekFormat: WRAPPED_DEK_FORMAT.LOCAL_TEST_RANDOM_BYTES_V1,
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

  await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    businessId,
    "Evidence persistence test business",
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

async function createActiveMutationActor(context: Context): Promise<string> {
  const actorUserId = randomUUID();
  await fixtures("INSERT INTO users(id,email) VALUES($1,$2)", [
    actorUserId,
    `${actorUserId}@example.invalid`,
  ]);
  await fixtures(
    "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,'operator','active')",
    [context.businessId, actorUserId],
  );
  return actorUserId;
}

async function prepare(
  context: Context,
  fingerprint = requestFingerprint(),
  provider = new SyntheticDekProvider(),
  actorUserId = context.actorUserId,
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
    createdByUserId: actorUserId,
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

async function assertNoPersistenceWrites(
  context: Context,
  expectedStatus = "Funded",
): Promise<void> {
  assert.deepEqual(await counts(context), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    events: "0",
    idempotency: "0",
    status: expectedStatus,
  });
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

test("quote source and relational simulated flag are constrained, while final comparison rejects either hypothetical stale row", async () => {
  const context = await createContext();
  const fingerprint = requestFingerprint();
  const { candidate } = await prepare(context, fingerprint);

  await assert.rejects(
    fixtures("UPDATE quotes SET source='other-source' WHERE id=$1", [
      context.quoteId,
    ]),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
  await assert.rejects(
    fixtures("UPDATE quotes SET simulated=false WHERE id=$1", [
      context.quoteId,
    ]),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );

  const snapshot = await readEvidencePreparationSnapshot(
    context.businessId,
    context.invoiceId,
    context.quoteId,
  );
  if (snapshot.kind !== "ready")
    assert.fail(`expected constrained quote snapshot, got ${snapshot.kind}`);
  const verificationContext = {
    businessId: context.businessId,
    actorUserId: context.actorUserId,
    requestFingerprint: fingerprint,
  };
  assert.throws(
    () =>
      assertPreparedCandidateMatchesLockedRows(
        candidate,
        verificationContext,
        snapshot.invoice,
        { ...snapshot.quote, source: "other-source" },
      ),
    isPersistenceError("CANDIDATE_MISMATCH"),
  );
  assert.throws(
    () =>
      assertPreparedCandidateMatchesLockedRows(
        candidate,
        verificationContext,
        snapshot.invoice,
        { ...snapshot.quote, simulated: false },
      ),
    isPersistenceError("CANDIDATE_MISMATCH"),
  );
  await assertNoPersistenceWrites(context);
});

test("final persistence remains server-only and is reached only through orchestration", async () => {
  const [persistence, service, appRoute, clientService] = await Promise.all([
    readFile("src/server/evidence/persist-candidate.ts", "utf8"),
    readFile("src/server/service.ts", "utf8"),
    readFile("src/app/[[...path]]/page.tsx", "utf8"),
    readFile("src/lib/services.ts", "utf8"),
  ]);
  assert.match(persistence, /^import "server-only";/m);
  assert.match(service, /orchestratePreparedRoutingCandidate/);
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
