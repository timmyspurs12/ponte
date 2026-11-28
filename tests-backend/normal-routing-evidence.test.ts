import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Invoice } from "../src/lib/models";
import { resolveLocalRoutingEvidencePreparationDependencies } from "../src/server/evidence/local-routing-config";
import { PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV } from "../src/server/evidence/kms-config-constants";
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
import { fixtures } from "./helpers/fixtures";

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
  await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    business,
    "Normal Routing evidence integration test business",
  ]);
  await fixtures("INSERT INTO users(id,email) VALUES($1,$2)", [
    user,
    `${user}@example.invalid`,
  ]);
  await fixtures(
    "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,'admin','active')",
    [business, user],
  );
});

after(async () => {
  restoreEnvironment();
  await pool.end();
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

test("service default dependency selection keeps local synthetic evidence when KMS configuration exists", async () => {
  // A valid production KMS configuration exists, but the test runtime must
  // not instantiate ADC or contact Google Cloud: the service default
  // dependency-selection point resolves the guarded local synthetic provider
  // and the full Routing flow persists explicitly local-test-only evidence.
  const previousKey = process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV];
  try {
    process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] =
      "projects/ponte-kms-12345/locations/africa-south1/keyRings/ponte-evidence/cryptoKeys/route-evidence/cryptoKeyVersions/7";
    const { invoice, quoteId } = await createFundedInvoiceWithQuote();
    const key = randomUUID();
    const result = (await call(
      `/${invoice.id}/transitions`,
      routingBody(quoteId),
      key,
    )) as Invoice;
    assert.equal(result.status, "Routing");
    const counts = await routingCounts(invoice.id, key);
    assert.equal(counts.evidence, "1");
    assert.equal(counts.outbox, "1");

    const evidence = await pool.query<{ kms_provider: string }>(
      "SELECT kms_provider FROM route_decision_evidence WHERE business_id=$1 AND invoice_id=$2",
      [business, invoice.id],
    );
    assert.equal(evidence.rows[0].kms_provider, KMS_PROVIDER.LOCAL_TEST_ONLY);
  } finally {
    if (previousKey === undefined)
      delete process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV];
    else
      process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV] = previousKey;
  }
});
