/**
 * Phase 2B.1 — Shared TypeScript vs Rust JSON-lines differential test harness.
 *
 * Evaluates static edge-case, legacy-parity, and minimized regression fixtures
 * plus >= 10,000 deterministic synthetic cases (fixed seed 0x504f4e54455f3242),
 * candidate permutation pairs, and malformed adversarial lines across both the
 * TypeScript BigInt reference and the Rust optimizer-v1 binary.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { StaticFixtureFile } from "./build-static-fixtures";
import {
  generateSyntheticCases,
  generateValidOrRejectedRequest,
} from "./generator";
import { evaluateJsonLine } from "./json";
import type { WireOptimizeRequestV1, WireOptimizeResponseV1 } from "./model";
import { DEFAULT_DIFFERENTIAL_SEED, DeterministicPrng } from "./prng";

interface DifferentialCase {
  readonly id: string;
  readonly source: "static" | "generated" | "permutation" | "fuzz";
  readonly category: string;
  readonly rawJsonLine: string;
  readonly staticExpected?: WireOptimizeResponseV1;
}

interface MismatchRecord {
  readonly id: string;
  readonly source: string;
  readonly category: string;
  readonly rawJsonLine: string;
  readonly tsCanonical: string;
  readonly rustCanonical: string;
  readonly minimizedJsonLine?: string;
}

export interface DifferentialSummary {
  readonly seedHex: string;
  readonly seedDecimal: string;
  readonly rustBinary: string;
  readonly staticCount: number;
  readonly generatedCount: number;
  readonly permutationCount: number;
  readonly fuzzCount: number;
  readonly totalCount: number;
  readonly outcomes: {
    readonly SELECTED: number;
    readonly NO_ROUTE: number;
    readonly ERROR: number;
  };
  readonly successfulComparisons: number;
  readonly mismatchCount: number;
  readonly mismatches: readonly MismatchRecord[];
}

function loadStaticCases(): DifferentialCase[] {
  const dir = path.resolve(process.cwd(), "scripts/phase2b/fixtures/v1");
  const files = [
    "edge-cases.json",
    "legacy-parity.json",
    "regression-minimized.json",
  ];
  const out: DifferentialCase[] = [];
  for (const filename of files) {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, filename), "utf8"),
    ) as StaticFixtureFile;
    for (const vec of parsed.vectors) {
      if (vec.rawRequestJson.includes("\n") || vec.rawRequestJson.includes("\r")) {
        throw new Error(`Fixture ${vec.id} contains newline in JSONL payload`);
      }
      out.push({
        id: vec.id,
        source: "static",
        category: vec.category,
        rawJsonLine: vec.rawRequestJson,
        staticExpected: vec.expectedResponse,
      });
    }
  }
  return out;
}

function buildPermutationAndFuzzCases(seed: bigint): {
  readonly permutationCases: DifferentialCase[];
  readonly fuzzCases: DifferentialCase[];
} {
  const prng = new DeterministicPrng(seed ^ 0x0f0f0f0f0f0f0f0fn);
  const permutationCases: DifferentialCase[] = [];
  for (let i = 0; i < 250; i += 1) {
    const { request } = generateValidOrRejectedRequest(prng, i);
    const shuffled: WireOptimizeRequestV1 = {
      ...request,
      candidates: prng.shuffle(request.candidates),
    };
    permutationCases.push({
      id: `perm-${String(i + 1).padStart(4, "0")}-a`,
      source: "permutation",
      category: "permutation_pair_original",
      rawJsonLine: JSON.stringify(request),
    });
    permutationCases.push({
      id: `perm-${String(i + 1).padStart(4, "0")}-b`,
      source: "permutation",
      category: "permutation_pair_shuffled",
      rawJsonLine: JSON.stringify(shuffled),
    });
  }

  const fuzzCases: DifferentialCase[] = [];
  const fixedAdversarial = [
    "",
    " ",
    "{}",
    "[]",
    "null",
    "true",
    "123",
    '"string"',
    '{"version":1,"version":1}',
    '{"version":1.0}',
    '{"version":1e0}',
    '{"a":"\\uD800"}',
    '{"a":"\\uDC00"}',
    "[".repeat(40) + "]".repeat(40),
  ];
  fixedAdversarial.forEach((line, idx) => {
    fuzzCases.push({
      id: `fuzz-fixed-${String(idx + 1).padStart(3, "0")}`,
      source: "fuzz",
      category: "adversarial_wire",
      rawJsonLine: line,
    });
  });

  for (let i = 0; i < 186; i += 1) {
    const len = prng.intBetween(1, 96);
    let s = "";
    for (let j = 0; j < len; j += 1) {
      let ch = prng.intBetween(0x20, 0x7e);
      if (ch === 0x0a || ch === 0x0d) ch = 0x20;
      s += String.fromCharCode(ch);
    }
    fuzzCases.push({
      id: `fuzz-rand-${String(i + 1).padStart(3, "0")}`,
      source: "fuzz",
      category: "random_ascii_fuzz",
      rawJsonLine: s,
    });
  }

  return { permutationCases, fuzzCases };
}

function invokeRustBatch(
  rustBinPath: string,
  lines: readonly string[],
): readonly string[] {
  const CHUNK_SIZE = 2500;
  const results: string[] = [];

  for (let offset = 0; offset < lines.length; offset += CHUNK_SIZE) {
    const slice = lines.slice(offset, offset + CHUNK_SIZE);
    const payload = `${slice.join("\n")}\n`;
    const proc = spawnSync(rustBinPath, [], {
      input: payload,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
    if (proc.error) {
      throw proc.error;
    }
    if (proc.status !== 0) {
      throw new Error(
        `Rust optimizer-v1 exited with status ${proc.status}: ${proc.stderr}`,
      );
    }
    const outLines = proc.stdout.split("\n");
    if (outLines[outLines.length - 1] === "") {
      outLines.pop();
    }
    if (outLines.length !== slice.length) {
      throw new Error(
        `Rust output line count mismatch: expected ${slice.length}, received ${outLines.length}`,
      );
    }
    results.push(...outLines);
  }

  return results;
}

/**
 * Greedy delta-debugger that shrinks a failing request's candidate list while
 * preserving a TS-vs-Rust discrepancy, so minimized counterexamples can be saved.
 */
