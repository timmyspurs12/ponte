//! Structural validation, candidate evaluation, rejection precedence, and route selection.

use crate::{
    arithmetic::compute_candidate_amounts,
    model::{
        AssetIdV1, CandidateRejectionReason, CandidateV1, MAX_ASSET_DECIMALS,
        MAX_ASSET_FIELD_LEN, MAX_BPS, MAX_CANDIDATES, MIN_CANDIDATES,
        NoRouteResultV1, OPTIMIZER_VERSION_V1, OptimizeOutcomeV1, OptimizeRequestV1,
        OptimizerError, OptimizerMode, RejectedCandidateV1, SelectedRouteV1,
    },
};
use alloc::vec::Vec;
use alloy_primitives::B256;
use core::cmp::Ordering;

#[derive(Clone, Copy, Debug)]
struct EligibleCandidate {
    route_id: B256,
    gross_out: u128,
    fee_out: u128,
    expected_out: u128,
    minimum_out: u128,
    execution_cost_usd_cents: u128,
    effective_expiry: u64,
}

fn is_valid_ascii_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_ASSET_FIELD_LEN {
        return false;
    }
    bytes.iter().all(|&b| (0x21..=0x7e).contains(&b))
}

fn validate_asset(asset: &AssetIdV1) -> Result<(), OptimizerError> {
    if !is_valid_ascii_identifier(&asset.namespace)
        || !is_valid_ascii_identifier(&asset.identifier)
    {
        return Err(OptimizerError::InvalidAsset);
    }
    if asset.decimals > MAX_ASSET_DECIMALS {
        return Err(OptimizerError::InvalidAssetDecimals);
    }
    Ok(())
}

/// Validates structural request invariants and returns candidate indices sorted
/// in canonical unsigned 32-byte `route_id` ascending order.
pub fn validate_request_v1(
    request: &OptimizeRequestV1,
) -> Result<Vec<usize>, OptimizerError> {
    if request.version != OPTIMIZER_VERSION_V1 {
        return Err(OptimizerError::UnsupportedVersion);
    }
    if request.mode != OptimizerMode::Synthetic {
        return Err(OptimizerError::UnsupportedMode);
    }

    validate_asset(&request.input_asset)?;
    validate_asset(&request.output_asset)?;
    if request.input_asset.namespace == request.output_asset.namespace
        && request.input_asset.identifier == request.output_asset.identifier
    {
        return Err(OptimizerError::InvalidAsset);
    }

    if request.amount_in == 0 {
        return Err(OptimizerError::InvalidAmountIn);
    }
    if request.tolerance_bps > MAX_BPS {
        return Err(OptimizerError::InvalidBps);
    }
    if request.as_of_unix_seconds >= request.expires_at_unix_seconds {
        return Err(OptimizerError::InvalidRequestExpiry);
    }

    let count = request.candidates.len();
    if !(MIN_CANDIDATES..=MAX_CANDIDATES).contains(&count) {
        return Err(OptimizerError::InvalidCandidateCount);
    }

    for candidate in &request.candidates {
        if candidate.fee_bps > MAX_BPS || candidate.estimated_impact_bps > MAX_BPS {
            return Err(OptimizerError::InvalidBps);
        }
    }

    let mut indices: Vec<usize> = (0..count).collect();
    indices.sort_by(|&a, &b| {
        request.candidates[a]
            .route_id
            .cmp(&request.candidates[b].route_id)
    });

    for pair in indices.windows(2) {
        let left = &request.candidates[pair[0]];
        let right = &request.candidates[pair[1]];
        if left.route_id == right.route_id {
            return Err(OptimizerError::DuplicateRouteId);
        }
    }

    for &idx in &indices {
        let candidate: &CandidateV1 = &request.candidates[idx];
        if candidate.snapshot_id != request.snapshot_id {
            return Err(OptimizerError::SnapshotMismatch);
        }
        if candidate.rate_numerator == 0 || candidate.rate_denominator == 0 {
            return Err(OptimizerError::ZeroRate);
        }
        if candidate.min_input > candidate.max_input {
            return Err(OptimizerError::InvalidCandidateBounds);
        }
    }

    Ok(indices)
}

fn compare_eligible(challenger: &EligibleCandidate, incumbent: &EligibleCandidate) -> Ordering {
    challenger
        .expected_out
        .cmp(&incumbent.expected_out)
        .then_with(|| {
            incumbent
                .execution_cost_usd_cents
                .cmp(&challenger.execution_cost_usd_cents)
        })
        .then_with(|| incumbent.route_id.cmp(&challenger.route_id))
}

