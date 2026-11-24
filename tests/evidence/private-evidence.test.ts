import assert from "node:assert/strict";
import test from "node:test";
import { keccak256 } from "ethers";
import { quote } from "../../src/lib/quotes";
import {
  buildCanonicalPrivateEvidenceAad,
  buildKmsWrappingContext,
  canonicalizePrivateEvidenceAad,
  EvidenceAadValidationError,
  KMS_WRAPPING_CONTEXT_DOMAIN,
  PRIVATE_EVIDENCE_AAD_DOMAIN,
  type CanonicalPrivateEvidenceAadInput,
} from "../../src/server/evidence/aad";
import {
  buildCanonicalPrivateEvidencePayload,
  PrivateEvidencePayloadValidationError,
  type ExpectedPrivateEvidenceCommitment,
  type PrivateEvidencePayloadInput,
} from "../../src/server/evidence/private-payload";

const ZERO = `0x${"00".repeat(32)}`;
const AAD_INPUT: CanonicalPrivateEvidenceAadInput = {
  aadVersion: 1,
  evidenceRecordId: "11111111-1111-4111-8111-111111111111",
  businessId: "22222222-2222-4222-8222-222222222222",
  invoiceId: "33333333-3333-4333-8333-333333333333",
  quoteId: "44444444-4444-4444-8444-444444444444",
  publicEvidenceId: `0x${"00".repeat(31)}01`,
  evidenceSchemaVersion: 1,
  chainId: 421614n,
  registryAddress: "0x1111111111111111111111111111111111111111",
};
const GOLDEN_AAD_HEX =
  "0x436d7077df329e5122318408d5ed7aa7e667e8e28093cc933a9e63f6097f25df00000000000000000000000000000000000000000000000000000000000000011111111111114111811111111111111100000000000000000000000000000000222222222222422282222222222222220000000000000000000000000000000033333333333343338333333333333333000000000000000000000000000000004444444444444444844444444444444400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000066eee0000000000000000000000001111111111111111111111111111111111111111";
const GOLDEN_AAD_DIGEST =
  "0xc137351e5142bbda198ae132f7114877bcb8e3429d406736f076f7adc942e7a0";
const GOLDEN_KMS_CONTEXT_HEX =
  "0xc993df0de465310923dc7d254e80cc9baedf8429461ac1cb3dfe5f224d5a4e370000000000000000000000000000000000000000000000000000000000000001c137351e5142bbda198ae132f7114877bcb8e3429d406736f076f7adc942e7a0";
const GOLDEN_KMS_CONTEXT_DIGEST =
  "0x6537d2ce395619e3697262d7bf54c54bda33985a2fdad660ff0ae3bea8f9b7af";