function minimizeFailingRequest(
  rustBinPath: string,
  rawJsonLine: string,
): string | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawJsonLine) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed.candidates) || parsed.candidates.length <= 1) {
    return undefined;
  }

  let currentCandidates = [...(parsed.candidates as unknown[])];
  let improved = true;
  while (improved && currentCandidates.length > 1) {
    improved = false;
    for (let i = 0; i < currentCandidates.length; i += 1) {
      const next = [
        ...currentCandidates.slice(0, i),
        ...currentCandidates.slice(i + 1),
      ];
      const candidateLine = JSON.stringify({ ...parsed, candidates: next });
      const tsOut = evaluateJsonLine(candidateLine).canonicalJson;
      const [rustOut] = invokeRustBatch(rustBinPath, [candidateLine]);
      if (tsOut !== rustOut) {
        currentCandidates = next;
        improved = true;
        break;
      }
    }
  }

  return JSON.stringify({ ...parsed, candidates: currentCandidates });
}

function parseCliArgs(argv: readonly string[]): {
  readonly rustBin: string;
  readonly count: number;
  readonly seed: bigint;
  readonly summaryOut?: string;
} {
  let rustBin = path.resolve(
    process.cwd(),
    "rust/optimizer/target/release/optimizer-v1",
  );
  if (!fs.existsSync(rustBin)) {
    const debugBin = path.resolve(
      process.cwd(),
      "rust/optimizer/target/debug/optimizer-v1",
    );
    if (fs.existsSync(debugBin)) {
      rustBin = debugBin;
    }
  }
  let count = 10_000;
  let seed = DEFAULT_DIFFERENTIAL_SEED;
  let summaryOut: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--rust-bin" && argv[i + 1]) {
      rustBin = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--count" && argv[i + 1]) {
      count = Number.parseInt(argv[i + 1], 10);
      i += 1;
    } else if (arg === "--seed" && argv[i + 1]) {
      seed = BigInt(argv[i + 1]);
      i += 1;
    } else if (arg === "--summary-out" && argv[i + 1]) {
      summaryOut = path.resolve(argv[i + 1]);
      i += 1;
    }
  }

  if (!Number.isInteger(count) || count < 10_000) {
    throw new Error(`--count must be an integer >= 10000 (got ${count})`);
  }

  return { rustBin, count, seed, summaryOut };
}

