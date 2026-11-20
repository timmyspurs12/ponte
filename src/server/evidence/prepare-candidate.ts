// Candidate preparation is intentionally isolated from repository, Routing, and
// provider implementations. It creates no database connection or transaction.
import "server-only";

import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { keccak256 } from "ethers";
import type { RouteCandidate } from "../../lib/models";
import type { EvidencePreparationSnapshot } from "../repository";
import {
  buildCanonicalPrivateEvidenceAad,
  buildKmsWrappingContext,
  canonicalizeEvidenceUuid,
  canonicalizePrivateEvidenceAad,
  PRIVATE_EVIDENCE_AAD_VERSION,
} from "./aad";
import {
  ARBITRUM_SEPOLIA_CHAIN_ID,
  buildRouteDecisionCommitment,
  CANONICAL_ROUTE_IDS,
  type CanonicalRouteId,
  EVIDENCE_SCHEMA_VERSION,
  QUOTE_SCHEMA_VERSION,
  SIMULATED_ROUTE_DECISION_KIND,
} from "./commitment";
import {
  EVIDENCE_CONTENT_ALGORITHM,
  EVIDENCE_ENVELOPE_VERSION,
  encryptEvidenceEnvelope,
} from "./envelope";
import {
  assertDekProviderResult,
  clearDekBestEffort,
  KMS_PROVIDER,
  type CreatedAndWrappedDek,
  type DekProvider,
  type KmsProviderIdentifier,
  type WrappedDekAlgorithmIdentifier,
  type WrappedDekFormatIdentifier,
} from "./kms";
import {
  buildCanonicalPrivateEvidencePayload,
  type ExpectedPrivateEvidenceCommitment,
} from "./private-payload";

const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const PREPARED_CANDIDATE_DIGEST_DOMAIN = "PONTE_PREPARED_EVIDENCE_CANDIDATE_V1";
const REQUEST_FINGERPRINT = /^[0-9a-f]{64}$/i;

export type EvidenceCandidatePreparationErrorCode =
  | "INVALID_INPUT"
  | "PROVIDER_FAILURE"
  | "PROVIDER_RESULT_INVALID"
  | "ENCRYPTION_FAILED"
  | "PREPARATION_FAILED";

const ERROR_MESSAGES: Readonly<
  Record<EvidenceCandidatePreparationErrorCode, string>
> = Object.freeze({
  INVALID_INPUT: "evidence candidate input is invalid",
  PROVIDER_FAILURE: "evidence candidate provider operation failed",
  PROVIDER_RESULT_INVALID: "evidence candidate provider result is invalid",
  ENCRYPTION_FAILED: "evidence candidate encryption failed",
  PREPARATION_FAILED: "evidence candidate preparation failed",
});

/** A fixed, non-sensitive error boundary for future API/service integration. */
export class EvidenceCandidatePreparationError extends Error {
  readonly code: EvidenceCandidatePreparationErrorCode;

  constructor(code: EvidenceCandidatePreparationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "EvidenceCandidatePreparationError";
    this.code = code;
  }
}

export type ReadyEvidencePreparationSnapshot = Extract<
  EvidencePreparationSnapshot,
  { kind: "ready" }
>;

export interface PrepareEvidenceCandidateInput {
  /** Already completed non-locking persisted read; no repository call is made here. */
  snapshot: ReadyEvidencePreparationSnapshot;
  selectedRouteId: CanonicalRouteId;
  /** Explicit caller-supplied deployment value; no default or environment fallback exists. */
  registryAddress: string;
  createdByUserId: string;
  requestFingerprint: string;
  /** Existing narrow provider boundary; concrete providers remain out of scope. */
  provider: DekProvider;
}

export interface CandidateRouteData {
  id: CanonicalRouteId;
  feeBps: number;
  slippageBps: number;
  toleranceBps: number;
  feeMinor: string;
  outputMinor: string;
  minimumOutputMinor: string;
}

export interface CandidateQuoteData {
  simulated: true;
  asset: "USDG";
  demoAssetDecimals: 2;
  fundingMinor: string;
  rate: Readonly<{ numerator: string; denominator: string }>;
  executionCostMinor: string;
  routes: readonly Readonly<CandidateRouteData>[];
}

