//! Pure `no_std + alloc` RFC-8259 float-free JSON codec for Optimizer V1 wire lines.
//!
//! Monetary and timestamp values are parsed strictly from canonical base-10 strings
//! without any floating-point deserialization.

use crate::{
    arithmetic::{
        format_bytes32, parse_canonical_bytes32, parse_canonical_u128, parse_canonical_u64,
    },
    model::{
        AssetIdV1, CandidateV1, MAX_ASSET_DECIMALS, MAX_ASSET_FIELD_LEN, MAX_BPS,
        MAX_CANDIDATES, MIN_CANDIDATES, OPTIMIZER_VERSION_V1, OptimizeOutcomeV1,
        OptimizeRequestV1, OptimizerError, OptimizerMode, RejectedCandidateV1,
    },
    optimizer::optimize_v1,
};
use alloc::{
    collections::BTreeMap,
    format,
    string::{String, ToString},
    vec::Vec,
};

const MAX_JSON_DEPTH: usize = 32;

const REQUEST_KEYS: [&str; 11] = [
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
];

const ASSET_KEYS: [&str; 3] = ["namespace", "identifier", "decimals"];

const CANDIDATE_KEYS: [&str; 12] = [
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
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RawJsonValue {
    Null,
    Bool(bool),
    Int(String),
    Float(String),
    String(String),
    Array(Vec<RawJsonValue>),
    Object(BTreeMap<String, RawJsonValue>),
}

struct JsonCursor<'a> {
    bytes: &'a [u8],
    src: &'a str,
    pos: usize,
}

impl<'a> JsonCursor<'a> {
    fn new(src: &'a str) -> Self {
        Self {
            bytes: src.as_bytes(),
            src,
            pos: 0,
        }
    }

    fn parse_root(&mut self) -> Result<RawJsonValue, OptimizerError> {
        self.skip_whitespace();
        let val = self.parse_value(0)?;
        self.skip_whitespace();
        if self.pos != self.bytes.len() {
            return Err(OptimizerError::MalformedJson);
        }
        Ok(val)
    }

    fn skip_whitespace(&mut self) {
        while self.pos < self.bytes.len() {
            match self.bytes[self.pos] {
                b' ' | b'\t' | b'\n' | b'\r' => self.pos += 1,
                _ => break,
            }
        }
    }

    fn parse_value(&mut self, depth: usize) -> Result<RawJsonValue, OptimizerError> {
        if depth > MAX_JSON_DEPTH || self.pos >= self.bytes.len() {
            return Err(OptimizerError::MalformedJson);
        }
        match self.bytes[self.pos] {
            b'{' => self.parse_object(depth + 1),
            b'[' => self.parse_array(depth + 1),
            b'"' => Ok(RawJsonValue::String(self.parse_string()?)),
            b't' => {
                self.expect_literal(b"true")?;
                Ok(RawJsonValue::Bool(true))
            }
            b'f' => {
                self.expect_literal(b"false")?;
                Ok(RawJsonValue::Bool(false))
            }
            b'n' => {
                self.expect_literal(b"null")?;
                Ok(RawJsonValue::Null)
            }
            b'-' | b'0'..=b'9' => self.parse_number(),
            _ => Err(OptimizerError::MalformedJson),
        }
    }

    fn expect_literal(&mut self, lit: &[u8]) -> Result<(), OptimizerError> {
        if self.bytes.get(self.pos..self.pos + lit.len()) != Some(lit) {
            return Err(OptimizerError::MalformedJson);
        }
        self.pos += lit.len();
        Ok(())
    }

    fn parse_object(&mut self, depth: usize) -> Result<RawJsonValue, OptimizerError> {
        self.pos += 1; // '{'
        self.skip_whitespace();
        let mut entries = BTreeMap::new();
        if self.pos < self.bytes.len() && self.bytes[self.pos] == b'}' {
            self.pos += 1;
            return Ok(RawJsonValue::Object(entries));
        }
        loop {
            self.skip_whitespace();
            if self.pos >= self.bytes.len() || self.bytes[self.pos] != b'"' {
                return Err(OptimizerError::MalformedJson);
            }
            let key = self.parse_string()?;
            if entries.contains_key(&key) {
                return Err(OptimizerError::MalformedJson);
            }
            self.skip_whitespace();
            if self.pos >= self.bytes.len() || self.bytes[self.pos] != b':' {
                return Err(OptimizerError::MalformedJson);
            }
            self.pos += 1;
            self.skip_whitespace();
            let value = self.parse_value(depth)?;
            entries.insert(key, value);
            self.skip_whitespace();
            if self.pos >= self.bytes.len() {
                return Err(OptimizerError::MalformedJson);
            }
            match self.bytes[self.pos] {
                b'}' => {
                    self.pos += 1;
                    return Ok(RawJsonValue::Object(entries));
                }
                b',' => self.pos += 1,
                _ => return Err(OptimizerError::MalformedJson),
            }
        }
    }

