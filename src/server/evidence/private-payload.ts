// Canonical private plaintext serialization only. This module deliberately
// contains no KMS client, key material, encryption, persistence, or lifecycle
// integration.
import "server-only";

import type { Invoice, RouteCandidate } from "../../lib/models";
import {
  ARBITRUM_SEPOLIA_CHAIN_ID,
  buildRouteDecisionCommitment,
  CANONICAL_ROUTE_IDS,
  EVIDENCE_SCHEMA_VERSION,
  QUOTE_SCHEMA_VERSION,
  SIMULATED_ROUTE_DECISION_KIND,
  type CanonicalRouteId,
  type PersistedQuoteRow,
  type RouteDecisionCommitment,
} from "./commitment";
import {
  canonicalizePrivateEvidenceAad,
  type CanonicalPrivateEvidenceAadInput,
} from "./aad";

const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const MAX_UINT256 = 1n << 256n;
const MAX_UINT64 = 1n << 64n;
const MAX_UINT16 = 1n << 16n;

export const PRIVATE_EVIDENCE_PAYLOAD_SCHEMA =
  "ponte-private-route-decision-evidence/v1";

export interface ExpectedPrivateEvidenceCommitment {
  routeHashes: {
    direct: string;
    split: string;
    multi: string;
  };
  routesHash: string;
  quoteSnapshotHash: string;
  payloadHash: string;
}

export interface PrivateEvidencePayloadInput {
  aad: CanonicalPrivateEvidenceAadInput;
  invoice: Pick<Invoice, "fundingCurrency" | "fundingMinor">;
  quoteRow: PersistedQuoteRow;
  selectedRouteId: CanonicalRouteId;
  sequence: string;
  previousPayloadHash: string;
  salt: string;
  /** Optional immutable record values, always compared after recomputation. */
  expectedCommitment?: ExpectedPrivateEvidenceCommitment;
}

export class PrivateEvidencePayloadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateEvidencePayloadValidationError";
  }
}

type CanonicalRoute = {
  id: CanonicalRouteId;
  code: string;
  feeBps: string;
  slippageBps: string;
  toleranceBps: string;
  feeMinor: string;
  outputMinor: string;
  minimumOutputMinor: string;
};

function fail(message: string): never {
  throw new PrivateEvidencePayloadValidationError(message);
}

