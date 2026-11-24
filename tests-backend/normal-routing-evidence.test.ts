import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Invoice } from "../src/lib/models";
import { resolveLocalRoutingEvidencePreparationDependencies } from "../src/server/evidence/local-routing-config";
import { EvidenceCandidatePreparationError } from "../src/server/evidence/errors";
import {
  isLocalTestOnlyDekWrappingMetadata,
  KMS_PROVIDER,
  WRAPPED_DEK_ALGORITHM,
  WRAPPED_DEK_FORMAT,
  type CreatedAndWrappedDek,
  type DekProvider,
  type DekWrappingContext,
} from "../src/server/evidence/kms";
import { pool } from "../src/server/repository";
import { __testOnlyExecute, ApiError, execute } from "../src/server/service";

const TEST_REGISTRY = "0x1111111111111111111111111111111111111111";
const token = process.env.PONTE_DEV_TOKEN!;
const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  PONTE_DEV_BUSINESS_ID: process.env.PONTE_DEV_BUSINESS_ID,
  PONTE_DEV_USER_ID: process.env.PONTE_DEV_USER_ID,
  PONTE_LOCAL_EVIDENCE_TEST_PROVIDER:
    process.env.PONTE_LOCAL_EVIDENCE_TEST_PROVIDER,
  PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS:
    process.env.PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS,
};
const business = randomUUID();
const user = randomUUID();

Object.assign(process.env, {
  NODE_ENV: "test",
  PONTE_DEV_BUSINESS_ID: business,
  PONTE_DEV_USER_ID: user,
  PONTE_LOCAL_EVIDENCE_TEST_PROVIDER: "1",
  PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS: TEST_REGISTRY,
});

class ControlledDekProvider implements DekProvider {
  readonly provider = KMS_PROVIDER.LOCAL_TEST_ONLY;

  constructor(
    private readonly onCreate?: () => void | Promise<void>,
    private readonly failure?: Error,
  ) {}

  async createAndWrapDek(
    _context: DekWrappingContext,
  ): Promise<CreatedAndWrappedDek> {
    await this.onCreate?.();
    if (this.failure) throw this.failure;
    return {
      plaintextDek: Buffer.alloc(32, 83),
      wrappedDek: Buffer.from("normal-routing-evidence-test-dek-v1"),
      kmsProvider: KMS_PROVIDER.LOCAL_TEST_ONLY,
      kmsKeyReference: "local-test-only/normal-routing/evidence",
      kmsKeyVersion: "local-test-only/normal-routing/v1",
      wrappedDekAlgorithm: WRAPPED_DEK_ALGORITHM.LOCAL_TEST_RANDOM_BYTES_V1,
      wrappedDekFormat: WRAPPED_DEK_FORMAT.LOCAL_TEST_RANDOM_BYTES_V1,
    };
  }
}

