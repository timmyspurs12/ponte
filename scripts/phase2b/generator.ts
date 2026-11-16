/**
 * Phase 2B.1 — Deterministic synthetic request generator for differential,
 * property, and benchmark testing.
 *
 * All generated assets, snapshots, and routes are explicitly labelled synthetic.
 */

import {
  MAX_ASSET_DECIMALS,
  MAX_BPS,
  MAX_CANDIDATES,
  OPTIMIZER_MODE_SYNTHETIC,
  OPTIMIZER_VERSION_V1,
  U64_MAX,
  U128_MAX,
  U256_MAX,
  type AssetIdV1,
  type WireCandidateV1,
  type WireOptimizeRequestV1,
} from "./model";
import { DEFAULT_DIFFERENTIAL_SEED, DeterministicPrng } from "./prng";

export interface GeneratedTestCase {
  readonly id: string;
  readonly category: string;
  readonly rawJson: string;
}

const SYNTHETIC_INPUT_ASSETS: readonly AssetIdV1[] = [
  { namespace: "SYNTHETIC_FIAT", identifier: "SYNTH_BRL", decimals: 2 },
  { namespace: "SYNTHETIC_FIAT", identifier: "SYNTH_USD", decimals: 2 },
  { namespace: "SYNTHETIC_TOKEN", identifier: "SYNTH_USDC_6", decimals: 6 },
  { namespace: "SYNTHETIC_TOKEN", identifier: "SYNTH_DAI_18", decimals: 18 },
  { namespace: "SYNTHETIC_UNIT", identifier: "SYNTH_ZERO_DEC", decimals: 0 },
  { namespace: "SYNTHETIC_MAXDEC", identifier: "SYNTH_DEC_38", decimals: 38 },
];

const SYNTHETIC_OUTPUT_ASSETS: readonly AssetIdV1[] = [
  { namespace: "SYNTHETIC_TOKEN", identifier: "SYNTH_USDG", decimals: 2 },
  { namespace: "SYNTHETIC_TOKEN", identifier: "SYNTH_USDG_6", decimals: 6 },
  { namespace: "SYNTHETIC_TOKEN", identifier: "SYNTH_SETTLE_18", decimals: 18 },
  {
    namespace: "SYNTHETIC_TOKEN",
    identifier: "SYNTH_HIGH_PRECISION",
    decimals: MAX_ASSET_DECIMALS,
  },
];

