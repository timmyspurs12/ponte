/**
 * Phase 2B.1 — Isolated TypeScript V1 optimizer domain and wire models.
 *
 * Synthetic settlement-route evaluation only. Not connected to application APIs,
 * databases, market data, PSPs, or on-chain contracts.
 */

export const OPTIMIZER_VERSION_V1 = 1;
export const OPTIMIZER_MODE_SYNTHETIC = "SYNTHETIC" as const;

export const BPS_DENOMINATOR_U16 = 10_000;
export const BPS_DENOMINATOR_BIGINT = 10_000n;
export const MAX_BPS = 10_000;
export const MAX_ASSET_DECIMALS = 38;
export const MIN_CANDIDATES = 1;
export const MAX_CANDIDATES = 64;
export const MAX_ASSET_FIELD_LEN = 64;

export const U64_MAX: bigint = (1n << 64n) - 1n;
export const U128_MAX: bigint = (1n << 128n) - 1n;
export const U256_MAX: bigint = (1n << 256n) - 1n;

export type OptimizerMode = typeof OPTIMIZER_MODE_SYNTHETIC;

export interface AssetIdV1 {
  readonly namespace: string;
  readonly identifier: string;
  readonly decimals: number;
}

export interface CandidateV1 {
  readonly routeId: string;
  readonly snapshotId: string;
  readonly rateNumerator: bigint;
  readonly rateDenominator: bigint;
  readonly feeBps: number;
  readonly estimatedImpactBps: number;
  readonly minInput: bigint;
  readonly maxInput: bigint;
  readonly availableInput: bigint;
  readonly availableOutput: bigint;
  readonly executionCostUsdCents: bigint;
  readonly expiresAtUnixSeconds: bigint;
}

export interface OptimizeRequestV1 {
  readonly version: number;
  readonly mode: string;
  readonly inputAsset: AssetIdV1;
  readonly outputAsset: AssetIdV1;
  readonly amountIn: bigint;
  readonly userMinOut: bigint;
  readonly toleranceBps: number;
  readonly asOfUnixSeconds: bigint;
  readonly expiresAtUnixSeconds: bigint;
  readonly snapshotId: string;
  readonly candidates: readonly CandidateV1[];
}

export type CandidateRejectionReason =
  | "EXPIRED"
  | "BELOW_MIN"
  | "CAPACITY"
  | "INPUT_LIQUIDITY"
  | "ARITHMETIC_RANGE"
  | "ZERO_OUTPUT"
  | "OUTPUT_LIQUIDITY"
  | "USER_MIN_UNMET";

export interface RejectedCandidateV1 {
  readonly routeId: string;
  readonly reason: CandidateRejectionReason;
}

export interface SelectedRouteV1 {
  readonly status: "SELECTED";
  readonly selectedRouteId: string;
  readonly amountIn: bigint;
  readonly grossOut: bigint;
  readonly feeOut: bigint;
  readonly expectedOut: bigint;
  readonly minimumOut: bigint;
  readonly executionCostUsdCents: bigint;
  readonly effectiveExpiry: bigint;
  readonly snapshotId: string;
  readonly evaluatedCount: number;
  readonly rejected: readonly RejectedCandidateV1[];
}

export interface NoRouteResultV1 {
  readonly status: "NO_ROUTE";
  readonly amountIn: bigint;
  readonly snapshotId: string;
  readonly evaluatedCount: number;
  readonly rejected: readonly RejectedCandidateV1[];
}

export type OptimizeOutcomeV1 = SelectedRouteV1 | NoRouteResultV1;

export type OptimizerErrorCode =
  | "MALFORMED_JSON"
  | "INVALID_REQUEST_SHAPE"
  | "UNSUPPORTED_VERSION"
  | "UNSUPPORTED_MODE"
  | "INVALID_ASSET"
  | "INVALID_ASSET_DECIMALS"
  | "INVALID_BYTES32"
  | "INVALID_INTEGER_ENCODING"
  | "INTEGER_OVERFLOW"
  | "INVALID_AMOUNT_IN"
  | "INVALID_BPS"
  | "INVALID_REQUEST_EXPIRY"
  | "INVALID_CANDIDATE_COUNT"
  | "DUPLICATE_ROUTE_ID"
  | "SNAPSHOT_MISMATCH"
  | "ZERO_RATE"
  | "INVALID_CANDIDATE_BOUNDS";

