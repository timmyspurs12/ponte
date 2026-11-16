//! PONTE Phase 2B.1 — Isolated deterministic synthetic liquidity route optimizer.
//!
//! Pure `no_std + alloc` library with checked `U256` intermediate arithmetic,
//! bounded integer inputs/outputs, no floating-point math, and no `unsafe` code.

#![no_std]
#![forbid(unsafe_code)]
#![deny(clippy::float_arithmetic)]

extern crate alloc;
#[cfg(test)]
extern crate std;

pub mod arithmetic;
pub mod json;
pub mod model;
pub mod optimizer;

pub use arithmetic::{
    compute_candidate_amounts, format_bytes32, is_canonical_unsigned_int_str,
    parse_canonical_bytes32, parse_canonical_u128, parse_canonical_u64, ComputedQuoteAmounts,
};
pub use json::{
    evaluate_json_line, format_result_v1_json, parse_raw_json, parse_request_v1_json, RawJsonValue,
};
pub use model::{
    AssetIdV1, CandidateRejectionReason, CandidateV1, NoRouteResultV1, OptimizeOutcomeV1,
    OptimizeRequestV1, OptimizerError, OptimizerMode, RejectedCandidateV1, SelectedRouteV1,
    BPS_DENOMINATOR, MAX_ASSET_DECIMALS, MAX_ASSET_FIELD_LEN, MAX_BPS, MAX_CANDIDATES,
    MIN_CANDIDATES, OPTIMIZER_VERSION_V1,
};
pub use optimizer::{optimize_v1, validate_request_v1};

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::{string::ToString, vec, vec::Vec};
    use alloy_primitives::{B256, U256};

    fn make_route_id(index: u8) -> B256 {
        let mut bytes = [0u8; 32];
        bytes[31] = index;
        B256::new(bytes)
    }

    fn make_snapshot_id(tag: u8) -> B256 {
        B256::new([tag; 32])
    }

    fn synth_brl() -> AssetIdV1 {
        AssetIdV1 {
            namespace: "SYNTHETIC_FIAT".to_string(),
            identifier: "SYNTH_BRL".to_string(),
            decimals: 2,
        }
    }

    fn synth_usdg() -> AssetIdV1 {
        AssetIdV1 {
            namespace: "SYNTHETIC_TOKEN".to_string(),
            identifier: "SYNTH_USDG".to_string(),
            decimals: 2,
        }
    }

    fn base_candidate(route_idx: u8) -> CandidateV1 {
        CandidateV1 {
            route_id: make_route_id(route_idx),
            snapshot_id: make_snapshot_id(0xa1),
            rate_numerator: 2,
            rate_denominator: 1,
            fee_bps: 50,
            estimated_impact_bps: 10,
            min_input: 1,
            max_input: u128::MAX,
            available_input: u128::MAX,
            available_output: u128::MAX,
            execution_cost_usd_cents: 4,
            expires_at_unix_seconds: 1_763_324_100,
        }
    }

    fn base_request(candidates: Vec<CandidateV1>) -> OptimizeRequestV1 {
        OptimizeRequestV1 {
            version: OPTIMIZER_VERSION_V1,
            mode: OptimizerMode::Synthetic,
            input_asset: synth_brl(),
            output_asset: synth_usdg(),
            amount_in: 1_000,
            user_min_out: 0,
            tolerance_bps: 50,
            as_of_unix_seconds: 1_763_323_200,
            expires_at_unix_seconds: 1_763_324_100,
            snapshot_id: make_snapshot_id(0xa1),
            candidates,
        }
    }

    #[test]
    fn canonical_integer_parsing_enforces_strict_base10_rules() {
        assert_eq!(parse_canonical_u128("0"), Ok(0));
        assert_eq!(parse_canonical_u128("1"), Ok(1));
        assert_eq!(
            parse_canonical_u128("340282366920938463463374607431768211455"),
            Ok(u128::MAX),
        );
        assert_eq!(
            parse_canonical_u128("340282366920938463463374607431768211456"),
            Err(OptimizerError::IntegerOverflow),
        );
        for bad in [
            "", "00", "01", "-1", "+1", "1.0", "1e2", " 1", "1 ", "1_000",
        ] {
            assert_eq!(
                parse_canonical_u128(bad),
                Err(OptimizerError::InvalidIntegerEncoding),
            );
        }

        assert_eq!(parse_canonical_u64("18446744073709551615"), Ok(u64::MAX),);
        assert_eq!(
            parse_canonical_u64("18446744073709551616"),
            Err(OptimizerError::IntegerOverflow),
        );
    }

    #[test]
    fn canonical_bytes32_rejects_non_lowercase_or_wrong_length() {
        let valid = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let parsed = parse_canonical_bytes32(valid).expect("valid bytes32");
        assert_eq!(format_bytes32(&parsed), valid);

        let upper = "0x0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(
            parse_canonical_bytes32(upper),
            Err(OptimizerError::InvalidBytes32),
        );
        assert_eq!(
            parse_canonical_bytes32("0x1234"),
            Err(OptimizerError::InvalidBytes32),
        );
    }

    #[test]
    fn legacy_quote_vectors_match_exact_single_floor_arithmetic() {
        let vectors: [(u128, u16, u16, u128, u128, u128, u128); 9] = [
            // F = 100, G = 19
            (100, 35, 5, 19, 1, 18, 17),
            (100, 48, 8, 19, 1, 18, 17),
            (100, 65, 12, 19, 1, 18, 17),
            // F = 2,500,000, G = 476,190
            (2_500_000, 35, 5, 476_190, 1_667, 474_523, 472_150),
            (2_500_000, 48, 8, 476_190, 2_286, 473_904, 471_534),
            (2_500_000, 65, 12, 476_190, 3_095, 473_095, 470_729),
            // F = 1,000,000,000, G = 190,476,190
            (
                1_000_000_000,
                35,
                5,
                190_476_190,
                666_667,
                189_809_523,
                188_860_475,
            ),
            (
                1_000_000_000,
                48,
                8,
                190_476_190,
                914_286,
                189_561_904,
                188_614_094,
            ),
            (
                1_000_000_000,
                65,
                12,
                190_476_190,
                1_238_095,
                189_238_095,
                188_291_904,
            ),
        ];

        for (f_in, fee_bps, impact_bps, g_exp, fee_exp, o_exp, m_exp) in vectors {
            let mut cand = base_candidate(1);
            cand.rate_numerator = 100;
            cand.rate_denominator = 525;
            cand.fee_bps = fee_bps;
            cand.estimated_impact_bps = impact_bps;
            cand.execution_cost_usd_cents = 2;

            let mut req = base_request(vec![cand.clone()]);
            req.amount_in = f_in;
            req.tolerance_bps = 50;

            let res = optimize_v1(&req).expect("valid legacy vector");
            let OptimizeOutcomeV1::Selected(sel) = res else {
                panic!("expected selected route");
            };
            assert_eq!(sel.gross_out, g_exp);
            assert_eq!(sel.fee_out, fee_exp);
            assert_eq!(sel.expected_out, o_exp);
            assert_eq!(sel.minimum_out, m_exp);
            assert_eq!(sel.gross_out, sel.fee_out + sel.expected_out);

            // Descriptive impact metadata must never alter output
            cand.estimated_impact_bps = 9_500;
            req.candidates = vec![cand];
            assert_eq!(optimize_v1(&req), Ok(OptimizeOutcomeV1::Selected(sel)));
        }
    }

    #[test]
    fn u256_intermediate_overflow_is_rejected_without_algebraic_cancellation() {
        let mut cand = base_candidate(1);
        cand.rate_numerator = u128::MAX;
        cand.rate_denominator = u128::MAX;
        cand.fee_bps = 0;

        let mut req = base_request(vec![cand]);
        req.amount_in = u128::MAX;
        req.tolerance_bps = 0;

        let outcome = optimize_v1(&req).expect("valid request");
        assert_eq!(
            outcome,
            OptimizeOutcomeV1::NoRoute(NoRouteResultV1 {
                amount_in: u128::MAX,
                snapshot_id: req.snapshot_id,
                evaluated_count: 1,
                rejected: vec![RejectedCandidateV1 {
                    route_id: make_route_id(1),
                    reason: CandidateRejectionReason::ArithmeticRange,
                }],
            }),
        );

        // Exact largest safe N where U128_MAX * N * 10000 <= U256_MAX must pass
        let max_safe_n_256 = U256::MAX / (U256::from(u128::MAX) * U256::from(10_000u16));
        let max_safe_n = u128::try_from(max_safe_n_256).expect("fits u128");
        let mut safe_cand = base_candidate(1);
        safe_cand.rate_numerator = max_safe_n;
        safe_cand.rate_denominator = u128::MAX;
        safe_cand.fee_bps = 0;
        req.candidates = vec![safe_cand];
        let safe_outcome = optimize_v1(&req).expect("valid request");
        let OptimizeOutcomeV1::Selected(sel) = safe_outcome else {
            panic!("expected selected route at exact U256 ceiling");
        };
        assert_eq!(sel.expected_out, max_safe_n);
    }

    #[test]
    fn rejection_precedence_and_no_route_ordering_are_deterministic() {
        let mut c_expired = base_candidate(8);
        c_expired.expires_at_unix_seconds = 1_763_323_200; // == as_of -> EXPIRED
        c_expired.min_input = 5_000; // also below min, but EXPIRED has precedence 1

        let mut c_below_min = base_candidate(7);
        c_below_min.min_input = 1_001;
        c_below_min.max_input = 2_000;
        c_below_min.available_input = 10; // BELOW_MIN (2) precedes INPUT_LIQUIDITY (4)

        let mut c_capacity = base_candidate(6);
        c_capacity.max_input = 999;
        c_capacity.available_input = 10; // CAPACITY (3) precedes INPUT_LIQUIDITY (4)

        let mut c_in_liq = base_candidate(5);
        c_in_liq.available_input = 999;

        let mut c_range = base_candidate(4);
        c_range.rate_numerator = u128::MAX;
        c_range.rate_denominator = 1;
        c_range.fee_bps = 10_000; // ARITHMETIC_RANGE (5) precedes ZERO_OUTPUT (6)

        let mut c_zero = base_candidate(3);
        c_zero.fee_bps = 10_000;
        c_zero.available_output = 0; // ZERO_OUTPUT (6) precedes OUTPUT_LIQUIDITY (7)

        let mut c_out_liq = base_candidate(2);
        c_out_liq.available_output = 1_989; // O = 1990

        let mut c_min_unmet = base_candidate(1);
        c_min_unmet.fee_bps = 50; // O = 1990 < user_min_out 2000

        let mut req = base_request(vec![
            c_expired,
            c_below_min,
            c_capacity,
            c_in_liq,
            c_range,
            c_zero,
            c_out_liq,
            c_min_unmet,
        ]);
        req.user_min_out = 2_000;

        let outcome = optimize_v1(&req).expect("structurally valid");
        let OptimizeOutcomeV1::NoRoute(nr) = outcome else {
            panic!("expected NO_ROUTE");
        };
        assert_eq!(nr.evaluated_count, 8);
        let reasons: Vec<(u8, CandidateRejectionReason)> = nr
            .rejected
            .iter()
            .map(|r| (r.route_id.as_slice()[31], r.reason))
            .collect();
        assert_eq!(
            reasons,
            vec![
                (1, CandidateRejectionReason::UserMinUnmet),
                (2, CandidateRejectionReason::OutputLiquidity),
                (3, CandidateRejectionReason::ZeroOutput),
                (4, CandidateRejectionReason::ArithmeticRange),
                (5, CandidateRejectionReason::InputLiquidity),
                (6, CandidateRejectionReason::Capacity),
                (7, CandidateRejectionReason::BelowMin),
                (8, CandidateRejectionReason::Expired),
            ],
        );
    }

    #[test]
    fn structural_validation_rejects_all_malformed_request_conditions() {
        let mut req = base_request(vec![base_candidate(1)]);
        req.version = 2;
        assert_eq!(optimize_v1(&req), Err(OptimizerError::UnsupportedVersion));

        let mut req = base_request(vec![base_candidate(1)]);
        req.mode = OptimizerMode::Unsupported;
        assert_eq!(optimize_v1(&req), Err(OptimizerError::UnsupportedMode));

        let mut req = base_request(vec![base_candidate(1)]);
        req.output_asset.decimals = 39;
        assert_eq!(optimize_v1(&req), Err(OptimizerError::InvalidAssetDecimals));

        let mut req = base_request(vec![base_candidate(1)]);
        req.output_asset = req.input_asset.clone();
        assert_eq!(optimize_v1(&req), Err(OptimizerError::InvalidAsset));

        let mut req = base_request(vec![base_candidate(1)]);
        req.amount_in = 0;
        assert_eq!(optimize_v1(&req), Err(OptimizerError::InvalidAmountIn));

        let mut req = base_request(vec![base_candidate(1)]);
        req.tolerance_bps = 10_001;
        assert_eq!(optimize_v1(&req), Err(OptimizerError::InvalidBps));

        let mut req = base_request(vec![base_candidate(1)]);
        req.as_of_unix_seconds = req.expires_at_unix_seconds;
        assert_eq!(optimize_v1(&req), Err(OptimizerError::InvalidRequestExpiry));

        let req_empty = base_request(Vec::new());
        assert_eq!(
            optimize_v1(&req_empty),
            Err(OptimizerError::InvalidCandidateCount),
        );

        let over_max: Vec<CandidateV1> = (1..=65u8).map(base_candidate).collect();
        let req_65 = base_request(over_max);
        assert_eq!(
            optimize_v1(&req_65),
            Err(OptimizerError::InvalidCandidateCount),
        );

        let req_dup = base_request(vec![base_candidate(1), base_candidate(1)]);
        assert_eq!(optimize_v1(&req_dup), Err(OptimizerError::DuplicateRouteId));

        let mut bad_snap = base_candidate(1);
        bad_snap.snapshot_id = make_snapshot_id(0xff);
        assert_eq!(
            optimize_v1(&base_request(vec![bad_snap])),
            Err(OptimizerError::SnapshotMismatch),
        );

        let mut bad_rate = base_candidate(1);
        bad_rate.rate_denominator = 0;
        assert_eq!(
            optimize_v1(&base_request(vec![bad_rate])),
            Err(OptimizerError::ZeroRate),
        );

        let mut bad_bounds = base_candidate(1);
        bad_bounds.min_input = 500;
        bad_bounds.max_input = 499;
        assert_eq!(
            optimize_v1(&base_request(vec![bad_bounds])),
            Err(OptimizerError::InvalidCandidateBounds),
        );
    }

    #[test]
    fn property_permutation_invariance_and_accounting_conservation() {
        // Deterministic xorshift64 PRNG, used only to generate synthetic cases.
        let mut state: u64 = 0x504f_4e54_455f_3242;
        let mut next_u64 = || -> u64 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };

        for _ in 0..500 {
            let count = usize::try_from((next_u64() % 16) + 1).unwrap_or(1);
            let amount_in = u128::from((next_u64() % 10_000_000) + 1);
            let tolerance_bps = u16::try_from(next_u64() % 10_001).unwrap_or(0);
            let mut cands = Vec::with_capacity(count);
            for i in 0..count {
                let mut c = base_candidate(u8::try_from(i + 1).unwrap_or(1));
                c.rate_numerator = u128::from((next_u64() % 1_000) + 1);
                c.rate_denominator = u128::from((next_u64() % 1_000) + 1);
                c.fee_bps = u16::try_from(next_u64() % 10_001).unwrap_or(0);
                c.execution_cost_usd_cents = u128::from(next_u64() % 10);
                if next_u64() % 5 == 0 {
                    c.expires_at_unix_seconds = 1_763_323_100;
                }
                cands.push(c);
            }

            let mut req = base_request(cands.clone());
            req.amount_in = amount_in;
            req.tolerance_bps = tolerance_bps;

            let first = optimize_v1(&req).expect("valid synthetic request");
            let second = optimize_v1(&req).expect("idempotent evaluation");
            assert_eq!(first, second);

            if let OptimizeOutcomeV1::Selected(ref sel) = first {
                assert!(sel.expected_out > 0);
                assert!(sel.minimum_out <= sel.expected_out);
                assert!(sel.expected_out <= sel.gross_out);
                assert_eq!(sel.gross_out, sel.fee_out + sel.expected_out);
            }

            // Reverse and Fisher-Yates shuffle candidates and verify identical outcome
            let mut reversed = cands.clone();
            reversed.reverse();
            req.candidates = reversed;
            assert_eq!(optimize_v1(&req).expect("reversed"), first);

            let mut shuffled = cands;
            for i in (1..shuffled.len()).rev() {
                let j =
                    usize::try_from(next_u64() % u64::try_from(i + 1).unwrap_or(1)).unwrap_or(0);
                shuffled.swap(i, j);
            }
            req.candidates = shuffled;
            assert_eq!(optimize_v1(&req).expect("shuffled"), first);
        }
    }

    #[test]
    fn property_arbitrary_malformed_json_never_panics() {
        let mut state: u64 = 0xdead_beef_cafe_babe;
        for _ in 0..400 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let len = usize::try_from(state % 80).unwrap_or(0);
            let mut s = alloc::string::String::with_capacity(len);
            for _ in 0..len {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                let byte = u8::try_from((state >> 32) % 128).unwrap_or(b' ');
                s.push(char::from(byte));
            }
            let line_out = evaluate_json_line(&s);
            assert!(line_out.starts_with("{\"status\":\"ERROR\""));
        }
    }
}