function makeBaseCandidate(
  prng: DeterministicPrng,
  snapshotId: string,
  routeId: string,
  amountIn: bigint,
  asOf: bigint,
  reqExp: bigint,
): WireCandidateV1 {
  const rateNumerator = prng.sampleLogUniformU128(false);
  const rateDenominator = prng.sampleLogUniformU128(false);
  const feeBps = prng.intBetween(0, MAX_BPS);
  const estimatedImpactBps = prng.intBetween(0, MAX_BPS);

  // Choose varied capacity/liquidity envelopes around amountIn
  const mode = prng.intBetween(0, 9);
  let minInput: bigint;
  let maxInput: bigint;
  let availableInput: bigint;
  let availableOutput: bigint;
  let expiresAt: bigint;

  if (mode === 0) {
    // Expired candidate
    expiresAt = asOf > 0n ? prng.bigIntBetween(0n, asOf) : 0n;
  } else if (mode === 1) {
    // Candidate expires earlier than request but still after asOf
    expiresAt =
      reqExp > asOf + 1n ? prng.bigIntBetween(asOf + 1n, reqExp - 1n) : reqExp;
  } else {
    // Candidate expires at or after request expiry (bounded by U64_MAX)
    const headroom = U64_MAX - reqExp;
    const extra = headroom > 10_000n ? prng.bigIntBetween(0n, 10_000n) : headroom;
    expiresAt = reqExp + extra;
  }

  if (mode === 2 && amountIn < U128_MAX) {
    // Trigger BELOW_MIN
    minInput = amountIn + 1n;
    maxInput = minInput + (U128_MAX - minInput > 1000n ? 1000n : U128_MAX - minInput);
  } else if (mode === 3 && amountIn > 1n) {
    // Trigger CAPACITY
    minInput = 0n;
    maxInput = amountIn - 1n;
  } else {
    minInput = amountIn > 10n ? prng.bigIntBetween(0n, 10n) : 0n;
    const capAdd = U128_MAX - amountIn > 1_000_000n ? 1_000_000n : U128_MAX - amountIn;
    maxInput = amountIn + capAdd;
  }

  if (mode === 4 && amountIn > 0n) {
    // Trigger INPUT_LIQUIDITY
    availableInput = amountIn - 1n;
  } else {
    availableInput = maxInput;
  }

  if (mode === 5) {
    // Tight output liquidity
    availableOutput = prng.sampleLogUniformU128(true);
  } else {
    availableOutput = U128_MAX;
  }

  const executionCostUsdCents =
    prng.intBetween(0, 4) === 0
      ? BigInt(prng.intBetween(0, 25))
      : prng.sampleLogUniformU128(true);

  return {
    routeId,
    snapshotId,
    rateNumerator: rateNumerator.toString(),
    rateDenominator: rateDenominator.toString(),
    feeBps,
    estimatedImpactBps,
    minInput: minInput.toString(),
    maxInput: maxInput.toString(),
    availableInput: availableInput.toString(),
    availableOutput: availableOutput.toString(),
    executionCostUsdCents: executionCostUsdCents.toString(),
    expiresAtUnixSeconds: expiresAt.toString(),
  };
}