function assertObject(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${field} must be an object`);
}

function assertPayloadInputKeys(value: Record<string, unknown>): void {
  const required = [
    "aad",
    "invoice",
    "quoteRow",
    "selectedRouteId",
    "sequence",
    "previousPayloadHash",
    "salt",
  ];
  const allowed = new Set([...required, "expectedCommitment"]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !(key in value)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    fail("private payload input contains unsupported fields");
  }
}

function canonicalDecimalString(
  value: unknown,
  limit: bigint,
  field: string,
): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    fail(`${field} must be a canonical unsigned decimal string`);
  const parsed = BigInt(value);
  if (parsed >= limit) fail(`${field} exceeds its unsigned ABI width`);
  return value;
}

function canonicalSafeInteger(
  value: unknown,
  limit: bigint,
  field: string,
): string {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail(`${field} must be a safe non-negative integer`);
  const parsed = BigInt(value as number);
  if (parsed >= limit) fail(`${field} exceeds its unsigned ABI width`);
  return parsed.toString();
}

function canonicalBytes32(
  value: unknown,
  field: string,
  allowZero = true,
): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    fail(`${field} must be an exact bytes32 hex value`);
  const normalized = value.toLowerCase();
  if (!allowZero && normalized === ZERO_BYTES32)
    fail(`${field} must not be zero`);
  return normalized;
}

function exactUnixMilliseconds(value: unknown): string {
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
      fail(
        "quoteRow.expires_at must be an exact non-negative millisecond timestamp",
      );
    return milliseconds.toString();
  }
  if (typeof value === "bigint") {
    if (value < 0n || value >= MAX_UINT64)
      fail("quoteRow.expires_at exceeds uint64");
    return value.toString();
  }
  return canonicalDecimalString(value, MAX_UINT64, "quoteRow.expires_at");
}

function canonicalRouteId(value: unknown): CanonicalRouteId {
  if ((CANONICAL_ROUTE_IDS as readonly string[]).includes(value as string))
    return value as CanonicalRouteId;
  return fail("selectedRouteId must be direct, split, or multi");
}

function canonicalRoutes(value: unknown): CanonicalRoute[] {
  if (!Array.isArray(value) || value.length !== CANONICAL_ROUTE_IDS.length)
    fail("quoteRow.data.routes must contain exactly direct, split, multi");

  return value.map((candidate, index) => {
    assertObject(candidate, "route candidate");
    const expectedId = CANONICAL_ROUTE_IDS[index];
    if (candidate.id !== expectedId)
      fail(
        "quoteRow.data.routes must be in canonical direct, split, multi order",
      );
    return {
      id: expectedId,
      code: (index + 1).toString(),
      feeBps: canonicalSafeInteger(
        candidate.feeBps,
        MAX_UINT16,
        `${expectedId}.feeBps`,
      ),
      slippageBps: canonicalSafeInteger(
        candidate.slippageBps,
        MAX_UINT16,
        `${expectedId}.slippageBps`,
      ),
      toleranceBps: canonicalSafeInteger(
        candidate.toleranceBps,
        MAX_UINT16,
        `${expectedId}.toleranceBps`,
      ),
      feeMinor: canonicalDecimalString(
        candidate.feeMinor,
        MAX_UINT256,
        `${expectedId}.feeMinor`,
      ),
      outputMinor: canonicalDecimalString(
        candidate.outputMinor,
        MAX_UINT256,
        `${expectedId}.outputMinor`,
      ),
      minimumOutputMinor: canonicalDecimalString(
        candidate.minimumOutputMinor,
        MAX_UINT256,
        `${expectedId}.minimumOutputMinor`,
      ),
    };
  });
}

function commitmentRoutes(routes: readonly CanonicalRoute[]): RouteCandidate[] {
  return routes.map((route) => ({
    id: route.id,
    name: route.id,
    feeBps: Number(route.feeBps),
    slippageBps: Number(route.slippageBps),
    toleranceBps: Number(route.toleranceBps),
    feeMinor: route.feeMinor,
    outputMinor: route.outputMinor,
    minimumOutputMinor: route.minimumOutputMinor,
  }));
}

function canonicalQuote(
  invoice: PrivateEvidencePayloadInput["invoice"],
  quoteRow: PrivateEvidencePayloadInput["quoteRow"],
): {
  fundingCurrency: "BRL";
  fundingMinor: string;
  source: "simulation-fixed-525";
  persistedSimulated: true;
  expiresAtUnixMs: string;
  quoteSimulated: true;
  asset: "USDG";
  demoAssetDecimals: string;
  quoteFundingMinor: string;
  rateNumerator: string;
  rateDenominator: string;
  executionCostMinor: string;
  routes: CanonicalRoute[];
} {
  assertObject(invoice, "invoice");
  assertObject(quoteRow, "quoteRow");
  if (invoice.fundingCurrency !== "BRL")
    fail("invoice funding currency must be BRL");
  const fundingMinor = canonicalDecimalString(
    invoice.fundingMinor,
    MAX_UINT256,
    "invoice.fundingMinor",
  );
  if (quoteRow.source !== "simulation-fixed-525")
    fail("quoteRow.source is not supported");
  if (quoteRow.simulated !== true) fail("quoteRow.simulated must be true");
  const expiresAtUnixMs = exactUnixMilliseconds(quoteRow.expires_at);

  assertObject(quoteRow.data, "quoteRow.data");
  const quoteData = quoteRow.data;
  if (quoteData.simulated !== true)
    fail("quoteRow.data.simulated must be true");
  if (quoteData.asset !== "USDG") fail("quoteRow.data.asset must be USDG");
  if (quoteData.demoAssetDecimals !== 2)
    fail("quoteRow.data.demoAssetDecimals must be 2");
  const quoteFundingMinor = canonicalDecimalString(
    quoteData.fundingMinor,
    MAX_UINT256,
    "quoteRow.data.fundingMinor",
  );
  if (fundingMinor !== quoteFundingMinor)
    fail("invoice funding minor must match quote funding minor");

  assertObject(quoteData.rate, "quoteRow.data.rate");
  const rateNumerator = canonicalDecimalString(
    quoteData.rate.numerator,
    MAX_UINT256,
    "quoteRow.data.rate.numerator",
  );
  const rateDenominator = canonicalDecimalString(
    quoteData.rate.denominator,
    MAX_UINT256,
    "quoteRow.data.rate.denominator",
  );
  const executionCostMinor = canonicalDecimalString(
    quoteData.executionCostMinor,
    MAX_UINT256,
    "quoteRow.data.executionCostMinor",
  );
  if (rateNumerator !== "525" || rateDenominator !== "100")
    fail("quoteRow.data.rate is not supported");
  if (executionCostMinor !== "2")
    fail("quoteRow.data.executionCostMinor is not supported");

  return {
    fundingCurrency: "BRL",
    fundingMinor,
    source: "simulation-fixed-525",
    persistedSimulated: true,
    expiresAtUnixMs,
    quoteSimulated: true,
    asset: "USDG",
    demoAssetDecimals: "2",
    quoteFundingMinor,
    rateNumerator,
    rateDenominator,
    executionCostMinor,
    routes: canonicalRoutes(quoteData.routes),
  };
}

function expectedCommitment(
  value: unknown,
): ExpectedPrivateEvidenceCommitment | undefined {
  if (value === undefined) return undefined;
  assertObject(value, "expectedCommitment");
  const expectedKeys = [
    "routeHashes",
    "routesHash",
    "quoteSnapshotHash",
    "payloadHash",
  ];
  if (
    Object.keys(value).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in value))
  ) {
    fail(
      "expectedCommitment must contain exactly the derived commitment fields",
    );
  }
  const routeHashes = value.routeHashes;
  assertObject(routeHashes, "expectedCommitment.routeHashes");
  const routeHashKeys = ["direct", "split", "multi"];
  if (
    Object.keys(routeHashes).length !== routeHashKeys.length ||
    routeHashKeys.some((key) => !(key in routeHashes))
  ) {
    fail("expectedCommitment.routeHashes must contain canonical route hashes");
  }
  return {
    routeHashes: {
      direct: canonicalBytes32(
        routeHashes.direct,
        "expected direct route hash",
      ),
      split: canonicalBytes32(routeHashes.split, "expected split route hash"),
      multi: canonicalBytes32(routeHashes.multi, "expected multi route hash"),
    },
    routesHash: canonicalBytes32(value.routesHash, "expected routes hash"),
    quoteSnapshotHash: canonicalBytes32(
      value.quoteSnapshotHash,
      "expected quote snapshot hash",
    ),
    payloadHash: canonicalBytes32(
      value.payloadHash,
      "expected payload hash",
      false,
    ),
  };
}

function assertExpectedCommitment(
  expected: ExpectedPrivateEvidenceCommitment | undefined,
  actual: RouteDecisionCommitment,
): void {
  if (!expected) return;
  if (
    expected.routeHashes.direct !== actual.routeHashes.direct ||
    expected.routeHashes.split !== actual.routeHashes.split ||
    expected.routeHashes.multi !== actual.routeHashes.multi ||
    expected.routesHash !== actual.routesHash ||
    expected.quoteSnapshotHash !== actual.quoteSnapshotHash ||
    expected.payloadHash !== actual.payloadHash
  ) {
    fail("expected derived commitment does not match recomputed commitment");
  }
}

/**
 * Builds the one allowed private V1 plaintext representation. It derives all
 * binding fields from canonical AAD input and all commitment values from the
 * frozen commitment helper; it neither generates nor retains a salt or key.
 */
export function buildCanonicalPrivateEvidencePayload(
  input: PrivateEvidencePayloadInput,
): Buffer {
  assertObject(input, "private payload input");
  assertPayloadInputKeys(input);
  const aad = canonicalizePrivateEvidenceAad(input.aad);
  const quote = canonicalQuote(input.invoice, input.quoteRow);
  const sequence = canonicalDecimalString(
    input.sequence,
    MAX_UINT64,
    "sequence",
  );
  if (sequence !== "1") fail("sequence must be 1 for private evidence v1");
  const previousPayloadHash = canonicalBytes32(
    input.previousPayloadHash,
    "previousPayloadHash",
  );
  if (previousPayloadHash !== ZERO_BYTES32)
    fail("previousPayloadHash must be zero for private evidence v1");
  const salt = canonicalBytes32(input.salt, "salt", false);
  const selectedRouteId = canonicalRouteId(input.selectedRouteId);
  const expected = expectedCommitment(input.expectedCommitment);

  let commitment: RouteDecisionCommitment;
  try {
    commitment = buildRouteDecisionCommitment({
      invoice: {
        fundingCurrency: quote.fundingCurrency,
        fundingMinor: quote.fundingMinor,
      },
      quoteRow: {
        source: quote.source,
        simulated: quote.persistedSimulated,
        expires_at: quote.expiresAtUnixMs,
        data: {
          fundingMinor: quote.quoteFundingMinor,
          asset: quote.asset,
          demoAssetDecimals: 2,
          rate: {
            numerator: quote.rateNumerator,
            denominator: quote.rateDenominator,
          },
          executionCostMinor: quote.executionCostMinor,
          simulated: quote.quoteSimulated,
          routes: commitmentRoutes(quote.routes),
        },
      },
      registry: aad.registryAddress,
      evidenceId: aad.publicEvidenceId,
      sequence,
      selectedRouteId,
      previousPayloadHash,
      salt,
    });
  } catch {
    fail("private evidence payload validation failed");
  }
  assertExpectedCommitment(expected, commitment);

  const payload = {
    schema: PRIVATE_EVIDENCE_PAYLOAD_SCHEMA,
    aadVersion: aad.aadVersion.toString(),
    record: {
      evidenceRecordId: aad.evidenceRecordId,
      businessId: aad.businessId,
      invoiceId: aad.invoiceId,
      quoteId: aad.quoteId,
      publicEvidenceId: aad.publicEvidenceId,
      evidenceSchemaVersion: aad.evidenceSchemaVersion.toString(),
      quoteSchemaVersion: QUOTE_SCHEMA_VERSION.toString(),
      chainId: ARBITRUM_SEPOLIA_CHAIN_ID.toString(),
      registryAddress: aad.registryAddress,
      sequence,
      evidenceKind: SIMULATED_ROUTE_DECISION_KIND.toString(),
      previousPayloadHash,
    },
    invoice: {
      fundingCurrency: quote.fundingCurrency,
      fundingMinor: quote.fundingMinor,
    },
    quote: {
      source: quote.source,
      persistedSimulated: quote.persistedSimulated,
      expiresAtUnixMs: quote.expiresAtUnixMs,
      data: {
        simulated: quote.quoteSimulated,
        asset: quote.asset,
        demoAssetDecimals: quote.demoAssetDecimals,
        fundingMinor: quote.quoteFundingMinor,
        rate: {
          numerator: quote.rateNumerator,
          denominator: quote.rateDenominator,
        },
        executionCostMinor: quote.executionCostMinor,
        routes: quote.routes.map((route) => ({
          id: route.id,
          code: route.code,
          feeBps: route.feeBps,
          slippageBps: route.slippageBps,
          toleranceBps: route.toleranceBps,
          feeMinor: route.feeMinor,
          outputMinor: route.outputMinor,
          minimumOutputMinor: route.minimumOutputMinor,
        })),
      },
    },
    decision: {
      selectedRouteId,
      selectedRouteCode: commitment.selectedRouteCode.toString(),
    },
    privateCommitmentInputs: { salt },
    derivedCommitments: {
      routeHashes: {
        direct: commitment.routeHashes.direct,
        split: commitment.routeHashes.split,
        multi: commitment.routeHashes.multi,
      },
      routesHash: commitment.routesHash,
      quoteSnapshotHash: commitment.quoteSnapshotHash,
      payloadHash: commitment.payloadHash,
    },
  };

  return Buffer.from(JSON.stringify(payload), "utf8");
}