    fn parse_array(&mut self, depth: usize) -> Result<RawJsonValue, OptimizerError> {
        self.pos += 1; // '['
        self.skip_whitespace();
        let mut items = Vec::new();
        if self.pos < self.bytes.len() && self.bytes[self.pos] == b']' {
            self.pos += 1;
            return Ok(RawJsonValue::Array(items));
        }
        loop {
            self.skip_whitespace();
            items.push(self.parse_value(depth)?);
            self.skip_whitespace();
            if self.pos >= self.bytes.len() {
                return Err(OptimizerError::MalformedJson);
            }
            match self.bytes[self.pos] {
                b']' => {
                    self.pos += 1;
                    return Ok(RawJsonValue::Array(items));
                }
                b',' => self.pos += 1,
                _ => return Err(OptimizerError::MalformedJson),
            }
        }
    }

    fn parse_string(&mut self) -> Result<String, OptimizerError> {
        self.pos += 1; // '"'
        let mut out = String::new();
        while self.pos < self.bytes.len() {
            let b = self.bytes[self.pos];
            if b == b'"' {
                self.pos += 1;
                return Ok(out);
            }
            if b < 0x20 {
                return Err(OptimizerError::MalformedJson);
            }
            if b != b'\\' {
                let tail = self
                    .src
                    .get(self.pos..)
                    .ok_or(OptimizerError::MalformedJson)?;
                let ch = tail.chars().next().ok_or(OptimizerError::MalformedJson)?;
                out.push(ch);
                self.pos += ch.len_utf8();
                continue;
            }
            self.pos += 1; // '\\'
            if self.pos >= self.bytes.len() {
                return Err(OptimizerError::MalformedJson);
            }
            let esc = self.bytes[self.pos];
            self.pos += 1;
            match esc {
                b'"' => out.push('"'),
                b'\\' => out.push('\\'),
                b'/' => out.push('/'),
                b'b' => out.push('\u{0008}'),
                b'f' => out.push('\u{000c}'),
                b'n' => out.push('\n'),
                b'r' => out.push('\r'),
                b't' => out.push('\t'),
                b'u' => {
                    let high = self.read_hex_quad()?;
                    if (0xd800..=0xdbff).contains(&high) {
                        if self.bytes.get(self.pos..self.pos + 2) != Some(b"\\u") {
                            return Err(OptimizerError::MalformedJson);
                        }
                        self.pos += 2;
                        let low = self.read_hex_quad()?;
                        if !(0xdc00..=0xdfff).contains(&low) {
                            return Err(OptimizerError::MalformedJson);
                        }
                        let cp = 0x1_0000
                            + ((u32::from(high - 0xd800)) << 10)
                            + u32::from(low - 0xdc00);
                        let ch =
                            char::from_u32(cp).ok_or(OptimizerError::MalformedJson)?;
                        out.push(ch);
                    } else if (0xdc00..=0xdfff).contains(&high) {
                        return Err(OptimizerError::MalformedJson);
                    } else {
                        let ch = char::from_u32(u32::from(high))
                            .ok_or(OptimizerError::MalformedJson)?;
                        out.push(ch);
                    }
                }
                _ => return Err(OptimizerError::MalformedJson),
            }
        }
        Err(OptimizerError::MalformedJson)
    }

    fn read_hex_quad(&mut self) -> Result<u16, OptimizerError> {
        let slice = self
            .bytes
            .get(self.pos..self.pos + 4)
            .ok_or(OptimizerError::MalformedJson)?;
        let mut val: u16 = 0;
        for &b in slice {
            let nibble = match b {
                b'0'..=b'9' => u16::from(b - b'0'),
                b'a'..=b'f' => u16::from(b - b'a' + 10),
                b'A'..=b'F' => u16::from(b - b'A' + 10),
                _ => return Err(OptimizerError::MalformedJson),
            };
            val = (val << 4) | nibble;
        }
        self.pos += 4;
        Ok(val)
    }

