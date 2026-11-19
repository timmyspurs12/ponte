import {
  AbiCoder,
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import type { Invoice, PaymentQuote, RouteCandidate } from "../../lib/models";

const abi = AbiCoder.defaultAbiCoder();
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

export const EVIDENCE_SCHEMA_VERSION = 1;
export const QUOTE_SCHEMA_VERSION = 1;
export const ARBITRUM_SEPOLIA_CHAIN_ID = 421614n;
export const SIMULATED_ROUTE_DECISION_KIND = 1;
export const FUNDING_CURRENCY_DECIMALS = 2;
export const DEMO_OUTPUT_ASSET_DECIMALS = 2;

export const CANONICAL_ROUTE_IDS = ["direct", "split", "multi"] as const;
export type CanonicalRouteId = (typeof CANONICAL_ROUTE_IDS)[number];

type UnsignedInteger = bigint | string | number;
type ExactUnixMilliseconds = bigint | string | Date;
type Hex32 = string;

export interface PersistedQuoteRow {
  /** Persisted `quotes.source` metadata; not a PaymentQuote property. */
  source: string;
  /** Persisted `quotes.simulated` metadata; not a PaymentQuote property. */
  simulated: boolean;
  /** Persisted `quotes.expires_at`; never generated or substituted here. */
  expires_at: ExactUnixMilliseconds;
  /** Persisted `quotes.data` JSON decoded as PaymentQuote. */
  data: PaymentQuote;
}

export interface RouteDecisionCommitmentInput {
  invoice: Pick<Invoice, "fundingCurrency" | "fundingMinor">;
  quoteRow: PersistedQuoteRow;
  registry: string;
  evidenceId: string;
  sequence: bigint | string;
  selectedRouteId: CanonicalRouteId;
  previousPayloadHash: string;
  salt: string;
}

export interface PayloadHashInput {
  registry: string;
  evidenceId: string;
  sequence: bigint | string;
  quoteSnapshotHash: string;
  selectedRouteCode: number;
  previousPayloadHash: string;
  salt: string;
}

export interface RouteHashes {
  direct: Hex32;
  split: Hex32;
  multi: Hex32;
}

export interface QuoteSnapshotCommitment {
  routeHashes: RouteHashes;
  routesHash: Hex32;
  quoteSnapshotHash: Hex32;
}

export interface RouteDecisionCommitment extends QuoteSnapshotCommitment {
  selectedRouteCode: number;
  payloadHash: Hex32;
}

export class EvidenceCommitmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceCommitmentValidationError";
  }
}

function hashLiteral(value: string): Hex32 {
  return keccak256(toUtf8Bytes(value));
}

export const DOMAIN_HASHES = Object.freeze({
  route: hashLiteral("PONTE_SIMULATED_ROUTE_V1"),
  routes: hashLiteral("PONTE_SIMULATED_ROUTES_V1"),
  quote: hashLiteral("PONTE_SIMULATED_QUOTE_SNAPSHOT_V1"),
  payload: hashLiteral("PONTE_ROUTE_DECISION_EVIDENCE_V1"),
  simulationSource: hashLiteral("simulation-fixed-525"),
  fundingCurrency: hashLiteral("BRL"),
  demoOutputAsset: hashLiteral("USDG"),
});

const ROUTE_CODE: Readonly<Record<CanonicalRouteId, number>> = Object.freeze({
  direct: 1,
  split: 2,
  multi: 3,
});

function fail(message: string): never {
  throw new EvidenceCommitmentValidationError(message);
}

function hashAbi(types: readonly string[], values: readonly unknown[]): Hex32 {
  return keccak256(abi.encode(types, values));
}

function asUnsignedInteger(
  value: UnsignedInteger,
  bits: number,
  field: string,
): bigint {
  let parsed: bigint;

  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "string") {
    if (!/^\d+$/.test(value))
      fail(`${field} must be an unsigned base-10 integer`);
    parsed = BigInt(value);
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0)
      fail(`${field} must be a safe non-negative integer`);
    parsed = BigInt(value);
  } else {
    fail(`${field} must be an unsigned integer`);
  }

  if (parsed < 0n) fail(`${field} must be non-negative`);
  if (parsed >= 1n << BigInt(bits)) fail(`${field} exceeds uint${bits}`);
  return parsed;
}

function asNonZeroUnsignedInteger(
  value: UnsignedInteger,
  bits: number,
  field: string,
): bigint {
  const parsed = asUnsignedInteger(value, bits, field);
  if (parsed === 0n) fail(`${field} must not be zero`);
  return parsed;
}

function asBytes32(value: string, field: string, allowZero = true): Hex32 {
  if (!isHexString(value, 32))
    fail(`${field} must be an exact bytes32 hex value`);
  const normalized = value.toLowerCase();
  if (!allowZero && normalized === ZERO_BYTES32)
    fail(`${field} must not be zero`);
  return normalized;
}

function asAddress(value: string, field: string): string {
  try {
    return getAddress(value);
  } catch {
    return fail(`${field} must be a valid EVM address`);
  }
}

