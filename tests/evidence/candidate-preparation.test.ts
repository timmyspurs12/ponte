import assert from "node:assert/strict";
import test from "node:test";
import { keccak256 } from "ethers";
import { quote } from "../../src/lib/quotes";
import type { EvidencePreparationSnapshot } from "../../src/server/repository";
import {
  buildCanonicalPrivateEvidenceAad,
  buildKmsWrappingContext,
} from "../../src/server/evidence/aad";
import { buildRouteDecisionCommitment } from "../../src/server/evidence/commitment";
import { decryptEvidenceEnvelope } from "../../src/server/evidence/envelope";
import {
  KMS_PROVIDER,
  WRAPPED_DEK_ALGORITHM,
  WRAPPED_DEK_FORMAT,
  type CreatedAndWrappedDek,
  type DekProvider,
  type DekWrappingContext,
} from "../../src/server/evidence/kms";
import {
  EvidenceCandidatePreparationError,
  prepareEvidenceCandidate,
  verifyPreparedEvidenceCandidateIntegrity,
  type PrepareEvidenceCandidateInput,
  type PreparedEvidenceCandidate,
} from "../../src/server/evidence/prepare-candidate";

const BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const INVOICE_ID = "33333333-3333-4333-8333-333333333333";
const QUOTE_ID = "44444444-4444-4444-8444-444444444444";
const ACTOR_ID = "55555555-5555-4555-8555-555555555555";
const REGISTRY = "0x1111111111111111111111111111111111111111";
const REQUEST_FINGERPRINT = "ab".repeat(32);
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

/**
 * Explicitly synthetic test double only. It performs no cryptographic provider
 * operation, network request, credential lookup, or production-resource call.
 */
class SyntheticFakeDekProvider implements DekProvider {
  readonly provider = KMS_PROVIDER.LOCAL_TEST_ONLY;
  calls = 0;
  readonly contexts: Buffer[] = [];
  readonly returnedDeks: Buffer[] = [];
  throwError: Error | undefined;
  resultOverrides: Partial<CreatedAndWrappedDek> = {};

  async createAndWrapDek(
    context: DekWrappingContext,
  ): Promise<CreatedAndWrappedDek> {
    this.calls += 1;
    this.contexts.push(context.canonicalContext);
    if (this.throwError) throw this.throwError;

    const result = {
      plaintextDek: Buffer.from("42".repeat(32), "hex"),
      wrappedDek: Buffer.from("synthetic-wrapped-dek-v1", "utf8"),
      kmsProvider: KMS_PROVIDER.LOCAL_TEST_ONLY,
      kmsKeyReference: "local-test-only/test-candidate-key",
      kmsKeyVersion: "local-test-only/version-1",
      wrappedDekAlgorithm: WRAPPED_DEK_ALGORITHM.LOCAL_TEST_RANDOM_BYTES_V1,
      wrappedDekFormat: WRAPPED_DEK_FORMAT.LOCAL_TEST_RANDOM_BYTES_V1,
      ...this.resultOverrides,
    } as CreatedAndWrappedDek;
    if (Buffer.isBuffer(result.plaintextDek))
      this.returnedDeks.push(result.plaintextDek);
    return result;
  }
}

function readySnapshot(): Extract<
  EvidencePreparationSnapshot,
  { kind: "ready" }
> {
  const fundingMinor = "2500000";
  return {
    kind: "ready",
    invoice: {
      id: INVOICE_ID,
      business_id: BUSINESS_ID,
      status: "Funded",
      funding_minor: fundingMinor,
      funding_currency: "BRL",
      data: {
        fundingCurrency: "BRL",
        fundingMinor,
      },
    },
    quote: {
      id: QUOTE_ID,
      business_id: BUSINESS_ID,
      invoice_id: INVOICE_ID,
      source: "simulation-fixed-525",
      simulated: true,
      // Deliberately independent of wall-clock test execution until well after
      // the frozen evidence vectors; candidate preparation rejects expired rows.
      expires_at: new Date("2030-01-01T00:00:00.000Z"),
      data: quote({ fundingMinor }),
    },
  };
}

function input(
  provider = new SyntheticFakeDekProvider(),
): PrepareEvidenceCandidateInput {
  return {
    snapshot: readySnapshot(),
    selectedRouteId: "split",
    registryAddress: REGISTRY,
    createdByUserId: ACTOR_ID.toUpperCase(),
    requestFingerprint: REQUEST_FINGERPRINT.toUpperCase(),
    provider,
  };
}