    fn parse_number(&mut self) -> Result<RawJsonValue, OptimizerError> {
        let start = self.pos;
        if self.bytes[self.pos] == b'-' {
            self.pos += 1;
            if self.pos >= self.bytes.len() {
                return Err(OptimizerError::MalformedJson);
            }
        }
        match self.bytes[self.pos] {
            b'0' => self.pos += 1,
            b'1'..=b'9' => {
                self.pos += 1;
                while self.pos < self.bytes.len()
                    && self.bytes[self.pos].is_ascii_digit()
                {
                    self.pos += 1;
                }
            }
            _ => return Err(OptimizerError::MalformedJson),
        }

        let mut is_float = false;
        if self.pos < self.bytes.len() && self.bytes[self.pos] == b'.' {
            is_float = true;
            self.pos += 1;
            let mut frac_digits = 0usize;
            while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_digit() {
                self.pos += 1;
                frac_digits += 1;
            }
            if frac_digits == 0 {
                return Err(OptimizerError::MalformedJson);
            }
        }

        if self.pos < self.bytes.len()
            && matches!(self.bytes[self.pos], b'e' | b'E')
        {
            is_float = true;
            self.pos += 1;
            if self.pos < self.bytes.len()
                && matches!(self.bytes[self.pos], b'+' | b'-')
            {
                self.pos += 1;
            }
            let mut exp_digits = 0usize;
            while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_digit() {
                self.pos += 1;
                exp_digits += 1;
            }
            if exp_digits == 0 {
                return Err(OptimizerError::MalformedJson);
            }
        }

        let raw = self
            .src
            .get(start..self.pos)
            .ok_or(OptimizerError::MalformedJson)?
            .to_string();
        if is_float {
            Ok(RawJsonValue::Float(raw))
        } else {
            Ok(RawJsonValue::Int(raw))
        }
    }
}

pub fn parse_raw_json(input: &str) -> Result<RawJsonValue, OptimizerError> {
    JsonCursor::new(input).parse_root()
}

fn expect_exact_object<'a>(
    val: &'a RawJsonValue,
    expected_keys: &[&str],
) -> Result<&'a BTreeMap<String, RawJsonValue>, OptimizerError> {
    let RawJsonValue::Object(map) = val else {
        return Err(OptimizerError::InvalidRequestShape);
    };
    if map.len() != expected_keys.len() {
        return Err(OptimizerError::InvalidRequestShape);
    }
    for &key in expected_keys {
        if !map.contains_key(key) {
            return Err(OptimizerError::InvalidRequestShape);
        }
    }
    Ok(map)
}

fn parse_bounded_u16(val: &RawJsonValue, max_val: u16) -> Option<u16> {
    let RawJsonValue::Int(raw) = val else {
        return None;
    };
    let bytes = raw.as_bytes();
    if bytes.is_empty() || bytes[0] == b'-' {
        return None;
    }
    let mut acc: u16 = 0;
    for &b in bytes {
        let digit = u16::from(b - b'0');
        acc = acc.checked_mul(10)?.checked_add(digit)?;
        if acc > max_val {
            return None;
        }
    }
    Some(acc)
}

fn is_valid_ascii_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_ASSET_FIELD_LEN {
        return false;
    }
    bytes.iter().all(|&b| (0x21..=0x7e).contains(&b))
}

fn parse_asset_json(val: &RawJsonValue) -> Result<AssetIdV1, OptimizerError> {
    let obj = expect_exact_object(val, &ASSET_KEYS)?;
    let ns_val = obj
        .get("namespace")
        .ok_or(OptimizerError::InvalidRequestShape)?;
    let id_val = obj
        .get("identifier")
        .ok_or(OptimizerError::InvalidRequestShape)?;
    let dec_val = obj
        .get("decimals")
        .ok_or(OptimizerError::InvalidRequestShape)?;

    let (RawJsonValue::String(ns), RawJsonValue::String(id)) = (ns_val, id_val) else {
        return Err(OptimizerError::InvalidAsset);
    };
    if !is_valid_ascii_identifier(ns) || !is_valid_ascii_identifier(id) {
        return Err(OptimizerError::InvalidAsset);
    }

    let decimals_u16 = parse_bounded_u16(dec_val, u16::from(MAX_ASSET_DECIMALS))
        .ok_or(OptimizerError::InvalidAssetDecimals)?;
    let decimals =
        u8::try_from(decimals_u16).map_err(|_| OptimizerError::InvalidAssetDecimals)?;

    Ok(AssetIdV1 {
        namespace: ns.clone(),
        identifier: id.clone(),
        decimals,
    })
}

