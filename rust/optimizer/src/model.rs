//! Domain request, candidate, outcome, and error types for PONTE Optimizer V1.
//!
//! Evaluations operate strictly on normalized synthetic route candidates.

use alloc::{string::String, vec::Vec};
use alloy_primitives::B256;
use core::fmt;

pub const OPTIMIZER_VERSION_V1: u16 = 1;
pub const BPS_DENOMINATOR: u16 = 10_000;
pub const MAX_BPS: u16 = 10_000;
pub const MAX_ASSET_DECIMALS: u8 = 38;
pub const MIN_CANDIDATES: usize = 1;
pub const MAX_CANDIDATES: usize = 64;
pub const MAX_ASSET_FIELD_LEN: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OptimizerMode {
    Synthetic,
    Unsupported,
}

impl OptimizerMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Synthetic => "SYNTHETIC",
            Self::Unsupported => "UNSUPPORTED",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetIdV1 {
    pub namespace: String,
    pub identifier: String,
    pub decimals: u8,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CandidateV1 {
    pub route_id: B256,
    pub snapshot_id: B256,
    pub rate_numerator: u128,
    pub rate_denominator: u128,
    pub fee_bps: u16,
    pub estimated_impact_bps: u16,
    pub min_input: u128,
    pub max_input: u128,
    pub available_input: u128,
    pub available_output: u128,
    pub execution_cost_usd_cents: u128,
    pub expires_at_unix_seconds: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OptimizeRequestV1 {
    pub version: u16,
    pub mode: OptimizerMode,
    pub input_asset: AssetIdV1,
    pub output_asset: AssetIdV1,
    pub amount_in: u128,
    pub user_min_out: u128,
    pub tolerance_bps: u16,
    pub as_of_unix_seconds: u64,
    pub expires_at_unix_seconds: u64,
    pub snapshot_id: B256,
    pub candidates: Vec<CandidateV1>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CandidateRejectionReason {
    Expired,
    BelowMin,
    Capacity,
    InputLiquidity,
    ArithmeticRange,
    ZeroOutput,
    OutputLiquidity,
    UserMinUnmet,
}

impl CandidateRejectionReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Expired => "EXPIRED",
            Self::BelowMin => "BELOW_MIN",
            Self::Capacity => "CAPACITY",
            Self::InputLiquidity => "INPUT_LIQUIDITY",
            Self::ArithmeticRange => "ARITHMETIC_RANGE",
            Self::ZeroOutput => "ZERO_OUTPUT",
            Self::OutputLiquidity => "OUTPUT_LIQUIDITY",
            Self::UserMinUnmet => "USER_MIN_UNMET",
        }
    }
}

impl fmt::Display for CandidateRejectionReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RejectedCandidateV1 {
    pub route_id: B256,
    pub reason: CandidateRejectionReason,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectedRouteV1 {
    pub selected_route_id: B256,
    pub amount_in: u128,
    pub gross_out: u128,
    pub fee_out: u128,
    pub expected_out: u128,
    pub minimum_out: u128,
    pub execution_cost_usd_cents: u128,
    pub effective_expiry: u64,
    pub snapshot_id: B256,
    pub evaluated_count: usize,
    pub rejected: Vec<RejectedCandidateV1>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoRouteResultV1 {
    pub amount_in: u128,
    pub snapshot_id: B256,
    pub evaluated_count: usize,
    pub rejected: Vec<RejectedCandidateV1>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OptimizeOutcomeV1 {
    Selected(SelectedRouteV1),
    NoRoute(NoRouteResultV1),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OptimizerError {
    MalformedJson,
    InvalidRequestShape,
    UnsupportedVersion,
    UnsupportedMode,
    InvalidAsset,
    InvalidAssetDecimals,
    InvalidBytes32,
    InvalidIntegerEncoding,
    IntegerOverflow,
    InvalidAmountIn,
    InvalidBps,
    InvalidRequestExpiry,
    InvalidCandidateCount,
    DuplicateRouteId,
    SnapshotMismatch,
    ZeroRate,
    InvalidCandidateBounds,
}

impl OptimizerError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::MalformedJson => "MALFORMED_JSON",
            Self::InvalidRequestShape => "INVALID_REQUEST_SHAPE",
            Self::UnsupportedVersion => "UNSUPPORTED_VERSION",
            Self::UnsupportedMode => "UNSUPPORTED_MODE",
            Self::InvalidAsset => "INVALID_ASSET",
            Self::InvalidAssetDecimals => "INVALID_ASSET_DECIMALS",
            Self::InvalidBytes32 => "INVALID_BYTES32",
            Self::InvalidIntegerEncoding => "INVALID_INTEGER_ENCODING",
            Self::IntegerOverflow => "INTEGER_OVERFLOW",
            Self::InvalidAmountIn => "INVALID_AMOUNT_IN",
            Self::InvalidBps => "INVALID_BPS",
            Self::InvalidRequestExpiry => "INVALID_REQUEST_EXPIRY",
            Self::InvalidCandidateCount => "INVALID_CANDIDATE_COUNT",
            Self::DuplicateRouteId => "DUPLICATE_ROUTE_ID",
            Self::SnapshotMismatch => "SNAPSHOT_MISMATCH",
            Self::ZeroRate => "ZERO_RATE",
            Self::InvalidCandidateBounds => "INVALID_CANDIDATE_BOUNDS",
        }
    }

    pub const fn message(self) -> &'static str {
        match self {
            Self::MalformedJson => "Request payload is not valid JSON.",
            Self::InvalidRequestShape => {
                "Request structure is missing required fields or has invalid field types."
            }
            Self::UnsupportedVersion => "Unsupported optimizer request version; expected 1.",
            Self::UnsupportedMode => "Unsupported optimizer mode; expected SYNTHETIC.",
            Self::InvalidAsset => {
                "Asset namespace and identifier must be distinct non-empty ASCII identifiers."
            }
            Self::InvalidAssetDecimals => "Asset decimals must be an integer between 0 and 38.",
            Self::InvalidBytes32 => {
                "Identifier must be a canonical lowercase 0x-prefixed 32-byte hex string."
            }
            Self::InvalidIntegerEncoding => {
                "Monetary and timestamp fields must be canonical unsigned base-10 integer strings."
            }
            Self::IntegerOverflow => "Integer value exceeds bounded width.",
            Self::InvalidAmountIn => "Input amount must be a positive integer.",
            Self::InvalidBps => "Basis-point value must be an integer between 0 and 10000.",
            Self::InvalidRequestExpiry => {
                "Evaluation timestamp must be strictly earlier than request expiry."
            }
            Self::InvalidCandidateCount => "Candidate count must be between 1 and 64.",
            Self::DuplicateRouteId => "Candidate routeId values must be unique.",
            Self::SnapshotMismatch => "Candidate snapshotId must match request snapshotId.",
            Self::ZeroRate => "Candidate rateNumerator and rateDenominator must be positive.",
            Self::InvalidCandidateBounds => "Candidate minInput must not exceed maxInput.",
        }
    }
}

impl fmt::Display for OptimizerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}
