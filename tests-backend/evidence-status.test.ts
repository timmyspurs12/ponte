import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Invoice, InvoiceEvidenceStatus } from "../src/lib/models";
import { evidenceProvenance } from "../src/server/evidence/status";
import { ApiError, execute } from "../src/server/service";
import { pool } from "../src/server/repository";

const token = process.env.PONTE_DEV_TOKEN!;
const userId = process.env.PONTE_DEV_USER_ID!;
const configuredBusinessId = process.env.PONTE_DEV_BUSINESS_ID!;
let businessId = "";

function api(
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
  authorization = token,
): Promise<unknown> {
  return execute(
    new Request(`http://localhost/api/v1/invoices${path}`, {
      method,
      headers: {
        authorization: `Bearer ${authorization}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "POST"
          ? { "idempotency-key": `evidence-status-${randomUUID()}` }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    ["invoices", ...path.split("/").filter(Boolean)],
  );
}

async function createInvoice(): Promise<Invoice> {
  return api("", "POST", {
    reference: `EVIDENCE-STATUS-${randomUUID()}`,
    supplier: "Evidence status supplier",
    wallet: `0x${"e".repeat(40)}`,
    fundingMinor: "2500001",
    due: "2027-12-20",
    description: "Evidence status integration test",
  }) as Promise<Invoice>;
}

async function createRoutedInvoice(): Promise<Invoice> {
  const invoice = await createInvoice();
  await api(`/${invoice.id}/transitions`, "POST", {
    status: "Pending payment",
  });
  await api(`/${invoice.id}/payments`, "POST", {});
  const quote = (await api(`/${invoice.id}/quotes`, "POST", {})) as {
    id: string;
  };
  return api(`/${invoice.id}/transitions`, "POST", {
    status: "Routing",
    route: "direct",
    quoteId: quote.id,
  }) as Promise<Invoice>;
}

const isApiError =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof ApiError && error.code === code;

before(async () => {
  // Isolate these additional endpoint requests from the foundation suite's
  // intentional per-tenant rate-limit coverage.
  businessId = randomUUID();
  await pool.query("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    businessId,
    "Evidence status integration business",
  ]);
  await pool.query(
    "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,'admin','active')",
    [businessId, userId],
  );
  process.env.PONTE_DEV_BUSINESS_ID = businessId;
});

after(async () => {
  process.env.PONTE_DEV_BUSINESS_ID = configuredBusinessId;
  await pool.end();
});

test("authorized invoice reader receives the deliberate pending evidence status without envelope secrets", async () => {
  const invoice = await createRoutedInvoice();
  const status = (await api(
    `/${invoice.id}/evidence`,
  )) as InvoiceEvidenceStatus;

  assert.equal(status.state, "persisted");
  assert.equal(status.invoiceId, invoice.id);
  assert.equal(status.evidence.evidenceKind, 1);
  assert.equal(status.evidence.evidenceSchemaVersion, 1);
  assert.equal(status.evidence.chainId, "421614");
  assert.equal(status.evidence.sequence, "1");
  assert.match(status.evidence.publicEvidenceId, /^0x[a-f0-9]{64}$/);
  assert.match(status.evidence.registryAddress, /^0x[a-f0-9]{40}$/);
  assert.match(status.evidence.payloadHash, /^0x[a-f0-9]{64}$/);
  assert.equal(status.evidence.outboxSubmissionState, "pending");
  assert.deepEqual(status.anchoring, {
    verified: false,
    status: "not_verified",
  });
  assert.equal(status.evidence.provenance.provider, "local-test-only");
  assert.match(
    status.evidence.provenance.disclosure,
    /synthetic|real cloud kms/i,
  );

  const serialized = JSON.stringify(status).toLowerCase();
  for (const forbidden of [
    "ciphertext",
    "wrapped_dek",
    "wrappeddek",
    "plaintext",
    "nonce",
    "authentication_tag",
    "authenticationtag",
    "aad",
    "canonicalcontext",
    "kms_key_reference",
    "kmskeyreference",
    "kms_key_version",
    "kmskeyversion",
    "transaction_hash",
    "transactionhash",
  ])
    assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("missing evidence is an explicit empty state for an authorized invoice reader", async () => {
  const invoice = await createInvoice();
  const status = (await api(
    `/${invoice.id}/evidence`,
  )) as InvoiceEvidenceStatus;
  assert.deepEqual(status, {
    state: "missing",
    invoiceId: invoice.id,
    evidence: null,
  });
});

test("evidence status rejects unauthenticated and disabled memberships", async () => {
  const invoice = await createInvoice();
  await assert.rejects(
    api(`/${invoice.id}/evidence`, "GET", undefined, "wrong-token"),
    isApiError("UNAUTHENTICATED"),
  );

  await pool.query(
    "UPDATE memberships SET status='disabled' WHERE business_id=$1 AND user_id=$2",
    [businessId, userId],
  );
  try {
    await assert.rejects(
      api(`/${invoice.id}/evidence`),
      isApiError("FORBIDDEN"),
    );
  } finally {
    await pool.query(
      "UPDATE memberships SET status='active' WHERE business_id=$1 AND user_id=$2",
      [businessId, userId],
    );
  }
});

test("active viewers retain the established invoice-detail read policy but cannot cross business or invoice evidence", async () => {
  const withEvidence = await createRoutedInvoice();
  const withoutEvidence = await createInvoice();
  await pool.query(
    "UPDATE memberships SET role='viewer' WHERE business_id=$1 AND user_id=$2",
    [businessId, userId],
  );
  try {
    const viewerStatus = (await api(
      `/${withEvidence.id}/evidence`,
    )) as InvoiceEvidenceStatus;
    assert.equal(viewerStatus.state, "persisted");
  } finally {
    await pool.query(
      "UPDATE memberships SET role='admin' WHERE business_id=$1 AND user_id=$2",
      [businessId, userId],
    );
  }

  const differentInvoice = (await api(
    `/${withoutEvidence.id}/evidence`,
  )) as InvoiceEvidenceStatus;
  assert.deepEqual(differentInvoice, {
    state: "missing",
    invoiceId: withoutEvidence.id,
    evidence: null,
  });
  assert.equal(
    JSON.stringify(differentInvoice).includes(withEvidence.id),
    false,
  );

  const otherBusiness = randomUUID();
  await pool.query("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    otherBusiness,
    "Evidence status isolation business",
  ]);
  await pool.query(
    "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,'admin','active')",
    [otherBusiness, userId],
  );
  const previousBusiness = process.env.PONTE_DEV_BUSINESS_ID;
  process.env.PONTE_DEV_BUSINESS_ID = otherBusiness;
  try {
    await assert.rejects(
      api(`/${withEvidence.id}/evidence`),
      isApiError("NOT_FOUND"),
    );
  } finally {
    process.env.PONTE_DEV_BUSINESS_ID = previousBusiness;
  }
});

test("GCP provenance wording remains metadata-only rather than an anchoring assertion", () => {
  const provenance = evidenceProvenance("gcp-cloud-kms");
  assert.equal(provenance.category, "genuine-gcp-metadata");
  assert.match(provenance.disclosure, /not proof of registry anchoring/i);
  assert.doesNotMatch(provenance.disclosure, /verified|confirmed|anchored/i);
});
