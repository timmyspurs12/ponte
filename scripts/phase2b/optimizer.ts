/**
 * Phase 2B.1 — Pure TypeScript V1 synthetic route optimizer reference.
 *
 * Implements structural validation, deterministic per-candidate evaluation,
 * rejection precedence, and canonical tie-breaking using BigInt only.
 */

import {
  assertCanonicalBytes32,
  compareBytes32,
  computeCandidateAmounts,
} from "./arithmetic";
import {
  ERROR_MESSAGES,
  MAX_ASSET_DECIMALS,
  MAX_ASSET_FIELD_LEN,
  MAX_BPS,
  MAX_CANDIDATES,
  MIN_CANDIDATES,
  OPTIMIZER_MODE_SYNTHETIC,
  OPTIMIZER_VERSION_V1,
  OptimizerValidationError,
  U64_MAX,
  U128_MAX,
  type AssetIdV1,
  type CandidateV1,
  type OptimizeOutcomeV1,
  type OptimizeRequestV1,
  type OptimizeResultV1,
  type RejectedCandidateV1,
} from "./model";

interface EligibleCandidate {
  readonly routeId: string;
  readonly grossOut: bigint;
  readonly feeOut: bigint;
  readonly expectedOut: bigint;
  readonly minimumOut: bigint;
  readonly executionCostUsdCents: bigint;
  readonly effectiveExpiry: bigint;
}

function isValidAsciiIdentifier(value: string): boolean {
  if (value.length < 1 || value.length > MAX_ASSET_FIELD_LEN) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

function validateAsset(asset: AssetIdV1): void {
  if (
    !isValidAsciiIdentifier(asset.namespace) ||
    !isValidAsciiIdentifier(asset.identifier)
  ) {
    throw new OptimizerValidationError("INVALID_ASSET");
  }
  if (
    !Number.isInteger(asset.decimals) ||
    asset.decimals < 0 ||
    asset.decimals > MAX_ASSET_DECIMALS
  ) {
    throw new OptimizerValidationError("INVALID_ASSET_DECIMALS");
  }
}

function assertU128Range(value: bigint): void {
  if (value < 0n || value > U128_MAX) {
    throw new OptimizerValidationError("INTEGER_OVERFLOW");
  }
}

function assertU64Range(value: bigint): void {
  if (value < 0n || value > U64_MAX) {
    throw new OptimizerValidationError("INTEGER_OVERFLOW");
  }
}

function assertBpsRange(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_BPS) {
    throw new OptimizerValidationError("INVALID_BPS");
  }
}

function validateCandidateTypeBounds(candidate: CandidateV1): void {
  assertCanonicalBytes32(candidate.routeId);
  assertCanonicalBytes32(candidate.snapshotId);
  assertU128Range(candidate.rateNumerator);
  assertU128Range(candidate.rateDenominator);
  assertBpsRange(candidate.feeBps);
  assertBpsRange(candidate.estimatedImpactBps);
  assertU128Range(candidate.minInput);
  assertU128Range(candidate.maxInput);
  assertU128Range(candidate.availableInput);
  assertU128Range(candidate.availableOutput);
  assertU128Range(candidate.executionCostUsdCents);
  assertU64Range(candidate.expiresAtUnixSeconds);
}

/**
 * Validates all structural request fields and returns candidates sorted in
 * canonical unsigned 32-byte routeId ascending order.
 */
export function validateRequestV1(
  request: OptimizeRequestV1,
): readonly CandidateV1[] {
  if (request.version !== OPTIMIZER_VERSION_V1) {
    throw new OptimizerValidationError("UNSUPPORTED_VERSION");
  }
  if (request.mode !== OPTIMIZER_MODE_SYNTHETIC) {
    throw new OptimizerValidationError("UNSUPPORTED_MODE");
  }

  validateAsset(request.inputAsset);
  validateAsset(request.outputAsset);
  if (
    request.inputAsset.namespace === request.outputAsset.namespace &&
    request.inputAsset.identifier === request.outputAsset.identifier
  ) {
    throw new OptimizerValidationError("INVALID_ASSET");
  }

  assertU128Range(request.amountIn);
  if (request.amountIn === 0n) {
    throw new OptimizerValidationError("INVALID_AMOUNT_IN");
  }
  assertU128Range(request.userMinOut);
  assertBpsRange(request.toleranceBps);

  assertU64Range(request.asOfUnixSeconds);
  assertU64Range(request.expiresAtUnixSeconds);
  if (request.asOfUnixSeconds >= request.expiresAtUnixSeconds) {
    throw new OptimizerValidationError("INVALID_REQUEST_EXPIRY");
  }

  assertCanonicalBytes32(request.snapshotId);

  const count = request.candidates.length;
  if (count < MIN_CANDIDATES || count > MAX_CANDIDATES) {
    throw new OptimizerValidationError("INVALID_CANDIDATE_COUNT");
  }

  for (const candidate of request.candidates) {
    validateCandidateTypeBounds(candidate);
  }

  const sorted = [...request.candidates].sort((a, b) =>
    compareBytes32(a.routeId, b.routeId),
  );

  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i - 1].routeId === sorted[i].routeId) {
      throw new OptimizerValidationError("DUPLICATE_ROUTE_ID");
    }
  }

  for (const candidate of sorted) {
    if (candidate.snapshotId !== request.snapshotId) {
      throw new OptimizerValidationError("SNAPSHOT_MISMATCH");
    }
    if (candidate.rateNumerator === 0n || candidate.rateDenominator === 0n) {
      throw new OptimizerValidationError("ZERO_RATE");
    }
    if (candidate.minInput > candidate.maxInput) {
      throw new OptimizerValidationError("INVALID_CANDIDATE_BOUNDS");
    }
  }

  return sorted;
}