const EXPECTED_COMMITMENT: ExpectedPrivateEvidenceCommitment = {
  routeHashes: {
    direct:
      "0xe85d2a8ca64bc1f3ad17af15cdbf9ecbafd6b6e0dbcc0204c88dff4c053c49c5",
    split: "0x14cc28efa0b0a5ef475291933e00fd4df57799b4df4e17f8e708d30cf39b85a8",
    multi: "0x3228aca2f7a5eff947fbb4f3eb26ba1c10040af08fc55334e0d0e79d746988ee",
  },
  routesHash:
    "0x572b1d298236efd97ab0458241c3f4c7b578adfe82f2da378b95af510a92fc2c",
  quoteSnapshotHash:
    "0xb693b1782cabfe3e00a58212fc4ce0a2e16908c8739c095824b68e3a7c463d74",
  payloadHash:
    "0x2869f332484338b67f38eec00bf504f2b20333100d78054bfad729133cb51c1c",
};
const GOLDEN_PAYLOAD_JSON =
  '{"schema":"ponte-private-route-decision-evidence/v1","aadVersion":"1","record":{"evidenceRecordId":"11111111-1111-4111-8111-111111111111","businessId":"22222222-2222-4222-8222-222222222222","invoiceId":"33333333-3333-4333-8333-333333333333","quoteId":"44444444-4444-4444-8444-444444444444","publicEvidenceId":"0x0000000000000000000000000000000000000000000000000000000000000001","evidenceSchemaVersion":"1","quoteSchemaVersion":"1","chainId":"421614","registryAddress":"0x1111111111111111111111111111111111111111","sequence":"1","evidenceKind":"1","previousPayloadHash":"0x0000000000000000000000000000000000000000000000000000000000000000"},"invoice":{"fundingCurrency":"BRL","fundingMinor":"2500000"},"quote":{"source":"simulation-fixed-525","persistedSimulated":true,"expiresAtUnixMs":"1803859140000","data":{"simulated":true,"asset":"USDG","demoAssetDecimals":"2","fundingMinor":"2500000","rate":{"numerator":"525","denominator":"100"},"executionCostMinor":"2","routes":[{"id":"direct","code":"1","feeBps":"35","slippageBps":"5","toleranceBps":"50","feeMinor":"1667","outputMinor":"474523","minimumOutputMinor":"472150"},{"id":"split","code":"2","feeBps":"48","slippageBps":"8","toleranceBps":"50","feeMinor":"2286","outputMinor":"473904","minimumOutputMinor":"471534"},{"id":"multi","code":"3","feeBps":"65","slippageBps":"12","toleranceBps":"50","feeMinor":"3095","outputMinor":"473095","minimumOutputMinor":"470729"}]}},"decision":{"selectedRouteId":"direct","selectedRouteCode":"1"},"privateCommitmentInputs":{"salt":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"derivedCommitments":{"routeHashes":{"direct":"0xe85d2a8ca64bc1f3ad17af15cdbf9ecbafd6b6e0dbcc0204c88dff4c053c49c5","split":"0x14cc28efa0b0a5ef475291933e00fd4df57799b4df4e17f8e708d30cf39b85a8","multi":"0x3228aca2f7a5eff947fbb4f3eb26ba1c10040af08fc55334e0d0e79d746988ee"},"routesHash":"0x572b1d298236efd97ab0458241c3f4c7b578adfe82f2da378b95af510a92fc2c","quoteSnapshotHash":"0xb693b1782cabfe3e00a58212fc4ce0a2e16908c8739c095824b68e3a7c463d74","payloadHash":"0x2869f332484338b67f38eec00bf504f2b20333100d78054bfad729133cb51c1c"}}';
const GOLDEN_PAYLOAD_DIGEST =
  "0x890933213ea0022af3e0f0135c1f65ff20963926535ccad3f745ac869c8611ce";

function payloadInput(): PrivateEvidencePayloadInput {
  const persistedInvoiceData = Object.assign(
    { fundingCurrency: "BRL" as const, fundingMinor: "2500000" },
    {
      reference: "SYNTHETIC-PRIVATE-INVOICE",
      supplier: "Synthetic supplier must not serialize",
      customerEmail: "synthetic@example.invalid",
      paymentReference: "SYNTHETIC-PAYMENT-REFERENCE",
    },
  );
  return {
    aad: { ...AAD_INPUT },
    invoiceRow: {
      id: AAD_INPUT.invoiceId,
      business_id: AAD_INPUT.businessId,
      status: "Funded",
      funding_minor: "2500000",
      funding_currency: "BRL",
      data: persistedInvoiceData,
    },
    quoteRow: {
      id: AAD_INPUT.quoteId,
      business_id: AAD_INPUT.businessId,
      invoice_id: AAD_INPUT.invoiceId,
      source: "simulation-fixed-525",
      simulated: true,
      expires_at: new Date(1803859140000),
      data: {
        ...quote({ fundingMinor: "2500000" }),
        routes: quote({ fundingMinor: "2500000" }).routes.map((route) => ({
          ...route,
          customerRouteNote: "not serialized",
        })),
      },
    },
    selectedRouteId: "direct",
    sequence: "1",
    previousPayloadHash: ZERO,
    salt: `0x${"aa".repeat(32)}`,
    expectedCommitment: {
      ...EXPECTED_COMMITMENT,
      routeHashes: { ...EXPECTED_COMMITMENT.routeHashes },
    },
  };
}