function asExactUnixMilliseconds(value: ExactUnixMilliseconds): bigint {
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
      fail(
        "quoteRow.expires_at must be a valid non-negative millisecond timestamp",
      );
    return asUnsignedInteger(milliseconds, 64, "quoteRow.expires_at");
  }
  return asUnsignedInteger(value, 64, "quoteRow.expires_at");
}

function routeId(value: string): CanonicalRouteId {
  if ((CANONICAL_ROUTE_IDS as readonly string[]).includes(value))
    return value as CanonicalRouteId;
  return fail(`unsupported route id: ${value}`);
}

function assertCanonicalRoutes(routes: readonly RouteCandidate[]): void {
  if (routes.length !== CANONICAL_ROUTE_IDS.length)
    fail("routes must contain exactly direct, split, multi in canonical order");

  for (const [index, expectedId] of CANONICAL_ROUTE_IDS.entries()) {
    const candidate = routes[index];
    if (!candidate || candidate.id !== expectedId)
      fail("routes must be ordered exactly as direct, split, multi");
  }
}

function assertFixedQuoteMetadata(
  invoice: Pick<Invoice, "fundingCurrency" | "fundingMinor">,
  quoteRow: PersistedQuoteRow,
): void {
  const quote = quoteRow.data;
  if (invoice.fundingCurrency !== "BRL")
    fail("invoice funding currency must be BRL");
  if (!invoice.fundingMinor) fail("invoice fundingMinor is required");
  if (quoteRow.source !== "simulation-fixed-525")
    fail("quoteRow.source must be simulation-fixed-525");
  if (!quoteRow.simulated) fail("quoteRow.simulated must be true");
  if (!quote.simulated) fail("quoteRow.data.simulated must be true");
  if (quote.asset !== "USDG") fail("quoteRow.data.asset must be USDG");
  if (quote.demoAssetDecimals !== DEMO_OUTPUT_ASSET_DECIMALS)
    fail("quoteRow.data.demoAssetDecimals must be 2");

  const invoiceFunding = asUnsignedInteger(
    invoice.fundingMinor,
    256,
    "invoice.fundingMinor",
  );
  const quoteFunding = asUnsignedInteger(
    quote.fundingMinor,
    256,
    "quoteRow.data.fundingMinor",
  );
  if (invoiceFunding !== quoteFunding)
    fail("invoice fundingMinor must match quoteRow.data.fundingMinor");

  if (
    asUnsignedInteger(
      quote.rate.numerator,
      256,
      "quoteRow.data.rate.numerator",
    ) !== 525n ||
    asUnsignedInteger(
      quote.rate.denominator,
      256,
      "quoteRow.data.rate.denominator",
    ) !== 100n
  ) {
    fail("quoteRow.data.rate must equal the fixed 525/100 simulation rate");
  }
  if (
    asUnsignedInteger(
      quote.executionCostMinor,
      256,
      "quoteRow.data.executionCostMinor",
    ) !== 2n
  ) {
    fail("quoteRow.data.executionCostMinor must equal 2");
  }
}

function hashRouteCandidate(route: RouteCandidate): Hex32 {
  const id = routeId(route.id);
  return hashAbi(
    [
      "bytes32",
      "uint8",
      "uint16",
      "uint16",
      "uint16",
      "uint256",
      "uint256",
      "uint256",
    ],
    [
      DOMAIN_HASHES.route,
      asUnsignedInteger(ROUTE_CODE[id], 8, "route code"),
      asUnsignedInteger(route.feeBps, 16, `${id}.feeBps`),
      asUnsignedInteger(route.slippageBps, 16, `${id}.slippageBps`),
      asUnsignedInteger(route.toleranceBps, 16, `${id}.toleranceBps`),
      asUnsignedInteger(route.feeMinor, 256, `${id}.feeMinor`),
      asUnsignedInteger(route.outputMinor, 256, `${id}.outputMinor`),
      asUnsignedInteger(
        route.minimumOutputMinor,
        256,
        `${id}.minimumOutputMinor`,
      ),
    ],
  );
}

/** Hashes a route only after checking its canonical route ID and numeric ABI widths. */
export function routeHash(route: RouteCandidate): Hex32 {
  return hashRouteCandidate(route);
}

/**
 * Hashes routes in the specification's immutable direct/split/multi order.
 * No caller-selected ordering or partial route list is accepted.
 */
export function routesCommitment(routes: readonly RouteCandidate[]): {
  routeHashes: RouteHashes;
  routesHash: Hex32;
} {
  assertCanonicalRoutes(routes);
  const routeHashes: RouteHashes = {
    direct: hashRouteCandidate(routes[0]),
    split: hashRouteCandidate(routes[1]),
    multi: hashRouteCandidate(routes[2]),
  };
  const routesHash = hashAbi(
    ["bytes32", "bytes32", "bytes32", "bytes32"],
    [
      DOMAIN_HASHES.routes,
      routeHashes.direct,
      routeHashes.split,
      routeHashes.multi,
    ],
  );
  return { routeHashes, routesHash };
}

/**
 * Computes the quote snapshot from row-level persisted metadata and row `data`.
 * It deliberately has no `quote.source` input.
 */