/// Evaluates a normalized synthetic `OptimizeRequestV1` and selects the best feasible route.
pub fn optimize_v1(
    request: &OptimizeRequestV1,
) -> Result<OptimizeOutcomeV1, OptimizerError> {
    let sorted_indices = validate_request_v1(request)?;
    let evaluated_count = sorted_indices.len();
    let mut rejected: Vec<RejectedCandidateV1> = Vec::with_capacity(evaluated_count);
    let mut winner: Option<EligibleCandidate> = None;

    for idx in sorted_indices {
        let candidate = &request.candidates[idx];
        let effective_expiry = request
            .expires_at_unix_seconds
            .min(candidate.expires_at_unix_seconds);

        // 1. EXPIRED
        if request.as_of_unix_seconds >= effective_expiry {
            rejected.push(RejectedCandidateV1 {
                route_id: candidate.route_id,
                reason: CandidateRejectionReason::Expired,
            });
            continue;
        }

        // 2. BELOW_MIN
        if request.amount_in < candidate.min_input {
            rejected.push(RejectedCandidateV1 {
                route_id: candidate.route_id,
                reason: CandidateRejectionReason::BelowMin,
            });
            continue;
        }

        // 3. CAPACITY
        if request.amount_in > candidate.max_input {
            rejected.push(RejectedCandidateV1 {
                route_id: candidate.route_id,
                reason: CandidateRejectionReason::Capacity,
            });
            continue;
        }

        // 4. INPUT_LIQUIDITY
        if request.amount_in > candidate.available_input {
            rejected.push(RejectedCandidateV1 {
                route_id: candidate.route_id,
                reason: CandidateRejectionReason::InputLiquidity,
            });
            continue;
        }

        // 5. ARITHMETIC_RANGE
        let amounts = match compute_candidate_amounts(
            request.amount_in,
            candidate.rate_numerator,
            candidate.rate_denominator,
            candidate.fee_bps,
            request.tolerance_bps,
            request.user_min_out,
        ) {
            Ok(val) => val,
            Err(reason) => {
                rejected.push(RejectedCandidateV1 {
                    route_id: candidate.route_id,
                    reason,
                });
                continue;
            }
        };

        // 6. ZERO_OUTPUT
        if amounts.expected_out == 0 {
            rejected.push(RejectedCandidateV1 {
                route_id: candidate.route_id,
                reason: CandidateRejectionReason::ZeroOutput,
            });
            continue;
        }

        // 7. OUTPUT_LIQUIDITY
        if amounts.expected_out > candidate.available_output {
            rejected.push(RejectedCandidateV1 {
                route_id: candidate.route_id,
                reason: CandidateRejectionReason::OutputLiquidity,
            });
            continue;
        }

        // 8. USER_MIN_UNMET
        if amounts.required_min_out > amounts.expected_out {
            rejected.push(RejectedCandidateV1 {
                route_id: candidate.route_id,
                reason: CandidateRejectionReason::UserMinUnmet,
            });
            continue;
        }

        let eligible = EligibleCandidate {
            route_id: candidate.route_id,
            gross_out: amounts.gross_out,
            fee_out: amounts.fee_out,
            expected_out: amounts.expected_out,
            minimum_out: amounts.required_min_out,
            execution_cost_usd_cents: candidate.execution_cost_usd_cents,
            effective_expiry,
        };

        if match &winner {
            None => true,
            Some(incumbent) => compare_eligible(&eligible, incumbent) == Ordering::Greater,
        } {
            winner = Some(eligible);
        }
    }

    match winner {
        Some(selected) => Ok(OptimizeOutcomeV1::Selected(SelectedRouteV1 {
            selected_route_id: selected.route_id,
            amount_in: request.amount_in,
            gross_out: selected.gross_out,
            fee_out: selected.fee_out,
            expected_out: selected.expected_out,
            minimum_out: selected.minimum_out,
            execution_cost_usd_cents: selected.execution_cost_usd_cents,
            effective_expiry: selected.effective_expiry,
            snapshot_id: request.snapshot_id,
            evaluated_count,
            rejected,
        })),
        None => Ok(OptimizeOutcomeV1::NoRoute(NoRouteResultV1 {
            amount_in: request.amount_in,
            snapshot_id: request.snapshot_id,
            evaluated_count,
            rejected,
        })),
    }
}
