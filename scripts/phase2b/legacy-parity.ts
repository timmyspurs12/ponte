/**
 * Phase 2B.1 — Legacy quote() parity verification (Section 8).
 *
 * Uses untouched src/lib/quotes.ts as the legacy source of truth and verifies
 * exact parity for funding amounts 100, 2500000, and 1000000000 across the
 * three synthetic candidates (direct, split, multi) in both the TypeScript V1
 * reference and (when --rust-bin is provided) the Rust optimizer-v1 binary.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { quote as legacyQuote } from "../../src/lib/quotes";
import { evaluateJsonLine } from "./json";
import type { WireCandidateV1, WireOptimizeRequestV1 } from "./model";

const LEGACY_AMOUNTS = ["100", "2500000", "1000000000"] as const;

const LEGACY_ROUTES = [
  {
    legacyId: "direct",
    routeId: `0x${"0".repeat(63)}1`,
    feeBps: 35,
    estimatedImpactBps: 5,
  },
  {
    legacyId: "split",
    routeId: `0x${"0".repeat(63)}2`,
    feeBps: 48,
    estimatedImpactBps: 8,
  },
  {
    legacyId: "multi",
    routeId: `0x${"0".repeat(63)}3`,
    feeBps: 65,
    estimatedImpactBps: 12,
  },
] as const;

const SNAPSHOT_ID = `0x${"53".repeat(32)}`;

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const head = items[i];
    const tail = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(tail)) {
      result.push([head, ...perm]);
    }
  }
  return result;
}

function makeLegacyV1Request(
  fundingMinor: string,
  candidates: readonly WireCandidateV1[],
): WireOptimizeRequestV1 {
  return {
    version: 1,
    mode: "SYNTHETIC",
    inputAsset: {
      namespace: "SYNTHETIC_FIAT",
      identifier: "SYNTH_BRL",
      decimals: 2,
    },
    outputAsset: {
      namespace: "SYNTHETIC_TOKEN",
      identifier: "SYNTH_USDG",
      decimals: 2,
    },
    amountIn: fundingMinor,
    userMinOut: "0",
    toleranceBps: 50,
    asOfUnixSeconds: "1763323200",
    expiresAtUnixSeconds: "1763324100",
    snapshotId: SNAPSHOT_ID,
    candidates,
  };
}

function runRustLines(rustBinPath: string, lines: readonly string[]): string[] {
  const input = `${lines.join("\n")}\n`;
  const proc = spawnSync(rustBinPath, [], {
    input,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (proc.error) {
    throw proc.error;
  }
  if (proc.status !== 0) {
    throw new Error(
      `Rust binary exited with status ${proc.status}: ${proc.stderr}`,
    );
  }
  const outLines = proc.stdout.split("\n");
  if (outLines[outLines.length - 1] === "") {
    outLines.pop();
  }
  assert.equal(outLines.length, lines.length, "Rust JSONL line count mismatch");
  return outLines;
}

export interface LegacyParityReport {
  readonly fundingAmounts: readonly string[];
  readonly singleRouteChecks: number;
  readonly permutationChecks: number;
  readonly impactNonDeductionChecks: number;
  readonly rustVerified: boolean;
  readonly rows: ReadonlyArray<{
    readonly fundingMinor: string;
    readonly legacyRoute: string;
    readonly grossOut: string;
    readonly feeOut: string;
    readonly expectedOut: string;
    readonly minimumOut: string;
  }>;
}

export function verifyLegacyParity(rustBinPath?: string): LegacyParityReport {
  const jsonLinesForRust: string[] = [];
  const expectedCanonicalForRust: string[] = [];
  const rows: Array<{
    readonly fundingMinor: string;
    readonly legacyRoute: string;
    readonly grossOut: string;
    readonly feeOut: string;
    readonly expectedOut: string;
    readonly minimumOut: string;
  }> = [];

  let singleRouteChecks = 0;
  let permutationChecks = 0;
  let impactNonDeductionChecks = 0;

  for (const fundingMinor of LEGACY_AMOUNTS) {
    const legacy = legacyQuote({ fundingMinor });
    assert.equal(legacy.simulated, true);
    assert.equal(legacy.rate.numerator, "525");
    assert.equal(legacy.rate.denominator, "100");

    const funding = BigInt(fundingMinor);
    const expectedGross = ((funding * 100n) / 525n).toString();

    const mappedCandidates: WireCandidateV1[] = LEGACY_ROUTES.map((meta) => ({
      routeId: meta.routeId,
      snapshotId: SNAPSHOT_ID,
      rateNumerator: "100",
      rateDenominator: "525",
      feeBps: meta.feeBps,
      estimatedImpactBps: meta.estimatedImpactBps,
      minInput: "100",
      maxInput: "1000000000",
      availableInput: "10000000000",
      availableOutput: "10000000000",
      executionCostUsdCents: legacy.executionCostMinor,
      expiresAtUnixSeconds: "1763324100",
    }));

    for (let idx = 0; idx < LEGACY_ROUTES.length; idx += 1) {
      const meta = LEGACY_ROUTES[idx];
      const cand = mappedCandidates[idx];
      const legacyRoute = legacy.routes.find((r) => r.id === meta.legacyId);
      assert.ok(legacyRoute, `Missing legacy route ${meta.legacyId}`);

      const singleReqJson = JSON.stringify(
        makeLegacyV1Request(fundingMinor, [cand]),
      );
      const { response, canonicalJson } = evaluateJsonLine(singleReqJson);
      assert.equal(response.status, "SELECTED");
      assert.equal(response.grossOut, expectedGross);
      assert.equal(response.feeOut, legacyRoute.feeMinor);
      assert.equal(response.expectedOut, legacyRoute.outputMinor);
      assert.equal(response.minimumOut, legacyRoute.minimumOutputMinor);
      assert.equal(
        BigInt(response.grossOut),
        BigInt(response.feeOut) + BigInt(response.expectedOut),
      );
      singleRouteChecks += 1;

      jsonLinesForRust.push(singleReqJson);
      expectedCanonicalForRust.push(canonicalJson);

      rows.push({
        fundingMinor,
        legacyRoute: meta.legacyId,
        grossOut: response.grossOut,
        feeOut: response.feeOut,
        expectedOut: response.expectedOut,
        minimumOut: response.minimumOut,
      });

      // Verify estimatedImpactBps is descriptive metadata only (never subtracted a second time)
      for (const altImpact of [0, 250, 9999]) {
        const altReqJson = JSON.stringify(
          makeLegacyV1Request(fundingMinor, [
            { ...cand, estimatedImpactBps: altImpact },
          ]),
        );
        const altEval = evaluateJsonLine(altReqJson);
        assert.deepStrictEqual(altEval.response, response);
        jsonLinesForRust.push(altReqJson);
        expectedCanonicalForRust.push(altEval.canonicalJson);
        impactNonDeductionChecks += 1;
      }

      if (funding > 10_000n) {
        const doubleDeductedWrong =
          (funding *
            100n *
            BigInt(10_000 - meta.feeBps - meta.estimatedImpactBps)) /
          (525n * 10_000n);
        assert.notEqual(
          BigInt(response.expectedOut),
          doubleDeductedWrong,
          "Engine must not subtract estimatedImpactBps from expectedOut",
        );
      }
    }

    // Verify all 6 candidate permutations pick direct (0x...01) identically
    const directLegacy = legacy.routes.find((r) => r.id === "direct")!;
    for (const perm of permutations(mappedCandidates)) {
      const permJson = JSON.stringify(makeLegacyV1Request(fundingMinor, perm));
      const permEval = evaluateJsonLine(permJson);
      assert.equal(permEval.response.status, "SELECTED");
      assert.equal(permEval.response.selectedRouteId, LEGACY_ROUTES[0].routeId);
      assert.equal(permEval.response.expectedOut, directLegacy.outputMinor);
      assert.equal(permEval.response.feeOut, directLegacy.feeMinor);
      assert.equal(permEval.response.minimumOut, directLegacy.minimumOutputMinor);
      jsonLinesForRust.push(permJson);
      expectedCanonicalForRust.push(permEval.canonicalJson);
      permutationChecks += 1;
    }
  }

  let rustVerified = false;
  if (rustBinPath !== undefined) {
    const rustOutputs = runRustLines(rustBinPath, jsonLinesForRust);
    for (let i = 0; i < rustOutputs.length; i += 1) {
      assert.equal(
        rustOutputs[i],
        expectedCanonicalForRust[i],
        `Rust legacy parity mismatch at index ${i}`,
      );
    }
    rustVerified = true;
  }

  return {
    fundingAmounts: LEGACY_AMOUNTS,
    singleRouteChecks,
    permutationChecks,
    impactNonDeductionChecks,
    rustVerified,
    rows,
  };
}

function parseCliArgs(argv: readonly string[]): {
  readonly rustBin?: string;
  readonly summaryOut?: string;
} {
  let rustBin: string | undefined;
  let summaryOut: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--rust-bin" && argv[i + 1]) {
      rustBin = path.resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--summary-out" && argv[i + 1]) {
      summaryOut = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return { rustBin, summaryOut };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseCliArgs(process.argv.slice(2));
  const report = verifyLegacyParity(args.rustBin);
  console.log(
    `Legacy parity PASS: singleRoute=${report.singleRouteChecks}, permutations=${report.permutationChecks}, impactNonDeduction=${report.impactNonDeductionChecks}, rustVerified=${report.rustVerified}`,
  );
  if (args.summaryOut) {
    fs.mkdirSync(path.dirname(args.summaryOut), { recursive: true });
    fs.writeFileSync(args.summaryOut, `${JSON.stringify(report, null, 2)}\n`);
  }
}
