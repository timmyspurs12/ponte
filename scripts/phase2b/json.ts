/**
 * Phase 2B.1 — Strict RFC-8259 float-free JSON wire codec for OptimizeRequestV1
 * and OptimizeOutcomeV1.
 *
 * Monetary and timestamp values are never parsed via floating-point numbers.
 */

import {
  assertCanonicalBytes32,
  parseCanonicalU64,
  parseCanonicalU128,
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
  type AssetIdV1,
  type CandidateV1,
  type OptimizeOutcomeV1,
  type OptimizeRequestV1,
  type OptimizeResultV1,
  type WireOptimizeRequestV1,
  type WireOptimizeResponseV1,
} from "./model";
import { optimizeV1 } from "./optimizer";

const MAX_JSON_DEPTH = 32;

const REQUEST_KEYS = [
  "version",
  "mode",
  "inputAsset",
  "outputAsset",
  "amountIn",
  "userMinOut",
  "toleranceBps",
  "asOfUnixSeconds",
  "expiresAtUnixSeconds",
  "snapshotId",
  "candidates",
] as const;

const ASSET_KEYS = ["namespace", "identifier", "decimals"] as const;

const CANDIDATE_KEYS = [
  "routeId",
  "snapshotId",
  "rateNumerator",
  "rateDenominator",
  "feeBps",
  "estimatedImpactBps",
  "minInput",
  "maxInput",
  "availableInput",
  "availableOutput",
  "executionCostUsdCents",
  "expiresAtUnixSeconds",
] as const;

type RawJsonValue =
  | { readonly kind: "null" }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "int"; readonly raw: string }
  | { readonly kind: "float"; readonly raw: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "array"; readonly items: readonly RawJsonValue[] }
  | {
      readonly kind: "object";
      readonly entries: ReadonlyMap<string, RawJsonValue>;
    };