function reconstructAad(
  candidate: Awaited<ReturnType<typeof prepareEvidenceCandidate>>,
) {
  return buildCanonicalPrivateEvidenceAad({
    aadVersion: candidate.aadVersion,
    evidenceRecordId: candidate.evidenceRecordId,
    businessId: candidate.businessId,
    invoiceId: candidate.invoiceId,
    quoteId: candidate.quoteId,
    publicEvidenceId: `0x${candidate.publicEvidenceId.toString("hex")}`,
    evidenceSchemaVersion: candidate.evidenceSchemaVersion,
    chainId: BigInt(candidate.chainId),
    registryAddress: candidate.registryAddress,
  });
}

async function captureZeroFills<T>(operation: () => Promise<T>): Promise<{
  result: T | undefined;
  error: unknown;
  cleared: Buffer[];
}> {
  const originalFill = Buffer.prototype.fill;
  const cleared: Buffer[] = [];
  Buffer.prototype.fill = function (this: Buffer, ...args: unknown[]): Buffer {
    if (args[0] === 0) cleared.push(this);
    return Reflect.apply(originalFill, this, args) as Buffer;
  } as typeof Buffer.prototype.fill;

  try {
    return { result: await operation(), error: undefined, cleared };
  } catch (error) {
    return { result: undefined, error, cleared };
  } finally {
    Buffer.prototype.fill = originalFill;
  }
}