export function quoteSnapshotCommitment(
  invoice: Pick<Invoice, "fundingCurrency" | "fundingMinor">,
  quoteRow: PersistedQuoteRow,
): QuoteSnapshotCommitment {
  assertFixedQuoteMetadata(invoice, quoteRow);
  const { routeHashes, routesHash } = routesCommitment(quoteRow.data.routes);
  const quote = quoteRow.data;

  const quoteSnapshotHash = hashAbi(
    [
      "bytes32",
      "uint16",
      "bool",
      "bytes32",
      "bytes32",
      "uint8",
      "bytes32",
      "uint8",
      "uint256",
      "uint256",
      "uint256",
      "uint256",
      "uint64",
      "bytes32",
    ],
    [
      DOMAIN_HASHES.quote,
      asUnsignedInteger(QUOTE_SCHEMA_VERSION, 16, "quote schema version"),
      quoteRow.simulated,
      hashLiteral(quoteRow.source),
      DOMAIN_HASHES.fundingCurrency,
      asUnsignedInteger(
        FUNDING_CURRENCY_DECIMALS,
        8,
        "funding currency decimals",
      ),
      DOMAIN_HASHES.demoOutputAsset,
      asUnsignedInteger(
        DEMO_OUTPUT_ASSET_DECIMALS,
        8,
        "demo output asset decimals",
      ),
      asUnsignedInteger(quote.fundingMinor, 256, "quoteRow.data.fundingMinor"),
      asUnsignedInteger(
        quote.rate.numerator,
        256,
        "quoteRow.data.rate.numerator",
      ),
      asUnsignedInteger(
        quote.rate.denominator,
        256,
        "quoteRow.data.rate.denominator",
      ),
      asUnsignedInteger(
        quote.executionCostMinor,
        256,
        "quoteRow.data.executionCostMinor",
      ),
      asExactUnixMilliseconds(quoteRow.expires_at),
      routesHash,
    ],
  );

  return { routeHashes, routesHash, quoteSnapshotHash };
}

/**
 * Computes the V1 registry payload hash from already-committed quote data.
 * This accepts no private preimage output and never submits a transaction.
 */
export function payloadHash(input: PayloadHashInput): Hex32 {
  const evidenceId = asBytes32(input.evidenceId, "evidenceId", false);
  const quoteSnapshotHash = asBytes32(
    input.quoteSnapshotHash,
    "quoteSnapshotHash",
    false,
  );
  const previousPayloadHash = asBytes32(
    input.previousPayloadHash,
    "previousPayloadHash",
  );
  const salt = asBytes32(input.salt, "salt", false);
  const selectedRouteCode = asUnsignedInteger(
    input.selectedRouteCode,
    8,
    "selectedRouteCode",
  );
  if (
    selectedRouteCode !== BigInt(ROUTE_CODE.direct) &&
    selectedRouteCode !== BigInt(ROUTE_CODE.split) &&
    selectedRouteCode !== BigInt(ROUTE_CODE.multi)
  ) {
    fail("selectedRouteCode must identify direct, split, or multi");
  }

  return hashAbi(
    [
      "bytes32",
      "uint16",
      "uint256",
      "address",
      "bytes32",
      "uint64",
      "uint8",
      "bytes32",
      "uint8",
      "bytes32",
      "uint16",
      "bytes32",
      "bytes32",
    ],
    [
      DOMAIN_HASHES.payload,
      asUnsignedInteger(EVIDENCE_SCHEMA_VERSION, 16, "evidence schema version"),
      ARBITRUM_SEPOLIA_CHAIN_ID,
      asAddress(input.registry, "registry"),
      evidenceId,
      asNonZeroUnsignedInteger(input.sequence, 64, "sequence"),
      asUnsignedInteger(SIMULATED_ROUTE_DECISION_KIND, 8, "evidence kind"),
      quoteSnapshotHash,
      selectedRouteCode,
      DOMAIN_HASHES.simulationSource,
      asUnsignedInteger(QUOTE_SCHEMA_VERSION, 16, "quote schema version"),
      previousPayloadHash,
      salt,
    ],
  );
}

/**
 * Builds deterministic V1 hashes from explicit persisted-row and evidence inputs.
 * The result intentionally exposes hashes and selected route code only, never salts
 * or other private preimage material.
 */
export function buildRouteDecisionCommitment(
  input: RouteDecisionCommitmentInput,
): RouteDecisionCommitment {
  const selectedRouteId = routeId(input.selectedRouteId);
  const quote = quoteSnapshotCommitment(input.invoice, input.quoteRow);
  const selectedRouteCode = ROUTE_CODE[selectedRouteId];
  const computedPayloadHash = payloadHash({
    registry: input.registry,
    evidenceId: input.evidenceId,
    sequence: input.sequence,
    quoteSnapshotHash: quote.quoteSnapshotHash,
    selectedRouteCode,
    previousPayloadHash: input.previousPayloadHash,
    salt: input.salt,
  });

  return { ...quote, selectedRouteCode, payloadHash: computedPayloadHash };
}