class JsonCursor {
  private readonly text: string;
  private pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  parseRoot(): RawJsonValue {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.pos !== this.text.length) {
      throw new OptimizerValidationError("MALFORMED_JSON");
    }
    return value;
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        this.pos += 1;
      } else {
        break;
      }
    }
  }

  private parseValue(depth: number): RawJsonValue {
    if (depth > MAX_JSON_DEPTH || this.pos >= this.text.length) {
      throw new OptimizerValidationError("MALFORMED_JSON");
    }
    const ch = this.text.charCodeAt(this.pos);
    if (ch === 0x7b) {
      return this.parseObject(depth + 1);
    }
    if (ch === 0x5b) {
      return this.parseArray(depth + 1);
    }
    if (ch === 0x22) {
      return { kind: "string", value: this.parseString() };
    }
    if (ch === 0x74) {
      this.expectLiteral("true");
      return { kind: "bool", value: true };
    }
    if (ch === 0x66) {
      this.expectLiteral("false");
      return { kind: "bool", value: false };
    }
    if (ch === 0x6e) {
      this.expectLiteral("null");
      return { kind: "null" };
    }
    if (ch === 0x2d || (ch >= 0x30 && ch <= 0x39)) {
      return this.parseNumber();
    }
    throw new OptimizerValidationError("MALFORMED_JSON");
  }

  private expectLiteral(literal: string): void {
    if (!this.text.startsWith(literal, this.pos)) {
      throw new OptimizerValidationError("MALFORMED_JSON");
    }
    this.pos += literal.length;
  }

  private parseObject(depth: number): RawJsonValue {
    this.pos += 1; // '{'
    this.skipWhitespace();
    const entries = new Map<string, RawJsonValue>();
    if (this.pos < this.text.length && this.text.charCodeAt(this.pos) === 0x7d) {
      this.pos += 1;
      return { kind: "object", entries };
    }
    while (true) {
      this.skipWhitespace();
      if (this.pos >= this.text.length || this.text.charCodeAt(this.pos) !== 0x22) {
        throw new OptimizerValidationError("MALFORMED_JSON");
      }
      const key = this.parseString();
      if (entries.has(key)) {
        throw new OptimizerValidationError("MALFORMED_JSON");
      }
      this.skipWhitespace();
      if (this.pos >= this.text.length || this.text.charCodeAt(this.pos) !== 0x3a) {
        throw new OptimizerValidationError("MALFORMED_JSON");
      }
      this.pos += 1;
      this.skipWhitespace();
      const val = this.parseValue(depth);
      entries.set(key, val);
      this.skipWhitespace();
      if (this.pos >= this.text.length) {
        throw new OptimizerValidationError("MALFORMED_JSON");
      }
      const sep = this.text.charCodeAt(this.pos);
      if (sep === 0x7d) {
        this.pos += 1;
        return { kind: "object", entries };
      }
      if (sep !== 0x2c) {
        throw new OptimizerValidationError("MALFORMED_JSON");
      }
      this.pos += 1;
    }
  }

  private parseArray(depth: number): RawJsonValue {
    this.pos += 1; // '['
    this.skipWhitespace();
    const items: RawJsonValue[] = [];
    if (this.pos < this.text.length && this.text.charCodeAt(this.pos) === 0x5d) {
      this.pos += 1;
      return { kind: "array", items };
    }
    while (true) {
      this.skipWhitespace();
      items.push(this.parseValue(depth));
      this.skipWhitespace();
      if (this.pos >= this.text.length) {
        throw new OptimizerValidationError("MALFORMED_JSON");
      }
      const sep = this.text.charCodeAt(this.pos);
      if (sep === 0x5d) {
        this.pos += 1;
        return { kind: "array", items };
      }
      if (sep !== 0x2c) {
        throw new OptimizerValidationError("MALFORMED_JSON");
      }
      this.pos += 1;
    }
  }

  private parseString(): string {
    this.pos += 1; // opening '"'
    let out = "";
    while (this.pos < this.text.length) {
      const code = this.text.charCodeAt(this.pos);
      if (code === 0x22) {
        this.pos += 1;
        return out;
      }
      if (code < 0x20) {
        throw new OptimizerValidationError("MALFORMED_JSON");
      }
      if (code >= 0xd800 && code <= 0xdfff) {
        // Check for valid UTF-16 surrogate pair in source string
        if (code <= 0xdbff && this.pos + 1 < this.text.length) {
          const low = this.text.charCodeAt(this.pos + 1);
          if (low >= 0xdc00 && low <= 0xdfff) {
            out += this.text.slice(this.pos, this.pos + 2);
            this.pos += 2;
            continue;
          }
        }
        throw new OptimizerValidationError("MALFORMED_JSON");
      }
      if (code !== 0x5c) {
        out += this.text[this.pos];
        this.pos += 1;
        continue;
      }
      // Escape sequence
      this.pos += 1;
      if (this.pos >= this.text.length) {
        throw new OptimizerValidationError("MALFORMED_JSON");
      }
      const esc = this.text.charCodeAt(this.pos);
      this.pos += 1;
      switch (esc) {
        case 0x22:
          out += '"';
          break;
        case 0x5c:
          out += "\\";
          break;
        case 0x2f:
          out += "/";
          break;
        case 0x62:
          out += "\b";
          break;
        case 0x66:
          out += "\f";
          break;
        case 0x6e:
          out += "\n";
          break;
        case 0x72:
          out += "\r";
          break;
        case 0x74:
          out += "\t";
          break;
        case 0x75: {
          const high = this.readHexQuad();
          if (high >= 0xd800 && high <= 0xdbff) {
            if (
              this.pos + 1 >= this.text.length ||
              this.text.charCodeAt(this.pos) !== 0x5c ||
              this.text.charCodeAt(this.pos + 1) !== 0x75
            ) {
              throw new OptimizerValidationError("MALFORMED_JSON");
            }
            this.pos += 2;
            const low = this.readHexQuad();
            if (low < 0xdc00 || low > 0xdfff) {
              throw new OptimizerValidationError("MALFORMED_JSON");
            }
            const cp = 0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00);
            out += String.fromCodePoint(cp);
          } else if (high >= 0xdc00 && high <= 0xdfff) {
            throw new OptimizerValidationError("MALFORMED_JSON");
          } else {
            out += String.fromCharCode(high);
          }
          break;
        }
        default:
          throw new OptimizerValidationError("MALFORMED_JSON");
      }
    }
    throw new OptimizerValidationError("MALFORMED_JSON");
  }

  private readHexQuad(): number {
    if (this.pos + 4 > this.text.length) {
      throw new OptimizerValidationError("MALFORMED_JSON");
    }
    let val = 0;
    for (let i = 0; i < 4; i += 1) {
      const c = this.text.charCodeAt(this.pos + i);
      let nibble: number;
      if (c >= 0x30 && c <= 0x39) {
        nibble = c - 0x30;
      } else if (c >= 0x61 && c <= 0x66) {
        nibble = c - 0x61 + 10;
      } else if (c >= 0x41 && c <= 0x46) {
        nibble = c - 0x41 + 10;
      } else {
        throw new OptimizerValidationError("MALFORMED_JSON");
      }
      val = (val << 4) | nibble;
    }
    this.pos += 4;
    return val;
  }

  private parseNumber(): RawJsonValue {
    const start = this.pos;
    if (this.text.charCodeAt(this.pos) === 0x2d) {
      this.pos += 1;
      if (this.pos >= this.text.length) {
        throw new OptimizerValidationError("MALFORMED_JSON");
      }
    }
    const firstDigit = this.text.charCodeAt(this.pos);
    if (firstDigit === 0x30) {
      this.pos += 1;
    } else if (firstDigit >= 0x31 && firstDigit <= 0x39) {
      this.pos += 1;
      while (this.pos < this.text.length) {
        const d = this.text.charCodeAt(this.pos);
        if (d >= 0x30 && d <= 0x39) {
          this.pos += 1;
        } else {
          break;
        }
      }
    } else {
      throw new OptimizerValidationError("MALFORMED_JSON");
    }

    let isFloat = false;
    if (this.pos < this.text.length && this.text.charCodeAt(this.pos) === 0x2e) {
      isFloat = true;
      this.pos += 1;
      let fracDigits = 0;
      while (this.pos < this.text.length) {
        const d = this.text.charCodeAt(this.pos);
        if (d >= 0x30 && d <= 0x39) {
          this.pos += 1;
          fracDigits += 1;
        } else {
          break;
        }
      }
      if (fracDigits === 0) {
        throw new OptimizerValidationError("MALFORMED_JSON");
      }
    }

    if (this.pos < this.text.length) {
      const e = this.text.charCodeAt(this.pos);
      if (e === 0x65 || e === 0x45) {
        isFloat = true;
        this.pos += 1;
        if (this.pos < this.text.length) {
          const sign = this.text.charCodeAt(this.pos);
          if (sign === 0x2b || sign === 0x2d) {
            this.pos += 1;
          }
        }
        let expDigits = 0;
        while (this.pos < this.text.length) {
          const d = this.text.charCodeAt(this.pos);
          if (d >= 0x30 && d <= 0x39) {
            this.pos += 1;
            expDigits += 1;
          } else {
            break;
          }
        }
        if (expDigits === 0) {
          throw new OptimizerValidationError("MALFORMED_JSON");
        }
      }
    }

    const raw = this.text.slice(start, this.pos);
    return isFloat ? { kind: "float", raw } : { kind: "int", raw };
  }
}