export function generateValidOrRejectedRequest(
  prng: DeterministicPrng,
  familyIndex: number,
): { readonly category: string; readonly request: WireOptimizeRequestV1 } {
  const inputAsset = prng.pick(SYNTHETIC_INPUT_ASSETS);
  let outputAsset = prng.pick(SYNTHETIC_OUTPUT_ASSETS);
  if (
    inputAsset.namespace === outputAsset.namespace &&
    inputAsset.identifier === outputAsset.identifier
  ) {
    outputAsset = SYNTHETIC_OUTPUT_ASSETS[0];
  }

  const snapshotId = prng.nextBytes32(0x53); // 'S' synthetic marker
  const asOf =
    prng.intBetween(0, 15) === 0
      ? prng.bigIntBetween(0n, U64_MAX - 2n)
      : BigInt(1_763_320_000 + prng.intBetween(0, 100_000));
  const maxSpan = U64_MAX - asOf > 3600n ? 3600n : U64_MAX - asOf;
  const reqExp = asOf + prng.bigIntBetween(1n, maxSpan);

  const family = familyIndex % 6;

  // Family 0: General mixed valid/rejected candidates across 1..64 count
  if (family === 0) {
    const amountIn = prng.sampleLogUniformU128(false);
    const toleranceBps = prng.intBetween(0, MAX_BPS);
    const userMinOut =
      prng.intBetween(0, 3) === 0 ? 0n : prng.sampleLogUniformU128(true);
    const count =
      prng.intBetween(0, 7) === 0
        ? prng.pick([1, 2, 3, 8, 16, 32, MAX_CANDIDATES])
        : prng.intBetween(1, 16);

    const routeIds = new Set<string>();
    const candidates: WireCandidateV1[] = [];
    while (candidates.length < count) {
      const rid = prng.nextBytes32();
      if (routeIds.has(rid)) continue;
      routeIds.add(rid);
      candidates.push(
        makeBaseCandidate(prng, snapshotId, rid, amountIn, asOf, reqExp),
      );
    }

    return {
      category: "synthetic_mixed",
      request: {
        version: OPTIMIZER_VERSION_V1,
        mode: OPTIMIZER_MODE_SYNTHETIC,
        inputAsset,
        outputAsset,
        amountIn: amountIn.toString(),
        userMinOut: userMinOut.toString(),
        toleranceBps,
        asOfUnixSeconds: asOf.toString(),
        expiresAtUnixSeconds: reqExp.toString(),
        snapshotId,
        candidates,
      },
    };
  }

  // Family 1: Exact tie-breakers (equal expectedOut, equal or varied cost, permuted IDs)
  if (family === 1) {
    const amountIn = BigInt(prng.intBetween(100, 10_000_000));
    const count = prng.intBetween(2, 12);
    const sharedRateNum = BigInt(prng.intBetween(50, 500));
    const sharedRateDen = BigInt(prng.intBetween(50, 500));
    const sharedFee = prng.intBetween(0, 500);
    const tieAllCosts = prng.intBetween(0, 1) === 0;
    const baseCost = BigInt(prng.intBetween(1, 50));

    const routeIds = new Set<string>();
    const candidates: WireCandidateV1[] = [];
    while (candidates.length < count) {
      const rid = prng.nextBytes32();
      if (routeIds.has(rid)) continue;
      routeIds.add(rid);
      const cost = tieAllCosts
        ? baseCost
        : baseCost + BigInt(prng.intBetween(0, 2));
      candidates.push({
        routeId: rid,
        snapshotId,
        rateNumerator: sharedRateNum.toString(),
        rateDenominator: sharedRateDen.toString(),
        feeBps: sharedFee,
        estimatedImpactBps: prng.intBetween(0, 100),
        minInput: "1",
        maxInput: U128_MAX.toString(),
        availableInput: U128_MAX.toString(),
        availableOutput: U128_MAX.toString(),
        executionCostUsdCents: cost.toString(),
        expiresAtUnixSeconds: reqExp.toString(),
      });
    }

    return {
      category: "tie_breaking",
      request: {
        version: OPTIMIZER_VERSION_V1,
        mode: OPTIMIZER_MODE_SYNTHETIC,
        inputAsset,
        outputAsset,
        amountIn: amountIn.toString(),
        userMinOut: "0",
        toleranceBps: prng.intBetween(0, 500),
        asOfUnixSeconds: asOf.toString(),
        expiresAtUnixSeconds: reqExp.toString(),
        snapshotId,
        candidates: prng.shuffle(candidates),
      },
    };
  }

  // Family 2: Rounding & basis-point boundaries (0, 1, 35, 48, 50, 65, 9999, 10000 bps)
  if (family === 2) {
    const amountIn = BigInt(prng.intBetween(1, 5_000_000));
    const bpsChoices = [0, 1, 35, 48, 50, 65, 100, 5000, 9999, 10000];
    const toleranceBps = prng.pick(bpsChoices);
    const count = prng.intBetween(1, 6);
    const routeIds = new Set<string>();
    const candidates: WireCandidateV1[] = [];

    while (candidates.length < count) {
      const rid = prng.nextBytes32();
      if (routeIds.has(rid)) continue;
      routeIds.add(rid);
      const feeBps = prng.pick(bpsChoices);
      const num = BigInt(prng.intBetween(1, 1000));
      const den = BigInt(prng.intBetween(1, 1000));
      candidates.push({
        routeId: rid,
        snapshotId,
        rateNumerator: num.toString(),
        rateDenominator: den.toString(),
        feeBps,
        estimatedImpactBps: prng.pick(bpsChoices),
        minInput: "1",
        maxInput: U128_MAX.toString(),
        availableInput: U128_MAX.toString(),
        availableOutput: U128_MAX.toString(),
        executionCostUsdCents: String(prng.intBetween(0, 10)),
        expiresAtUnixSeconds: reqExp.toString(),
      });
    }

    return {
      category: "rounding_and_bps_edges",
      request: {
        version: OPTIMIZER_VERSION_V1,
        mode: OPTIMIZER_MODE_SYNTHETIC,
        inputAsset,
        outputAsset,
        amountIn: amountIn.toString(),
        userMinOut: prng.intBetween(0, 2) === 0 ? "0" : String(prng.intBetween(1, 500)),
        toleranceBps,
        asOfUnixSeconds: asOf.toString(),
        expiresAtUnixSeconds: reqExp.toString(),
        snapshotId,
        candidates,
      },
    };
  }

  // Family 3: High-magnitude U128 & U256 intermediate arithmetic ceiling boundaries
  if (family === 3) {
    const subCase = prng.intBetween(0, 3);
    let amountIn: bigint;
    let rateNum: bigint;
    let rateDen: bigint;
    const feeBps = prng.pick([0, 1, 50, 9999, 10000]);

    if (subCase === 0) {
      // Exact U256 ceiling boundary for F * N * (10000 - f)
      const feeKeep = BigInt(MAX_BPS - feeBps);
      const denomFactor = feeKeep === 0n ? 1n : feeKeep;
      amountIn = U128_MAX - BigInt(prng.intBetween(0, 100));
      const maxN = U256_MAX / (amountIn * denomFactor);
      const delta = BigInt(prng.intBetween(-2, 2));
      const candidateN = maxN + delta;
      rateNum =
        candidateN < 1n ? 1n : candidateN > U128_MAX ? U128_MAX : candidateN;
      rateDen = U128_MAX - BigInt(prng.intBetween(0, 1000));
    } else if (subCase === 1) {
      // Gross output near U128_MAX boundary
      amountIn = U128_MAX - BigInt(prng.intBetween(0, 50));
      rateNum = BigInt(prng.intBetween(1, 5));
      rateDen = BigInt(prng.intBetween(1, 5));
    } else if (subCase === 2) {
      // Smallest amountIn = 1 with huge rates
      amountIn = 1n;
      rateNum = U128_MAX - BigInt(prng.intBetween(0, 100));
      rateDen = BigInt(prng.intBetween(1, 10_000));
    } else {
      // Both F and N near 2^127..2^128-1 (triggers U256 overflow when multiplied by feeKeep)
      amountIn = (1n << 127n) + BigInt(prng.intBetween(0, 10_000));
      rateNum = (1n << 127n) + BigInt(prng.intBetween(0, 10_000));
      rateDen = U128_MAX;
    }

    const fallbackRid = prng.nextBytes32(0xf0);
    const primaryRid = prng.nextBytes32(0x10);
    const includeFallback = prng.intBetween(0, 1) === 1;
    const candidates: WireCandidateV1[] = [
      {
        routeId: primaryRid,
        snapshotId,
        rateNumerator: rateNum.toString(),
        rateDenominator: rateDen.toString(),
        feeBps,
        estimatedImpactBps: 0,
        minInput: "1",
        maxInput: U128_MAX.toString(),
        availableInput: U128_MAX.toString(),
        availableOutput: U128_MAX.toString(),
        executionCostUsdCents: "5",
        expiresAtUnixSeconds: reqExp.toString(),
      },
    ];

    if (includeFallback) {
      candidates.push({
        routeId: fallbackRid,
        snapshotId,
        rateNumerator: "1",
        rateDenominator: "10000",
        feeBps: 0,
        estimatedImpactBps: 0,
        minInput: "1",
        maxInput: U128_MAX.toString(),
        availableInput: U128_MAX.toString(),
        availableOutput: U128_MAX.toString(),
        executionCostUsdCents: "10",
        expiresAtUnixSeconds: reqExp.toString(),
      });
    }

    return {
      category: "u128_u256_boundaries",
      request: {
        version: OPTIMIZER_VERSION_V1,
        mode: OPTIMIZER_MODE_SYNTHETIC,
        inputAsset,
        outputAsset,
        amountIn: amountIn.toString(),
        userMinOut: "0",
        toleranceBps: prng.intBetween(0, 100),
        asOfUnixSeconds: asOf.toString(),
        expiresAtUnixSeconds: reqExp.toString(),
        snapshotId,
        candidates: prng.shuffle(candidates),
      },
    };
  }

  // Family 4: Precise liquidity/capacity/expiry/minOut off-by-one boundaries (-1, 0, +1)
  if (family === 4) {
    const amountIn = BigInt(prng.intBetween(500, 500_000));
    const rateNum = BigInt(prng.intBetween(10, 500));
    const rateDen = BigInt(prng.intBetween(10, 500));
    const feeBps = prng.intBetween(0, 200);
    const expectedExact =
      (amountIn * rateNum * BigInt(MAX_BPS - feeBps)) /
      (rateDen * 10_000n);
    const baseExpected = expectedExact > 0n ? expectedExact : 1n;

    const deltaChoice = () => BigInt(prng.intBetween(-1, 1));
    const cCount = prng.intBetween(2, 6);
    const routeIds = new Set<string>();
    const candidates: WireCandidateV1[] = [];

    while (candidates.length < cCount) {
      const rid = prng.nextBytes32();
      if (routeIds.has(rid)) continue;
      routeIds.add(rid);

      const minRaw = amountIn + deltaChoice();
      const minIn = minRaw < 0n ? 0n : minRaw;
      const maxCandidate = amountIn + deltaChoice();
      const maxIn = maxCandidate < minIn ? minIn : maxCandidate;
      const availInRaw = amountIn + deltaChoice();
      const availIn = availInRaw < 0n ? 0n : availInRaw;
      const availOutRaw = baseExpected + deltaChoice();
      const availOut = availOutRaw < 0n ? 0n : availOutRaw;
      const expDelta = BigInt(prng.intBetween(-1, 2));
      const rawCandExp = asOf + expDelta;
      const candExp =
        rawCandExp < 0n ? 0n : rawCandExp > U64_MAX ? U64_MAX : rawCandExp;

      candidates.push({
        routeId: rid,
        snapshotId,
        rateNumerator: rateNum.toString(),
        rateDenominator: rateDen.toString(),
        feeBps,
        estimatedImpactBps: 10,
        minInput: minIn.toString(),
        maxInput: maxIn.toString(),
        availableInput: availIn.toString(),
        availableOutput: availOut.toString(),
        executionCostUsdCents: String(prng.intBetween(1, 5)),
        expiresAtUnixSeconds: candExp.toString(),
      });
    }

    const userMinDelta = BigInt(prng.intBetween(-1, 1));
    const userMinOut =
      prng.intBetween(0, 1) === 0
        ? 0n
        : baseExpected + userMinDelta < 0n
          ? 0n
          : baseExpected + userMinDelta;

    return {
      category: "exact_off_by_one_boundaries",
      request: {
        version: OPTIMIZER_VERSION_V1,
        mode: OPTIMIZER_MODE_SYNTHETIC,
        inputAsset,
        outputAsset,
        amountIn: amountIn.toString(),
        userMinOut: userMinOut.toString(),
        toleranceBps: prng.intBetween(0, MAX_BPS),
        asOfUnixSeconds: asOf.toString(),
        expiresAtUnixSeconds: reqExp.toString(),
        snapshotId,
        candidates,
      },
    };
  }

  // Family 5: All candidates infeasible (NO_ROUTE) with multiple rejection reasons simultaneously active
  const amountIn = BigInt(prng.intBetween(1000, 100_000));
  const reasonsCount = prng.intBetween(1, 8);
  const routeIds = new Set<string>();
  const candidates: WireCandidateV1[] = [];
  while (candidates.length < reasonsCount) {
    const rid = prng.nextBytes32();
    if (routeIds.has(rid)) continue;
    routeIds.add(rid);
    const idx = candidates.length % 8;
    candidates.push({
      routeId: rid,
      snapshotId,
      rateNumerator: idx === 4 ? U128_MAX.toString() : idx === 5 ? "1" : "100",
      rateDenominator:
        idx === 4 ? U128_MAX.toString() : idx === 5 ? "10000000" : "100",
      feeBps: idx === 5 && prng.intBetween(0, 1) === 0 ? 10000 : 10,
      estimatedImpactBps: 5,
      minInput: idx === 1 ? (amountIn + 1n).toString() : "1",
      maxInput:
        idx === 1
          ? (amountIn + 100n).toString()
          : idx === 2
            ? (amountIn - 1n).toString()
            : U128_MAX.toString(),
      availableInput:
        idx === 3 ? (amountIn - 1n).toString() : U128_MAX.toString(),
      availableOutput: idx === 6 ? "1" : U128_MAX.toString(),
      executionCostUsdCents: "2",
      expiresAtUnixSeconds:
        idx === 0 ? asOf.toString() : reqExp.toString(),
    });
  }

  return {
    category: "no_route_precedence",
    request: {
      version: OPTIMIZER_VERSION_V1,
      mode: OPTIMIZER_MODE_SYNTHETIC,
      inputAsset,
      outputAsset,
      amountIn: idxAmountForNoRoute(amountIn),
      userMinOut: (amountIn * 2n).toString(),
      toleranceBps: 50,
      asOfUnixSeconds: asOf.toString(),
      expiresAtUnixSeconds: reqExp.toString(),
      snapshotId,
      candidates: prng.shuffle(candidates),
    },
  };
}