fn parse_u128_field(val: &RawJsonValue) -> Result<u128, OptimizerError> {
    let RawJsonValue::String(s) = val else {
        return Err(OptimizerError::InvalidIntegerEncoding);
    };
    parse_canonical_u128(s)
}

fn parse_u64_field(val: &RawJsonValue) -> Result<u64, OptimizerError> {
    let RawJsonValue::String(s) = val else {
        return Err(OptimizerError::InvalidIntegerEncoding);
    };
    parse_canonical_u64(s)
}

fn parse_bytes32_field(
    val: &RawJsonValue,
) -> Result<alloy_primitives::B256, OptimizerError> {
    let RawJsonValue::String(s) = val else {
        return Err(OptimizerError::InvalidBytes32);
    };
    parse_canonical_bytes32(s)
}

fn parse_bps_field(val: &RawJsonValue) -> Result<u16, OptimizerError> {
    parse_bounded_u16(val, MAX_BPS).ok_or(OptimizerError::InvalidBps)
}

fn parse_candidate_json(val: &RawJsonValue) -> Result<CandidateV1, OptimizerError> {
    let obj = expect_exact_object(val, &CANDIDATE_KEYS)?;
    let route_id = parse_bytes32_field(&obj["routeId"])?;
    let snapshot_id = parse_bytes32_field(&obj["snapshotId"])?;
    let rate_numerator = parse_u128_field(&obj["rateNumerator"])?;
    let rate_denominator = parse_u128_field(&obj["rateDenominator"])?;
    let fee_bps = parse_bps_field(&obj["feeBps"])?;
    let estimated_impact_bps = parse_bps_field(&obj["estimatedImpactBps"])?;
    let min_input = parse_u128_field(&obj["minInput"])?;
    let max_input = parse_u128_field(&obj["maxInput"])?;
    let available_input = parse_u128_field(&obj["availableInput"])?;
    let available_output = parse_u128_field(&obj["availableOutput"])?;
    let execution_cost_usd_cents = parse_u128_field(&obj["executionCostUsdCents"])?;
    let expires_at_unix_seconds = parse_u64_field(&obj["expiresAtUnixSeconds"])?;

    Ok(CandidateV1 {
        route_id,
        snapshot_id,
        rate_numerator,
        rate_denominator,
        fee_bps,
        estimated_impact_bps,
        min_input,
        max_input,
        available_input,
        available_output,
        execution_cost_usd_cents,
        expires_at_unix_seconds,
    })
}

/// Parses a raw JSON request line into `OptimizeRequestV1`.
pub fn parse_request_v1_json(raw_json: &str) -> Result<OptimizeRequestV1, OptimizerError> {
    let root = parse_raw_json(raw_json)?;
    let obj = expect_exact_object(&root, &REQUEST_KEYS)?;

    match &obj["version"] {
        RawJsonValue::Int(raw) if raw == "1" => {}
        _ => return Err(OptimizerError::UnsupportedVersion),
    }

    match &obj["mode"] {
        RawJsonValue::String(s) if s == "SYNTHETIC" => {}
        _ => return Err(OptimizerError::UnsupportedMode),
    }

    let input_asset = parse_asset_json(&obj["inputAsset"])?;
    let output_asset = parse_asset_json(&obj["outputAsset"])?;
    if input_asset.namespace == output_asset.namespace
        && input_asset.identifier == output_asset.identifier
    {
        return Err(OptimizerError::InvalidAsset);
    }

    let amount_in = parse_u128_field(&obj["amountIn"])?;
    if amount_in == 0 {
        return Err(OptimizerError::InvalidAmountIn);
    }

    let user_min_out = parse_u128_field(&obj["userMinOut"])?;
    let tolerance_bps = parse_bps_field(&obj["toleranceBps"])?;
    let as_of_unix_seconds = parse_u64_field(&obj["asOfUnixSeconds"])?;
    let expires_at_unix_seconds = parse_u64_field(&obj["expiresAtUnixSeconds"])?;
    if as_of_unix_seconds >= expires_at_unix_seconds {
        return Err(OptimizerError::InvalidRequestExpiry);
    }

    let snapshot_id = parse_bytes32_field(&obj["snapshotId"])?;

    let RawJsonValue::Array(items) = &obj["candidates"] else {
        return Err(OptimizerError::InvalidRequestShape);
    };
    if !(MIN_CANDIDATES..=MAX_CANDIDATES).contains(&items.len()) {
        return Err(OptimizerError::InvalidCandidateCount);
    }

    let mut candidates = Vec::with_capacity(items.len());
    for item in items {
        candidates.push(parse_candidate_json(item)?);
    }

    Ok(OptimizeRequestV1 {
        version: OPTIMIZER_VERSION_V1,
        mode: OptimizerMode::Synthetic,
        input_asset,
        output_asset,
        amount_in,
        user_min_out,
        tolerance_bps,
        as_of_unix_seconds,
        expires_at_unix_seconds,
        snapshot_id,
        candidates,
    })
}

