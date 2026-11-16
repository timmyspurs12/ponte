/**
 * Phase 2B.1 — Checked BigInt arithmetic enforcing exact U128 input/output bounds
 * and U256 intermediate arithmetic ceiling (matching Rust's alloy_primitives::U256).
 *
 * JavaScript Number is never used for monetary or timestamp calculations.
 */

import {
  BPS_DENOMINATOR_BIGINT,
  MAX_BPS,
  OptimizerValidationError,
  U64_MAX,
  U128_MAX,
  U256_MAX,
  type CandidateRejectionReason,
} from "./model";

export interface ComputedQuoteAmounts {
  readonly grossOut: bigint;
  readonly expectedOut: bigint;
  readonly feeOut: bigint;
  readonly toleranceMinOut: bigint;
  readonly requiredMinOut: bigint;
}

/**
 * Checks canonical unsigned base-10 integer string syntax:
 * either "0" or a non-empty sequence of ASCII digits without leading zeros.
 */
export function isCanonicalUnsignedIntString(raw: string): boolean {
  if (raw.length === 0) {
    return false;
  }
  if (raw === "0") {
    return true;
  }
  const first = raw.charCodeAt(0);
  if (first < 0x31 || first > 0x39) {
    return false;
  }
  for (let i = 1; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x30 || code > 0x39) {
      return false;
    }
  }
  return true;
}

function parseDigitsChecked(raw: string, maxBound: bigint): bigint {
  if (!isCanonicalUnsignedIntString(raw)) {
    throw new OptimizerValidationError("INVALID_INTEGER_ENCODING");
  }
  let acc = 0n;
  for (let i = 0; i < raw.length; i += 1) {
    const digit = BigInt(raw.charCodeAt(i) - 0x30);
    acc = acc * 10n + digit;
    if (acc > maxBound) {
      throw new OptimizerValidationError("INTEGER_OVERFLOW");
    }
  }
  return acc;
}

export function parseCanonicalU128(raw: string): bigint {
  return parseDigitsChecked(raw, U128_MAX);
}

export function parseCanonicalU64(raw: string): bigint {
  return parseDigitsChecked(raw, U64_MAX);
}

export function isValidBytes32Hex(raw: string): boolean {
  if (raw.length !== 66 || raw.charCodeAt(0) !== 0x30 || raw.charCodeAt(1) !== 0x78) {
    return false;
  }
  for (let i = 2; i < 66; i += 1) {
    const c = raw.charCodeAt(i);
    const isDigit = c >= 0x30 && c <= 0x39;
    const isLowerHex = c >= 0x61 && c <= 0x66;
    if (!isDigit && !isLowerHex) {
      return false;
    }
  }
  return true;
}

export function assertCanonicalBytes32(raw: string): string {
  if (!isValidBytes32Hex(raw)) {
    throw new OptimizerValidationError("INVALID_BYTES32");
  }
  return raw;
}

/**
 * Compares two validated canonical lowercase 0x-prefixed bytes32 strings
 * in unsigned 32-byte big-endian lexicographic order.
 */