function restoreEnvironment(): void {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function setNodeEnvironment(value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
  else Object.assign(process.env, { NODE_ENV: value });
}

function invoiceInput() {
  return {
    reference: `ROUTING-EVIDENCE-${randomUUID()}`,
    supplier: "Normal Routing evidence integration supplier",
    wallet: `0x${"b".repeat(40)}`,
    fundingMinor: "2500001",
    due: "2027-12-20",
    description: "Local simulation evidence integration test",
  };
}

function request(
  path: string,
  body?: unknown,
  key: string = randomUUID(),
  method = "POST",
): Request {
  return new Request(`http://localhost/api/v1/invoices${path}`, {
    method: body === undefined ? "GET" : method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function parts(path: string): string[] {
  return ["invoices", ...path.split("/").filter(Boolean)];
}

async function call(
  path: string,
  body?: unknown,
  key?: string,
  method?: string,
): Promise<unknown> {
  return execute(request(path, body, key, method), parts(path));
}

async function postEndpoint(path: string, body: unknown, key: string) {
  const { POST } = await import("../src/app/api/v1/[...path]/route");
  return POST(request(path, body, key), {
    params: Promise.resolve({ path: parts(path) }),
  });
}

async function createFundedInvoiceWithQuote(): Promise<{
  invoice: Invoice;
  quoteId: string;
}> {
  const invoice = (await call("", invoiceInput())) as Invoice;
  await call(`/${invoice.id}/transitions`, { status: "Pending payment" });
  await call(`/${invoice.id}/transitions`, { status: "Funded" });
  const quote = (await call(`/${invoice.id}/quotes`, {})) as { id: string };
  return { invoice, quoteId: quote.id };
}

function routingBody(
  quoteId: string,
  route: "direct" | "split" | "multi" = "split",
) {
  return { status: "Routing", route, quoteId };
}

async function routingCounts(invoiceId: string, key: string) {
  const result = await pool.query<{
    evidence: string;
    outbox: string;
    settlements: string;
    routing_events: string;
    idempotency: string;
    status: string;
  }>(
    "SELECT (SELECT count(*) FROM route_decision_evidence WHERE business_id=$1 AND invoice_id=$2)::text AS evidence,(SELECT count(*) FROM evidence_outbox o JOIN route_decision_evidence e ON e.id=o.evidence_record_id WHERE e.business_id=$1 AND e.invoice_id=$2)::text AS outbox,(SELECT count(*) FROM settlements WHERE business_id=$1 AND invoice_id=$2)::text AS settlements,(SELECT count(*) FROM payment_events WHERE business_id=$1 AND invoice_id=$2 AND kind='invoice.Routing')::text AS routing_events,(SELECT count(*) FROM idempotency WHERE business_id=$1 AND key=$3)::text AS idempotency,(SELECT status FROM invoices WHERE business_id=$1 AND id=$2) AS status",
    [business, invoiceId, key],
  );
  return result.rows[0];
}

function isApiError(code: string) {
  return (error: unknown): boolean =>
    error instanceof ApiError && error.code === code;
}

function controlledDependencies(provider: DekProvider) {
  return {
    resolveRoutingPreparationDependencies: () => ({
      provider,
      registryAddress: TEST_REGISTRY,
    }),
  };
}

before(async () => {
  await pool.query("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    business,
    "Normal Routing evidence integration test business",
  ]);
  await pool.query("INSERT INTO users(id,email) VALUES($1,$2)", [
    user,
    `${user}@example.invalid`,
  ]);
  await pool.query(
    "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,'admin','active')",
    [business, user],
  );
});

after(async () => {
  restoreEnvironment();
  await pool.end();
});

test("normal Routing endpoint atomically persists simulated settlement, encrypted evidence, pending outbox, event, and replay", async () => {
  const { invoice, quoteId } = await createFundedInvoiceWithQuote();
  const key = `routing-evidence-${randomUUID()}`;
  const body = routingBody(quoteId);

  const firstResponse = await postEndpoint(
    `/${invoice.id}/transitions`,
    body,
    key,
  );
  assert.equal(firstResponse.status, 200);
  const firstEnvelope = (await firstResponse.json()) as { data: Invoice };
  const routed = firstEnvelope.data;
  assert.equal(routed.status, "Routing");
  assert.equal(routed.selectedRoute, "split");
  const replayResponse = await postEndpoint(
    `/${invoice.id}/transitions`,
    body,
    key,
  );
  assert.equal(replayResponse.status, 200);
  assert.deepEqual((await replayResponse.json()).data, routed);
  assert.deepEqual(await routingCounts(invoice.id, key), {
    evidence: "1",
    outbox: "1",
    settlements: "1",
    routing_events: "1",
    idempotency: "1",
    status: "Routing",
  });

  const stored = await pool.query<{
    transaction_hash: string | null;
    submission_state: string;
    settlement_status: string;
    event_simulated: boolean;
    kms_provider: string;
    wrapped_dek_algorithm: string;
    wrapped_dek_format: string;
    kms_key_reference: string;
    kms_key_version: string;
  }>(
    "SELECT s.transaction_hash,o.submission_state,s.status AS settlement_status,(ev.data->>'simulated')::boolean AS event_simulated,e.kms_provider,e.wrapped_dek_algorithm,e.wrapped_dek_format,e.kms_key_reference,e.kms_key_version FROM settlements s JOIN route_decision_evidence e ON e.invoice_id=s.invoice_id JOIN evidence_outbox o ON o.evidence_record_id=e.id JOIN payment_events ev ON ev.invoice_id=s.invoice_id AND ev.kind='invoice.Routing' WHERE s.business_id=$1 AND s.invoice_id=$2",
    [business, invoice.id],
  );
  assert.deepEqual(stored.rows, [
    {
      transaction_hash: null,
      submission_state: "pending",
      settlement_status: "Routing",
      event_simulated: true,
      kms_provider: KMS_PROVIDER.LOCAL_TEST_ONLY,
      wrapped_dek_algorithm: WRAPPED_DEK_ALGORITHM.LOCAL_TEST_RANDOM_BYTES_V1,
      wrapped_dek_format: WRAPPED_DEK_FORMAT.LOCAL_TEST_RANDOM_BYTES_V1,
      kms_key_reference: "local-test-only/ephemeral/evidence",
      kms_key_version: "local-test-only/ephemeral/v1",
    },
  ]);
  const history = (await call(`/${invoice.id}/settlements`)) as Array<{
    simulated: boolean;
    transaction_hash: string | null;
    status: string;
  }>;
  assert.deepEqual(history, [
    {
      ...(
        await pool.query(
          "SELECT * FROM settlements WHERE business_id=$1 AND invoice_id=$2",
          [business, invoice.id],
        )
      ).rows[0],
      simulated: true,
    },
  ]);
  assert.equal(history[0].simulated, true);
  assert.equal(history[0].transaction_hash, null);
  assert.equal(history[0].status, "Routing");
});

test("provider preparation failure leaves normal Routing without any routing writes", async () => {
  const { invoice, quoteId } = await createFundedInvoiceWithQuote();
  const key = `routing-provider-failure-${randomUUID()}`;
  const provider = new ControlledDekProvider(
    undefined,
    new Error("test provider unavailable"),
  );

  await assert.rejects(
    __testOnlyExecute(
      request(`/${invoice.id}/transitions`, routingBody(quoteId), key),
      parts(`/${invoice.id}/transitions`),
      controlledDependencies(provider),
    ),
    isApiError("EVIDENCE_PROVIDER_UNAVAILABLE"),
  );
  assert.deepEqual(await routingCounts(invoice.id, key), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    routing_events: "0",
    idempotency: "0",
    status: "Funded",
  });
});

test("final locked-row validation failure rolls back all normal Routing writes", async () => {
  const { invoice, quoteId } = await createFundedInvoiceWithQuote();
  const key = `routing-stale-${randomUUID()}`;
  const provider = new ControlledDekProvider(async () => {
    await pool.query(
      "UPDATE invoices SET status='Failed',data=jsonb_set(data,'{status}','\"Failed\"'::jsonb) WHERE business_id=$1 AND id=$2",
      [business, invoice.id],
    );
  });

  await assert.rejects(
    __testOnlyExecute(
      request(`/${invoice.id}/transitions`, routingBody(quoteId), key),
      parts(`/${invoice.id}/transitions`),
      controlledDependencies(provider),
    ),
    isApiError("EVIDENCE_PREPARATION_STALE"),
  );
  assert.deepEqual(await routingCounts(invoice.id, key), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    routing_events: "0",
    idempotency: "0",
    status: "Failed",
  });
});

test("concurrent identical normal Routing requests commit one operation and return a durable replay", async () => {
  const { invoice, quoteId } = await createFundedInvoiceWithQuote();
  const key = `routing-race-${randomUUID()}`;
  const path = `/${invoice.id}/transitions`;
  const body = routingBody(quoteId);
  const [first, second] = await Promise.all([
    call(path, body, key),
    call(path, body, key),
  ]);

  assert.deepEqual(first, second);
  assert.equal((first as Invoice).status, "Routing");
  assert.deepEqual(await routingCounts(invoice.id, key), {
    evidence: "1",
    outbox: "1",
    settlements: "1",
    routing_events: "1",
    idempotency: "1",
    status: "Routing",
  });
});

test("normal Routing rejects a same-key conflicting payload without a second write", async () => {
  const { invoice, quoteId } = await createFundedInvoiceWithQuote();
  const key = `routing-conflict-${randomUUID()}`;
  const path = `/${invoice.id}/transitions`;
  await call(path, routingBody(quoteId), key);

  await assert.rejects(
    call(path, routingBody(quoteId, "direct"), key),
    isApiError("IDEMPOTENCY_CONFLICT"),
  );
  assert.deepEqual(await routingCounts(invoice.id, key), {
    evidence: "1",
    outbox: "1",
    settlements: "1",
    routing_events: "1",
    idempotency: "1",
    status: "Routing",
  });
});

test("disabled local evidence mode returns a safe endpoint error without routing writes", async () => {
  const { invoice, quoteId } = await createFundedInvoiceWithQuote();
  const key = `routing-disabled-${randomUUID()}`;
  const previousFlag = process.env.PONTE_LOCAL_EVIDENCE_TEST_PROVIDER;
  delete process.env.PONTE_LOCAL_EVIDENCE_TEST_PROVIDER;
  try {
    const response = await postEndpoint(
      `/${invoice.id}/transitions`,
      routingBody(quoteId),
      key,
    );
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()).error, {
      code: "EVIDENCE_PROVIDER_UNAVAILABLE",
    });
  } finally {
    if (previousFlag === undefined) {
      delete process.env.PONTE_LOCAL_EVIDENCE_TEST_PROVIDER;
    } else {
      process.env.PONTE_LOCAL_EVIDENCE_TEST_PROVIDER = previousFlag;
    }
  }
  assert.deepEqual(await routingCounts(invoice.id, key), {
    evidence: "0",
    outbox: "0",
    settlements: "0",
    routing_events: "0",
    idempotency: "0",
    status: "Funded",
  });
});