/**
 * All fields are non-secret. Buffers are candidate-owned copies, but JavaScript
 * Buffers remain mutable even when this object is frozen; callers must verify
 * `preparedCandidateDigest` before a future final transaction consumes it.
 */
export interface PreparedEvidenceCandidate {
  readonly requestFingerprint: string;
  readonly createdByUserId: string;
  readonly routingCorrelationId: string;
  readonly outboxId: string;

  readonly evidenceRecordId: string;
  readonly businessId: string;
  readonly invoiceId: string;
  readonly quoteId: string;
  readonly invoiceFundingMinor: string;
  readonly invoiceFundingCurrency: "BRL";
  readonly invoiceStatusAtSnapshot: "Funded";
  readonly quoteSource: "simulation-fixed-525";
  readonly quoteSimulated: true;
  readonly quoteExpiresAtUnixMs: string;
  readonly canonicalQuoteData: Readonly<CandidateQuoteData>;
  readonly selectedRouteId: CanonicalRouteId;
  readonly selectedRouteCode: number;

  readonly publicEvidenceId: Buffer;
  readonly evidenceSchemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  readonly quoteSchemaVersion: typeof QUOTE_SCHEMA_VERSION;
  readonly aadVersion: typeof PRIVATE_EVIDENCE_AAD_VERSION;
  readonly chainId: string;
  readonly registryAddress: string;
  readonly sequence: "1";
  readonly evidenceKind: typeof SIMULATED_ROUTE_DECISION_KIND;
  readonly previousPayloadHash: string;

  readonly routeHashes: Readonly<{
    direct: string;
    split: string;
    multi: string;
  }>;
  readonly routesHash: string;
  readonly quoteSnapshotHash: string;
  readonly payloadHash: string;
  readonly canonicalAadDigest: string;
  readonly wrappingContextDigest: string;

  readonly envelopeVersion: typeof EVIDENCE_ENVELOPE_VERSION;
  readonly contentAlgorithm: typeof EVIDENCE_CONTENT_ALGORITHM;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly authenticationTag: Buffer;
  readonly wrappedDek: Buffer;
  readonly kmsProvider: KmsProviderIdentifier;
  readonly wrappedDekAlgorithm: WrappedDekAlgorithmIdentifier;
  readonly wrappedDekFormat: WrappedDekFormatIdentifier;
  readonly kmsKeyReference: string;
  readonly kmsKeyVersion: string;

  readonly preparedCandidateDigest: string;
}

type PreparedEvidenceCandidateWithoutDigest = Omit<
  PreparedEvidenceCandidate,
  "preparedCandidateDigest"
>;

type ReadySnapshot = ReadyEvidencePreparationSnapshot;

function preparationError(code: EvidenceCandidatePreparationErrorCode): never {
  throw new EvidenceCandidatePreparationError(code);
}

function clearBufferBestEffort(value: unknown): void {
  if (!Buffer.isBuffer(value)) return;
  try {
    clearDekBestEffort(value);
  } catch {
    // Best effort only: cleanup must never replace the original failure.
  }
}

function normalizeRequestFingerprint(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_FINGERPRINT.test(value))
    return preparationError("INVALID_INPUT");
  return value.toLowerCase();
}

function assertProvider(value: unknown): asserts value is DekProvider {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { createAndWrapDek?: unknown }).createAndWrapDek !==
      "function" ||
    !Object.values(KMS_PROVIDER).includes(
      (value as { provider?: unknown }).provider as KmsProviderIdentifier,
    )
  ) {
    preparationError("INVALID_INPUT");
  }
}

function freshNonZeroBytes32(): Buffer {
  while (true) {
    const value = randomBytes(32);
    if (value.some((byte) => byte !== 0)) return value;
    clearBufferBestEffort(value);
  }
}

function bytes32Hex(value: Buffer): string {
  return `0x${value.toString("hex")}`;
}

function exactExpiryMilliseconds(value: unknown): string {
  if (!(value instanceof Date)) return preparationError("INVALID_INPUT");
  const milliseconds = value.getTime();
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds <= Date.now()
  ) {
    return preparationError("INVALID_INPUT");
  }
  return milliseconds.toString();
}