export function compareBytes32(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

export function checkedMulU256(a: bigint, b: bigint): bigint | null {
  if (a < 0n || b < 0n || a > U256_MAX || b > U256_MAX) {
    return null;
  }
  const prod = a * b;
  if (prod > U256_MAX) {
    return null;
  }
  return prod;
}

export function checkedDivU256(a: bigint, b: bigint): bigint | null {
  if (a < 0n || b <= 0n || a > U256_MAX || b > U256_MAX) {
    return null;
  }
  return a / b;
}

export function checkedToU128(value: bigint): bigint | null {
  if (value < 0n || value > U128_MAX) {
    return null;
  }
  return value;
}

export function checkedSubU128(a: bigint, b: bigint): bigint | null {
  if (a < 0n || b < 0n || a > U128_MAX || b > U128_MAX || b > a) {
    return null;
  }
  return a - b;
}

/**
 * Evaluates V1 candidate arithmetic using checked U256 intermediates and U128 outputs.
 *
 * Preserves exact multiplication/division order without algebraic cancellation:
 *   G = floor(F * N / D)
 *   O = floor(F * N * (10000 - f) / (D * 10000))
 *   feeOut = G - O
 *   T = floor(O * (10000 - t) / 10000)
 *   M = max(T, userMinOut)
 */
export function computeCandidateAmounts(
  amountIn: bigint,
  rateNumerator: bigint,
  rateDenominator: bigint,
  feeBps: number,
  toleranceBps: number,
  userMinOut: bigint,
):
  | { readonly ok: true; readonly amounts: ComputedQuoteAmounts }
  | { readonly ok: false; readonly reason: CandidateRejectionReason } {
  if (
    !Number.isInteger(feeBps) ||
    feeBps < 0 ||
    feeBps > MAX_BPS ||
    !Number.isInteger(toleranceBps) ||
    toleranceBps < 0 ||
    toleranceBps > MAX_BPS ||
    amountIn < 0n ||
    amountIn > U128_MAX ||
    rateNumerator <= 0n ||
    rateNumerator > U128_MAX ||
    rateDenominator <= 0n ||
    rateDenominator > U128_MAX ||
    userMinOut < 0n ||
    userMinOut > U128_MAX
  ) {
    return { ok: false, reason: "ARITHMETIC_RANGE" };
  }

  // 1. Gross output: G = floor((F * N) / D)
  const fnProd = checkedMulU256(amountIn, rateNumerator);
  if (fnProd === null) {
    return { ok: false, reason: "ARITHMETIC_RANGE" };
  }
  const gross256 = checkedDivU256(fnProd, rateDenominator);
  if (gross256 === null) {
    return { ok: false, reason: "ARITHMETIC_RANGE" };
  }
  const grossOut = checkedToU128(gross256);
  if (grossOut === null) {
    return { ok: false, reason: "ARITHMETIC_RANGE" };
  }

  // 2. Expected output: O = floor((F * N * (10000 - f)) / (D * 10000))
  // Explicitly reject U256 overflow before division even if cancellation could fit.
  const feeKeep = BigInt(MAX_BPS - feeBps);
  const expectedNum = checkedMulU256(fnProd, feeKeep);
  if (expectedNum === null) {
    return { ok: false, reason: "ARITHMETIC_RANGE" };
  }
  const expectedDen = checkedMulU256(rateDenominator, BPS_DENOMINATOR_BIGINT);
  if (expectedDen === null) {
    return { ok: false, reason: "ARITHMETIC_RANGE" };
  }
  const expected256 = checkedDivU256(expectedNum, expectedDen);
  if (expected256 === null) {
    return { ok: false, reason: "ARITHMETIC_RANGE" };
  }
  const expectedOut = checkedToU128(expected256);
  if (expectedOut === null) {
    return { ok: false, reason: "ARITHMETIC_RANGE" };
  }

  // 3. Fee output: feeOut = G - O
  const feeOut = checkedSubU128(grossOut, expectedOut);
  if (feeOut === null) {
    return { ok: false, reason: "ARITHMETIC_RANGE" };
  }

  // 4. Tolerance-adjusted minimum: T = floor((O * (10000 - t)) / 10000)
  const tolKeep = BigInt(MAX_BPS - toleranceBps);
  const tolNum = checkedMulU256(expectedOut, tolKeep);
  if (tolNum === null) {
    return { ok: false, reason: "ARITHMETIC_RANGE" };
  }
  const tol256 = checkedDivU256(tolNum, BPS_DENOMINATOR_BIGINT);
  if (tol256 === null) {
    return { ok: false, reason: "ARITHMETIC_RANGE" };
  }
  const toleranceMinOut = checkedToU128(tol256);
  if (toleranceMinOut === null) {
    return { ok: false, reason: "ARITHMETIC_RANGE" };
  }

  // 5. Required minimum: M = max(T, userMinOut)
  const requiredMinOut =
    toleranceMinOut >= userMinOut ? toleranceMinOut : userMinOut;

  return {
    ok: true,
    amounts: {
      grossOut,
      expectedOut,
      feeOut,
      toleranceMinOut,
      requiredMinOut,
    },
  };
}