export const ERROR_MESSAGES: Readonly<Record<OptimizerErrorCode, string>> = {
  MALFORMED_JSON: "Request payload is not valid JSON.",
  INVALID_REQUEST_SHAPE:
    "Request structure is missing required fields or has invalid field types.",
  UNSUPPORTED_VERSION: "Unsupported optimizer request version; expected 1.",
  UNSUPPORTED_MODE: "Unsupported optimizer mode; expected SYNTHETIC.",
  INVALID_ASSET:
    "Asset namespace and identifier must be distinct non-empty ASCII identifiers.",
  INVALID_ASSET_DECIMALS:
    "Asset decimals must be an integer between 0 and 38.",
  INVALID_BYTES32:
    "Identifier must be a canonical lowercase 0x-prefixed 32-byte hex string.",
  INVALID_INTEGER_ENCODING:
    "Monetary and timestamp fields must be canonical unsigned base-10 integer strings.",
  INTEGER_OVERFLOW: "Integer value exceeds bounded width.",
  INVALID_AMOUNT_IN: "Input amount must be a positive integer.",
  INVALID_BPS: "Basis-point value must be an integer between 0 and 10000.",
  INVALID_REQUEST_EXPIRY:
    "Evaluation timestamp must be strictly earlier than request expiry.",
  INVALID_CANDIDATE_COUNT: "Candidate count must be between 1 and 64.",
  DUPLICATE_ROUTE_ID: "Candidate routeId values must be unique.",
  SNAPSHOT_MISMATCH: "Candidate snapshotId must match request snapshotId.",
  ZERO_RATE: "Candidate rateNumerator and rateDenominator must be positive.",
  INVALID_CANDIDATE_BOUNDS: "Candidate minInput must not exceed maxInput.",
};

export class OptimizerValidationError extends Error {
  readonly code: OptimizerErrorCode;

  constructor(code: OptimizerErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "OptimizerValidationError";
    this.code = code;
  }
}

export type OptimizeResultV1 =
  | { readonly ok: true; readonly value: OptimizeOutcomeV1 }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: OptimizerErrorCode;
        readonly message: string;
      };
    };

/** Wire-format JSON shapes used by fixtures and the JSON-lines runner. */
export interface WireCandidateV1 {
  readonly routeId: string;
  readonly snapshotId: string;
  readonly rateNumerator: string;
  readonly rateDenominator: string;
  readonly feeBps: number;
  readonly estimatedImpactBps: number;
  readonly minInput: string;
  readonly maxInput: string;
  readonly availableInput: string;
  readonly availableOutput: string;
  readonly executionCostUsdCents: string;
  readonly expiresAtUnixSeconds: string;
}

export interface WireOptimizeRequestV1 {
  readonly version: number;
  readonly mode: string;
  readonly inputAsset: AssetIdV1;
  readonly outputAsset: AssetIdV1;
  readonly amountIn: string;
  readonly userMinOut: string;
  readonly toleranceBps: number;
  readonly asOfUnixSeconds: string;
  readonly expiresAtUnixSeconds: string;
  readonly snapshotId: string;
  readonly candidates: readonly WireCandidateV1[];
}

export type WireOptimizeResponseV1 =
  | {
      readonly status: "SELECTED";
      readonly selectedRouteId: string;
      readonly amountIn: string;
      readonly grossOut: string;
      readonly feeOut: string;
      readonly expectedOut: string;
      readonly minimumOut: string;
      readonly executionCostUsdCents: string;
      readonly effectiveExpiry: string;
      readonly snapshotId: string;
      readonly evaluatedCount: number;
      readonly rejected: readonly RejectedCandidateV1[];
    }
  | {
      readonly status: "NO_ROUTE";
      readonly amountIn: string;
      readonly snapshotId: string;
      readonly evaluatedCount: number;
      readonly rejected: readonly RejectedCandidateV1[];
    }
  | {
      readonly status: "ERROR";
      readonly error: {
        readonly code: OptimizerErrorCode;
        readonly message: string;
      };
    };