function assertReadySnapshot(
  snapshot: EvidencePreparationSnapshot,
  selectedRouteId: CanonicalRouteId,
): ReadySnapshot {
  if (!snapshot || snapshot.kind !== "ready")
    return preparationError("INVALID_INPUT");

  const { invoice, quote } = snapshot;
  if (
    !invoice ||
    !quote ||
    invoice.status !== "Funded" ||
    invoice.funding_currency !== "BRL" ||
    invoice.data?.fundingCurrency !== "BRL" ||
    typeof invoice.funding_minor !== "string" ||
    invoice.data.fundingMinor !== invoice.funding_minor ||
    quote.business_id !== invoice.business_id ||
    quote.invoice_id !== invoice.id ||
    quote.source !== "simulation-fixed-525" ||
    quote.simulated !== true ||
    !quote.data ||
    quote.data.simulated !== true ||
    quote.data.fundingMinor !== invoice.funding_minor ||
    !(CANONICAL_ROUTE_IDS as readonly string[]).includes(selectedRouteId) ||
    !Array.isArray(quote.data.routes) ||
    !quote.data.routes.some((route) => route?.id === selectedRouteId)
  ) {
    return preparationError("INVALID_INPUT");
  }

  exactExpiryMilliseconds(quote.expires_at);
  return snapshot;
}

function canonicalQuoteData(
  routes: readonly RouteCandidate[],
  quote: ReadySnapshot["quote"]["data"],
): Readonly<CandidateQuoteData> {
  const copiedRoutes = routes.map((route, index) =>
    Object.freeze({
      id: CANONICAL_ROUTE_IDS[index],
      feeBps: route.feeBps,
      slippageBps: route.slippageBps,
      toleranceBps: route.toleranceBps,
      feeMinor: route.feeMinor,
      outputMinor: route.outputMinor,
      minimumOutputMinor: route.minimumOutputMinor,
    }),
  ) as readonly Readonly<CandidateRouteData>[];

  return Object.freeze({
    simulated: quote.simulated,
    asset: quote.asset,
    demoAssetDecimals: quote.demoAssetDecimals,
    fundingMinor: quote.fundingMinor,
    rate: Object.freeze({
      numerator: quote.rate.numerator,
      denominator: quote.rate.denominator,
    }),
    executionCostMinor: quote.executionCostMinor,
    routes: Object.freeze(copiedRoutes),
  });
}

function pushUint32(parts: Buffer[], value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
    throw new Error("candidate digest field length is invalid");
  const encoded = Buffer.allocUnsafe(4);
  encoded.writeUInt32BE(value);
  parts.push(encoded);
}

/**
 * Deterministic domain-separated, length-prefixed encoding. Each field is
 * encoded as uint32(label length) || label UTF-8 || uint32(value length) ||
 * exact value bytes; labels and a fixed order make the representation unambiguous.
 */
