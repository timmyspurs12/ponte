/**
 * Phase 2B.1 — Versioned static fixture specification and builder.
 *
 * Constructs hand-derived static edge-case, legacy-parity, and minimized
 * regression vectors with independently specified expected results, verifies
 * each vector against the TypeScript V1 reference and legacy quote() engine,
 * and writes versioned JSON files under scripts/phase2b/fixtures/v1/.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { quote as legacyQuote } from "../../src/lib/quotes";
import { evaluateJsonLine } from "./json";
import {
  ERROR_MESSAGES,
  U64_MAX,
  U128_MAX,
  U256_MAX,
  type OptimizerErrorCode,
  type WireCandidateV1,
  type WireOptimizeRequestV1,
  type WireOptimizeResponseV1,
} from "./model";

export interface StaticFixtureVector {
  readonly id: string;
  readonly category: string;
  readonly description: string;
  readonly synthetic: true;
  readonly rawRequestJson: string;
  readonly expectedResponse: WireOptimizeResponseV1;
}

export interface StaticFixtureFile {
  readonly schemaVersion: 1;
  readonly suite: string;
  readonly syntheticOnly: true;
  readonly vectors: readonly StaticFixtureVector[];
}

const SNAPSHOT_A = `0x${"a1".repeat(32)}`;
const SNAPSHOT_B = `0x${"b2".repeat(32)}`;

function routeIdHex(index: number): string {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

const SYNTH_BRL = {
  namespace: "SYNTHETIC_FIAT",
  identifier: "SYNTH_BRL",
  decimals: 2,
} as const;

const SYNTH_USDG = {
  namespace: "SYNTHETIC_TOKEN",
  identifier: "SYNTH_USDG",
  decimals: 2,
} as const;

function baseCandidate(
  overrides: Partial<WireCandidateV1> = {},
): WireCandidateV1 {
  return {
    routeId: routeIdHex(1),
    snapshotId: SNAPSHOT_A,
    rateNumerator: "2",
    rateDenominator: "1",
    feeBps: 50,
    estimatedImpactBps: 10,
    minInput: "1",
    maxInput: U128_MAX.toString(),
    availableInput: U128_MAX.toString(),
    availableOutput: U128_MAX.toString(),
    executionCostUsdCents: "4",
    expiresAtUnixSeconds: "1763324100",
    ...overrides,
  };
}

function baseRequest(
  overrides: Partial<WireOptimizeRequestV1> = {},
): WireOptimizeRequestV1 {
  return {
    version: 1,
    mode: "SYNTHETIC",
    inputAsset: SYNTH_BRL,
    outputAsset: SYNTH_USDG,
    amountIn: "1000",
    userMinOut: "0",
    toleranceBps: 50,
    asOfUnixSeconds: "1763323200",
    expiresAtUnixSeconds: "1763324100",
    snapshotId: SNAPSHOT_A,
    candidates: [baseCandidate()],
    ...overrides,
  };
}

function errorExpected(code: OptimizerErrorCode): WireOptimizeResponseV1 {
  return {
    status: "ERROR",
    error: {
      code,
      message: ERROR_MESSAGES[code],
    },
  };
}

function buildEdgeCaseFixtures(): StaticFixtureFile {
  const vectors: StaticFixtureVector[] = [];

  // 1. Normal amount & readiness report hand-derived example (F=1000, rate=2/1, A=100bps/3c, B=50bps/4c)
  vectors.push({
    id: "edge-001-normal-two-candidate-selection",
    category: "normal_amounts",
    description:
      "Synthetic two-candidate evaluation from readiness report: route 2 wins with expectedOut=1990 over route 1 expectedOut=1980 despite 1c higher execution cost.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        candidates: [
          baseCandidate({
            routeId: routeIdHex(1),
            feeBps: 100,
            executionCostUsdCents: "3",
          }),
          baseCandidate({
            routeId: routeIdHex(2),
            feeBps: 50,
            executionCostUsdCents: "4",
          }),
        ],
      }),
    ),
    expectedResponse: {
      status: "SELECTED",
      selectedRouteId: routeIdHex(2),
      amountIn: "1000",
      grossOut: "2000",
      feeOut: "10",
      expectedOut: "1990",
      minimumOut: "1980",
      executionCostUsdCents: "4",
      effectiveExpiry: "1763324100",
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 2,
      rejected: [],
    },
  });

  // 2a. Smallest supported amount (amountIn = 1)
  vectors.push({
    id: "edge-002-smallest-supported-amount",
    category: "smallest_and_largest_amounts",
    description: "Smallest supported input amountIn=1 with rate 3/1 and 0 fee.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        amountIn: "1",
        toleranceBps: 0,
        candidates: [
          baseCandidate({
            rateNumerator: "3",
            rateDenominator: "1",
            feeBps: 0,
            executionCostUsdCents: "1",
          }),
        ],
      }),
    ),
    expectedResponse: {
      status: "SELECTED",
      selectedRouteId: routeIdHex(1),
      amountIn: "1",
      grossOut: "3",
      feeOut: "0",
      expectedOut: "3",
      minimumOut: "3",
      executionCostUsdCents: "1",
      effectiveExpiry: "1763324100",
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 1,
      rejected: [],
    },
  });

  // 2b. Largest supported amount (amountIn = U128_MAX, N=1, D=1, feeBps=0)
  // F * N * 10000 = (2^128 - 1) * 10000 < 2^256 - 1, so O = U128_MAX!
  const u128MaxTol50 = ((U128_MAX * 9950n) / 10_000n).toString();
  vectors.push({
    id: "edge-003-largest-supported-amount-u128-max",
    category: "smallest_and_largest_amounts",
    description:
      "Largest supported amountIn=U128_MAX with 1:1 rate and zero fee produces expectedOut=U128_MAX without U256 overflow.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        amountIn: U128_MAX.toString(),
        toleranceBps: 50,
        candidates: [
          baseCandidate({
            rateNumerator: "1",
            rateDenominator: "1",
            feeBps: 0,
            executionCostUsdCents: "0",
          }),
        ],
      }),
    ),
    expectedResponse: {
      status: "SELECTED",
      selectedRouteId: routeIdHex(1),
      amountIn: U128_MAX.toString(),
      grossOut: U128_MAX.toString(),
      feeOut: "0",
      expectedOut: U128_MAX.toString(),
      minimumOut: u128MaxTol50,
      executionCostUsdCents: "0",
      effectiveExpiry: "1763324100",
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 1,
      rejected: [],
    },
  });

  // 3. Fee rounding boundary where single floor differs from double-rounded fee subtraction
  // F=2500000, N=100, D=525, f=35 => G=476190, O=474523, feeOut=1667 (naive floor(G*35/10000)=1666 would yield 474524)
  vectors.push({
    id: "edge-004-fee-rounding-single-floor",
    category: "fee_rounding_boundaries",
    description:
      "Preserves single floor division O=floor(F*N*(10000-f)/(D*10000))=474523 and feeOut=G-O=1667 instead of double-rounded fee deduction.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        amountIn: "2500000",
        toleranceBps: 50,
        candidates: [
          baseCandidate({
            rateNumerator: "100",
            rateDenominator: "525",
            feeBps: 35,
            estimatedImpactBps: 5,
            executionCostUsdCents: "2",
          }),
        ],
      }),
    ),
    expectedResponse: {
      status: "SELECTED",
      selectedRouteId: routeIdHex(1),
      amountIn: "2500000",
      grossOut: "476190",
      feeOut: "1667",
      expectedOut: "474523",
      minimumOut: "472150",
      executionCostUsdCents: "2",
      effectiveExpiry: "1763324100",
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 1,
      rejected: [],
    },
  });

  // 4a. Tolerance boundary: toleranceBps=10000 with userMinOut=0 => T=0, M=0
  vectors.push({
    id: "edge-005-tolerance-max-bps-zero-user-min",
    category: "tolerance_boundaries",
    description:
      "At toleranceBps=10000 and userMinOut=0, T=0 and required minimum M=0 <= O.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        amountIn: "1000",
        userMinOut: "0",
        toleranceBps: 10000,
      }),
    ),
    expectedResponse: {
      status: "SELECTED",
      selectedRouteId: routeIdHex(1),
      amountIn: "1000",
      grossOut: "2000",
      feeOut: "10",
      expectedOut: "1990",
      minimumOut: "0",
      executionCostUsdCents: "4",
      effectiveExpiry: "1763324100",
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 1,
      rejected: [],
    },
  });

  // 4b. Tolerance boundary: userMinOut == O succeeds (M = max(T, O) = O); userMinOut == O + 1 fails USER_MIN_UNMET
  vectors.push({
    id: "edge-006-user-min-exact-and-unmet",
    category: "tolerance_boundaries",
    description:
      "Route 1 (O=1980 < userMinOut=1990) is rejected with USER_MIN_UNMET while Route 2 (O=1990 == userMinOut=1990) is selected with M=1990.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        amountIn: "1000",
        userMinOut: "1990",
        toleranceBps: 50,
        candidates: [
          baseCandidate({ routeId: routeIdHex(1), feeBps: 100 }),
          baseCandidate({ routeId: routeIdHex(2), feeBps: 50 }),
        ],
      }),
    ),
    expectedResponse: {
      status: "SELECTED",
      selectedRouteId: routeIdHex(2),
      amountIn: "1000",
      grossOut: "2000",
      feeOut: "10",
      expectedOut: "1990",
      minimumOut: "1990",
      executionCostUsdCents: "4",
      effectiveExpiry: "1763324100",
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 2,
      rejected: [{ routeId: routeIdHex(1), reason: "USER_MIN_UNMET" }],
    },
  });

  // 5. Zero and maximum fee basis points (feeBps=10000 -> ZERO_OUTPUT; feeBps=0 -> O=G)
  vectors.push({
    id: "edge-007-zero-and-max-fee-bps",
    category: "zero_and_max_bps",
    description:
      "Candidate with feeBps=10000 produces O=0 and is rejected with ZERO_OUTPUT; candidate with feeBps=0 and toleranceBps=0 yields G=O=M=2000.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        amountIn: "1000",
        toleranceBps: 0,
        candidates: [
          baseCandidate({ routeId: routeIdHex(1), feeBps: 10000 }),
          baseCandidate({ routeId: routeIdHex(2), feeBps: 0 }),
        ],
      }),
    ),
    expectedResponse: {
      status: "SELECTED",
      selectedRouteId: routeIdHex(2),
      amountIn: "1000",
      grossOut: "2000",
      feeOut: "0",
      expectedOut: "2000",
      minimumOut: "2000",
      executionCostUsdCents: "4",
      effectiveExpiry: "1763324100",
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 2,
      rejected: [{ routeId: routeIdHex(1), reason: "ZERO_OUTPUT" }],
    },
  });

  // 6. Insufficient input liquidity (F-1 rejected, F accepted)
  vectors.push({
    id: "edge-008-input-liquidity-boundary",
    category: "insufficient_input_liquidity",
    description:
      "Route 1 with availableInput=999 (< F=1000) is rejected with INPUT_LIQUIDITY; Route 2 with availableInput=1000 is selected.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        amountIn: "1000",
        candidates: [
          baseCandidate({
            routeId: routeIdHex(1),
            feeBps: 10,
            availableInput: "999",
          }),
          baseCandidate({
            routeId: routeIdHex(2),
            feeBps: 50,
            availableInput: "1000",
          }),
        ],
      }),
    ),
    expectedResponse: {
      status: "SELECTED",
      selectedRouteId: routeIdHex(2),
      amountIn: "1000",
      grossOut: "2000",
      feeOut: "10",
      expectedOut: "1990",
      minimumOut: "1980",
      executionCostUsdCents: "4",
      effectiveExpiry: "1763324100",
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 2,
      rejected: [{ routeId: routeIdHex(1), reason: "INPUT_LIQUIDITY" }],
    },
  });

  // 7. Insufficient output liquidity (O-1 rejected, O accepted)
  vectors.push({
    id: "edge-009-output-liquidity-boundary",
    category: "insufficient_output_liquidity",
    description:
      "Route 1 with O=1990 and availableOutput=1989 is rejected with OUTPUT_LIQUIDITY; Route 2 with O=1990 and availableOutput=1990 is selected.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        amountIn: "1000",
        candidates: [
          baseCandidate({
            routeId: routeIdHex(1),
            availableOutput: "1989",
            executionCostUsdCents: "1",
          }),
          baseCandidate({
            routeId: routeIdHex(2),
            availableOutput: "1990",
            executionCostUsdCents: "4",
          }),
        ],
      }),
    ),
    expectedResponse: {
      status: "SELECTED",
      selectedRouteId: routeIdHex(2),
      amountIn: "1000",
      grossOut: "2000",
      feeOut: "10",
      expectedOut: "1990",
      minimumOut: "1980",
      executionCostUsdCents: "4",
      effectiveExpiry: "1763324100",
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 2,
      rejected: [{ routeId: routeIdHex(1), reason: "OUTPUT_LIQUIDITY" }],
    },
  });

  // 8. Minimum and maximum input capacity boundaries (BELOW_MIN, CAPACITY, exact min==F==max)
  vectors.push({
    id: "edge-010-min-max-input-boundaries",
    category: "min_max_input_boundaries",
    description:
      "Route 1 (minInput=1001) fails BELOW_MIN; Route 2 (maxInput=999) fails CAPACITY; Route 3 (minInput=1000, maxInput=1000) succeeds.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        amountIn: "1000",
        candidates: [
          baseCandidate({
            routeId: routeIdHex(1),
            minInput: "1001",
            maxInput: "2000",
          }),
          baseCandidate({
            routeId: routeIdHex(2),
            minInput: "1",
            maxInput: "999",
          }),
          baseCandidate({
            routeId: routeIdHex(3),
            minInput: "1000",
            maxInput: "1000",
          }),
        ],
      }),
    ),
    expectedResponse: {
      status: "SELECTED",
      selectedRouteId: routeIdHex(3),
      amountIn: "1000",
      grossOut: "2000",
      feeOut: "10",
      expectedOut: "1990",
      minimumOut: "1980",
      executionCostUsdCents: "4",
      effectiveExpiry: "1763324100",
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 3,
      rejected: [
        { routeId: routeIdHex(1), reason: "BELOW_MIN" },
        { routeId: routeIdHex(2), reason: "CAPACITY" },
      ],
    },
  });

  // 9 & 10. Expired candidates & effectiveExpiry = min(request.expiresAt, candidate.expiresAt)
  vectors.push({
    id: "edge-011-candidate-and-request-expiry",
    category: "expiry_boundaries",
    description:
      "Route 1 (expiresAt == asOf) and Route 2 (expiresAt < asOf) fail EXPIRED; Route 3 (expiresAt < request.expiresAt) sets effectiveExpiry to candidate expiry.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        asOfUnixSeconds: "1763323200",
        expiresAtUnixSeconds: "1763324100",
        candidates: [
          baseCandidate({
            routeId: routeIdHex(1),
            expiresAtUnixSeconds: "1763323200",
          }),
          baseCandidate({
            routeId: routeIdHex(2),
            expiresAtUnixSeconds: "1763323199",
          }),
          baseCandidate({
            routeId: routeIdHex(3),
            expiresAtUnixSeconds: "1763323201",
          }),
        ],
      }),
    ),
    expectedResponse: {
      status: "SELECTED",
      selectedRouteId: routeIdHex(3),
      amountIn: "1000",
      grossOut: "2000",
      feeOut: "10",
      expectedOut: "1990",
      minimumOut: "1980",
      executionCostUsdCents: "4",
      effectiveExpiry: "1763323201",
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 3,
      rejected: [
        { routeId: routeIdHex(1), reason: "EXPIRED" },
        { routeId: routeIdHex(2), reason: "EXPIRED" },
      ],
    },
  });

  // 10b. Candidate expiry > request expiry caps effectiveExpiry at request expiry (tested at U64_MAX)
  vectors.push({
    id: "edge-012-effective-expiry-capped-by-request-and-u64-max",
    category: "expiry_boundaries",
    description:
      "When candidate expiresAt=U64_MAX exceeds request expiresAt=U64_MAX-10, effectiveExpiry equals request expiresAt.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        asOfUnixSeconds: (U64_MAX - 20n).toString(),
        expiresAtUnixSeconds: (U64_MAX - 10n).toString(),
        candidates: [
          baseCandidate({
            routeId: routeIdHex(1),
            expiresAtUnixSeconds: U64_MAX.toString(),
          }),
        ],
      }),
    ),
    expectedResponse: {
      status: "SELECTED",
      selectedRouteId: routeIdHex(1),
      amountIn: "1000",
      grossOut: "2000",
      feeOut: "10",
      expectedOut: "1990",
      minimumOut: "1980",
      executionCostUsdCents: "4",
      effectiveExpiry: (U64_MAX - 10n).toString(),
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 1,
      rejected: [],
    },
  });

  // 11. Equal expected output broken by lowest executionCostUsdCents
  vectors.push({
    id: "edge-013-equal-expected-output-cost-tiebreaker",
    category: "equal_expected_output",
    description:
      "Routes 1, 2, 3 produce identical expectedOut=1990; Route 2 wins on lowest executionCostUsdCents=2 (never subtracted from token output).",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        candidates: [
          baseCandidate({
            routeId: routeIdHex(1),
            executionCostUsdCents: "5",
          }),
          baseCandidate({
            routeId: routeIdHex(2),
            executionCostUsdCents: "2",
          }),
          baseCandidate({
            routeId: routeIdHex(3),
            executionCostUsdCents: "20",
          }),
        ],
      }),
    ),
    expectedResponse: {
      status: "SELECTED",
      selectedRouteId: routeIdHex(2),
      amountIn: "1000",
      grossOut: "2000",
      feeOut: "10",
      expectedOut: "1990",
      minimumOut: "1980",
      executionCostUsdCents: "2",
      effectiveExpiry: "1763324100",
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 3,
      rejected: [],
    },
  });

  // 12 & 13 & 14. Equal expected output AND equal cost broken by lexicographically smallest routeId, invariant under reverse permutation
  vectors.push({
    id: "edge-014-equal-output-equal-cost-route-id-tiebreaker-permuted",
    category: "deterministic_tie_breaking_and_permutation",
    description:
      "Candidates supplied in descending routeId order with identical output and cost still select smallest canonical bytes32 routeId and sort rejected deterministically.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        candidates: [
          baseCandidate({
            routeId: `0x${"ff".repeat(32)}`,
            executionCostUsdCents: "3",
          }),
          baseCandidate({
            routeId: routeIdHex(9),
            expiresAtUnixSeconds: "1763323100",
          }),
          baseCandidate({
            routeId: routeIdHex(5),
            executionCostUsdCents: "3",
          }),
          baseCandidate({
            routeId: routeIdHex(2),
            minInput: "5000",
            maxInput: "6000",
          }),
          baseCandidate({
            routeId: routeIdHex(4),
            executionCostUsdCents: "3",
          }),
        ],
      }),
    ),
    expectedResponse: {
      status: "SELECTED",
      selectedRouteId: routeIdHex(4),
      amountIn: "1000",
      grossOut: "2000",
      feeOut: "10",
      expectedOut: "1990",
      minimumOut: "1980",
      executionCostUsdCents: "3",
      effectiveExpiry: "1763324100",
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 5,
      rejected: [
        { routeId: routeIdHex(2), reason: "BELOW_MIN" },
        { routeId: routeIdHex(9), reason: "EXPIRED" },
      ],
    },
  });

  // Asset decimals metadata non-rescaling test (decimals 6 -> 18)
  vectors.push({
    id: "edge-015-asset-decimals-metadata-no-rescaling",
    category: "asset_decimals_metadata",
    description:
      "Mixed asset decimals (6 and 18) are metadata only; optimizer does not rescale amountIn or rate.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        inputAsset: {
          namespace: "SYNTHETIC_TOKEN",
          identifier: "SYNTH_IN_6",
          decimals: 6,
        },
        outputAsset: {
          namespace: "SYNTHETIC_TOKEN",
          identifier: "SYNTH_OUT_18",
          decimals: 18,
        },
        amountIn: "1000",
        toleranceBps: 0,
        candidates: [
          baseCandidate({
            rateNumerator: "3",
            rateDenominator: "2",
            feeBps: 0,
            executionCostUsdCents: "1",
          }),
        ],
      }),
    ),
    expectedResponse: {
      status: "SELECTED",
      selectedRouteId: routeIdHex(1),
      amountIn: "1000",
      grossOut: "1500",
      feeOut: "0",
      expectedOut: "1500",
      minimumOut: "1500",
      executionCostUsdCents: "1",
      effectiveExpiry: "1763324100",
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 1,
      rejected: [],
    },
  });

  // 19b. Gross output U128 overflow -> ARITHMETIC_RANGE
  vectors.push({
    id: "edge-016-gross-output-u128-overflow-rejected",
    category: "u128_overflow",
    description:
      "Candidate whose gross output G = U128_MAX * 2 / 1 exceeds U128_MAX is rejected with ARITHMETIC_RANGE while fallback route wins.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        amountIn: U128_MAX.toString(),
        toleranceBps: 0,
        candidates: [
          baseCandidate({
            routeId: routeIdHex(1),
            rateNumerator: "2",
            rateDenominator: "1",
            feeBps: 0,
          }),
          baseCandidate({
            routeId: routeIdHex(2),
            rateNumerator: "1",
            rateDenominator: "2",
            feeBps: 0,
          }),
        ],
      }),
    ),
    expectedResponse: {
      status: "SELECTED",
      selectedRouteId: routeIdHex(2),
      amountIn: U128_MAX.toString(),
      grossOut: (U128_MAX / 2n).toString(),
      feeOut: "0",
      expectedOut: (U128_MAX / 2n).toString(),
      minimumOut: (U128_MAX / 2n).toString(),
      executionCostUsdCents: "4",
      effectiveExpiry: "1763324100",
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 2,
      rejected: [{ routeId: routeIdHex(1), reason: "ARITHMETIC_RANGE" }],
    },
  });

  // 20. U256 intermediate overflow even when algebraic cancellation would fit U128!
  // F = U128_MAX, N = U128_MAX, D = U128_MAX, feeBps = 0 => G = U128_MAX fits,
  // but F * N * 10000 overflows U256!
  vectors.push({
    id: "edge-017-u256-intermediate-overflow-no-cancellation",
    category: "u256_intermediate_overflow",
    description:
      "Explicitly rejects U256 overflow in F * N * (10000 - f) even though algebraic cancellation with D * 10000 would equal U128_MAX.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        amountIn: U128_MAX.toString(),
        toleranceBps: 0,
        candidates: [
          baseCandidate({
            routeId: routeIdHex(1),
            rateNumerator: U128_MAX.toString(),
            rateDenominator: U128_MAX.toString(),
            feeBps: 0,
          }),
        ],
      }),
    ),
    expectedResponse: {
      status: "NO_ROUTE",
      amountIn: U128_MAX.toString(),
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 1,
      rejected: [{ routeId: routeIdHex(1), reason: "ARITHMETIC_RANGE" }],
    },
  });

  // 21. No feasible route across all 8 rejection reasons in shuffled input order
  vectors.push({
    id: "edge-018-no-feasible-route-all-eight-reasons",
    category: "no_feasible_route",
    description:
      "Evaluates 8 infeasible candidates covering all 8 deterministic rejection reasons and returns NO_ROUTE sorted by canonical routeId.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        amountIn: "1000",
        userMinOut: "2500",
        toleranceBps: 50,
        candidates: [
          baseCandidate({
            routeId: routeIdHex(8),
            rateNumerator: "2",
            rateDenominator: "1",
            feeBps: 0, // O = 2000 < userMinOut 2500 => USER_MIN_UNMET
          }),
          baseCandidate({
            routeId: routeIdHex(4),
            availableInput: "999", // INPUT_LIQUIDITY
          }),
          baseCandidate({
            routeId: routeIdHex(1),
            expiresAtUnixSeconds: "1763323200", // EXPIRED
          }),
          baseCandidate({
            routeId: routeIdHex(6),
            rateNumerator: "1",
            rateDenominator: "5000", // O = 0 => ZERO_OUTPUT
          }),
          baseCandidate({
            routeId: routeIdHex(2),
            minInput: "1001",
            maxInput: "2000", // BELOW_MIN
          }),
          baseCandidate({
            routeId: routeIdHex(7),
            rateNumerator: "3",
            rateDenominator: "1",
            feeBps: 0,
            availableOutput: "2999", // O = 3000 > 2999 => OUTPUT_LIQUIDITY
          }),
          baseCandidate({
            routeId: routeIdHex(5),
            rateNumerator: U128_MAX.toString(),
            rateDenominator: "1", // G = 1000 * U128_MAX > U128_MAX => ARITHMETIC_RANGE
          }),
          baseCandidate({
            routeId: routeIdHex(3),
            minInput: "1",
            maxInput: "999", // CAPACITY
          }),
        ],
      }),
    ),
    expectedResponse: {
      status: "NO_ROUTE",
      amountIn: "1000",
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 8,
      rejected: [
        { routeId: routeIdHex(1), reason: "EXPIRED" },
        { routeId: routeIdHex(2), reason: "BELOW_MIN" },
        { routeId: routeIdHex(3), reason: "CAPACITY" },
        { routeId: routeIdHex(4), reason: "INPUT_LIQUIDITY" },
        { routeId: routeIdHex(5), reason: "ARITHMETIC_RANGE" },
        { routeId: routeIdHex(6), reason: "ZERO_OUTPUT" },
        { routeId: routeIdHex(7), reason: "OUTPUT_LIQUIDITY" },
        { routeId: routeIdHex(8), reason: "USER_MIN_UNMET" },
      ],
    },
  });

  // 22a. Maximum candidate count = 64
  const max64Candidates: WireCandidateV1[] = [];
  for (let i = 64; i >= 1; i -= 1) {
    max64Candidates.push(
      baseCandidate({
        routeId: routeIdHex(i),
        feeBps: 100,
        executionCostUsdCents: String(i),
      }),
    );
  }
  vectors.push({
    id: "edge-019-max-candidate-count-64",
    category: "candidate_count_limits",
    description:
      "Accepts maximum 64 candidates supplied in reverse order and selects route 1 (lowest cost=1).",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        candidates: max64Candidates,
      }),
    ),
    expectedResponse: {
      status: "SELECTED",
      selectedRouteId: routeIdHex(1),
      amountIn: "1000",
      grossOut: "2000",
      feeOut: "20",
      expectedOut: "1980",
      minimumOut: "1970",
      executionCostUsdCents: "1",
      effectiveExpiry: "1763324100",
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 64,
      rejected: [],
    },
  });

  // 22b. Candidate count = 65 (one above limit) & 0
  const over65Candidates: WireCandidateV1[] = [];
  for (let i = 1; i <= 65; i += 1) {
    over65Candidates.push(baseCandidate({ routeId: routeIdHex(i) }));
  }
  vectors.push({
    id: "edge-020-candidate-count-65-rejected",
    category: "candidate_count_limits",
    description: "Rejects 65 candidates (one above maximum 64).",
    synthetic: true,
    rawRequestJson: JSON.stringify(baseRequest({ candidates: over65Candidates })),
    expectedResponse: errorExpected("INVALID_CANDIDATE_COUNT"),
  });

  vectors.push({
    id: "edge-021-candidate-count-0-rejected",
    category: "candidate_count_limits",
    description: "Rejects empty candidate array.",
    synthetic: true,
    rawRequestJson: JSON.stringify(baseRequest({ candidates: [] })),
    expectedResponse: errorExpected("INVALID_CANDIDATE_COUNT"),
  });

  // 15. Duplicate route IDs
  vectors.push({
    id: "edge-022-duplicate-route-ids",
    category: "duplicate_route_ids",
    description: "Rejects duplicate candidate routeId values.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        candidates: [
          baseCandidate({ routeId: routeIdHex(7), feeBps: 10 }),
          baseCandidate({ routeId: routeIdHex(7), feeBps: 20 }),
        ],
      }),
    ),
    expectedResponse: errorExpected("DUPLICATE_ROUTE_ID"),
  });

  // 16. Invalid snapshots (mismatch + malformed bytes32)
  vectors.push({
    id: "edge-023-snapshot-mismatch",
    category: "invalid_snapshots",
    description:
      "Rejects request when any candidate snapshotId differs from request snapshotId.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        candidates: [
          baseCandidate({ routeId: routeIdHex(1), snapshotId: SNAPSHOT_A }),
          baseCandidate({ routeId: routeIdHex(2), snapshotId: SNAPSHOT_B }),
        ],
      }),
    ),
    expectedResponse: errorExpected("SNAPSHOT_MISMATCH"),
  });

  vectors.push({
    id: "edge-024-invalid-bytes32-uppercase-and-short",
    category: "invalid_bytes32",
    description: "Rejects non-canonical uppercase bytes32 identifier.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        snapshotId: `0x${"AA".repeat(32)}`,
      }),
    ),
    expectedResponse: errorExpected("INVALID_BYTES32"),
  });

  // 17. Zero numerator or denominator
  vectors.push({
    id: "edge-025-zero-rate-numerator",
    category: "zero_rate",
    description: "Rejects candidate with zero rateNumerator.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        candidates: [baseCandidate({ rateNumerator: "0" })],
      }),
    ),
    expectedResponse: errorExpected("ZERO_RATE"),
  });

  vectors.push({
    id: "edge-026-zero-rate-denominator",
    category: "zero_rate",
    description: "Rejects candidate with zero rateDenominator.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        candidates: [baseCandidate({ rateDenominator: "0" })],
      }),
    ),
    expectedResponse: errorExpected("ZERO_RATE"),
  });

  // 18. Invalid integer encodings (leading zero, negative, float string, numeric JSON literal, scientific notation)
  for (const [suffix, badAmount] of [
    ["leading-zero", "0100"],
    ["negative", "-100"],
    ["decimal-point", "100.50"],
    ["scientific", "1e3"],
    ["whitespace", " 100"],
    ["empty", ""],
  ] as const) {
    vectors.push({
      id: `edge-027-invalid-int-encoding-${suffix}`,
      category: "invalid_integer_encodings",
      description: `Rejects non-canonical integer string "${badAmount}" for amountIn.`,
      synthetic: true,
      rawRequestJson: JSON.stringify({
        ...baseRequest(),
        amountIn: badAmount,
      }),
      expectedResponse: errorExpected("INVALID_INTEGER_ENCODING"),
    });
  }

  vectors.push({
    id: "edge-028-invalid-int-json-number-for-amount",
    category: "invalid_integer_encodings",
    description:
      "Rejects JSON numeric literal for amountIn; monetary values must be canonical strings.",
    synthetic: true,
    rawRequestJson: JSON.stringify({ ...baseRequest(), amountIn: 1000 }),
    expectedResponse: errorExpected("INVALID_INTEGER_ENCODING"),
  });

  // 19a. U128 request parse overflow
  vectors.push({
    id: "edge-029-u128-parse-overflow",
    category: "u128_overflow",
    description: "Rejects canonical integer string U128_MAX + 1 with INTEGER_OVERFLOW.",
    synthetic: true,
    rawRequestJson: JSON.stringify({
      ...baseRequest(),
      amountIn: (U128_MAX + 1n).toString(),
    }),
    expectedResponse: errorExpected("INTEGER_OVERFLOW"),
  });

  // Structural checks: version, mode, decimals, bps, request expiry, minInput > maxInput, zero amountIn
  vectors.push({
    id: "edge-030-unsupported-version",
    category: "structural_validation",
    description: "Rejects unsupported version=2.",
    synthetic: true,
    rawRequestJson: JSON.stringify({ ...baseRequest(), version: 2 }),
    expectedResponse: errorExpected("UNSUPPORTED_VERSION"),
  });

  vectors.push({
    id: "edge-031-unsupported-mode",
    category: "structural_validation",
    description: "Rejects unsupported mode=LIVE.",
    synthetic: true,
    rawRequestJson: JSON.stringify({ ...baseRequest(), mode: "LIVE" }),
    expectedResponse: errorExpected("UNSUPPORTED_MODE"),
  });

  vectors.push({
    id: "edge-032-invalid-asset-decimals-39",
    category: "structural_validation",
    description: "Rejects asset decimals=39 (above max 38).",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        outputAsset: { ...SYNTH_USDG, decimals: 39 },
      }),
    ),
    expectedResponse: errorExpected("INVALID_ASSET_DECIMALS"),
  });

  vectors.push({
    id: "edge-033-invalid-bps-above-10000",
    category: "structural_validation",
    description: "Rejects toleranceBps=10001.",
    synthetic: true,
    rawRequestJson: JSON.stringify(baseRequest({ toleranceBps: 10001 })),
    expectedResponse: errorExpected("INVALID_BPS"),
  });

  vectors.push({
    id: "edge-034-invalid-request-expiry",
    category: "structural_validation",
    description: "Rejects request where asOfUnixSeconds == expiresAtUnixSeconds.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        asOfUnixSeconds: "1763324100",
        expiresAtUnixSeconds: "1763324100",
      }),
    ),
    expectedResponse: errorExpected("INVALID_REQUEST_EXPIRY"),
  });

  vectors.push({
    id: "edge-035-min-input-greater-than-max-input",
    category: "structural_validation",
    description: "Rejects candidate where minInput > maxInput.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        candidates: [baseCandidate({ minInput: "500", maxInput: "499" })],
      }),
    ),
    expectedResponse: errorExpected("INVALID_CANDIDATE_BOUNDS"),
  });

  vectors.push({
    id: "edge-036-zero-amount-in",
    category: "structural_validation",
    description: "Rejects zero amountIn in core optimizer.",
    synthetic: true,
    rawRequestJson: JSON.stringify(baseRequest({ amountIn: "0" })),
    expectedResponse: errorExpected("INVALID_AMOUNT_IN"),
  });

  return {
    schemaVersion: 1,
    suite: "phase2b-v1-edge-cases",
    syntheticOnly: true,
    vectors,
  };
}

function buildLegacyParityFixtures(): StaticFixtureFile {
  const vectors: StaticFixtureVector[] = [];
  const legacyAmounts = ["100", "2500000", "1000000000"] as const;
  const legacyRouteMeta = [
    { id: "direct", routeId: routeIdHex(1), feeBps: 35, impactBps: 5 },
    { id: "split", routeId: routeIdHex(2), feeBps: 48, impactBps: 8 },
    { id: "multi", routeId: routeIdHex(3), feeBps: 65, impactBps: 12 },
  ] as const;

  for (const fundingMinor of legacyAmounts) {
    const legacy = legacyQuote({ fundingMinor });
    const grossExpected = ((BigInt(fundingMinor) * 100n) / 525n).toString();

    for (const meta of legacyRouteMeta) {
      const legacyRoute = legacy.routes.find((r) => r.id === meta.id)!;
      assert.equal(
        (BigInt(legacyRoute.outputMinor) + BigInt(legacyRoute.feeMinor)).toString(),
        grossExpected,
      );

      const req = baseRequest({
        amountIn: fundingMinor,
        userMinOut: "0",
        toleranceBps: 50,
        candidates: [
          baseCandidate({
            routeId: meta.routeId,
            rateNumerator: "100",
            rateDenominator: "525",
            feeBps: meta.feeBps,
            estimatedImpactBps: meta.impactBps,
            minInput: "100",
            maxInput: "1000000000",
            availableInput: "10000000000",
            availableOutput: "10000000000",
            executionCostUsdCents: legacy.executionCostMinor,
          }),
        ],
      });

      vectors.push({
        id: `legacy-${fundingMinor}-${meta.id}`,
        category: "legacy_single_route_parity",
        description: `Exact legacy quote() parity for F=${fundingMinor} on synthetic ${meta.id} route (${meta.feeBps} bps fee, ${meta.impactBps} bps descriptive impact).`,
        synthetic: true,
        rawRequestJson: JSON.stringify(req),
        expectedResponse: {
          status: "SELECTED",
          selectedRouteId: meta.routeId,
          amountIn: fundingMinor,
          grossOut: grossExpected,
          feeOut: legacyRoute.feeMinor,
          expectedOut: legacyRoute.outputMinor,
          minimumOut: legacyRoute.minimumOutputMinor,
          executionCostUsdCents: legacy.executionCostMinor,
          effectiveExpiry: "1763324100",
          snapshotId: SNAPSHOT_A,
          evaluatedCount: 1,
          rejected: [],
        },
      });
    }

    // Combined 3-route competition
    const directLegacy = legacy.routes.find((r) => r.id === "direct")!;
    const allThreeReq = baseRequest({
      amountIn: fundingMinor,
      userMinOut: "0",
      toleranceBps: 50,
      candidates: legacyRouteMeta.map((meta) =>
        baseCandidate({
          routeId: meta.routeId,
          rateNumerator: "100",
          rateDenominator: "525",
          feeBps: meta.feeBps,
          estimatedImpactBps: meta.impactBps,
          minInput: "100",
          maxInput: "1000000000",
          availableInput: "10000000000",
          availableOutput: "10000000000",
          executionCostUsdCents: legacy.executionCostMinor,
        }),
      ),
    });

    vectors.push({
      id: `legacy-${fundingMinor}-combined-selection`,
      category: "legacy_three_route_selection",
      description: `Combined 3-candidate evaluation for F=${fundingMinor}; synthetic direct route wins (by highest output, or canonical routeId tie-breaker at F=100).`,
      synthetic: true,
      rawRequestJson: JSON.stringify(allThreeReq),
      expectedResponse: {
        status: "SELECTED",
        selectedRouteId: routeIdHex(1),
        amountIn: fundingMinor,
        grossOut: grossExpected,
        feeOut: directLegacy.feeMinor,
        expectedOut: directLegacy.outputMinor,
        minimumOut: directLegacy.minimumOutputMinor,
        executionCostUsdCents: legacy.executionCostMinor,
        effectiveExpiry: "1763324100",
        snapshotId: SNAPSHOT_A,
        evaluatedCount: 3,
        rejected: [],
      },
    });
  }

  return {
    schemaVersion: 1,
    suite: "phase2b-v1-legacy-parity",
    syntheticOnly: true,
    vectors,
  };
}

function buildRegressionMinimizedFixtures(): StaticFixtureFile {
  const vectors: StaticFixtureVector[] = [];

  // Exact U256 boundary: largest N where U128_MAX * N * 10000 <= U256_MAX vs N + 1
  const exactMaxN = U256_MAX / (U128_MAX * 10_000n);
  const exactGross = (U128_MAX * exactMaxN) / U128_MAX; // == exactMaxN

  vectors.push({
    id: "reg-001-u256-exact-ceiling-passes",
    category: "minimized_u256_ceiling",
    description:
      "Minimized boundary: largest N with U128_MAX * N * 10000 <= U256_MAX succeeds without overflow.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        amountIn: U128_MAX.toString(),
        toleranceBps: 0,
        candidates: [
          baseCandidate({
            routeId: routeIdHex(1),
            rateNumerator: exactMaxN.toString(),
            rateDenominator: U128_MAX.toString(),
            feeBps: 0,
          }),
        ],
      }),
    ),
    expectedResponse: {
      status: "SELECTED",
      selectedRouteId: routeIdHex(1),
      amountIn: U128_MAX.toString(),
      grossOut: exactGross.toString(),
      feeOut: "0",
      expectedOut: exactGross.toString(),
      minimumOut: exactGross.toString(),
      executionCostUsdCents: "4",
      effectiveExpiry: "1763324100",
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 1,
      rejected: [],
    },
  });

  vectors.push({
    id: "reg-002-u256-exact-ceiling-plus-one-rejected",
    category: "minimized_u256_ceiling",
    description:
      "Minimized boundary: incrementing rateNumerator by 1 past U256_MAX / (U128_MAX * 10000) triggers ARITHMETIC_RANGE.",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        amountIn: U128_MAX.toString(),
        toleranceBps: 0,
        candidates: [
          baseCandidate({
            routeId: routeIdHex(1),
            rateNumerator: (exactMaxN + 1n).toString(),
            rateDenominator: U128_MAX.toString(),
            feeBps: 0,
          }),
        ],
      }),
    ),
    expectedResponse: {
      status: "NO_ROUTE",
      amountIn: U128_MAX.toString(),
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 1,
      rejected: [{ routeId: routeIdHex(1), reason: "ARITHMETIC_RANGE" }],
    },
  });

  // Precedence: Gross U128 overflow + feeBps=10000 must report ARITHMETIC_RANGE (step 5) before ZERO_OUTPUT (step 6)
  vectors.push({
    id: "reg-003-gross-overflow-precedes-zero-output-at-100pct-fee",
    category: "minimized_precedence",
    description:
      "When G overflows U128 even at feeBps=10000, candidate is rejected with ARITHMETIC_RANGE (step 5) rather than ZERO_OUTPUT (step 6).",
    synthetic: true,
    rawRequestJson: JSON.stringify(
      baseRequest({
        amountIn: U128_MAX.toString(),
        toleranceBps: 0,
        candidates: [
          baseCandidate({
            routeId: routeIdHex(1),
            rateNumerator: "2",
            rateDenominator: "1",
            feeBps: 10000,
          }),
        ],
      }),
    ),
    expectedResponse: {
      status: "NO_ROUTE",
      amountIn: U128_MAX.toString(),
      snapshotId: SNAPSHOT_A,
      evaluatedCount: 1,
      rejected: [{ routeId: routeIdHex(1), reason: "ARITHMETIC_RANGE" }],
    },
  });

  // Raw JSON float literal 50.0 on toleranceBps (JS JSON.parse turns 50.0 into integer 50; strict wire parser rejects floats!)
  const rawWithFloatBps = JSON.stringify(baseRequest({ toleranceBps: 50 })).replace(
    '"toleranceBps":50',
    '"toleranceBps":50.0',
  );
  vectors.push({
    id: "reg-004-raw-json-float-bps-rejected",
    category: "minimized_wire_float_rejection",
    description:
      "Raw JSON float token 50.0 for toleranceBps is rejected as INVALID_BPS rather than coerced to integer 50.",
    synthetic: true,
    rawRequestJson: rawWithFloatBps,
    expectedResponse: errorExpected("INVALID_BPS"),
  });

  // Duplicate JSON object key rejected as MALFORMED_JSON
  const rawDuplicateKey = `{"version":1,"version":1}`;
  vectors.push({
    id: "reg-005-raw-json-duplicate-key-rejected",
    category: "minimized_wire_duplicate_key",
    description: "Duplicate JSON object keys are rejected as MALFORMED_JSON.",
    synthetic: true,
    rawRequestJson: rawDuplicateKey,
    expectedResponse: errorExpected("MALFORMED_JSON"),
  });

  // Multi-error structural permutation invariance: candidate 0x01 has SNAPSHOT_MISMATCH, candidate 0x02 has ZERO_RATE
  for (const [label, order] of [
    ["forward", [1, 2]],
    ["reversed", [2, 1]],
  ] as const) {
    vectors.push({
      id: `reg-006-multi-structural-error-order-${label}`,
      category: "minimized_structural_permutation",
      description: `Permuted candidates (${label}) with distinct structural errors produce identical SNAPSHOT_MISMATCH because validation runs in canonical routeId order.`,
      synthetic: true,
      rawRequestJson: JSON.stringify(
        baseRequest({
          candidates: order.map((idx) =>
            idx === 1
              ? baseCandidate({
                  routeId: routeIdHex(1),
                  snapshotId: SNAPSHOT_B,
                })
              : baseCandidate({
                  routeId: routeIdHex(2),
                  rateNumerator: "0",
                }),
          ),
        }),
      ),
      expectedResponse: errorExpected("SNAPSHOT_MISMATCH"),
    });
  }

  return {
    schemaVersion: 1,
    suite: "phase2b-v1-regression-minimized",
    syntheticOnly: true,
    vectors,
  };
}

export function writeAndVerifyAllStaticFixtures(): void {
  const outDir = path.resolve(process.cwd(), "scripts/phase2b/fixtures/v1");
  fs.mkdirSync(outDir, { recursive: true });

  const files: ReadonlyArray<readonly [string, StaticFixtureFile]> = [
    ["edge-cases.json", buildEdgeCaseFixtures()],
    ["legacy-parity.json", buildLegacyParityFixtures()],
    ["regression-minimized.json", buildRegressionMinimizedFixtures()],
  ];

  let totalVerified = 0;
  for (const [filename, content] of files) {
    for (const vec of content.vectors) {
      const actual = evaluateJsonLine(vec.rawRequestJson);
      assert.deepStrictEqual(
        actual.response,
        vec.expectedResponse,
        `Static fixture mismatch on ${vec.id}`,
      );
      totalVerified += 1;
    }
    const targetPath = path.join(outDir, filename);
    fs.writeFileSync(targetPath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
  }

  console.log(
    `Verified and wrote ${totalVerified} static fixture vectors across ${files.length} files in ${outDir}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeAndVerifyAllStaticFixtures();
}