test("local test-provider metadata is explicit and configuration fails closed outside development or test", async () => {
  const previousFlag = process.env.PONTE_LOCAL_EVIDENCE_TEST_PROVIDER;
  const previousRegistry =
    process.env.PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousDevAuth = process.env.PONTE_DEV_AUTH;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  try {
    process.env.PONTE_DEV_AUTH = "1";
    process.env.DATABASE_URL =
      "postgres://ponte:local-only@localhost:54329/ponte";
    delete process.env.PONTE_LOCAL_EVIDENCE_TEST_PROVIDER;
    assert.throws(
      () => resolveLocalRoutingEvidencePreparationDependencies(),
      (error: unknown) =>
        error instanceof EvidenceCandidatePreparationError &&
        error.code === "PROVIDER_FAILURE",
    );

    process.env.PONTE_LOCAL_EVIDENCE_TEST_PROVIDER = "1";
    for (const environment of [
      undefined,
      "preview",
      "staging",
      "production",
    ] as const) {
      setNodeEnvironment(environment);
      assert.throws(
        () => resolveLocalRoutingEvidencePreparationDependencies(),
        (error: unknown) =>
          error instanceof EvidenceCandidatePreparationError &&
          error.code === "PROVIDER_FAILURE",
        `${environment ?? "unset"} runtime must fail closed`,
      );
    }

    setNodeEnvironment("test");
    process.env.PONTE_DEV_AUTH = "0";
    assert.throws(
      () => resolveLocalRoutingEvidencePreparationDependencies(),
      (error: unknown) =>
        error instanceof EvidenceCandidatePreparationError &&
        error.code === "PROVIDER_FAILURE",
    );
    process.env.PONTE_DEV_AUTH = "1";
    process.env.DATABASE_URL =
      "postgres://ponte:local-only@example.invalid/ponte";
    assert.throws(
      () => resolveLocalRoutingEvidencePreparationDependencies(),
      (error: unknown) =>
        error instanceof EvidenceCandidatePreparationError &&
        error.code === "PROVIDER_FAILURE",
    );
    process.env.DATABASE_URL =
      "postgres://ponte:local-only@localhost:54329/ponte";
    delete process.env.PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS;
    assert.throws(
      () => resolveLocalRoutingEvidencePreparationDependencies(),
      (error: unknown) =>
        error instanceof EvidenceCandidatePreparationError &&
        error.code === "PROVIDER_FAILURE",
    );
    process.env.PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS =
      "0x0000000000000000000000000000000000000000";
    assert.throws(
      () => resolveLocalRoutingEvidencePreparationDependencies(),
      (error: unknown) =>
        error instanceof EvidenceCandidatePreparationError &&
        error.code === "PROVIDER_FAILURE",
    );
    process.env.PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS =
      "not-a-registry-address";
    assert.throws(
      () => resolveLocalRoutingEvidencePreparationDependencies(),
      (error: unknown) =>
        error instanceof EvidenceCandidatePreparationError &&
        error.code === "PROVIDER_FAILURE",
    );
    process.env.PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS = TEST_REGISTRY;

    for (const environment of ["development", "test"] as const) {
      setNodeEnvironment(environment);
      if (environment === "development")
        await assert.rejects(
          __testOnlyExecute(request(""), parts(""), {}),
          /test-only service dependencies are unavailable/,
        );
      const dependencies = resolveLocalRoutingEvidencePreparationDependencies();
      const result = await dependencies.provider.createAndWrapDek({
        canonicalContext: Buffer.alloc(96),
      });
      assert.equal(isLocalTestOnlyDekWrappingMetadata(result), true);
      assert.equal(result.kmsProvider, KMS_PROVIDER.LOCAL_TEST_ONLY);
      assert.equal(
        result.wrappedDekAlgorithm,
        WRAPPED_DEK_ALGORITHM.LOCAL_TEST_RANDOM_BYTES_V1,
      );
      assert.equal(
        result.wrappedDekFormat,
        WRAPPED_DEK_FORMAT.LOCAL_TEST_RANDOM_BYTES_V1,
      );
      assert.match(result.kmsKeyReference, /^local-test-only\//);
      assert.match(result.kmsKeyVersion, /^local-test-only\//);
      assert.notEqual(result.kmsProvider, KMS_PROVIDER.GCP_CLOUD_KMS);
      assert.notEqual(result.kmsProvider, KMS_PROVIDER.AWS_KMS);
    }

    setNodeEnvironment("production");
    await assert.rejects(
      execute(request(""), parts("")),
      isApiError("AUTH_NOT_CONFIGURED"),
    );
  } finally {
    if (previousFlag === undefined) {
      delete process.env.PONTE_LOCAL_EVIDENCE_TEST_PROVIDER;
    } else {
      process.env.PONTE_LOCAL_EVIDENCE_TEST_PROVIDER = previousFlag;
    }
    if (previousRegistry === undefined) {
      delete process.env.PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS;
    } else {
      process.env.PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS = previousRegistry;
    }
    if (previousDevAuth === undefined) {
      delete process.env.PONTE_DEV_AUTH;
    } else {
      process.env.PONTE_DEV_AUTH = previousDevAuth;
    }
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    setNodeEnvironment(previousNodeEnv);
  }
});