function digestParts(
  candidate: PreparedEvidenceCandidateWithoutDigest,
): Buffer[] {
  const parts: Buffer[] = [];
  const push = (label: string, value: string | Buffer) => {
    const labelBytes = Buffer.from(label, "utf8");
    const valueBytes = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value, "utf8");
    pushUint32(parts, labelBytes.length);
    parts.push(labelBytes);
    pushUint32(parts, valueBytes.length);
    parts.push(valueBytes);
  };
  const pushNumber = (label: string, value: number) =>
    push(label, value.toString());
  const pushBoolean = (label: string, value: boolean) =>
    push(label, value ? "true" : "false");

  push("domain", PREPARED_CANDIDATE_DIGEST_DOMAIN);
  push("requestFingerprint", candidate.requestFingerprint);
  push("createdByUserId", candidate.createdByUserId);
  push("routingCorrelationId", candidate.routingCorrelationId);
  push("outboxId", candidate.outboxId);

  push("evidenceRecordId", candidate.evidenceRecordId);
  push("businessId", candidate.businessId);
  push("invoiceId", candidate.invoiceId);
  push("quoteId", candidate.quoteId);
  push("invoiceFundingMinor", candidate.invoiceFundingMinor);
  push("invoiceFundingCurrency", candidate.invoiceFundingCurrency);
  push("invoiceStatusAtSnapshot", candidate.invoiceStatusAtSnapshot);
  push("quoteSource", candidate.quoteSource);
  pushBoolean("quoteSimulated", candidate.quoteSimulated);
  push("quoteExpiresAtUnixMs", candidate.quoteExpiresAtUnixMs);
  pushBoolean("quoteData.simulated", candidate.canonicalQuoteData.simulated);
  push("quoteData.asset", candidate.canonicalQuoteData.asset);
  pushNumber(
    "quoteData.demoAssetDecimals",
    candidate.canonicalQuoteData.demoAssetDecimals,
  );
  push("quoteData.fundingMinor", candidate.canonicalQuoteData.fundingMinor);
  push("quoteData.rate.numerator", candidate.canonicalQuoteData.rate.numerator);
  push(
    "quoteData.rate.denominator",
    candidate.canonicalQuoteData.rate.denominator,
  );
  push(
    "quoteData.executionCostMinor",
    candidate.canonicalQuoteData.executionCostMinor,
  );
  pushNumber(
    "quoteData.routes.length",
    candidate.canonicalQuoteData.routes.length,
  );
  for (const [index, route] of candidate.canonicalQuoteData.routes.entries()) {
    const prefix = `quoteData.routes.${index}`;
    push(`${prefix}.id`, route.id);
    pushNumber(`${prefix}.feeBps`, route.feeBps);
    pushNumber(`${prefix}.slippageBps`, route.slippageBps);
    pushNumber(`${prefix}.toleranceBps`, route.toleranceBps);
    push(`${prefix}.feeMinor`, route.feeMinor);
    push(`${prefix}.outputMinor`, route.outputMinor);
    push(`${prefix}.minimumOutputMinor`, route.minimumOutputMinor);
  }
  push("selectedRouteId", candidate.selectedRouteId);
  pushNumber("selectedRouteCode", candidate.selectedRouteCode);

  push("publicEvidenceId", candidate.publicEvidenceId);
  pushNumber("evidenceSchemaVersion", candidate.evidenceSchemaVersion);
  pushNumber("quoteSchemaVersion", candidate.quoteSchemaVersion);
  pushNumber("aadVersion", candidate.aadVersion);
  push("chainId", candidate.chainId);
  push("registryAddress", candidate.registryAddress);
  push("sequence", candidate.sequence);
  pushNumber("evidenceKind", candidate.evidenceKind);
  push("previousPayloadHash", candidate.previousPayloadHash);

  push("routeHashes.direct", candidate.routeHashes.direct);
  push("routeHashes.split", candidate.routeHashes.split);
  push("routeHashes.multi", candidate.routeHashes.multi);
  push("routesHash", candidate.routesHash);
  push("quoteSnapshotHash", candidate.quoteSnapshotHash);
  push("payloadHash", candidate.payloadHash);
  push("canonicalAadDigest", candidate.canonicalAadDigest);
  push("wrappingContextDigest", candidate.wrappingContextDigest);

  pushNumber("envelopeVersion", candidate.envelopeVersion);
  push("contentAlgorithm", candidate.contentAlgorithm);
  push("ciphertext", candidate.ciphertext);
  push("nonce", candidate.nonce);
  push("authenticationTag", candidate.authenticationTag);
  push("wrappedDek", candidate.wrappedDek);
  push("kmsProvider", candidate.kmsProvider);
  push("wrappedDekAlgorithm", candidate.wrappedDekAlgorithm);
  push("wrappedDekFormat", candidate.wrappedDekFormat);
  push("kmsKeyReference", candidate.kmsKeyReference);
  push("kmsKeyVersion", candidate.kmsKeyVersion);
  return parts;
}

function candidateDigest(
  candidate: PreparedEvidenceCandidateWithoutDigest,
): string {
  return createHash("sha256")
    .update(Buffer.concat(digestParts(candidate)))
    .digest("hex");
}

function freezeCandidate(
  candidate: PreparedEvidenceCandidateWithoutDigest,
): PreparedEvidenceCandidate {
  const frozenCore = Object.freeze({
    ...candidate,
    routeHashes: Object.freeze({ ...candidate.routeHashes }),
  });
  return Object.freeze({
    ...frozenCore,
    preparedCandidateDigest: candidateDigest(frozenCore),
  });
}

/**
 * Recomputes the in-memory mutation detector. This has no registry or on-chain
 * meaning and is not a substitute for final locked-row revalidation.
 */
