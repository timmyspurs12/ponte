//! Local-only synthetic Stylus adapter. This is not an executable quote.
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]

extern crate alloc;
use alloc::{string::String, vec::Vec};
use alloy_sol_types::sol;
use ponte_optimizer::{
    optimize_v1, AssetIdV1, CandidateV1, OptimizeOutcomeV1, OptimizeRequestV1, OptimizerMode,
};
use stylus_sdk::prelude::*;

sol! {
    #[derive(Debug, AbiType)]
    struct SyntheticAsset {
        string namespace;
        string identifier;
        uint8 decimals;
    }
    #[derive(Debug, AbiType)]
    struct SyntheticCandidate {
        bytes32 routeId;
        bytes32 snapshotId;
        uint128 rateNumerator;
        uint128 rateDenominator;
        uint16 feeBps;
        uint16 estimatedImpactBps;
        uint128 minInput;
        uint128 maxInput;
        uint128 availableInput;
        uint128 availableOutput;
        uint128 executionCostUsdCents;
        uint64 expiresAtUnixSeconds;
    }
    #[derive(Debug, AbiType)]
    struct SyntheticRequest {
        uint16 version;
        uint8 mode;
        SyntheticAsset inputAsset;
        SyntheticAsset outputAsset;
        uint128 amountIn;
        uint128 userMinOut;
        uint16 toleranceBps;
        uint64 asOfUnixSeconds;
        uint64 expiresAtUnixSeconds;
        bytes32 snapshotId;
        SyntheticCandidate[] candidates;
    }
    #[derive(Debug, AbiType)]
    struct Rejection {
        bytes32 routeId;
        string reason;
    }
    #[derive(Debug, AbiType)]
    struct SyntheticResult {
        uint8 status;
        string errorCode;
        bytes32 selectedRouteId;
        uint128 amountIn;
        uint128 grossOut;
        uint128 feeOut;
        uint128 expectedOut;
        uint128 minimumOut;
        uint128 executionCostUsdCents;
        uint64 effectiveExpiry;
        bytes32 snapshotId;
        uint8 evaluatedCount;
        Rejection[] rejected;
    }
    function evaluateSynthetic(SyntheticRequest request) external returns (SyntheticResult);
}

#[storage]
#[entrypoint]
pub struct SyntheticOptimizer {}

fn empty_result() -> SyntheticResult {
    SyntheticResult {
        status: 0,
        errorCode: String::new(),
        selectedRouteId: Default::default(),
        amountIn: 0,
        grossOut: 0,
        feeOut: 0,
        expectedOut: 0,
        minimumOut: 0,
        executionCostUsdCents: 0,
        effectiveExpiry: 0,
        snapshotId: Default::default(),
        evaluatedCount: 0,
        rejected: Vec::new(),
    }
}

fn make_error(code: &str) -> SyntheticResult {
    let mut result = empty_result();
    result.errorCode = code.into();
    result
}

fn convert_asset(asset: SyntheticAsset) -> AssetIdV1 {
    AssetIdV1 {
        namespace: asset.namespace,
        identifier: asset.identifier,
        decimals: asset.decimals,
    }
}

/// Mode 1 means synthetic. Evaluation time is caller-provided and unauthenticated.
/// The SDK ABI decoder handles dynamic input before this method can enforce limits.
#[public]
impl SyntheticOptimizer {
    pub fn evaluate_synthetic(&self, request: SyntheticRequest) -> SyntheticResult {
        evaluate(request)
    }
}