function isBetterCandidate(
  challenger: EligibleCandidate,
  incumbent: EligibleCandidate,
): boolean {
  if (challenger.expectedOut !== incumbent.expectedOut) {
    return challenger.expectedOut > incumbent.expectedOut;
  }
  if (challenger.executionCostUsdCents !== incumbent.executionCostUsdCents) {
    return challenger.executionCostUsdCents < incumbent.executionCostUsdCents;
  }
  return compareBytes32(challenger.routeId, incumbent.routeId) < 0;
}

/**
 * Evaluates a pre-parsed OptimizeRequestV1 and returns a typed OptimizeOutcomeV1
 * or throws OptimizerValidationError on structural errors.
 */
export function optimizeV1OrThrow(
  request: OptimizeRequestV1,
): OptimizeOutcomeV1 {
  const sortedCandidates = validateRequestV1(request);
  const rejected: RejectedCandidateV1[] = [];
  let winner: EligibleCandidate | null = null;

  for (const candidate of sortedCandidates) {
    const effectiveExpiry =
      request.expiresAtUnixSeconds <= candidate.expiresAtUnixSeconds
        ? request.expiresAtUnixSeconds
        : candidate.expiresAtUnixSeconds;

    // 1. EXPIRED
    if (request.asOfUnixSeconds >= effectiveExpiry) {
      rejected.push({ routeId: candidate.routeId, reason: "EXPIRED" });
      continue;
    }

    // 2. BELOW_MIN
    if (request.amountIn < candidate.minInput) {
      rejected.push({ routeId: candidate.routeId, reason: "BELOW_MIN" });
      continue;
    }

    // 3. CAPACITY
    if (request.amountIn > candidate.maxInput) {
      rejected.push({ routeId: candidate.routeId, reason: "CAPACITY" });
      continue;
    }

    // 4. INPUT_LIQUIDITY
    if (request.amountIn > candidate.availableInput) {
      rejected.push({ routeId: candidate.routeId, reason: "INPUT_LIQUIDITY" });
      continue;
    }

    // 5. ARITHMETIC_RANGE
    const calc = computeCandidateAmounts(
      request.amountIn,
      candidate.rateNumerator,
      candidate.rateDenominator,
      candidate.feeBps,
      request.toleranceBps,
      request.userMinOut,
    );
    if (!calc.ok) {
      rejected.push({ routeId: candidate.routeId, reason: calc.reason });
      continue;
    }

    const { grossOut, expectedOut, feeOut, requiredMinOut } = calc.amounts;

    // 6. ZERO_OUTPUT
    if (expectedOut === 0n) {
      rejected.push({ routeId: candidate.routeId, reason: "ZERO_OUTPUT" });
      continue;
    }

    // 7. OUTPUT_LIQUIDITY
    if (expectedOut > candidate.availableOutput) {
      rejected.push({ routeId: candidate.routeId, reason: "OUTPUT_LIQUIDITY" });
      continue;
    }

    // 8. USER_MIN_UNMET
    if (requiredMinOut > expectedOut) {
      rejected.push({ routeId: candidate.routeId, reason: "USER_MIN_UNMET" });
      continue;
    }

    const eligible: EligibleCandidate = {
      routeId: candidate.routeId,
      grossOut,
      feeOut,
      expectedOut,
      minimumOut: requiredMinOut,
      executionCostUsdCents: candidate.executionCostUsdCents,
      effectiveExpiry,
    };

    if (winner === null || isBetterCandidate(eligible, winner)) {
      winner = eligible;
    }
  }

  if (winner === null) {
    return {
      status: "NO_ROUTE",
      amountIn: request.amountIn,
      snapshotId: request.snapshotId,
      evaluatedCount: sortedCandidates.length,
      rejected,
    };
  }

  return {
    status: "SELECTED",
    selectedRouteId: winner.routeId,
    amountIn: request.amountIn,
    grossOut: winner.grossOut,
    feeOut: winner.feeOut,
    expectedOut: winner.expectedOut,
    minimumOut: winner.minimumOut,
    executionCostUsdCents: winner.executionCostUsdCents,
    effectiveExpiry: winner.effectiveExpiry,
    snapshotId: request.snapshotId,
    evaluatedCount: sortedCandidates.length,
    rejected,
  };
}

/**
 * Non-throwing typed result wrapper around optimizeV1OrThrow.
 */
export function optimizeV1(request: OptimizeRequestV1): OptimizeResultV1 {
  try {
    return { ok: true, value: optimizeV1OrThrow(request) };
  } catch (err) {
    if (err instanceof OptimizerValidationError) {
      return {
        ok: false,
        error: {
          code: err.code,
          message: ERROR_MESSAGES[err.code],
        },
      };
    }
    throw err;
  }
}