function expectExactObjectKeys(
  val: RawJsonValue,
  expectedKeys: readonly string[],
): ReadonlyMap<string, RawJsonValue> {
  if (val.kind !== "object" || val.entries.size !== expectedKeys.length) {
    throw new OptimizerValidationError("INVALID_REQUEST_SHAPE");
  }
  for (const key of expectedKeys) {
    if (!val.entries.has(key)) {
      throw new OptimizerValidationError("INVALID_REQUEST_SHAPE");
    }
  }
  return val.entries;
}

function parseBoundedSmallInt(val: RawJsonValue, maxVal: number): number | null {
  if (val.kind !== "int") {
    return null;
  }
  if (val.raw.charCodeAt(0) === 0x2d) {
    return null;
  }
  let acc = 0;
  for (let i = 0; i < val.raw.length; i += 1) {
    acc = acc * 10 + (val.raw.charCodeAt(i) - 0x30);
    if (acc > maxVal) {
      return null;
    }
  }
  return acc;
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

function parseAssetJson(val: RawJsonValue): AssetIdV1 {
  const obj = expectExactObjectKeys(val, ASSET_KEYS);
  const nsVal = obj.get("namespace")!;
  const idVal = obj.get("identifier")!;
  const decVal = obj.get("decimals")!;

  if (
    nsVal.kind !== "string" ||
    idVal.kind !== "string" ||
    !isValidAsciiIdentifier(nsVal.value) ||
    !isValidAsciiIdentifier(idVal.value)
  ) {
    throw new OptimizerValidationError("INVALID_ASSET");
  }

  const decimals = parseBoundedSmallInt(decVal, MAX_ASSET_DECIMALS);
  if (decimals === null) {
    throw new OptimizerValidationError("INVALID_ASSET_DECIMALS");
  }

  return {
    namespace: nsVal.value,
    identifier: idVal.value,
    decimals,
  };
}

function parseU128Field(val: RawJsonValue): bigint {
  if (val.kind !== "string") {
    throw new OptimizerValidationError("INVALID_INTEGER_ENCODING");
  }
  return parseCanonicalU128(val.value);
}

function parseU64Field(val: RawJsonValue): bigint {
  if (val.kind !== "string") {
    throw new OptimizerValidationError("INVALID_INTEGER_ENCODING");
  }
  return parseCanonicalU64(val.value);
}

function parseBytes32Field(val: RawJsonValue): string {
  if (val.kind !== "string") {
    throw new OptimizerValidationError("INVALID_BYTES32");
  }
  return assertCanonicalBytes32(val.value);
}

function parseBpsField(val: RawJsonValue): number {
  const parsed = parseBoundedSmallInt(val, MAX_BPS);
  if (parsed === null) {
    throw new OptimizerValidationError("INVALID_BPS");
  }
  return parsed;
}

function parseCandidateJson(val: RawJsonValue): CandidateV1 {
  const obj = expectExactObjectKeys(val, CANDIDATE_KEYS);
  const routeId = parseBytes32Field(obj.get("routeId")!);
  const snapshotId = parseBytes32Field(obj.get("snapshotId")!);
  const rateNumerator = parseU128Field(obj.get("rateNumerator")!);
  const rateDenominator = parseU128Field(obj.get("rateDenominator")!);
  const feeBps = parseBpsField(obj.get("feeBps")!);
  const estimatedImpactBps = parseBpsField(obj.get("estimatedImpactBps")!);
  const minInput = parseU128Field(obj.get("minInput")!);
  const maxInput = parseU128Field(obj.get("maxInput")!);
  const availableInput = parseU128Field(obj.get("availableInput")!);
  const availableOutput = parseU128Field(obj.get("availableOutput")!);
  const executionCostUsdCents = parseU128Field(obj.get("executionCostUsdCents")!);
  const expiresAtUnixSeconds = parseU64Field(obj.get("expiresAtUnixSeconds")!);

  return {
    routeId,
    snapshotId,
    rateNumerator,
    rateDenominator,
    feeBps,
    estimatedImpactBps,
    minInput,
    maxInput,
    availableInput,
    availableOutput,
    executionCostUsdCents,
    expiresAtUnixSeconds,
  };
}

/**
 * Parses a raw JSON request string into a validated OptimizeRequestV1 structure
 * (before domain cross-candidate checks in optimizeV1).
 */
export function parseRequestV1Json(rawJson: string): OptimizeRequestV1 {
  const root = new JsonCursor(rawJson).parseRoot();
  const obj = expectExactObjectKeys(root, REQUEST_KEYS);

  const versionVal = obj.get("version")!;
  if (versionVal.kind !== "int" || versionVal.raw !== String(OPTIMIZER_VERSION_V1)) {
    throw new OptimizerValidationError("UNSUPPORTED_VERSION");
  }

  const modeVal = obj.get("mode")!;
  if (modeVal.kind !== "string" || modeVal.value !== OPTIMIZER_MODE_SYNTHETIC) {
    throw new OptimizerValidationError("UNSUPPORTED_MODE");
  }

  const inputAsset = parseAssetJson(obj.get("inputAsset")!);
  const outputAsset = parseAssetJson(obj.get("outputAsset")!);
  if (
    inputAsset.namespace === outputAsset.namespace &&
    inputAsset.identifier === outputAsset.identifier
  ) {
    throw new OptimizerValidationError("INVALID_ASSET");
  }

  const amountIn = parseU128Field(obj.get("amountIn")!);
  if (amountIn === 0n) {
    throw new OptimizerValidationError("INVALID_AMOUNT_IN");
  }

  const userMinOut = parseU128Field(obj.get("userMinOut")!);
  const toleranceBps = parseBpsField(obj.get("toleranceBps")!);
  const asOfUnixSeconds = parseU64Field(obj.get("asOfUnixSeconds")!);
  const expiresAtUnixSeconds = parseU64Field(obj.get("expiresAtUnixSeconds")!);
  if (asOfUnixSeconds >= expiresAtUnixSeconds) {
    throw new OptimizerValidationError("INVALID_REQUEST_EXPIRY");
  }

  const snapshotId = parseBytes32Field(obj.get("snapshotId")!);

  const candidatesVal = obj.get("candidates")!;
  if (candidatesVal.kind !== "array") {
    throw new OptimizerValidationError("INVALID_REQUEST_SHAPE");
  }
  if (
    candidatesVal.items.length < MIN_CANDIDATES ||
    candidatesVal.items.length > MAX_CANDIDATES
  ) {
    throw new OptimizerValidationError("INVALID_CANDIDATE_COUNT");
  }

  const candidates = candidatesVal.items.map(parseCandidateJson);

  return {
    version: OPTIMIZER_VERSION_V1,
    mode: OPTIMIZER_MODE_SYNTHETIC,
    inputAsset,
    outputAsset,
    amountIn,
    userMinOut,
    toleranceBps,
    asOfUnixSeconds,
    expiresAtUnixSeconds,
    snapshotId,
    candidates,
  };
}

export function toWireResponse(result: OptimizeResultV1): WireOptimizeResponseV1 {
  if (!result.ok) {
    return {
      status: "ERROR",
      error: {
        code: result.error.code,
        message: result.error.message,
      },
    };
  }
  const outcome: OptimizeOutcomeV1 = result.value;
  if (outcome.status === "NO_ROUTE") {
    return {
      status: "NO_ROUTE",
      amountIn: outcome.amountIn.toString(),
      snapshotId: outcome.snapshotId,
      evaluatedCount: outcome.evaluatedCount,
      rejected: outcome.rejected,
    };
  }
  return {
    status: "SELECTED",
    selectedRouteId: outcome.selectedRouteId,
    amountIn: outcome.amountIn.toString(),
    grossOut: outcome.grossOut.toString(),
    feeOut: outcome.feeOut.toString(),
    expectedOut: outcome.expectedOut.toString(),
    minimumOut: outcome.minimumOut.toString(),
    executionCostUsdCents: outcome.executionCostUsdCents.toString(),
    effectiveExpiry: outcome.effectiveExpiry.toString(),
    snapshotId: outcome.snapshotId,
    evaluatedCount: outcome.evaluatedCount,
    rejected: outcome.rejected,
  };
}

function escapeJsonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x22) {
      out += '\\"';
    } else if (code === 0x5c) {
      out += "\\\\";
    } else if (code === 0x08) {
      out += "\\b";
    } else if (code === 0x0c) {
      out += "\\f";
    } else if (code === 0x0a) {
      out += "\\n";
    } else if (code === 0x0d) {
      out += "\\r";
    } else if (code === 0x09) {
      out += "\\t";
    } else if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += value[i];
    }
  }
  out += '"';
  return out;
}

