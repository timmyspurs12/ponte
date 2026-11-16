/**
 * Phase 2B.1 — Unit, static-fixture, legacy-parity, and deterministic property
 * tests for the isolated TypeScript V1 synthetic route optimizer.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { StaticFixtureFile } from "./build-static-fixtures";
import {
  generateSyntheticCases,
  generateValidOrRejectedRequest,
} from "./generator";
import { evaluateJsonLine, parseRequestV1Json } from "./json";
import { verifyLegacyParity } from "./legacy-parity";
import { U128_MAX, U256_MAX } from "./model";
import { optimizeV1 } from "./optimizer";
import { DEFAULT_DIFFERENTIAL_SEED, DeterministicPrng } from "./prng";

test("all versioned static fixture suites match expected V1 results", () => {
  const dir = path.resolve(process.cwd(), "scripts/phase2b/fixtures/v1");
  const files = [
    "edge-cases.json",
    "legacy-parity.json",
    "regression-minimized.json",
  ];
  let count = 0;
  for (const file of files) {
    const data = JSON.parse(
      fs.readFileSync(path.join(dir, file), "utf8"),
    ) as StaticFixtureFile;
    assert.equal(data.schemaVersion, 1);
    assert.equal(data.syntheticOnly, true);
    for (const vec of data.vectors) {
      const actual = evaluateJsonLine(vec.rawRequestJson);
      assert.deepStrictEqual(
        actual.response,
        vec.expectedResponse,
        `Mismatch in ${file} -> ${vec.id}`,
      );
      count += 1;
    }
  }
  assert.ok(count >= 60, `Expected >= 60 static fixtures, ran ${count}`);
});

test("legacy quote() parity holds across all 3 funding amounts, 3 routes, and 6 permutations", () => {
  const report = verifyLegacyParity();
  assert.equal(report.singleRouteChecks, 9);
  assert.equal(report.permutationChecks, 18);
  assert.equal(report.impactNonDeductionChecks, 27);
});

test("property: repeated identical evaluations always produce byte-for-byte identical outputs", () => {
  const cases = generateSyntheticCases(500, DEFAULT_DIFFERENTIAL_SEED);
  for (const tc of cases) {
    const first = evaluateJsonLine(tc.rawJson);
    const second = evaluateJsonLine(tc.rawJson);
    const third = evaluateJsonLine(tc.rawJson);
    assert.equal(first.canonicalJson, second.canonicalJson);
    assert.equal(second.canonicalJson, third.canonicalJson);
    assert.deepStrictEqual(first.response, second.response);
  }
});

test("property: candidate permutation never changes winner, quote values, or rejected ordering", () => {
  const prng = new DeterministicPrng(0x123456789abcdef0n);
  for (let i = 0; i < 600; i += 1) {
    const { request } = generateValidOrRejectedRequest(prng, i);
    const baseline = evaluateJsonLine(JSON.stringify(request));
    for (let p = 0; p < 3; p += 1) {
      const permuted = {
        ...request,
        candidates: prng.shuffle(request.candidates),
      };
      const reEvaluated = evaluateJsonLine(JSON.stringify(permuted));
      assert.equal(
        reEvaluated.canonicalJson,
        baseline.canonicalJson,
        `Permutation changed output on iteration ${i}`,
      );
    }
  }
});

test("property: selected routes satisfy 0 < O, 0 <= M <= O <= G, G = feeOut + O, capacity, liquidity, and expiry invariants", () => {
  const prng = new DeterministicPrng(0xfedcba9876543210n);
  let selectedSeen = 0;
  let noRouteSeen = 0;

  for (let i = 0; i < 1500; i += 1) {
    const { request: wireReq } = generateValidOrRejectedRequest(prng, i);
    const raw = JSON.stringify(wireReq);
    const parsedReq = parseRequestV1Json(raw);
    const res = optimizeV1(parsedReq);
    assert.equal(res.ok, true);

    const outcome = res.value;
    assert.equal(outcome.evaluatedCount, parsedReq.candidates.length);
    assert.equal(outcome.snapshotId, parsedReq.snapshotId);
    assert.equal(outcome.amountIn, parsedReq.amountIn);

    // Rejected list must be strictly sorted by canonical routeId ascending
    for (let r = 1; r < outcome.rejected.length; r += 1) {
      assert.ok(
        outcome.rejected[r - 1].routeId < outcome.rejected[r].routeId,
        "Rejected candidates must be strictly sorted by routeId",
      );
    }

    if (outcome.status === "NO_ROUTE") {
      assert.equal(outcome.rejected.length, parsedReq.candidates.length);
      noRouteSeen += 1;
      continue;
    }

    selectedSeen += 1;
    assert.ok(outcome.expectedOut > 0n);
    assert.ok(outcome.minimumOut >= 0n);
    assert.ok(outcome.minimumOut <= outcome.expectedOut);
    assert.ok(outcome.expectedOut <= outcome.grossOut);
    assert.ok(outcome.grossOut <= U128_MAX);
    assert.equal(outcome.grossOut, outcome.feeOut + outcome.expectedOut);

    // Selected candidate constraints
    const winnerCand = parsedReq.candidates.find(
      (c) => c.routeId === outcome.selectedRouteId,
    );
    assert.ok(winnerCand, "Selected route must belong to request candidates");
    assert.ok(parsedReq.amountIn >= winnerCand.minInput);
    assert.ok(parsedReq.amountIn <= winnerCand.maxInput);
    assert.ok(parsedReq.amountIn <= winnerCand.availableInput);
    assert.ok(outcome.expectedOut <= winnerCand.availableOutput);
    assert.ok(outcome.minimumOut >= parsedReq.userMinOut);
    assert.equal(outcome.executionCostUsdCents, winnerCand.executionCostUsdCents);

    const expectedEffectiveExpiry =
      parsedReq.expiresAtUnixSeconds <= winnerCand.expiresAtUnixSeconds
        ? parsedReq.expiresAtUnixSeconds
        : winnerCand.expiresAtUnixSeconds;
    assert.equal(outcome.effectiveExpiry, expectedEffectiveExpiry);
    assert.ok(parsedReq.asOfUnixSeconds < outcome.effectiveExpiry);
  }

  assert.ok(selectedSeen > 200);
  assert.ok(noRouteSeen > 100);
});

test("property: overflow never wraps or saturates near U128_MAX and U256_MAX", () => {
  const maxSafeN = U256_MAX / (U128_MAX * 10_000n);
  for (const delta of [-2n, -1n, 0n, 1n, 2n, 100n]) {
    const n = maxSafeN + delta;
    const raw = JSON.stringify({
      version: 1,
      mode: "SYNTHETIC",
      inputAsset: {
        namespace: "SYNTHETIC_TOKEN",
        identifier: "SYNTH_A",
        decimals: 18,
      },
      outputAsset: {
        namespace: "SYNTHETIC_TOKEN",
        identifier: "SYNTH_B",
        decimals: 18,
      },
      amountIn: U128_MAX.toString(),
      userMinOut: "0",
      toleranceBps: 0,
      asOfUnixSeconds: "100",
      expiresAtUnixSeconds: "200",
      snapshotId: `0x${"11".repeat(32)}`,
      candidates: [
        {
          routeId: `0x${"01".repeat(32)}`,
          snapshotId: `0x${"11".repeat(32)}`,
          rateNumerator: n.toString(),
          rateDenominator: U128_MAX.toString(),
          feeBps: 0,
          estimatedImpactBps: 0,
          minInput: "1",
          maxInput: U128_MAX.toString(),
          availableInput: U128_MAX.toString(),
          availableOutput: U128_MAX.toString(),
          executionCostUsdCents: "0",
          expiresAtUnixSeconds: "200",
        },
      ],
    });
    const { response } = evaluateJsonLine(raw);
    if (delta <= 0n) {
      assert.equal(response.status, "SELECTED");
      assert.equal(response.expectedOut, n.toString());
    } else {
      assert.equal(response.status, "NO_ROUTE");
      assert.equal(response.rejected[0].reason, "ARITHMETIC_RANGE");
    }
  }
});

test("property: arbitrary malformed and adversarial strings never throw uncaught errors", () => {
  const prng = new DeterministicPrng(0x9988776655443322n);
  const adversarial = [
    "",
    " ",
    "\0",
    "{",
    "}",
    "[".repeat(100),
    '{"a":'.repeat(50),
    '{"version":1e9999}',
    '{"version":-0}',
    '{"s":"\\uD800\\u0041"}',
    '{"s":"\\uDC00"}',
  ];

  for (let i = 0; i < 300; i += 1) {
    const len = prng.intBetween(0, 120);
    let randomStr = "";
    for (let j = 0; j < len; j += 1) {
      randomStr += String.fromCharCode(prng.intBetween(0, 127));
    }
    adversarial.push(randomStr);
  }

  for (const input of adversarial) {
    const out = evaluateJsonLine(input);
    assert.equal(out.response.status, "ERROR");
  }
});
