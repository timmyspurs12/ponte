/**
 * Phase 2B.1 — Native Rust vs TypeScript BigInt benchmark harness (Section 11).
 *
 * Compares pre-parsed core evaluation latency and end-to-end JSON roundtrip
 * latency across identical deterministic synthetic datasets (1, 3, 8, 16, 32,
 * and 64 candidates; valid/rejected mixes; equal-output ties; U128/U256
 * numeric boundaries) over multiple warmed OS process runs.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateJsonLine, parseRequestV1Json } from "./json";
import {
  MAX_BPS,
  OPTIMIZER_MODE_SYNTHETIC,
  OPTIMIZER_VERSION_V1,
  U128_MAX,
  U256_MAX,
  type OptimizeRequestV1,
  type WireCandidateV1,
  type WireOptimizeRequestV1,
} from "./model";
import { optimizeV1 } from "./optimizer";
import { DEFAULT_BENCHMARK_SEED, DeterministicPrng } from "./prng";

interface DatasetSpec {
  readonly name: string;
  readonly candidateCount: number;
  readonly scenario: "all_valid" | "mixed_rejected" | "equal_ties" | "numeric_boundary";
}

const DATASETS: readonly DatasetSpec[] = [
  { name: "valid_01_cand", candidateCount: 1, scenario: "all_valid" },
  { name: "valid_03_cand", candidateCount: 3, scenario: "all_valid" },
  { name: "valid_08_cand", candidateCount: 8, scenario: "all_valid" },
  { name: "valid_16_cand", candidateCount: 16, scenario: "all_valid" },
  { name: "valid_32_cand", candidateCount: 32, scenario: "all_valid" },
  { name: "valid_64_cand", candidateCount: 64, scenario: "all_valid" },
  { name: "mixed_16_cand", candidateCount: 16, scenario: "mixed_rejected" },
  { name: "mixed_64_cand", candidateCount: 64, scenario: "mixed_rejected" },
  { name: "ties_32_cand", candidateCount: 32, scenario: "equal_ties" },
  { name: "ties_64_cand", candidateCount: 64, scenario: "equal_ties" },
  { name: "boundary_16_cand", candidateCount: 16, scenario: "numeric_boundary" },
];

interface WorkerTimingOutput {
  readonly coreBatchNs: readonly number[];
  readonly jsonBatchNs: readonly number[];
  readonly requestCount: number;
  readonly checksum: string;
}

export interface PercentileStatsNs {
  readonly minNsPerEval: number;
  readonly p50NsPerEval: number;
  readonly p95NsPerEval: number;
  readonly p99NsPerEval: number;
  readonly maxNsPerEval: number;
  readonly iqrNsPerEval: number;
  readonly processRunMediansNs: readonly number[];
}

export interface DatasetBenchmarkResult {
  readonly dataset: string;
  readonly candidateCount: number;
  readonly scenario: string;
  readonly requestsPerPass: number;
  readonly warmupEvaluationsPerRun: number;
  readonly measuredEvaluationsPerRun: number;
  readonly processRuns: number;
  readonly tsCore: PercentileStatsNs;
  readonly rustCore: PercentileStatsNs;
  readonly tsJsonRoundtrip: PercentileStatsNs;
  readonly rustJsonRoundtrip: PercentileStatsNs;
  readonly coreMedianRatioTsOverRust: number;
}

export interface BenchmarkReport {
  readonly timestampUtc: string;
  readonly seedHex: string;
  readonly environment: {
    readonly platform: string;
    readonly arch: string;
    readonly release: string;
    readonly cpuModel: string;
    readonly cpuLogicalCores: number;
    readonly totalMemoryBytes: number;
    readonly nodeVersion: string;
    readonly rustcVersion: string;
    readonly cargoVersion: string;
  };
  readonly methodology: {
    readonly requestsPerDataset: number;
    readonly warmupPassesPerRun: number;
    readonly measuredPassesPerRun: number;
    readonly processRuns: number;
    readonly tsClock: string;
    readonly rustClock: string;
  };
  readonly results: readonly DatasetBenchmarkResult[];
}

function buildDatasetLines(
  spec: DatasetSpec,
  requestsPerDataset: number,
  seed: bigint,
): string[] {
  const prng = new DeterministicPrng(
    seed ^ BigInt(spec.candidateCount * 997 + spec.name.length * 31),
  );
  const lines: string[] = [];

  for (let r = 0; r < requestsPerDataset; r += 1) {
    const snapshotId = prng.nextBytes32(0xbe);
    const asOf = 1_763_323_200n;
    const reqExp = 1_763_324_100n;
    let amountIn = BigInt(prng.intBetween(10_000, 50_000_000));
    const candidates: WireCandidateV1[] = [];

    if (spec.scenario === "numeric_boundary") {
      amountIn = U128_MAX - BigInt(r);
    }

    const sharedNum = BigInt(prng.intBetween(80, 400));
    const sharedDen = BigInt(prng.intBetween(80, 400));
    const maxSafeN = U256_MAX / (amountIn * 10_000n);

    for (let c = 0; c < spec.candidateCount; c += 1) {
      const routeId = `0x${(c + 1).toString(16).padStart(8, "0")}${prng
        .nextU64()
        .toString(16)
        .padStart(16, "0")}${"0".repeat(40)}`;

      if (spec.scenario === "all_valid") {
        candidates.push({
          routeId,
          snapshotId,
          rateNumerator: String(prng.intBetween(90, 550)),
          rateDenominator: String(prng.intBetween(90, 550)),
          feeBps: prng.intBetween(5, 150),
          estimatedImpactBps: prng.intBetween(1, 50),
          minInput: "100",
          maxInput: U128_MAX.toString(),
          availableInput: U128_MAX.toString(),
          availableOutput: U128_MAX.toString(),
          executionCostUsdCents: String(prng.intBetween(1, 20)),
          expiresAtUnixSeconds: reqExp.toString(),
        });
      } else if (spec.scenario === "mixed_rejected") {
        const rejectMode = c % 6;
        candidates.push({
          routeId,
          snapshotId,
          rateNumerator: String(prng.intBetween(90, 550)),
          rateDenominator: String(prng.intBetween(90, 550)),
          feeBps: rejectMode === 3 ? MAX_BPS : prng.intBetween(10, 120),
          estimatedImpactBps: 10,
          minInput: rejectMode === 1 ? (amountIn + 10n).toString() : "100",
          maxInput:
            rejectMode === 1
              ? (amountIn + 1000n).toString()
              : rejectMode === 2
                ? (amountIn - 1n).toString()
                : U128_MAX.toString(),
          availableInput: U128_MAX.toString(),
          availableOutput: U128_MAX.toString(),
          executionCostUsdCents: String(prng.intBetween(1, 15)),
          expiresAtUnixSeconds:
            rejectMode === 0 ? asOf.toString() : reqExp.toString(),
        });
      } else if (spec.scenario === "equal_ties") {
        candidates.push({
          routeId,
          snapshotId,
          rateNumerator: sharedNum.toString(),
          rateDenominator: sharedDen.toString(),
          feeBps: 35,
          estimatedImpactBps: 5,
          minInput: "100",
          maxInput: U128_MAX.toString(),
          availableInput: U128_MAX.toString(),
          availableOutput: U128_MAX.toString(),
          executionCostUsdCents: "2",
          expiresAtUnixSeconds: reqExp.toString(),
        });
      } else {
        // numeric_boundary
        const over = c % 3 === 0;
        const nVal = over
          ? maxSafeN + 1n < U128_MAX
            ? maxSafeN + 1n
            : U128_MAX
          : maxSafeN > BigInt(c + 1)
            ? maxSafeN - BigInt(c)
            : 1n;
        candidates.push({
          routeId,
          snapshotId,
          rateNumerator: nVal.toString(),
          rateDenominator: U128_MAX.toString(),
          feeBps: 0,
          estimatedImpactBps: 0,
          minInput: "1",
          maxInput: U128_MAX.toString(),
          availableInput: U128_MAX.toString(),
          availableOutput: U128_MAX.toString(),
          executionCostUsdCents: String(c + 1),
          expiresAtUnixSeconds: reqExp.toString(),
        });
      }
    }

    const req: WireOptimizeRequestV1 = {
      version: OPTIMIZER_VERSION_V1,
      mode: OPTIMIZER_MODE_SYNTHETIC,
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
      amountIn: amountIn.toString(),
      userMinOut: "0",
      toleranceBps: 50,
      asOfUnixSeconds: asOf.toString(),
      expiresAtUnixSeconds: reqExp.toString(),
      snapshotId,
      candidates: prng.shuffle(candidates),
    };
    lines.push(JSON.stringify(req));
  }

  return lines;
}

function runTsBenchmarkWorker(
  jsonlPath: string,
  warmupPasses: number,
  measurePasses: number,
): WorkerTimingOutput {
  const rawContent = fs.readFileSync(jsonlPath, "utf8");
  const lines = rawContent.split("\n").filter((l) => l.length > 0);
  const parsedRequests: OptimizeRequestV1[] = lines.map(parseRequestV1Json);

  let sink = 0n;

  // Core warmup
  for (let w = 0; w < warmupPasses; w += 1) {
    for (let i = 0; i < parsedRequests.length; i += 1) {
      const res = optimizeV1(parsedRequests[i]);
      if (res.ok && res.value.status === "SELECTED") {
        sink = (sink + (res.value.expectedOut & 0xffffn)) & 0xffffffffn;
      } else {
        sink = (sink + 1n) & 0xffffffffn;
      }
    }
  }

  // Core measurement
  const coreBatchNs: number[] = [];
  for (let m = 0; m < measurePasses; m += 1) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < parsedRequests.length; i += 1) {
      const res = optimizeV1(parsedRequests[i]);
      if (res.ok && res.value.status === "SELECTED") {
        sink = (sink + (res.value.expectedOut & 0xffffn)) & 0xffffffffn;
      } else {
        sink = (sink + 1n) & 0xffffffffn;
      }
    }
    const t1 = process.hrtime.bigint();
    coreBatchNs.push(Number(t1 - t0));
  }

  // JSON roundtrip warmup & measurement (separate auxiliary serialization baseline)
  const jsonWarmups = Math.max(3, Math.floor(warmupPasses / 4));
  const jsonMeasures = Math.max(10, Math.floor(measurePasses / 5));
  for (let w = 0; w < jsonWarmups; w += 1) {
    for (let i = 0; i < lines.length; i += 1) {
      const out = evaluateJsonLine(lines[i]);
      sink = (sink + BigInt(out.canonicalJson.length)) & 0xffffffffn;
    }
  }

  const jsonBatchNs: number[] = [];
  for (let m = 0; m < jsonMeasures; m += 1) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < lines.length; i += 1) {
      const out = evaluateJsonLine(lines[i]);
      sink = (sink + BigInt(out.canonicalJson.length)) & 0xffffffffn;
    }
    const t1 = process.hrtime.bigint();
    jsonBatchNs.push(Number(t1 - t0));
  }

  return {
    coreBatchNs,
    jsonBatchNs,
    requestCount: parsedRequests.length,
    checksum: sink.toString(16),
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

function computeStats(
  runsBatchNs: ReadonlyArray<readonly number[]>,
  requestsPerPass: number,
): PercentileStatsNs {
  const allPerEval: number[] = [];
  const runMedians: number[] = [];

  for (const runBatches of runsBatchNs) {
    const perEvalInRun = runBatches
      .map((ns) => Math.round(ns / requestsPerPass))
      .sort((a, b) => a - b);
    runMedians.push(percentile(perEvalInRun, 50));
    allPerEval.push(...perEvalInRun);
  }

  allPerEval.sort((a, b) => a - b);
  const p25 = percentile(allPerEval, 25);
  const p75 = percentile(allPerEval, 75);

  return {
    minNsPerEval: allPerEval[0],
    p50NsPerEval: percentile(allPerEval, 50),
    p95NsPerEval: percentile(allPerEval, 95),
    p99NsPerEval: percentile(allPerEval, 99),
    maxNsPerEval: allPerEval[allPerEval.length - 1],
    iqrNsPerEval: p75 - p25,
    processRunMediansNs: runMedians,
  };
}

function readCmdLineVersion(cmd: string, args: readonly string[]): string {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error || res.status !== 0) {
    return "unavailable";
  }
  return res.stdout.trim();
}

function runFullBenchmark(options: {
  readonly rustBin: string;
  readonly processRuns: number;
  readonly warmupPasses: number;
  readonly measurePasses: number;
  readonly requestsPerDataset: number;
  readonly jsonOut?: string;
  readonly markdownOut?: string;
}): BenchmarkReport {
  if (!fs.existsSync(options.rustBin)) {
    throw new Error(`Rust release binary not found at ${options.rustBin}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ponte-phase2b-bench-"));
  const results: DatasetBenchmarkResult[] = [];

  try {
    for (const spec of DATASETS) {
      const lines = buildDatasetLines(
        spec,
        options.requestsPerDataset,
        DEFAULT_BENCHMARK_SEED,
      );
      const datasetPath = path.join(tmpDir, `${spec.name}.jsonl`);
      fs.writeFileSync(datasetPath, `${lines.join("\n")}\n`, "utf8");

      const tsCoreRuns: number[][] = [];
      const tsJsonRuns: number[][] = [];
      const rustCoreRuns: number[][] = [];
      const rustJsonRuns: number[][] = [];

      for (let run = 0; run < options.processRuns; run += 1) {
        // Isolated Node 22 child process run
        const tsProc = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            path.resolve(process.cwd(), "scripts/phase2b/benchmark.ts"),
            "--ts-worker",
            datasetPath,
            String(options.warmupPasses),
            String(options.measurePasses),
          ],
          { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
        );
        if (tsProc.error || tsProc.status !== 0) {
          throw new Error(
            `TS benchmark worker failed: ${tsProc.stderr || tsProc.error}`,
          );
        }
        const tsOut = JSON.parse(tsProc.stdout.trim()) as WorkerTimingOutput;
        tsCoreRuns.push([...tsOut.coreBatchNs]);
        tsJsonRuns.push([...tsOut.jsonBatchNs]);

        // Isolated Native Rust release child process run
        const rustProc = spawnSync(
          options.rustBin,
          [
            "--bench",
            datasetPath,
            String(options.warmupPasses),
            String(options.measurePasses),
          ],
          { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
        );
        if (rustProc.error || rustProc.status !== 0) {
          throw new Error(
            `Rust benchmark worker failed: ${rustProc.stderr || rustProc.error}`,
          );
        }
        const rustOut = JSON.parse(rustProc.stdout.trim()) as WorkerTimingOutput;
        rustCoreRuns.push([...rustOut.coreBatchNs]);
        rustJsonRuns.push([...rustOut.jsonBatchNs]);
      }

      const tsCore = computeStats(tsCoreRuns, options.requestsPerDataset);
      const rustCore = computeStats(rustCoreRuns, options.requestsPerDataset);
      const tsJsonRoundtrip = computeStats(
        tsJsonRuns,
        options.requestsPerDataset,
      );
      const rustJsonRoundtrip = computeStats(
        rustJsonRuns,
        options.requestsPerDataset,
      );

      const ratio =
        rustCore.p50NsPerEval > 0
          ? Number((tsCore.p50NsPerEval / rustCore.p50NsPerEval).toFixed(2))
          : 0;

      results.push({
        dataset: spec.name,
        candidateCount: spec.candidateCount,
        scenario: spec.scenario,
        requestsPerPass: options.requestsPerDataset,
        warmupEvaluationsPerRun:
          options.warmupPasses * options.requestsPerDataset,
        measuredEvaluationsPerRun:
          options.measurePasses * options.requestsPerDataset,
        processRuns: options.processRuns,
        tsCore,
        rustCore,
        tsJsonRoundtrip,
        rustJsonRoundtrip,
        coreMedianRatioTsOverRust: ratio,
      });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const cpus = os.cpus();
  const report: BenchmarkReport = {
    timestampUtc: new Date().toISOString(),
    seedHex: `0x${DEFAULT_BENCHMARK_SEED.toString(16)}`,
    environment: {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      cpuModel: cpus[0]?.model ?? "unknown",
      cpuLogicalCores: cpus.length,
      totalMemoryBytes: os.totalmem(),
      nodeVersion: process.version,
      rustcVersion: readCmdLineVersion("rustc", ["--version"]),
      cargoVersion: readCmdLineVersion("cargo", ["--version"]),
    },
    methodology: {
      requestsPerDataset: options.requestsPerDataset,
      warmupPassesPerRun: options.warmupPasses,
      measuredPassesPerRun: options.measurePasses,
      processRuns: options.processRuns,
      tsClock: "process.hrtime.bigint()",
      rustClock: "std::time::Instant::now()",
    },
    results,
  };

  const mdLines = [
    "# Phase 2B.1 Native Host Benchmark Summary",
    "",
    `- UTC timestamp: \`${report.timestampUtc}\``,
    `- Seed: \`${report.seedHex}\``,
    `- OS / Arch: \`${report.environment.platform} ${report.environment.release} (${report.environment.arch})\``,
    `- CPU: \`${report.environment.cpuModel}\` (${report.environment.cpuLogicalCores} logical cores)`,
    `- Memory: \`${Math.round(report.environment.totalMemoryBytes / (1024 * 1024))} MiB\``,
    `- Node: \`${report.environment.nodeVersion}\``,
    `- Rustc: \`${report.environment.rustcVersion}\``,
    `- Cargo: \`${report.environment.cargoVersion}\``,
    `- Runs: \`${report.methodology.processRuns}\` OS process runs x \`${report.methodology.measuredPassesPerRun * report.methodology.requestsPerDataset}\` measured evaluations/run (\`${report.methodology.warmupPassesPerRun * report.methodology.requestsPerDataset}\` warmup evaluations/run)`,
    "",
    "## Pre-parsed Core Evaluation (ns / evaluation)",
    "",
    "| Dataset | Candidates | Scenario | TS p50 (ns) | TS p95 (ns) | TS p99 (ns) | Rust p50 (ns) | Rust p95 (ns) | Rust p99 (ns) | TS/Rust p50 |",
    "|---|---:|---|---:|---:|---:|---:|---:|---:|---:|",
    ...report.results.map(
      (r) =>
        `| ${r.dataset} | ${r.candidateCount} | ${r.scenario} | ${r.tsCore.p50NsPerEval} | ${r.tsCore.p95NsPerEval} | ${r.tsCore.p99NsPerEval} | ${r.rustCore.p50NsPerEval} | ${r.rustCore.p95NsPerEval} | ${r.rustCore.p99NsPerEval} | ${r.coreMedianRatioTsOverRust}x |`,
    ),
    "",
    "## JSON Parse + Core Evaluate + Canonical Serialize (ns / line)",
    "",
    "| Dataset | Candidates | TS JSON p50 (ns) | TS JSON p95 (ns) | Rust JSON p50 (ns) | Rust JSON p95 (ns) |",
    "|---|---:|---:|---:|---:|---:|",
    ...report.results.map(
      (r) =>
        `| ${r.dataset} | ${r.candidateCount} | ${r.tsJsonRoundtrip.p50NsPerEval} | ${r.tsJsonRoundtrip.p95NsPerEval} | ${r.rustJsonRoundtrip.p50NsPerEval} | ${r.rustJsonRoundtrip.p95NsPerEval} |`,
    ),
    "",
    "*Note: Host microbenchmark only on synthetic offline inputs. Does not represent WASM execution, Arbitrum Stylus gas/ink, RPC latency, or production settlement throughput.*",
  ];

  const mdText = `${mdLines.join("\n")}\n`;
  console.log(mdText);

  if (options.jsonOut) {
    fs.mkdirSync(path.dirname(options.jsonOut), { recursive: true });
    fs.writeFileSync(options.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.markdownOut) {
    fs.mkdirSync(path.dirname(options.markdownOut), { recursive: true });
    fs.writeFileSync(options.markdownOut, mdText);
  }

  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--ts-worker") {
    const out = runTsBenchmarkWorker(
      argv[1],
      Number.parseInt(argv[2], 10),
      Number.parseInt(argv[3], 10),
    );
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } else {
    let rustBin = path.resolve(
      process.cwd(),
      "rust/optimizer/target/release/optimizer-v1",
    );
    let processRuns = 5;
    let warmupPasses = 20;
    let measurePasses = 100;
    let requestsPerDataset = 100;
    let jsonOut: string | undefined;
    let markdownOut: string | undefined;

    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === "--rust-bin" && argv[i + 1]) {
        rustBin = path.resolve(argv[i + 1]);
        i += 1;
      } else if (argv[i] === "--runs" && argv[i + 1]) {
        processRuns = Number.parseInt(argv[i + 1], 10);
        i += 1;
      } else if (argv[i] === "--warmup-passes" && argv[i + 1]) {
        warmupPasses = Number.parseInt(argv[i + 1], 10);
        i += 1;
      } else if (argv[i] === "--measure-passes" && argv[i + 1]) {
        measurePasses = Number.parseInt(argv[i + 1], 10);
        i += 1;
      } else if (argv[i] === "--dataset-size" && argv[i + 1]) {
        requestsPerDataset = Number.parseInt(argv[i + 1], 10);
        i += 1;
      } else if (argv[i] === "--json-out" && argv[i + 1]) {
        jsonOut = path.resolve(argv[i + 1]);
        i += 1;
      } else if (argv[i] === "--markdown-out" && argv[i + 1]) {
        markdownOut = path.resolve(argv[i + 1]);
        i += 1;
      }
    }

    runFullBenchmark({
      rustBin,
      processRuns,
      warmupPasses,
      measurePasses,
      requestsPerDataset,
      jsonOut,
      markdownOut,
    });
  }
}