export function runDifferentialHarness(options: {
  readonly rustBin: string;
  readonly count: number;
  readonly seed: bigint;
  readonly summaryOut?: string;
}): DifferentialSummary {
  if (!fs.existsSync(options.rustBin)) {
    throw new Error(
      `Rust test runner binary not found at ${options.rustBin}. Build rust/optimizer first.`,
    );
  }

  const staticCases = loadStaticCases();
  const generatedRaw = generateSyntheticCases(options.count, options.seed);
  const generatedCases: DifferentialCase[] = generatedRaw.map((g) => ({
    id: g.id,
    source: "generated",
    category: g.category,
    rawJsonLine: g.rawJson,
  }));
  const { permutationCases, fuzzCases } = buildPermutationAndFuzzCases(
    options.seed,
  );

  const allCases: DifferentialCase[] = [
    ...staticCases,
    ...generatedCases,
    ...permutationCases,
    ...fuzzCases,
  ];

  const tsEvaluations = allCases.map((tc) => {
    const evaluated = evaluateJsonLine(tc.rawJsonLine);
    if (tc.staticExpected !== undefined) {
      assert.deepStrictEqual(
        evaluated.response,
        tc.staticExpected,
        `TypeScript reference deviated from static fixture ${tc.id}`,
      );
    }
    return evaluated;
  });

  const rustLines = invokeRustBatch(
    options.rustBin,
    allCases.map((tc) => tc.rawJsonLine),
  );

  const outcomes = {
    SELECTED: 0,
    NO_ROUTE: 0,
    ERROR: 0,
  };

  const mismatches: MismatchRecord[] = [];
  let successfulComparisons = 0;

  for (let i = 0; i < allCases.length; i += 1) {
    const tc = allCases[i];
    const tsEval = tsEvaluations[i];
    const rustLine = rustLines[i];
    outcomes[tsEval.response.status] += 1;

    let matches = tsEval.canonicalJson === rustLine;
    if (!matches) {
      try {
        const rustParsed = JSON.parse(rustLine) as WireOptimizeResponseV1;
        assert.deepStrictEqual(rustParsed, tsEval.response);
        matches = true;
      } catch {
        matches = false;
      }
    }

    if (matches) {
      successfulComparisons += 1;
    } else {
      const minimized = minimizeFailingRequest(
        options.rustBin,
        tc.rawJsonLine,
      );
      mismatches.push({
        id: tc.id,
        source: tc.source,
        category: tc.category,
        rawJsonLine: tc.rawJsonLine,
        tsCanonical: tsEval.canonicalJson,
        rustCanonical: rustLine,
        minimizedJsonLine: minimized,
      });
    }
  }

  // Verify permutation pairs agree identically in Rust as well
  const permStart = staticCases.length + generatedCases.length;
  for (let p = 0; p < permutationCases.length; p += 2) {
    const idxA = permStart + p;
    const idxB = permStart + p + 1;
    if (rustLines[idxA] !== rustLines[idxB]) {
      mismatches.push({
        id: `${permutationCases[p].id}-vs-${permutationCases[p + 1].id}`,
        source: "permutation",
        category: "rust_permutation_invariance",
        rawJsonLine: permutationCases[p + 1].rawJsonLine,
        tsCanonical: rustLines[idxA],
        rustCanonical: rustLines[idxB],
      });
    }
  }

  const summary: DifferentialSummary = {
    seedHex: `0x${options.seed.toString(16)}`,
    seedDecimal: options.seed.toString(10),
    rustBinary: options.rustBin,
    staticCount: staticCases.length,
    generatedCount: generatedCases.length,
    permutationCount: permutationCases.length,
    fuzzCount: fuzzCases.length,
    totalCount: allCases.length,
    outcomes,
    successfulComparisons,
    mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, 20),
  };

  if (options.summaryOut) {
    fs.mkdirSync(path.dirname(options.summaryOut), { recursive: true });
    fs.writeFileSync(
      options.summaryOut,
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );
  }

  console.log(
    [
      "=== Phase 2B.1 Differential Test Summary ===",
      `Seed:                  ${summary.seedHex} (${summary.seedDecimal})`,
      `Static fixtures:       ${summary.staticCount}`,
      `Generated synthetic:   ${summary.generatedCount}`,
      `Permutation cases:     ${summary.permutationCount}`,
      `Adversarial fuzz:      ${summary.fuzzCount}`,
      `Total cases compared:  ${summary.totalCount}`,
      `Outcomes:              SELECTED=${outcomes.SELECTED}, NO_ROUTE=${outcomes.NO_ROUTE}, ERROR=${outcomes.ERROR}`,
      `Successful matches:    ${summary.successfulComparisons}`,
      `Mismatches:            ${summary.mismatchCount}`,
    ].join("\n"),
  );

  if (summary.mismatchCount > 0) {
    console.error("Differential mismatches detected:", summary.mismatches[0]);
    process.exit(1);
  }

  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseCliArgs(process.argv.slice(2));
  runDifferentialHarness(args);
}