/**
 * Serializes a WireOptimizeResponseV1 to deterministic single-line JSON
 * with exact key ordering matching the Rust optimizer-v1 runner.
 */
export function serializeWireResponse(response: WireOptimizeResponseV1): string {
  if (response.status === "ERROR") {
    return `{"status":"ERROR","error":{"code":${escapeJsonString(response.error.code)},"message":${escapeJsonString(response.error.message)}}}`;
  }
  const rejectedJson = `[${response.rejected
    .map(
      (r) =>
        `{"routeId":${escapeJsonString(r.routeId)},"reason":${escapeJsonString(r.reason)}}`,
    )
    .join(",")}]`;

  if (response.status === "NO_ROUTE") {
    return `{"status":"NO_ROUTE","amountIn":${escapeJsonString(response.amountIn)},"snapshotId":${escapeJsonString(response.snapshotId)},"evaluatedCount":${response.evaluatedCount},"rejected":${rejectedJson}}`;
  }

  return (
    `{"status":"SELECTED","selectedRouteId":${escapeJsonString(response.selectedRouteId)},` +
    `"amountIn":${escapeJsonString(response.amountIn)},` +
    `"grossOut":${escapeJsonString(response.grossOut)},` +
    `"feeOut":${escapeJsonString(response.feeOut)},` +
    `"expectedOut":${escapeJsonString(response.expectedOut)},` +
    `"minimumOut":${escapeJsonString(response.minimumOut)},` +
    `"executionCostUsdCents":${escapeJsonString(response.executionCostUsdCents)},` +
    `"effectiveExpiry":${escapeJsonString(response.effectiveExpiry)},` +
    `"snapshotId":${escapeJsonString(response.snapshotId)},` +
    `"evaluatedCount":${response.evaluatedCount},` +
    `"rejected":${rejectedJson}}`
  );
}

/**
 * Evaluates a single raw JSON line using the TypeScript V1 reference.
 */
export function evaluateJsonLine(rawLine: string): {
  readonly response: WireOptimizeResponseV1;
  readonly canonicalJson: string;
} {
  let result: OptimizeResultV1;
  try {
    const request = parseRequestV1Json(rawLine);
    result = optimizeV1(request);
  } catch (err) {
    if (err instanceof OptimizerValidationError) {
      result = {
        ok: false,
        error: {
          code: err.code,
          message: ERROR_MESSAGES[err.code],
        },
      };
    } else {
      throw err;
    }
  }
  const response = toWireResponse(result);
  return {
    response,
    canonicalJson: serializeWireResponse(response),
  };
}

/**
 * Serializes a valid WireOptimizeRequestV1 to a single canonical JSON line.
 */
export function serializeWireRequest(req: WireOptimizeRequestV1): string {
  return JSON.stringify(req);
}
