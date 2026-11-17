//! Checked integer conversions, canonical parsing, and U256 quote arithmetic.

use crate::model::{CandidateRejectionReason, OptimizerError, BPS_DENOMINATOR, MAX_BPS};
use alloc::string::String;
use alloy_primitives::{B256, U256};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ComputedQuoteAmounts {
    pub gross_out: u128,
    pub expected_out: u128,
    pub fee_out: u128,
    pub tolerance_min_out: u128,
    pub required_min_out: u128,
}

pub fn is_canonical_unsigned_int_str(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    if bytes == b"0" {
        return true;
    }
    if !matches!(bytes[0], b'1'..=b'9') {
        return false;
    }
    bytes[1..].iter().all(u8::is_ascii_digit)
}

pub fn parse_canonical_u128(raw: &str) -> Result<u128, OptimizerError> {
    if !is_canonical_unsigned_int_str(raw) {
        return Err(OptimizerError::InvalidIntegerEncoding);
    }
    let mut acc: u128 = 0;
    for &b in raw.as_bytes() {
        let digit = u128::from(b - b'0');
        acc = acc
            .checked_mul(10)
            .and_then(|v| v.checked_add(digit))
            .ok_or(OptimizerError::IntegerOverflow)?;
    }
    Ok(acc)
}

pub fn parse_canonical_u64(raw: &str) -> Result<u64, OptimizerError> {
    if !is_canonical_unsigned_int_str(raw) {
        return Err(OptimizerError::InvalidIntegerEncoding);
    }
    let mut acc: u64 = 0;
    for &b in raw.as_bytes() {
        let digit = u64::from(b - b'0');
        acc = acc
            .checked_mul(10)
            .and_then(|v| v.checked_add(digit))
            .ok_or(OptimizerError::IntegerOverflow)?;
    }
    Ok(acc)
}

fn decode_lower_hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

pub fn parse_canonical_bytes32(raw: &str) -> Result<B256, OptimizerError> {
    let bytes = raw.as_bytes();
    if bytes.len() != 66 || bytes[0] != b'0' || bytes[1] != b'x' {
        return Err(OptimizerError::InvalidBytes32);
    }
    let mut out = [0u8; 32];
    for (idx, slot) in out.iter_mut().enumerate() {
        let hi =
            decode_lower_hex_nibble(bytes[2 + idx * 2]).ok_or(OptimizerError::InvalidBytes32)?;
        let lo = decode_lower_hex_nibble(bytes[2 + idx * 2 + 1])
            .ok_or(OptimizerError::InvalidBytes32)?;
        *slot = (hi << 4) | lo;
    }
    Ok(B256::new(out))
}

pub fn format_bytes32(value: &B256) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(66);
    out.push('0');
    out.push('x');
    for &byte in value.as_slice() {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}

/// Computes exact V1 candidate outputs using checked `U256` intermediates and `u128` outputs.
///
/// Order of operations:
/// - `G = floor((F * N) / D)`
/// - `O = floor((F * N * (10000 - f)) / (D * 10000))`
/// - `feeOut = G - O`
/// - `T = floor((O * (10000 - t)) / 10000)`
/// - `M = max(T, userMinOut)`
pub fn compute_candidate_amounts(
    amount_in: u128,
    rate_numerator: u128,
    rate_denominator: u128,
    fee_bps: u16,
    tolerance_bps: u16,
    user_min_out: u128,
) -> Result<ComputedQuoteAmounts, CandidateRejectionReason> {
    if fee_bps > MAX_BPS || tolerance_bps > MAX_BPS || rate_numerator == 0 || rate_denominator == 0
    {
        return Err(CandidateRejectionReason::ArithmeticRange);
    }

    let f_256 = U256::from(amount_in);
    let n_256 = U256::from(rate_numerator);
    let d_256 = U256::from(rate_denominator);
    let bps_denom_256 = U256::from(BPS_DENOMINATOR);

    // 1. Gross output: G = floor((F * N) / D)
    let fn_prod = f_256
        .checked_mul(n_256)
        .ok_or(CandidateRejectionReason::ArithmeticRange)?;
    let gross_256 = fn_prod
        .checked_div(d_256)
        .ok_or(CandidateRejectionReason::ArithmeticRange)?;
    let gross_out =
        u128::try_from(gross_256).map_err(|_| CandidateRejectionReason::ArithmeticRange)?;

    // 2. Expected output: O = floor((F * N * (10000 - f)) / (D * 10000))
    // Explicitly reject U256 overflow before division even when cancellation would fit.
    let fee_keep = MAX_BPS
        .checked_sub(fee_bps)
        .ok_or(CandidateRejectionReason::ArithmeticRange)?;
    let expected_num = fn_prod
        .checked_mul(U256::from(fee_keep))
        .ok_or(CandidateRejectionReason::ArithmeticRange)?;
    let expected_den = d_256
        .checked_mul(bps_denom_256)
        .ok_or(CandidateRejectionReason::ArithmeticRange)?;
    let expected_256 = expected_num
        .checked_div(expected_den)
        .ok_or(CandidateRejectionReason::ArithmeticRange)?;
    let expected_out =
        u128::try_from(expected_256).map_err(|_| CandidateRejectionReason::ArithmeticRange)?;

    // 3. Fee output: feeOut = G - O
    let fee_out = gross_out
        .checked_sub(expected_out)
        .ok_or(CandidateRejectionReason::ArithmeticRange)?;

    // 4. Tolerance-adjusted minimum: T = floor((O * (10000 - t)) / 10000)
    let tol_keep = MAX_BPS
        .checked_sub(tolerance_bps)
        .ok_or(CandidateRejectionReason::ArithmeticRange)?;
    let tol_num = U256::from(expected_out)
        .checked_mul(U256::from(tol_keep))
        .ok_or(CandidateRejectionReason::ArithmeticRange)?;
    let tol_256 = tol_num
        .checked_div(bps_denom_256)
        .ok_or(CandidateRejectionReason::ArithmeticRange)?;
    let tolerance_min_out =
        u128::try_from(tol_256).map_err(|_| CandidateRejectionReason::ArithmeticRange)?;

    // 5. Required minimum: M = max(T, userMinOut)
    let required_min_out = tolerance_min_out.max(user_min_out);

    Ok(ComputedQuoteAmounts {
        gross_out,
        expected_out,
        fee_out,
        tolerance_min_out,
        required_min_out,
    })
}