async function captureConsoleCalls<T>(operation: () => Promise<T>): Promise<{
  result: T | undefined;
  error: unknown;
  calls: unknown[][];
}> {
  const calls: unknown[][] = [];
  const capture = (...args: unknown[]) => calls.push(args);
  const originals = {
    debug: console.debug,
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  console.debug = capture;
  console.error = capture;
  console.info = capture;
  console.log = capture;
  console.warn = capture;

  try {
    return { result: await operation(), error: undefined, calls };
  } catch (error) {
    return { result: undefined, error, calls };
  } finally {
    console.debug = originals.debug;
    console.error = originals.error;
    console.info = originals.info;
    console.log = originals.log;
    console.warn = originals.warn;
  }
}

function assertSanitizedPreparationError(
  error: unknown,
  code: EvidenceCandidatePreparationError["code"],
  forbidden: readonly string[],
): asserts error is EvidenceCandidatePreparationError {
  assert.equal(error instanceof EvidenceCandidatePreparationError, true);
  if (!(error instanceof EvidenceCandidatePreparationError)) return;
  assert.equal(error.code, code);
  const rendered = `${error.name}:${error.message}:${error.stack ?? ""}`;
  for (const value of forbidden)
    assert.equal(rendered.includes(value), false, `disclosed value: ${value}`);
}

function isPreparationError(
  error: unknown,
  code: EvidenceCandidatePreparationError["code"],
): error is EvidenceCandidatePreparationError {
  return (
    error instanceof EvidenceCandidatePreparationError && error.code === code
  );
}

test("prepares a frozen non-secret candidate with builder/hash agreement and decryptable payload", async () => {
  const provider = new SyntheticFakeDekProvider();
  const candidate = await prepareEvidenceCandidate(input(provider));

  assert.equal(provider.calls, 1);
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(Object.isFrozen(candidate.canonicalQuoteData), true);
  assert.equal(Object.isFrozen(candidate.routeHashes), true);
  assert.equal(candidate.createdByUserId, ACTOR_ID);
  assert.equal(candidate.requestFingerprint, REQUEST_FINGERPRINT);
  assert.equal(candidate.invoiceStatusAtSnapshot, "Funded");
  assert.equal(candidate.invoiceFundingCurrency, "BRL");
  assert.equal(candidate.selectedRouteId, "split");
  assert.equal(candidate.selectedRouteCode, 2);
  assert.equal(candidate.publicEvidenceId.length, 32);
  assert.equal(candidate.publicEvidenceId.equals(Buffer.alloc(32)), false);
  assert.equal(candidate.previousPayloadHash, ZERO_BYTES32);
  assert.equal(
    candidate.canonicalAadDigest,
    keccak256(reconstructAad(candidate)),
  );
  assert.equal(
    candidate.wrappingContextDigest,
    keccak256(buildKmsWrappingContext(reconstructAad(candidate))),
  );
  assert.equal(verifyPreparedEvidenceCandidateIntegrity(candidate), true);

  // The fake retains no usable copy of the buffer it returned to application
  // code; the separate test DEK reconstructs the controlled test operation.
  const testDek = Buffer.from("42".repeat(32), "hex");
  const aad = reconstructAad(candidate);
  const plaintext = decryptEvidenceEnvelope({
    ciphertext: candidate.ciphertext,
    nonce: candidate.nonce,
    authenticationTag: candidate.authenticationTag,
    envelopeVersion: candidate.envelopeVersion,
    contentAlgorithm: candidate.contentAlgorithm,
    dek: testDek,
    canonicalAad: aad,
  });
  const payload = JSON.parse(plaintext.toString("utf8")) as {
    privateCommitmentInputs: { salt: string };
    derivedCommitments: {
      routeHashes: { direct: string; split: string; multi: string };
      routesHash: string;
      quoteSnapshotHash: string;
      payloadHash: string;
    };
  };
  const snapshot = readySnapshot();
  const recomputed = buildRouteDecisionCommitment({
    invoice: {
      fundingCurrency: snapshot.invoice.data.fundingCurrency,
      fundingMinor: snapshot.invoice.funding_minor,
    },
    quoteRow: snapshot.quote,
    registry: candidate.registryAddress,
    evidenceId: `0x${candidate.publicEvidenceId.toString("hex")}`,
    sequence: candidate.sequence,
    selectedRouteId: candidate.selectedRouteId,
    previousPayloadHash: candidate.previousPayloadHash,
    salt: payload.privateCommitmentInputs.salt,
  });
  assert.deepEqual(payload.derivedCommitments, {
    routeHashes: candidate.routeHashes,
    routesHash: candidate.routesHash,
    quoteSnapshotHash: candidate.quoteSnapshotHash,
    payloadHash: candidate.payloadHash,
  });
  assert.deepEqual(recomputed.routeHashes, candidate.routeHashes);
  assert.equal(recomputed.routesHash, candidate.routesHash);
  assert.equal(recomputed.quoteSnapshotHash, candidate.quoteSnapshotHash);
  assert.equal(recomputed.payloadHash, candidate.payloadHash);

  const serialized = JSON.stringify(candidate);
  for (const forbidden of [
    "plaintextDek",
    "privatePayload",
    "canonicalContext",
    payload.privateCommitmentInputs.salt,
    aad.toString("hex"),
    testDek.toString("hex"),
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  const untypedCandidate = candidate as unknown as Record<string, unknown>;
  assert.equal(untypedCandidate.plaintextDek, undefined);
  assert.equal(untypedCandidate.salt, undefined);
  assert.equal(untypedCandidate.privatePayload, undefined);
  assert.equal(untypedCandidate.canonicalAad, undefined);
  assert.equal(untypedCandidate.canonicalContext, undefined);
});

test("clears all caller-owned sensitive buffers best-effort on success", async () => {
  const provider = new SyntheticFakeDekProvider();
  const observed = await captureZeroFills(() =>
    prepareEvidenceCandidate(input(provider)),
  );

  assert.equal(observed.error, undefined);
  assert.ok(observed.result);
  assert.equal(provider.returnedDeks.length, 1);
  assert.equal(provider.contexts.length, 1);
  assert.equal(provider.returnedDeks[0].equals(Buffer.alloc(32)), true);
  assert.equal(provider.contexts[0].equals(Buffer.alloc(96)), true);
  assert.equal(observed.cleared.includes(provider.returnedDeks[0]), true);
  assert.equal(observed.cleared.includes(provider.contexts[0]), true);
  assert.equal(
    observed.cleared.some((value) => value.length === 320),
    true,
  );
  assert.equal(
    observed.cleared.filter((value) => value.length === 32).length >= 2,
    true,
  );
  assert.equal(
    observed.cleared.some((value) => value.length > 320),
    true,
  );
  for (const cleared of observed.cleared)
    assert.equal(cleared.equals(Buffer.alloc(cleared.length)), true);
});

test("clears captured raw provider plaintext DEK when result validation fails", async () => {
  const provider = new SyntheticFakeDekProvider();
  provider.resultOverrides = { wrappedDek: Buffer.alloc(0) };
  const observed = await captureZeroFills(() =>
    prepareEvidenceCandidate(input(provider)),
  );

  assert.equal(
    isPreparationError(observed.error, "PROVIDER_RESULT_INVALID"),
    true,
  );
  assert.equal(provider.calls, 1);
  assert.equal(provider.returnedDeks[0].equals(Buffer.alloc(32)), true);
  assert.equal(provider.contexts[0].equals(Buffer.alloc(96)), true);
  assert.equal(observed.cleared.includes(provider.returnedDeks[0]), true);
  assert.equal(
    observed.cleared.some((value) => value.length === 320),
    true,
  );
  assert.equal(
    observed.cleared.some((value) => value.length > 320),
    true,
  );
});

test("rejects invalid provider results without disclosing metadata and clears raw DEKs", async () => {
  type InvalidProviderResultCase = {
    name: string;
    dekLength: number;
    overrides: (rawDek: Buffer) => Partial<CreatedAndWrappedDek>;
    forbidden: readonly string[];
  };
  const invalidResults: readonly InvalidProviderResultCase[] = [
    {
      name: "short plaintext DEK",
      dekLength: 31,
      overrides: (plaintextDek) => ({ plaintextDek }),
      forbidden: ["local-test-only/test-candidate-key"],
    },
    {
      name: "long plaintext DEK",
      dekLength: 33,
      overrides: (plaintextDek) => ({ plaintextDek }),
      forbidden: ["local-test-only/test-candidate-key"],
    },
    {
      name: "empty wrapped DEK",
      dekLength: 32,
      overrides: (plaintextDek) => ({
        plaintextDek,
        wrappedDek: Buffer.alloc(0),
      }),
      forbidden: ["local-test-only/test-candidate-key"],
    },
    {
      name: "result provider differs from declared provider",
      dekLength: 32,
      overrides: (plaintextDek) => ({
        plaintextDek,
        kmsProvider: KMS_PROVIDER.AWS_KMS,
        kmsKeyReference: "synthetic/test-aws-key",
        kmsKeyVersion: "synthetic/aws-version-1",
        wrappedDekAlgorithm:
          WRAPPED_DEK_ALGORITHM.AWS_KMS_GENERATE_DATA_KEY_AES_256,
        wrappedDekFormat:
          WRAPPED_DEK_FORMAT.AWS_KMS_GENERATE_DATA_KEY_CIPHERTEXT_BLOB_V1,
      }),
      forbidden: ["synthetic/test-aws-key", "synthetic/aws-version-1"],
    },
    {
      name: "unsupported provider algorithm format combination",
      dekLength: 32,
      overrides: (plaintextDek) => ({
        plaintextDek,
        wrappedDekAlgorithm:
          WRAPPED_DEK_ALGORITHM.AWS_KMS_GENERATE_DATA_KEY_AES_256,
        wrappedDekFormat:
          WRAPPED_DEK_FORMAT.AWS_KMS_GENERATE_DATA_KEY_CIPHERTEXT_BLOB_V1,
      }),
      forbidden: [
        WRAPPED_DEK_ALGORITHM.AWS_KMS_GENERATE_DATA_KEY_AES_256,
        WRAPPED_DEK_FORMAT.AWS_KMS_GENERATE_DATA_KEY_CIPHERTEXT_BLOB_V1,
      ],
    },
    {
      name: "malformed KMS key reference",
      dekLength: 32,
      overrides: (plaintextDek) => ({
        plaintextDek,
        kmsKeyReference: "synthetic/private key reference",
      }),
      forbidden: ["synthetic/private key reference"],
    },
    {
      name: "malformed KMS key version",
      dekLength: 32,
      overrides: (plaintextDek) => ({
        plaintextDek,
        kmsKeyVersion: "synthetic/private key version",
      }),
      forbidden: ["synthetic/private key version"],
    },
  ];

  for (const invalid of invalidResults) {
    const rawDek = Buffer.alloc(invalid.dekLength, 0x5a);
    const rawDekHex = rawDek.toString("hex");
    const provider = new SyntheticFakeDekProvider();
    provider.resultOverrides = invalid.overrides(rawDek);
    const observed = await captureConsoleCalls(() =>
      captureZeroFills(() => prepareEvidenceCandidate(input(provider))),
    );

    assert.equal(observed.error, undefined, invalid.name);
    assert.ok(observed.result, invalid.name);
    assert.equal(observed.result.result, undefined, invalid.name);
    assertSanitizedPreparationError(
      observed.result.error,
      "PROVIDER_RESULT_INVALID",
      [rawDekHex, ...invalid.forbidden],
    );
    assert.equal(provider.calls, 1, invalid.name);
    assert.strictEqual(provider.returnedDeks[0], rawDek, invalid.name);
    assert.equal(
      rawDek.equals(Buffer.alloc(rawDek.length)),
      true,
      invalid.name,
    );
    assert.equal(
      provider.contexts[0].equals(Buffer.alloc(96)),
      true,
      invalid.name,
    );
    assert.equal(observed.result.cleared.includes(rawDek), true, invalid.name);
    assert.equal(observed.calls.length, 0, invalid.name);
  }
});

test("sanitizes provider exceptions, logs nothing, and clears pre-provider buffers", async () => {
  const provider = new SyntheticFakeDekProvider();
  provider.throwError = new Error("RAW_PROVIDER_SECRET_do_not_expose");
  const observed = await captureConsoleCalls(() =>
    captureZeroFills(() => prepareEvidenceCandidate(input(provider))),
  );

  assert.equal(observed.error, undefined);
  assert.ok(observed.result);
  assert.equal(observed.result.result, undefined);
  assertSanitizedPreparationError(observed.result.error, "PROVIDER_FAILURE", [
    "RAW_PROVIDER_SECRET_do_not_expose",
    BUSINESS_ID,
    INVOICE_ID,
    QUOTE_ID,
    ACTOR_ID,
    REGISTRY,
  ]);
  assert.equal(provider.calls, 1);
  assert.equal(provider.contexts[0].equals(Buffer.alloc(96)), true);
  assert.equal(observed.calls.length, 0);
});

test("rejects every adversarial snapshot/input form before provider invocation", async () => {
  type InvalidInputCase = {
    name: string;
    mutate: (request: PrepareEvidenceCandidateInput) => void;
    forbidden?: readonly string[];
  };
  const invalidCases: readonly InvalidInputCase[] = [
    {
      name: "missing ready snapshot",
      mutate: (request) => {
        (
          request as unknown as { snapshot: EvidencePreparationSnapshot }
        ).snapshot = { kind: "invoice_missing" };
      },
    },
    {
      name: "non-Funded invoice status",
      mutate: (request) => {
        (request.snapshot.invoice as { status: string }).status = "Routing";
      },
    },
    {
      name: "non-BRL generated invoice currency",
      mutate: (request) => {
        (
          request.snapshot.invoice as { funding_currency: string }
        ).funding_currency = "PRIVATE_USD";
      },
      forbidden: ["PRIVATE_USD"],
    },
    {
      name: "non-BRL invoice JSON currency",
      mutate: (request) => {
        (
          request.snapshot.invoice.data as { fundingCurrency: string }
        ).fundingCurrency = "PRIVATE_USD";
      },
      forbidden: ["PRIVATE_USD"],
    },
    {
      name: "invoice JSON funding minor differs from authoritative column",
      mutate: (request) => {
        (
          request.snapshot.invoice.data as { fundingMinor: string }
        ).fundingMinor = "2500001";
      },
      forbidden: ["2500001"],
    },
    {
      name: "quote JSON funding minor differs from authoritative invoice column",
      mutate: (request) => {
        (request.snapshot.quote.data as { fundingMinor: string }).fundingMinor =
          "2500001";
      },
      forbidden: ["2500001"],
    },
    {
      name: "unsupported quote source",
      mutate: (request) => {
        (request.snapshot.quote as { source: string }).source =
          "private-quote-source";
      },
      forbidden: ["private-quote-source"],
    },
    {
      name: "false persisted quote simulated flag",
      mutate: (request) => {
        (request.snapshot.quote as { simulated: boolean }).simulated = false;
      },
    },
    {
      name: "false quote JSON simulated flag",
      mutate: (request) => {
        (request.snapshot.quote.data as { simulated: boolean }).simulated =
          false;
      },
    },
    {
      name: "invalid quote expiry Date",
      mutate: (request) => {
        (request.snapshot.quote as { expires_at: Date }).expires_at = new Date(
          Number.NaN,
        );
      },
    },
    {
      name: "expired quote",
      mutate: (request) => {
        (request.snapshot.quote as { expires_at: Date }).expires_at = new Date(
          0,
        );
      },
    },
    {
      name: "missing quote routes",
      mutate: (request) => {
        delete (request.snapshot.quote.data as unknown as { routes?: unknown })
          .routes;
      },
    },
    {
      name: "incomplete quote routes",
      mutate: (request) => {
        const data = request.snapshot.quote.data as unknown as {
          routes: unknown[];
        };
        data.routes = data.routes.slice(0, 2);
      },
    },
    {
      name: "duplicated quote route ID",
      mutate: (request) => {
        const data = request.snapshot.quote.data as unknown as {
          routes: Array<Record<string, unknown>>;
        };
        data.routes[2] = { ...data.routes[2], id: "split" };
      },
    },
    {
      name: "out-of-order quote routes",
      mutate: (request) => {
        const data = request.snapshot.quote.data as unknown as {
          routes: unknown[];
        };
        data.routes = [data.routes[1], data.routes[0], data.routes[2]];
      },
    },
    {
      name: "selected canonical route absent from quote",
      mutate: (request) => {
        request.selectedRouteId = "multi";
        const data = request.snapshot.quote.data as unknown as {
          routes: unknown[];
        };
        data.routes = data.routes.slice(0, 2);
      },
    },
    {
      name: "unknown selected route",
      mutate: (request) => {
        request.selectedRouteId = "private-route" as "split";
      },
      forbidden: ["private-route"],
    },
    {
      name: "invalid fixed quote rate",
      mutate: (request) => {
        (request.snapshot.quote.data.rate as { numerator: string }).numerator =
          "524";
      },
      forbidden: ["524"],
    },
    {
      name: "invalid fixed execution cost",
      mutate: (request) => {
        (
          request.snapshot.quote.data as { executionCostMinor: string }
        ).executionCostMinor =
          "30000000000000000000000000000000000000000000000001";
      },
      forbidden: ["30000000000000000000000000000000000000000000000001"],
    },
    {
      name: "malformed authenticated actor UUID",
      mutate: (request) => {
        request.createdByUserId = "private-malformed-actor";
      },
      forbidden: ["private-malformed-actor"],
    },
    {
      name: "zero authenticated actor UUID",
      mutate: (request) => {
        request.createdByUserId = "00000000-0000-0000-0000-000000000000";
      },
    },
    {
      name: "malformed registry address",
      mutate: (request) => {
        request.registryAddress = "private-not-an-address";
      },
      forbidden: ["private-not-an-address"],
    },
    {
      name: "zero registry address",
      mutate: (request) => {
        request.registryAddress = `0x${"00".repeat(20)}`;
      },
    },
    {
      name: "invalid request fingerprint",
      mutate: (request) => {
        request.requestFingerprint = "private-invalid-fingerprint";
      },
      forbidden: ["private-invalid-fingerprint"],
    },
    {
      name: "missing provider object",
      mutate: (request) => {
        (request as unknown as { provider: unknown }).provider = undefined;
      },
    },
    {
      name: "malformed provider object",
      mutate: (request) => {
        (request as unknown as { provider: unknown }).provider = {
          provider: KMS_PROVIDER.LOCAL_TEST_ONLY,
        };
      },
    },
    {
      name: "unsupported provider declaration",
      mutate: (request) => {
        (request as unknown as { provider: unknown }).provider = {
          provider: "synthetic-unsupported-provider",
          createAndWrapDek: async () => {
            throw new Error("provider must not be called");
          },
        };
      },
      forbidden: ["synthetic-unsupported-provider"],
    },
  ];

  for (const invalid of invalidCases) {
    const provider = new SyntheticFakeDekProvider();
    const request = input(provider);
    invalid.mutate(request);
    const observed = await captureConsoleCalls(() =>
      captureZeroFills(() => prepareEvidenceCandidate(request)),
    );

    assert.equal(observed.error, undefined, invalid.name);
    assert.ok(observed.result, invalid.name);
    assert.equal(observed.result.result, undefined, invalid.name);
    assertSanitizedPreparationError(observed.result.error, "INVALID_INPUT", [
      BUSINESS_ID,
      INVOICE_ID,
      QUOTE_ID,
      ACTOR_ID,
      REGISTRY,
      ...(invalid.forbidden ?? []),
    ]);
    assert.equal(provider.calls, 0, invalid.name);
    assert.equal(observed.calls.length, 0, invalid.name);
  }
});

test("prepared candidate integrity detects binary, digest, and forged-content tampering", async () => {
  const candidate = await prepareEvidenceCandidate(input());
  assert.equal(verifyPreparedEvidenceCandidateIntegrity(candidate), true);

  const inspectionCopies = {
    authenticationTag: Buffer.from(candidate.authenticationTag),
    ciphertext: Buffer.from(candidate.ciphertext),
    nonce: Buffer.from(candidate.nonce),
    publicEvidenceId: Buffer.from(candidate.publicEvidenceId),
    wrappedDek: Buffer.from(candidate.wrappedDek),
  };
  for (const value of Object.values(inspectionCopies)) value.fill(0xff);
  assert.equal(verifyPreparedEvidenceCandidateIntegrity(candidate), true);

  const binaryFields = [
    "publicEvidenceId",
    "ciphertext",
    "nonce",
    "authenticationTag",
    "wrappedDek",
  ] as const;
  for (const field of binaryFields) {
    const original = Buffer.from(candidate[field]);
    candidate[field][0] ^= 0xff;
    assert.equal(
      verifyPreparedEvidenceCandidateIntegrity(candidate),
      false,
      field,
    );
    candidate[field].set(original);
    assert.equal(
      verifyPreparedEvidenceCandidateIntegrity(candidate),
      true,
      field,
    );
  }

  const forgedQuoteCandidate = {
    ...candidate,
    canonicalQuoteData: {
      ...candidate.canonicalQuoteData,
      rate: {
        ...candidate.canonicalQuoteData.rate,
        numerator: "526",
      },
    },
  } as unknown as PreparedEvidenceCandidate;
  assert.equal(
    verifyPreparedEvidenceCandidateIntegrity(forgedQuoteCandidate),
    false,
  );

  const { wrappedDek: _wrappedDek, ...missingWrappedDek } = candidate;
  const malformedCandidates: unknown[] = [
    null,
    undefined,
    {},
    { ...candidate, preparedCandidateDigest: "" },
    { ...candidate, preparedCandidateDigest: "g".repeat(64) },
    { ...candidate, preparedCandidateDigest: "0".repeat(64) },
    missingWrappedDek,
    {
      ...candidate,
      canonicalQuoteData: null,
    },
  ];
  for (const malformed of malformedCandidates) {
    let verified: boolean | undefined;
    assert.doesNotThrow(() => {
      verified = verifyPreparedEvidenceCandidateIntegrity(
        malformed as PreparedEvidenceCandidate,
      );
    });
    assert.equal(verified, false);
  }
});

test("candidate preparation preserves the frozen commitment golden vector", () => {
  const frozen = buildRouteDecisionCommitment({
    invoice: { fundingCurrency: "BRL", fundingMinor: "2500000" },
    quoteRow: {
      source: "simulation-fixed-525",
      simulated: true,
      expires_at: "1803859140000",
      data: quote({ fundingMinor: "2500000" }),
    },
    registry: REGISTRY,
    evidenceId: `0x${"00".repeat(31)}01`,
    sequence: "1",
    selectedRouteId: "direct",
    previousPayloadHash: ZERO_BYTES32,
    salt: `0x${"aa".repeat(32)}`,
  });
  assert.deepEqual(frozen, {
    routeHashes: {
      direct:
        "0xe85d2a8ca64bc1f3ad17af15cdbf9ecbafd6b6e0dbcc0204c88dff4c053c49c5",
      split:
        "0x14cc28efa0b0a5ef475291933e00fd4df57799b4df4e17f8e708d30cf39b85a8",
      multi:
        "0x3228aca2f7a5eff947fbb4f3eb26ba1c10040af08fc55334e0d0e79d746988ee",
    },
    routesHash:
      "0x572b1d298236efd97ab0458241c3f4c7b578adfe82f2da378b95af510a92fc2c",
    quoteSnapshotHash:
      "0xb693b1782cabfe3e00a58212fc4ce0a2e16908c8739c095824b68e3a7c463d74",
    selectedRouteCode: 1,
    payloadHash:
      "0x2869f332484338b67f38eec00bf504f2b20333100d78054bfad729133cb51c1c",
  });
});