function idxAmountForNoRoute(amountIn: bigint): string {
  return amountIn.toString();
}

function generateInvalidRequestRawJson(
  prng: DeterministicPrng,
  variant: number,
): { readonly category: string; readonly rawJson: string } {
  const base = generateValidOrRejectedRequest(prng, 1).request;
  const kind = variant % 18;

  switch (kind) {
    case 0:
      return {
        category: "invalid_malformed_json",
        rawJson: prng.pick([
          "",
          "{",
          '{"version":1,}',
          '{"version":1,"version":1}',
          "null",
          "[]",
          '{"unterminated',
          '{"version":01}',
          '{"version":1.}',
          '{"a":"\\uD800"}',
        ]),
      };
    case 1:
      return {
        category: "invalid_request_shape",
        rawJson: JSON.stringify({ ...base, extraUnknownField: true }),
      };
    case 2: {
      const rest: Record<string, unknown> = { ...base };
      delete rest.toleranceBps;
      return {
        category: "invalid_missing_field",
        rawJson: JSON.stringify(rest),
      };
    }
    case 3:
      return {
        category: "invalid_version",
        rawJson: JSON.stringify({
          ...base,
          version: prng.pick([0, 2, -1, "1", null]),
        }),
      };
    case 4:
      return {
        category: "invalid_mode",
        rawJson: JSON.stringify({
          ...base,
          mode: prng.pick(["LIVE", "synthetic", "", 1]),
        }),
      };
    case 5:
      return {
        category: "invalid_asset",
        rawJson: JSON.stringify({
          ...base,
          outputAsset: { ...base.inputAsset },
        }),
      };
    case 6:
      return {
        category: "invalid_decimals",
        rawJson: JSON.stringify({
          ...base,
          inputAsset: {
            ...base.inputAsset,
            decimals: prng.pick([-1, 39, 100, "2"]),
          },
        }),
      };
    case 7:
      return {
        category: "invalid_bytes32",
        rawJson: JSON.stringify({
          ...base,
          snapshotId: prng.pick([
            "0x1234",
            `0x${"A".repeat(64)}`,
            "1".repeat(66),
            `0x${"g".repeat(64)}`,
            `0x${"0".repeat(63)}`,
            `0x${"0".repeat(65)}`,
          ]),
        }),
      };
    case 8:
      return {
        category: "invalid_integer_encoding",
        rawJson: JSON.stringify({
          ...base,
          amountIn: prng.pick([
            "0100",
            "-100",
            "+100",
            "100.0",
            "1e5",
            " 100",
            "100 ",
            "",
            "abc",
          ]),
        }),
      };
    case 9:
      return {
        category: "invalid_numeric_json_type",
        rawJson: JSON.stringify({
          ...base,
          amountIn: 1000,
        }),
      };
    case 10:
      return {
        category: "invalid_u128_overflow",
        rawJson: JSON.stringify({
          ...base,
          amountIn: (U128_MAX + BigInt(prng.intBetween(1, 100))).toString(),
        }),
      };
    case 11:
      return {
        category: "invalid_u64_overflow",
        rawJson: JSON.stringify({
          ...base,
          expiresAtUnixSeconds: (U64_MAX + 1n).toString(),
        }),
      };
    case 12:
      return {
        category: "invalid_zero_amount_in",
        rawJson: JSON.stringify({
          ...base,
          amountIn: "0",
        }),
      };
    case 13:
      return {
        category: "invalid_bps",
        rawJson: JSON.stringify({
          ...base,
          toleranceBps: prng.pick([-1, 10001, 65535, 100000, "50"]),
        }),
      };
    case 14:
      return {
        category: "invalid_request_expiry",
        rawJson: JSON.stringify({
          ...base,
          expiresAtUnixSeconds: base.asOfUnixSeconds,
        }),
      };
    case 15: {
      const tooMany = prng.intBetween(0, 1) === 0;
      if (!tooMany) {
        return {
          category: "invalid_candidate_count_zero",
          rawJson: JSON.stringify({ ...base, candidates: [] }),
        };
      }
      const cands: WireCandidateV1[] = [];
      for (let i = 0; i < MAX_CANDIDATES + 1; i += 1) {
        cands.push({
          ...base.candidates[0],
          routeId: `0x${(i + 1).toString(16).padStart(64, "0")}`,
        });
      }
      return {
        category: "invalid_candidate_count_65",
        rawJson: JSON.stringify({ ...base, candidates: cands }),
      };
    }
    case 16: {
      const dupCands = [
        base.candidates[0],
        { ...base.candidates[0], feeBps: 99 },
      ];
      return {
        category: "invalid_duplicate_route_id",
        rawJson: JSON.stringify({ ...base, candidates: dupCands }),
      };
    }
    default: {
      const sub = prng.intBetween(0, 2);
      if (sub === 0) {
        return {
          category: "invalid_snapshot_mismatch",
          rawJson: JSON.stringify({
            ...base,
            candidates: [
              {
                ...base.candidates[0],
                snapshotId: `0x${"f".repeat(64)}`,
              },
            ],
          }),
        };
      }
      if (sub === 1) {
        const zeroNum = prng.intBetween(0, 1) === 0;
        return {
          category: "invalid_zero_rate",
          rawJson: JSON.stringify({
            ...base,
            candidates: [
              {
                ...base.candidates[0],
                rateNumerator: zeroNum ? "0" : "100",
                rateDenominator: zeroNum ? "100" : "0",
              },
            ],
          }),
        };
      }
      return {
        category: "invalid_min_gt_max",
        rawJson: JSON.stringify({
          ...base,
          candidates: [
            {
              ...base.candidates[0],
              minInput: "1001",
              maxInput: "1000",
            },
          ],
        }),
      };
    }
  }
}

/**
 * Generates `count` deterministic synthetic test cases from `seed`.
 * Approximately 80% exercise valid/rejected candidate evaluation and 20%
 * exercise structural/wire error handling.
 */
export function generateSyntheticCases(
  count: number,
  seed: bigint = DEFAULT_DIFFERENTIAL_SEED,
): readonly GeneratedTestCase[] {
  const prng = new DeterministicPrng(seed);
  const out: GeneratedTestCase[] = [];

  for (let i = 0; i < count; i += 1) {
    if (i % 5 === 4) {
      const inv = generateInvalidRequestRawJson(prng, Math.floor(i / 5));
      out.push({
        id: `gen-${String(i + 1).padStart(5, "0")}`,
        category: inv.category,
        rawJson: inv.rawJson,
      });
    } else {
      const gen = generateValidOrRejectedRequest(prng, i);
      out.push({
        id: `gen-${String(i + 1).padStart(5, "0")}`,
        category: gen.category,
        rawJson: JSON.stringify(gen.request),
      });
    }
  }

  return out;
}