fn evaluate(request: SyntheticRequest) -> SyntheticResult {
    // Scalar ABI types have exactly the widths used by the core. Reject candidate
    // count before cloning or converting candidate contents into core structures.
    // Preserve the core's validation precedence for earlier request fields.
    let valid_count = (1..=64).contains(&request.candidates.len());
    let candidates = if valid_count {
        request
            .candidates
            .into_iter()
            .map(|c| CandidateV1 {
                route_id: c.routeId,
                snapshot_id: c.snapshotId,
                rate_numerator: c.rateNumerator,
                rate_denominator: c.rateDenominator,
                fee_bps: c.feeBps,
                estimated_impact_bps: c.estimatedImpactBps,
                min_input: c.minInput,
                max_input: c.maxInput,
                available_input: c.availableInput,
                available_output: c.availableOutput,
                execution_cost_usd_cents: c.executionCostUsdCents,
                expires_at_unix_seconds: c.expiresAtUnixSeconds,
            })
            .collect()
    } else {
        Vec::new()
    };
    let core = OptimizeRequestV1 {
        version: request.version,
        mode: if request.mode == 1 {
            OptimizerMode::Synthetic
        } else {
            OptimizerMode::Unsupported
        },
        input_asset: convert_asset(request.inputAsset),
        output_asset: convert_asset(request.outputAsset),
        amount_in: request.amountIn,
        user_min_out: request.userMinOut,
        tolerance_bps: request.toleranceBps,
        as_of_unix_seconds: request.asOfUnixSeconds,
        expires_at_unix_seconds: request.expiresAtUnixSeconds,
        snapshot_id: request.snapshotId,
        candidates,
    };
    match optimize_v1(&core) {
        Err(err) => make_error(err.code()),
        Ok(outcome) => {
            let mut result = empty_result();
            let (count, rejected) = match outcome {
                OptimizeOutcomeV1::Selected(selected) => {
                    result.status = 1;
                    result.selectedRouteId = selected.selected_route_id;
                    result.amountIn = selected.amount_in;
                    result.grossOut = selected.gross_out;
                    result.feeOut = selected.fee_out;
                    result.expectedOut = selected.expected_out;
                    result.minimumOut = selected.minimum_out;
                    result.executionCostUsdCents = selected.execution_cost_usd_cents;
                    result.effectiveExpiry = selected.effective_expiry;
                    result.snapshotId = selected.snapshot_id;
                    (selected.evaluated_count, selected.rejected)
                }
                OptimizeOutcomeV1::NoRoute(no_route) => {
                    result.status = 2;
                    result.amountIn = no_route.amount_in;
                    result.snapshotId = no_route.snapshot_id;
                    (no_route.evaluated_count, no_route.rejected)
                }
            };
            // Core guarantees evaluated count 1..=64.
            result.evaluatedCount = u8::try_from(count).expect("bounded candidate count");
            result.rejected = rejected
                .into_iter()
                .map(|r| Rejection {
                    routeId: r.route_id,
                    reason: r.reason.as_str().into(),
                })
                .collect();
            result
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_sol_types::SolValue;
    use ponte_optimizer::{parse_raw_json, parse_request_v1_json, RawJsonValue};
    use stylus_sdk::testing::TestVM;

    fn asset(a: AssetIdV1) -> SyntheticAsset {
        SyntheticAsset {
            namespace: a.namespace,
            identifier: a.identifier,
            decimals: a.decimals,
        }
    }
    fn request(r: OptimizeRequestV1) -> SyntheticRequest {
        SyntheticRequest {
            version: r.version,
            mode: if r.mode == OptimizerMode::Synthetic {
                1
            } else {
                0
            },
            inputAsset: asset(r.input_asset),
            outputAsset: asset(r.output_asset),
            amountIn: r.amount_in,
            userMinOut: r.user_min_out,
            toleranceBps: r.tolerance_bps,
            asOfUnixSeconds: r.as_of_unix_seconds,
            expiresAtUnixSeconds: r.expires_at_unix_seconds,
            snapshotId: r.snapshot_id,
            candidates: r
                .candidates
                .into_iter()
                .map(|c| SyntheticCandidate {
                    routeId: c.route_id,
                    snapshotId: c.snapshot_id,
                    rateNumerator: c.rate_numerator,
                    rateDenominator: c.rate_denominator,
                    feeBps: c.fee_bps,
                    estimatedImpactBps: c.estimated_impact_bps,
                    minInput: c.min_input,
                    maxInput: c.max_input,
                    availableInput: c.available_input,
                    availableOutput: c.available_output,
                    executionCostUsdCents: c.execution_cost_usd_cents,
                    expiresAtUnixSeconds: c.expires_at_unix_seconds,
                })
                .collect(),
        }
    }
    fn fixture_requests() -> Vec<(String, OptimizeRequestV1, RawJsonValue)> {
        let mut entries = Vec::new();
        for file in [
            include_str!("../../../scripts/phase2b/fixtures/v1/edge-cases.json"),
            include_str!("../../../scripts/phase2b/fixtures/v1/legacy-parity.json"),
            include_str!("../../../scripts/phase2b/fixtures/v1/regression-minimized.json"),
        ] {
            let RawJsonValue::Object(root) = parse_raw_json(file).unwrap() else {
                panic!("root")
            };
            let RawJsonValue::Array(vectors) = &root["vectors"] else {
                panic!("vectors")
            };
            for vector in vectors {
                let RawJsonValue::Object(v) = vector else {
                    panic!("vector")
                };
                let RawJsonValue::String(raw) = &v["rawRequestJson"] else {
                    panic!("raw")
                };
                let RawJsonValue::String(id) = &v["id"] else {
                    panic!("id")
                };
                if let Ok(r) = parse_request_v1_json(raw) {
                    entries.push((id.clone(), r, v["expectedResponse"].clone()));
                }
            }
        }
        entries
    }
    fn compare(
        actual: &SyntheticResult,
        core: Result<OptimizeOutcomeV1, ponte_optimizer::OptimizerError>,
    ) {
        match core {
            Err(e) => {
                assert_eq!(actual.status, 0);
                assert_eq!(actual.errorCode, e.code());
            }
            Ok(outcome) => {
                let (count, rejects) = match outcome {
                    OptimizeOutcomeV1::Selected(s) => {
                        assert_eq!(actual.status, 1);
                        assert_eq!(actual.selectedRouteId, s.selected_route_id);
                        assert_eq!(actual.amountIn, s.amount_in);
                        assert_eq!(actual.grossOut, s.gross_out);
                        assert_eq!(actual.feeOut, s.fee_out);
                        assert_eq!(actual.expectedOut, s.expected_out);
                        assert_eq!(actual.minimumOut, s.minimum_out);
                        assert_eq!(actual.executionCostUsdCents, s.execution_cost_usd_cents);
                        assert_eq!(actual.effectiveExpiry, s.effective_expiry);
                        assert_eq!(actual.snapshotId, s.snapshot_id);
                        (s.evaluated_count, s.rejected)
                    }
                    OptimizeOutcomeV1::NoRoute(n) => {
                        assert_eq!(actual.status, 2);
                        assert_eq!(actual.amountIn, n.amount_in);
                        assert_eq!(actual.snapshotId, n.snapshot_id);
                        (n.evaluated_count, n.rejected)
                    }
                };
                assert_eq!(usize::from(actual.evaluatedCount), count);
                assert_eq!(actual.rejected.len(), rejects.len());
                for (a, b) in actual.rejected.iter().zip(rejects) {
                    assert_eq!(a.routeId, b.route_id);
                    assert_eq!(a.reason, b.reason.as_str());
                }
            }
        }
    }
    #[test]
    fn synthetic_fixture_parity_through_testvm_and_abi_roundtrip() {
        let vm = TestVM::default();
        let contract = SyntheticOptimizer::from(&vm);
        let fixtures = fixture_requests();
        assert!(
            fixtures.len() >= 35,
            "need meaningful representable fixture coverage"
        );
        for (id, core, expected) in fixtures {
            let core_result = optimize_v1(&core);
            let core_json = ponte_optimizer::format_result_v1_json(&core_result);
            assert_eq!(
                parse_raw_json(&core_json).unwrap(),
                expected,
                "fixture {id}"
            );
            let encoded = request(core).abi_encode();
            let decoded = SyntheticRequest::abi_decode(&encoded).unwrap();
            let actual = contract.evaluate_synthetic(decoded);
            let result_bytes = actual.abi_encode();
            let roundtrip = SyntheticResult::abi_decode(&result_bytes).unwrap();
            compare(&roundtrip, core_result);
        }
    }
    #[test]
    fn oversized_and_invalid_requests_have_deterministic_core_errors() {
        let vm = TestVM::default();
        let contract = SyntheticOptimizer::from(&vm);
        let (_, core, _) = fixture_requests()
            .into_iter()
            .find(|(_, r, _)| r.candidates.len() == 1)
            .unwrap();
        let mut oversized = core.clone();
        oversized.candidates = (0..65).map(|_| core.candidates[0].clone()).collect();
        compare(
            &contract.evaluate_synthetic(request(oversized.clone())),
            optimize_v1(&oversized),
        );
        oversized.version = 2;
        compare(
            &contract.evaluate_synthetic(request(oversized.clone())),
            optimize_v1(&oversized),
        );
        let mut zero = core;
        zero.amount_in = 0;
        compare(
            &contract.evaluate_synthetic(request(zero.clone())),
            optimize_v1(&zero),
        );
    }
    #[test]
    fn tie_break_and_rejections_are_permutation_invariant() {
        let vm = TestVM::default();
        let contract = SyntheticOptimizer::from(&vm);
        let (_, mut core, _) = fixture_requests()
            .into_iter()
            .find(|(_, r, _)| r.candidates.len() > 1)
            .unwrap();
        let a = contract
            .evaluate_synthetic(request(core.clone()))
            .abi_encode();
        core.candidates.reverse();
        let b = contract
            .evaluate_synthetic(request(core.clone()))
            .abi_encode();
        assert_eq!(a, b);
        compare(
            &SyntheticResult::abi_decode(&b).unwrap(),
            optimize_v1(&core),
        );
    }
    #[test]
    fn sdk_router_dispatches_abi_and_rejects_bad_selector_and_calldata() {
        use alloy_sol_types::SolCall;
        use stylus_sdk::abi::Router;
        let vm = TestVM::default();
        let mut contract = SyntheticOptimizer::from(&vm);
        let (_, core, _) = fixture_requests().into_iter().next().unwrap();
        let expected = optimize_v1(&core);
        let calldata = evaluateSyntheticCall { request: request(core) }.abi_encode();
        let selector = u32::from_be_bytes(evaluateSyntheticCall::SELECTOR);
        let output = SyntheticOptimizer::route(&mut contract, selector, &calldata[4..])
            .expect("known selector").expect("valid calldata");
        let decoded = evaluateSyntheticCall::abi_decode_returns(&output).unwrap();
        compare(&decoded, expected);
        assert!(SyntheticOptimizer::route(&mut contract, selector ^ 1, &calldata[4..]).is_none());
        assert!(SyntheticOptimizer::route(&mut contract, selector, &[]).unwrap().is_err());
    }

    #[test]
    fn candidate_limit_ties_and_maximum_widths_match_core() {
        let vm = TestVM::default();
        let contract = SyntheticOptimizer::from(&vm);
        let (_, mut core, _) = fixture_requests().into_iter()
            .find(|(_, r, _)| r.candidates.len() == 1 && optimize_v1(r).is_ok()).unwrap();
        let candidate = core.candidates[0].clone();
        core.candidates = (0..64).map(|i| {
            let mut c = candidate.clone();
            let mut id = [0u8; 32];
            id[31] = i;
            c.route_id = id.into();
            c
        }).collect();
        let expected = optimize_v1(&core);
        compare(&contract.evaluate_synthetic(request(core.clone())), expected);
        core.amount_in = u128::MAX;
        core.user_min_out = u128::MAX;
        core.candidates[0].rate_numerator = u128::MAX;
        core.candidates[0].available_input = u128::MAX;
        core.candidates[0].available_output = u128::MAX;
        core.candidates[0].max_input = u128::MAX;
        compare(&contract.evaluate_synthetic(request(core.clone())), optimize_v1(&core));
        core.candidates.clear();
        compare(&contract.evaluate_synthetic(request(core.clone())), optimize_v1(&core));
    }

}