fn push_escaped_json_str(buf: &mut String, s: &str) {
    buf.push('"');
    for ch in s.chars() {
        match ch {
            '"' => buf.push_str("\\\""),
            '\\' => buf.push_str("\\\\"),
            '\u{0008}' => buf.push_str("\\b"),
            '\u{000c}' => buf.push_str("\\f"),
            '\n' => buf.push_str("\\n"),
            '\r' => buf.push_str("\\r"),
            '\t' => buf.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                buf.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => buf.push(c),
        }
    }
    buf.push('"');
}

fn push_rejected_json(buf: &mut String, rejected: &[RejectedCandidateV1]) {
    buf.push('[');
    for (idx, item) in rejected.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        buf.push_str("{\"routeId\":");
        push_escaped_json_str(buf, &format_bytes32(&item.route_id));
        buf.push_str(",\"reason\":");
        push_escaped_json_str(buf, item.reason.as_str());
        buf.push('}');
    }
    buf.push(']');
}

/// Formats an `OptimizeOutcomeV1` or `OptimizerError` as a single canonical JSON line.
pub fn format_result_v1_json(
    result: &Result<OptimizeOutcomeV1, OptimizerError>,
) -> String {
    let mut out = String::with_capacity(256);
    match result {
        Err(err) => {
            out.push_str("{\"status\":\"ERROR\",\"error\":{\"code\":");
            push_escaped_json_str(&mut out, err.code());
            out.push_str(",\"message\":");
            push_escaped_json_str(&mut out, err.message());
            out.push_str("}}");
        }
        Ok(OptimizeOutcomeV1::NoRoute(no_route)) => {
            out.push_str("{\"status\":\"NO_ROUTE\",\"amountIn\":");
            push_escaped_json_str(&mut out, &no_route.amount_in.to_string());
            out.push_str(",\"snapshotId\":");
            push_escaped_json_str(&mut out, &format_bytes32(&no_route.snapshot_id));
            out.push_str(",\"evaluatedCount\":");
            out.push_str(&no_route.evaluated_count.to_string());
            out.push_str(",\"rejected\":");
            push_rejected_json(&mut out, &no_route.rejected);
            out.push('}');
        }
        Ok(OptimizeOutcomeV1::Selected(sel)) => {
            out.push_str("{\"status\":\"SELECTED\",\"selectedRouteId\":");
            push_escaped_json_str(&mut out, &format_bytes32(&sel.selected_route_id));
            out.push_str(",\"amountIn\":");
            push_escaped_json_str(&mut out, &sel.amount_in.to_string());
            out.push_str(",\"grossOut\":");
            push_escaped_json_str(&mut out, &sel.gross_out.to_string());
            out.push_str(",\"feeOut\":");
            push_escaped_json_str(&mut out, &sel.fee_out.to_string());
            out.push_str(",\"expectedOut\":");
            push_escaped_json_str(&mut out, &sel.expected_out.to_string());
            out.push_str(",\"minimumOut\":");
            push_escaped_json_str(&mut out, &sel.minimum_out.to_string());
            out.push_str(",\"executionCostUsdCents\":");
            push_escaped_json_str(&mut out, &sel.execution_cost_usd_cents.to_string());
            out.push_str(",\"effectiveExpiry\":");
            push_escaped_json_str(&mut out, &sel.effective_expiry.to_string());
            out.push_str(",\"snapshotId\":");
            push_escaped_json_str(&mut out, &format_bytes32(&sel.snapshot_id));
            out.push_str(",\"evaluatedCount\":");
            out.push_str(&sel.evaluated_count.to_string());
            out.push_str(",\"rejected\":");
            push_rejected_json(&mut out, &sel.rejected);
            out.push('}');
        }
    }
    out
}

/// Evaluates one raw JSON request line and returns one canonical JSON response line.
pub fn evaluate_json_line(raw_line: &str) -> String {
    let outcome = parse_request_v1_json(raw_line).and_then(|req| optimize_v1(&req));
    format_result_v1_json(&outcome)
}