export function verifyPreparedEvidenceCandidateIntegrity(
  candidate: PreparedEvidenceCandidate,
): boolean {
  try {
    if (
      !candidate ||
      typeof candidate.preparedCandidateDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(candidate.preparedCandidateDigest)
    ) {
      return false;
    }
    const expected = Buffer.from(candidate.preparedCandidateDigest, "hex");
    const actual = Buffer.from(
      candidateDigest(candidate as PreparedEvidenceCandidateWithoutDigest),
      "hex",
    );
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  } catch {
    return false;
  }
}

/**
 * Builds an encrypted but non-persisted candidate from a completed preparation
 * snapshot. It intentionally has no repository, transaction, Routing, or
 * provider implementation dependency. The snapshot can still become stale and
 * must be revalidated by a future final transaction.
 */
export async function prepareEvidenceCandidate(
  input: PrepareEvidenceCandidateInput,
): Promise<PreparedEvidenceCandidate> {
  let privatePayload: Buffer | undefined;
  let salt: Buffer | undefined;
  let canonicalAad: Buffer | undefined;
  let wrappingContext: Buffer | undefined;
  let providerResult: CreatedAndWrappedDek | undefined;
  // Captured separately because result validation can throw before a provider
  // response is trusted; cleanup must still target a Buffer-shaped raw DEK.
  let rawProviderPlaintextDek: unknown;
  let phase:
    "input" | "provider" | "provider-result" | "encryption" | "candidate" =
    "input";

  try {
    assertProvider(input?.provider);
    const snapshot = assertReadySnapshot(
      input?.snapshot,
      input?.selectedRouteId,
    );
    const requestFingerprint = normalizeRequestFingerprint(
      input?.requestFingerprint,
    );
    const createdByUserId = canonicalizeEvidenceUuid(
      input?.createdByUserId,
      "createdByUserId",
    );
    const evidenceRecordId = canonicalizeEvidenceUuid(
      randomUUID(),
      "evidenceRecordId",
    );
    const routingCorrelationId = canonicalizeEvidenceUuid(
      randomUUID(),
      "routingCorrelationId",
    );
    const outboxId = canonicalizeEvidenceUuid(randomUUID(), "outboxId");
    const publicEvidenceId = freshNonZeroBytes32();
    salt = freshNonZeroBytes32();
    const publicEvidenceIdHex = bytes32Hex(publicEvidenceId);
    const saltHex = bytes32Hex(salt);
    const quoteExpiresAtUnixMs = exactExpiryMilliseconds(
      snapshot.quote.expires_at,
    );

    const aad = canonicalizePrivateEvidenceAad({
      aadVersion: PRIVATE_EVIDENCE_AAD_VERSION,
      evidenceRecordId,
      businessId: snapshot.invoice.business_id,
      invoiceId: snapshot.invoice.id,
      quoteId: snapshot.quote.id,
      publicEvidenceId: publicEvidenceIdHex,
      evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
      chainId: ARBITRUM_SEPOLIA_CHAIN_ID,
      registryAddress: input?.registryAddress,
    });

    const commitment = buildRouteDecisionCommitment({
      invoice: {
        fundingCurrency: snapshot.invoice.data.fundingCurrency,
        fundingMinor: snapshot.invoice.funding_minor,
      },
      quoteRow: {
        source: snapshot.quote.source,
        simulated: snapshot.quote.simulated,
        expires_at: snapshot.quote.expires_at,
        data: snapshot.quote.data,
      },
      registry: aad.registryAddress,
      evidenceId: aad.publicEvidenceId,
      sequence: "1",
      selectedRouteId: input.selectedRouteId,
      previousPayloadHash: ZERO_BYTES32,
      salt: saltHex,
    });

    canonicalAad = buildCanonicalPrivateEvidenceAad(aad);
    const canonicalAadDigest = keccak256(canonicalAad);
    wrappingContext = buildKmsWrappingContext(canonicalAad);
    const wrappingContextDigest = keccak256(wrappingContext);

    const expectedPrivateCommitment: ExpectedPrivateEvidenceCommitment = {
      routeHashes: { ...commitment.routeHashes },
      routesHash: commitment.routesHash,
      quoteSnapshotHash: commitment.quoteSnapshotHash,
      payloadHash: commitment.payloadHash,
    };
    privatePayload = buildCanonicalPrivateEvidencePayload({
      aad,
      invoiceRow: snapshot.invoice,
      quoteRow: snapshot.quote,
      selectedRouteId: input.selectedRouteId,
      sequence: "1",
      previousPayloadHash: ZERO_BYTES32,
      salt: saltHex,
      expectedCommitment: expectedPrivateCommitment,
    });

    phase = "provider";
    try {
      providerResult = await input.provider.createAndWrapDek({
        canonicalContext: wrappingContext,
      });
    } catch {
      return preparationError("PROVIDER_FAILURE");
    }

    phase = "provider-result";
    let validatedProviderResult: CreatedAndWrappedDek;
    try {
      rawProviderPlaintextDek = providerResult?.plaintextDek;
      validatedProviderResult = assertDekProviderResult(
        input.provider,
        providerResult,
      );
    } catch {
      return preparationError("PROVIDER_RESULT_INVALID");
    }

    phase = "encryption";
    let envelope;
    try {
      envelope = encryptEvidenceEnvelope({
        plaintext: privatePayload,
        dek: validatedProviderResult.plaintextDek,
        canonicalAad,
      });
    } catch {
      return preparationError("ENCRYPTION_FAILED");
    }

    phase = "candidate";
    const candidate = freezeCandidate({
      requestFingerprint,
      createdByUserId,
      routingCorrelationId,
      outboxId,

      evidenceRecordId: aad.evidenceRecordId,
      businessId: aad.businessId,
      invoiceId: aad.invoiceId,
      quoteId: aad.quoteId,
      invoiceFundingMinor: snapshot.invoice.funding_minor,
      invoiceFundingCurrency: snapshot.invoice.funding_currency,
      invoiceStatusAtSnapshot: "Funded",
      quoteSource: "simulation-fixed-525",
      quoteSimulated: true,
      quoteExpiresAtUnixMs,
      canonicalQuoteData: canonicalQuoteData(
        snapshot.quote.data.routes,
        snapshot.quote.data,
      ),
      selectedRouteId: input.selectedRouteId,
      selectedRouteCode: commitment.selectedRouteCode,

      publicEvidenceId: Buffer.from(publicEvidenceId),
      evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
      quoteSchemaVersion: QUOTE_SCHEMA_VERSION,
      aadVersion: PRIVATE_EVIDENCE_AAD_VERSION,
      chainId: ARBITRUM_SEPOLIA_CHAIN_ID.toString(),
      registryAddress: aad.registryAddress,
      sequence: "1",
      evidenceKind: SIMULATED_ROUTE_DECISION_KIND,
      previousPayloadHash: ZERO_BYTES32,

      routeHashes: Object.freeze({ ...commitment.routeHashes }),
      routesHash: commitment.routesHash,
      quoteSnapshotHash: commitment.quoteSnapshotHash,
      payloadHash: commitment.payloadHash,
      canonicalAadDigest,
      wrappingContextDigest,

      envelopeVersion: envelope.envelopeVersion,
      contentAlgorithm: envelope.contentAlgorithm,
      ciphertext: Buffer.from(envelope.ciphertext),
      nonce: Buffer.from(envelope.nonce),
      authenticationTag: Buffer.from(envelope.authenticationTag),
      wrappedDek: Buffer.from(validatedProviderResult.wrappedDek),
      kmsProvider: validatedProviderResult.kmsProvider,
      wrappedDekAlgorithm: validatedProviderResult.wrappedDekAlgorithm,
      wrappedDekFormat: validatedProviderResult.wrappedDekFormat,
      kmsKeyReference: validatedProviderResult.kmsKeyReference,
      kmsKeyVersion: validatedProviderResult.kmsKeyVersion,
    });
    return candidate;
  } catch (error) {
    if (error instanceof EvidenceCandidatePreparationError) throw error;
    if (phase === "input") return preparationError("INVALID_INPUT");
    return preparationError("PREPARATION_FAILED");
  } finally {
    clearBufferBestEffort(rawProviderPlaintextDek);
    clearBufferBestEffort(privatePayload);
    clearBufferBestEffort(salt);
    clearBufferBestEffort(canonicalAad);
    clearBufferBestEffort(wrappingContext);
  }
}