const aadError = (error: unknown) =>
  error instanceof EvidenceAadValidationError;
const payloadError = (error: unknown) =>
  error instanceof PrivateEvidencePayloadValidationError ||
  error instanceof EvidenceAadValidationError;

test("AAD v1 has exact golden ABI bytes and digest", () => {
  const aad = buildCanonicalPrivateEvidenceAad(AAD_INPUT);
  assert.equal(PRIVATE_EVIDENCE_AAD_DOMAIN, GOLDEN_AAD_HEX.slice(0, 66));
  assert.equal(`0x${aad.toString("hex")}`, GOLDEN_AAD_HEX);
  assert.equal(aad.length, 320);
  assert.equal(keccak256(aad), GOLDEN_AAD_DIGEST);
});

test("AAD v1 is deterministic and all variable bound fields change it", () => {
  const first = buildCanonicalPrivateEvidenceAad(AAD_INPUT);
  assert.deepEqual(buildCanonicalPrivateEvidenceAad({ ...AAD_INPUT }), first);

  const alternatives: Array<Partial<CanonicalPrivateEvidenceAadInput>> = [
    { evidenceRecordId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { businessId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { invoiceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    { quoteId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
    { publicEvidenceId: `0x${"00".repeat(31)}02` },
    { registryAddress: "0x2222222222222222222222222222222222222222" },
  ];
  for (const change of alternatives) {
    assert.notDeepEqual(
      buildCanonicalPrivateEvidenceAad({ ...AAD_INPUT, ...change }),
      first,
    );
  }
});

test("AAD v1 rejects malformed or unsupported record bindings and unknown fields", () => {
  const invalids: unknown[] = [
    { ...AAD_INPUT, evidenceRecordId: "not-a-uuid" },
    {
      ...AAD_INPUT,
      businessId: "00000000-0000-0000-0000-000000000000",
    },
    { ...AAD_INPUT, publicEvidenceId: ZERO },
    { ...AAD_INPUT, publicEvidenceId: "0x1234" },
    { ...AAD_INPUT, registryAddress: `0x${"00".repeat(20)}` },
    { ...AAD_INPUT, registryAddress: "0x1234" },
    { ...AAD_INPUT, aadVersion: 2 },
    { ...AAD_INPUT, evidenceSchemaVersion: 2 },
    { ...AAD_INPUT, chainId: 1n },
    { ...AAD_INPUT, additionalData: "not allowed" },
  ];
  for (const invalid of invalids)
    assert.throws(
      () =>
        buildCanonicalPrivateEvidenceAad(
          invalid as CanonicalPrivateEvidenceAadInput,
        ),
      aadError,
    );
});

test("AAD values normalize UUIDs, public hashes, and addresses", () => {
  const uppercasePublicId = `0x${"AB".repeat(32)}`;
  const normalized = canonicalizePrivateEvidenceAad({
    ...AAD_INPUT,
    evidenceRecordId: AAD_INPUT.evidenceRecordId.toUpperCase(),
    publicEvidenceId: uppercasePublicId,
    registryAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  assert.equal(normalized.evidenceRecordId, AAD_INPUT.evidenceRecordId);
  assert.equal(normalized.publicEvidenceId, uppercasePublicId.toLowerCase());
  assert.equal(
    normalized.registryAddress,
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
});

test("KMS wrapping context v1 has exact golden bytes and binds the canonical AAD digest", () => {
  const aad = buildCanonicalPrivateEvidenceAad(AAD_INPUT);
  const context = buildKmsWrappingContext(aad);
  assert.equal(
    KMS_WRAPPING_CONTEXT_DOMAIN,
    GOLDEN_KMS_CONTEXT_HEX.slice(0, 66),
  );
  assert.equal(`0x${context.toString("hex")}`, GOLDEN_KMS_CONTEXT_HEX);
  assert.equal(context.length, 96);
  assert.equal(keccak256(context), GOLDEN_KMS_CONTEXT_DIGEST);
  assert.deepEqual(buildKmsWrappingContext(Buffer.from(aad)), context);
});

test("KMS wrapping context is deterministic, changes with AAD, and exposes no raw binding fields", () => {
  const aad = buildCanonicalPrivateEvidenceAad(AAD_INPUT);
  const changedAad = buildCanonicalPrivateEvidenceAad({
    ...AAD_INPUT,
    invoiceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  });
  const context = buildKmsWrappingContext(aad);
  assert.deepEqual(buildKmsWrappingContext(aad), context);
  assert.notDeepEqual(buildKmsWrappingContext(changedAad), context);
  assert.equal(
    context.includes(
      Buffer.from(AAD_INPUT.evidenceRecordId.replaceAll("-", ""), "hex"),
    ),
    false,
  );
  assert.equal(context.toString("utf8").includes("synthetic private"), false);
});

test("KMS wrapping context rejects empty, malformed, and zero-UUID AAD", () => {
  const zeroEvidenceRecordId = Buffer.from(
    buildCanonicalPrivateEvidenceAad(AAD_INPUT),
  );
  zeroEvidenceRecordId.fill(0, 64, 96);
  for (const value of [
    Buffer.alloc(0),
    Buffer.alloc(320),
    Buffer.alloc(319),
    zeroEvidenceRecordId,
  ]) {
    assert.throws(() => buildKmsWrappingContext(value), aadError);
  }
});

test("private payload v1 matches exact golden UTF-8 bytes and frozen commitment hashes", () => {
  const payload = buildCanonicalPrivateEvidencePayload(payloadInput());
  assert.deepEqual(payload, Buffer.from(GOLDEN_PAYLOAD_JSON, "utf8"));
  assert.equal(payload.toString("utf8"), GOLDEN_PAYLOAD_JSON);
  assert.equal(keccak256(payload), GOLDEN_PAYLOAD_DIGEST);

  const parsed = JSON.parse(payload.toString("utf8")) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(parsed), [
    "schema",
    "aadVersion",
    "record",
    "invoice",
    "quote",
    "decision",
    "privateCommitmentInputs",
    "derivedCommitments",
  ]);
  assert.equal(parsed.schema, "ponte-private-route-decision-evidence/v1");
  assert.deepEqual(parsed.derivedCommitments, EXPECTED_COMMITMENT);
});

test("private payload serialization is deterministic, allowlisted, and uses canonical decimal strings", () => {
  const first = buildCanonicalPrivateEvidencePayload(payloadInput());
  const second = buildCanonicalPrivateEvidencePayload(payloadInput());
  assert.deepEqual(first, second);
  const serialized = first.toString("utf8");
  for (const excluded of [
    "SYNTHETIC-PRIVATE-INVOICE",
    "Synthetic supplier must not serialize",
    "synthetic@example.invalid",
    "SYNTHETIC-PAYMENT-REFERENCE",
    "not serialized",
  ]) {
    assert.equal(serialized.includes(excluded), false);
  }

  const parsed = JSON.parse(serialized) as {
    aadVersion: string;
    record: Record<string, string>;
    quote: {
      expiresAtUnixMs: string;
      data: { routes: Array<Record<string, string>> };
    };
    decision: Record<string, string>;
  };
  assert.equal(parsed.aadVersion, "1");
  assert.equal(parsed.record.chainId, "421614");
  assert.equal(parsed.quote.expiresAtUnixMs, "1803859140000");
  assert.equal(parsed.decision.selectedRouteCode, "1");
  for (const route of parsed.quote.data.routes) {
    for (const field of [
      "code",
      "feeBps",
      "slippageBps",
      "toleranceBps",
      "feeMinor",
      "outputMinor",
      "minimumOutputMinor",
    ]) {
      assert.match(route[field], /^(0|[1-9][0-9]*)$/);
    }
  }
});

test("private payload rejects arbitrary top-level input fields", () => {
  const input = Object.assign(payloadInput(), { unsupported: "not allowed" });
  assert.throws(
    () => buildCanonicalPrivateEvidencePayload(input),
    payloadError,
  );
});

test("matching normalized persisted identities preserve every golden output", () => {
  const input = payloadInput();
  input.aad.businessId = input.aad.businessId.toUpperCase();
  input.aad.invoiceId = input.aad.invoiceId.toUpperCase();
  input.aad.quoteId = input.aad.quoteId.toUpperCase();
  input.invoiceRow.id = input.invoiceRow.id.toUpperCase();
  input.invoiceRow.business_id = input.invoiceRow.business_id.toUpperCase();
  input.quoteRow.id = input.quoteRow.id.toUpperCase();
  input.quoteRow.business_id = input.quoteRow.business_id.toUpperCase();
  input.quoteRow.invoice_id = input.quoteRow.invoice_id.toUpperCase();

  const aad = buildCanonicalPrivateEvidenceAad(input.aad);
  assert.equal(`0x${aad.toString("hex")}`, GOLDEN_AAD_HEX);
  assert.equal(
    `0x${buildKmsWrappingContext(aad).toString("hex")}`,
    GOLDEN_KMS_CONTEXT_HEX,
  );
  assert.equal(
    buildCanonicalPrivateEvidencePayload(input).toString("utf8"),
    GOLDEN_PAYLOAD_JSON,
  );
});

test("private payload rejects every persisted identity cross-binding mismatch generically", () => {
  const otherBusiness = "55555555-5555-4555-8555-555555555555";
  const anotherBusiness = "66666666-6666-4666-8666-666666666666";
  const otherInvoice = "77777777-7777-4777-8777-777777777777";
  const otherQuote = "88888888-8888-4888-8888-888888888888";
  const mutations: Array<{
    name: string;
    mutate: (input: PrivateEvidencePayloadInput) => void;
  }> = [
    {
      name: "quote from another business",
      mutate: (input) => {
        input.quoteRow.business_id = otherBusiness;
      },
    },
    {
      name: "quote from another invoice",
      mutate: (input) => {
        input.quoteRow.invoice_id = otherInvoice;
      },
    },
    {
      name: "quote persisted ID differs from AAD",
      mutate: (input) => {
        input.quoteRow.id = otherQuote;
      },
    },
    {
      name: "invoice persisted ID differs from AAD",
      mutate: (input) => {
        input.invoiceRow.id = otherInvoice;
      },
    },
    {
      name: "invoice business differs from AAD",
      mutate: (input) => {
        input.invoiceRow.business_id = otherBusiness;
      },
    },
    {
      name: "quote business differs from invoice business",
      mutate: (input) => {
        input.invoiceRow.business_id = otherBusiness;
        input.quoteRow.business_id = anotherBusiness;
      },
    },
  ];

  for (const { name, mutate } of mutations) {
    const input = payloadInput();
    mutate(input);
    assert.throws(
      () => buildCanonicalPrivateEvidencePayload(input),
      (error: unknown) => {
        assert(error instanceof PrivateEvidencePayloadValidationError, name);
        assert.equal(
          error.message,
          "persisted record identity does not match canonical AAD",
        );
        for (const privateValue of [
          input.aad.businessId,
          input.aad.invoiceId,
          input.aad.quoteId,
          input.invoiceRow.id,
          input.invoiceRow.business_id,
          input.quoteRow.id,
          input.quoteRow.business_id,
          input.quoteRow.invoice_id,
          input.salt,
        ]) {
          assert.equal(error.message.includes(privateValue), false);
        }
        return true;
      },
    );
  }
});

test("private payload emits the frozen selected-route code", () => {
  const input = payloadInput();
  input.expectedCommitment = undefined;
  input.selectedRouteId = "multi";
  const parsed = JSON.parse(
    buildCanonicalPrivateEvidencePayload(input).toString("utf8"),
  ) as { decision: { selectedRouteId: string; selectedRouteCode: string } };
  assert.deepEqual(parsed.decision, {
    selectedRouteId: "multi",
    selectedRouteCode: "3",
  });
});

test("private payload validates V1 route, binding, salt, registry, and predecessor tampering", () => {
  const mutations: Array<(input: PrivateEvidencePayloadInput) => void> = [
    (input) => {
      input.salt = ZERO;
    },
    (input) => {
      input.salt = `0x${"bb".repeat(32)}`;
    },
    (input) => {
      input.sequence = "2";
    },
    (input) => {
      input.selectedRouteId = "split";
    },
    (input) => {
      input.aad.publicEvidenceId = `0x${"00".repeat(31)}02`;
    },
    (input) => {
      input.aad.registryAddress = "0x2222222222222222222222222222222222222222";
    },
    (input) => {
      input.previousPayloadHash = `0x${"00".repeat(31)}01`;
    },
    (input) => {
      input.quoteRow.data.routes.reverse();
    },
    (input) => {
      input.quoteRow.data.routes[0].feeBps = 36;
    },
    (input) => {
      input.expectedCommitment!.payloadHash = `0x${"00".repeat(31)}02`;
    },
  ];
  for (const mutate of mutations) {
    const input = payloadInput();
    mutate(input);
    assert.throws(
      () => buildCanonicalPrivateEvidencePayload(input),
      payloadError,
    );
  }
});

test("private payload treats the invoice column as authoritative funding", () => {
  const columnVsQuote = payloadInput();
  columnVsQuote.invoiceRow.funding_minor = "2500001";
  columnVsQuote.invoiceRow.data.fundingMinor = "2500001";
  assert.throws(
    () => buildCanonicalPrivateEvidencePayload(columnVsQuote),
    payloadError,
  );

  const staleInvoiceJson = payloadInput();
  staleInvoiceJson.invoiceRow.data.fundingMinor = "2500001";
  assert.throws(
    () => buildCanonicalPrivateEvidencePayload(staleInvoiceJson),
    payloadError,
  );
});

test("private payload rejects invalid persisted quote metadata and expiry", () => {
  const mutations: Array<(input: PrivateEvidencePayloadInput) => void> = [
    (input) => {
      (
        input.invoiceRow.data as unknown as { fundingCurrency: string }
      ).fundingCurrency = "USD";
    },
    (input) => {
      input.quoteRow.data.fundingMinor = "2500001";
    },
    (input) => {
      input.quoteRow.source = "other-source";
    },
    (input) => {
      input.quoteRow.simulated = false;
    },
    (input) => {
      (input.quoteRow.data as unknown as { simulated: boolean }).simulated =
        false;
    },
    (input) => {
      (input.quoteRow.data as { asset: string }).asset = "OTHER";
    },
    (input) => {
      (input.quoteRow.data as { demoAssetDecimals: number }).demoAssetDecimals =
        3;
    },
    (input) => {
      input.quoteRow.data.rate.numerator = "524";
    },
    (input) => {
      input.quoteRow.data.executionCostMinor = "3";
    },
    (input) => {
      (input.quoteRow as unknown as { expires_at: unknown }).expires_at =
        "1803859140000.1";
    },
    (input) => {
      (input.quoteRow as unknown as { expires_at: unknown }).expires_at =
        "18446744073709551616";
    },
    (input) => {
      delete (input.quoteRow as unknown as Record<string, unknown>).source;
    },
  ];
  for (const mutate of mutations) {
    const input = payloadInput();
    mutate(input);
    assert.throws(
      () => buildCanonicalPrivateEvidencePayload(input),
      payloadError,
    );
  }
});

test("private payload validation errors and builders never log or reveal synthetic private inputs", () => {
  const calls: unknown[][] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const input = payloadInput();
  const secretFragments = [
    input.salt,
    input.aad.evidenceRecordId,
    "Synthetic supplier must not serialize",
  ];
  console.log = (...args: unknown[]) => calls.push(args);
  console.warn = (...args: unknown[]) => calls.push(args);
  console.error = (...args: unknown[]) => calls.push(args);
  try {
    buildCanonicalPrivateEvidencePayload(input);
    input.salt = ZERO;
    let error: unknown;
    try {
      buildCanonicalPrivateEvidencePayload(input);
    } catch (caught) {
      error = caught;
    }
    assert.equal(payloadError(error), true);
    for (const fragment of secretFragments)
      assert.equal(String(error).includes(fragment), false);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
  assert.deepEqual(calls, []);
});
