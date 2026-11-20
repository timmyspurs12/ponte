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
  readonly provider = KMS_PROVIDER.GCP_CLOUD_KMS;
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

    const plaintextDek = Buffer.from("42".repeat(32), "hex");
    this.returnedDeks.push(plaintextDek);
    return {
      plaintextDek,
      wrappedDek: Buffer.from("synthetic-wrapped-dek-v1", "utf8"),
      kmsProvider: KMS_PROVIDER.GCP_CLOUD_KMS,
      kmsKeyReference: "synthetic/test-candidate-key",
      kmsKeyVersion: "synthetic/version-1",
      wrappedDekAlgorithm: WRAPPED_DEK_ALGORITHM.GOOGLE_SYMMETRIC_ENCRYPTION,
      wrappedDekFormat: WRAPPED_DEK_FORMAT.GCP_KMS_ENCRYPT_CIPHERTEXT_V1,
      ...this.resultOverrides,
    } as CreatedAndWrappedDek;
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

test("sanitizes provider failures and does not log raw provider exceptions", async () => {
  const provider = new SyntheticFakeDekProvider();
  provider.throwError = new Error("RAW_PROVIDER_SECRET_do_not_expose");
  const calls: unknown[][] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => calls.push(args);
  console.warn = (...args: unknown[]) => calls.push(args);
  try {
    await assert.rejects(
      () => prepareEvidenceCandidate(input(provider)),
      (error: unknown) => {
        assert.equal(isPreparationError(error, "PROVIDER_FAILURE"), true);
        assert.equal(
          (error as Error).message.includes(
            "RAW_PROVIDER_SECRET_do_not_expose",
          ),
          false,
        );
        return true;
      },
    );
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  assert.equal(calls.length, 0);
});

test("rejects invalid and stale snapshot/input forms before provider invocation", async () => {
  const invalids: Array<PrepareEvidenceCandidateInput> = [];

  const missingInvoice = input();
  (
    missingInvoice as unknown as { snapshot: EvidencePreparationSnapshot }
  ).snapshot = {
    kind: "invoice_missing",
  };
  invalids.push(missingInvoice);

  const stale = input();
  if (stale.snapshot.kind === "ready")
    stale.snapshot.quote.expires_at = new Date(Date.now() - 1);
  invalids.push(stale);

  const invalidStatus = input();
  if (invalidStatus.snapshot.kind === "ready")
    invalidStatus.snapshot.invoice.status = "Routing";
  invalids.push(invalidStatus);

  const invalidRoute = input();
  invalidRoute.selectedRouteId = "not-a-route" as "split";
  invalids.push(invalidRoute);

  const zeroRegistry = input();
  zeroRegistry.registryAddress = `0x${"00".repeat(20)}`;
  invalids.push(zeroRegistry);

  const invalidFingerprint = input();
  invalidFingerprint.requestFingerprint = "not-a-request-fingerprint";
  invalids.push(invalidFingerprint);

  for (const invalid of invalids) {
    const provider = invalid.provider as SyntheticFakeDekProvider;
    await assert.rejects(
      () => prepareEvidenceCandidate(invalid),
      (error: unknown) => isPreparationError(error, "INVALID_INPUT"),
    );
    assert.equal(provider.calls, 0);
  }
});

test("prepared candidate digest detects mutable Buffer tampering", async () => {
  const candidate = await prepareEvidenceCandidate(input());
  assert.equal(verifyPreparedEvidenceCandidateIntegrity(candidate), true);

  const original = candidate.ciphertext[0];
  candidate.ciphertext[0] ^= 0xff;
  assert.equal(verifyPreparedEvidenceCandidateIntegrity(candidate), false);
  candidate.ciphertext[0] = original;
  assert.equal(verifyPreparedEvidenceCandidateIntegrity(candidate), true);
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
