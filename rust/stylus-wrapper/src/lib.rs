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
mod fixture_classification;

#[cfg(test)]
mod tests {
    use super::fixture_classification;
    use super::*;
    use alloy_sol_types::SolValue;
    use ponte_optimizer::{parse_canonical_bytes32, parse_raw_json, RawJsonValue};
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
    // Test-only conversion preserves ABI-representable values without applying
    // JSON adapter domain validation. It does not change production parsing.
    fn object(v: &RawJsonValue) -> &alloc::collections::BTreeMap<String, RawJsonValue> {
        let RawJsonValue::Object(v) = v else {
            panic!("expected object")
        };
        v
    }
    fn text(v: &RawJsonValue) -> &str {
        let RawJsonValue::String(v) = v else {
            panic!("expected string")
        };
        v
    }
    fn integer<T: core::str::FromStr>(v: &RawJsonValue) -> T
    where
        T::Err: core::fmt::Debug,
    {
        let RawJsonValue::Int(v) = v else {
            panic!("expected JSON integer")
        };
        v.parse().unwrap()
    }
    fn decimal<T: core::str::FromStr>(v: &RawJsonValue) -> T
    where
        T::Err: core::fmt::Debug,
    {
        text(v).parse().unwrap()
    }
    fn bytes32(v: &RawJsonValue) -> stylus_sdk::alloy_primitives::B256 {
        parse_canonical_bytes32(text(v)).unwrap()
    }
    fn fixture_asset(v: &RawJsonValue) -> AssetIdV1 {
        let o = object(v);
        AssetIdV1 {
            namespace: text(&o["namespace"]).into(),
            identifier: text(&o["identifier"]).into(),
            decimals: integer(&o["decimals"]),
        }
    }
    fn fixture_request(raw: &str) -> OptimizeRequestV1 {
        let value = parse_raw_json(raw).unwrap();
        let o = object(&value);
        let RawJsonValue::Array(items) = &o["candidates"] else {
            panic!("candidates")
        };
        OptimizeRequestV1 {
            version: integer(&o["version"]),
            mode: match text(&o["mode"]) {
                "SYNTHETIC" => OptimizerMode::Synthetic,
                "LIVE" => OptimizerMode::Unsupported,
                _ => panic!("unclassified fixture mode"),
            },
            input_asset: fixture_asset(&o["inputAsset"]),
            output_asset: fixture_asset(&o["outputAsset"]),
            amount_in: decimal(&o["amountIn"]),
            user_min_out: decimal(&o["userMinOut"]),
            tolerance_bps: integer(&o["toleranceBps"]),
            as_of_unix_seconds: decimal(&o["asOfUnixSeconds"]),
            expires_at_unix_seconds: decimal(&o["expiresAtUnixSeconds"]),
            snapshot_id: bytes32(&o["snapshotId"]),
            candidates: items
                .iter()
                .map(|v| {
                    let c = object(v);
                    CandidateV1 {
                        route_id: bytes32(&c["routeId"]),
                        snapshot_id: bytes32(&c["snapshotId"]),
                        rate_numerator: decimal(&c["rateNumerator"]),
                        rate_denominator: decimal(&c["rateDenominator"]),
                        fee_bps: integer(&c["feeBps"]),
                        estimated_impact_bps: integer(&c["estimatedImpactBps"]),
                        min_input: decimal(&c["minInput"]),
                        max_input: decimal(&c["maxInput"]),
                        available_input: decimal(&c["availableInput"]),
                        available_output: decimal(&c["availableOutput"]),
                        execution_cost_usd_cents: decimal(&c["executionCostUsdCents"]),
                        expires_at_unix_seconds: decimal(&c["expiresAtUnixSeconds"]),
                    }
                })
                .collect(),
        }
    }
    fn fixture_requests() -> Vec<(String, OptimizeRequestV1, RawJsonValue)> {
        use alloc::collections::BTreeSet;
        let mut entries = Vec::new();
        let mut seen = BTreeSet::new();
        for file in [
            include_str!("../../../scripts/phase2b/fixtures/v1/edge-cases.json"),
            include_str!("../../../scripts/phase2b/fixtures/v1/legacy-parity.json"),
            include_str!("../../../scripts/phase2b/fixtures/v1/regression-minimized.json"),
        ] {
            let root = parse_raw_json(file).unwrap();
            let RawJsonValue::Array(vectors) = &object(&root)["vectors"] else {
                panic!("vectors")
            };
            for vector in vectors {
                let v = object(vector);
                let id = text(&v["id"]);
                assert!(seen.insert(id.to_owned()), "duplicate fixture {id}");
                let (_, reason) = fixture_classification::FIXTURES
                    .iter()
                    .find(|(known, _)| *known == id)
                    .unwrap_or_else(|| panic!("unclassified fixture {id}"));
                if reason.is_empty() {
                    let raw = text(&v["rawRequestJson"]);
                    entries.push((
                        id.into(),
                        fixture_request(raw),
                        v["expectedResponse"].clone(),
                    ));
                }
            }
        }
        assert_eq!(
            seen.len(),
            fixture_classification::FIXTURES.len(),
            "missing classified fixture"
        );
        for (id, _) in fixture_classification::FIXTURES {
            assert!(seen.contains(*id), "missing fixture {id}");
        }
        assert_eq!(entries.len(), 49);
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
                assert_eq!(actual.selectedRouteId, stylus_sdk::alloy_primitives::B256::ZERO);
                assert_eq!(
                    (
                        actual.amountIn,
                        actual.grossOut,
                        actual.feeOut,
                        actual.expectedOut,
                        actual.minimumOut,
                        actual.executionCostUsdCents,
                        actual.effectiveExpiry
                    ),
                    (0, 0, 0, 0, 0, 0, 0)
                );
                assert_eq!(actual.snapshotId, stylus_sdk::alloy_primitives::B256::ZERO);
                assert_eq!(actual.evaluatedCount, 0);
                assert!(actual.rejected.is_empty());
            }
            Ok(outcome) => {
                let (count, rejects) = match outcome {
                    OptimizeOutcomeV1::Selected(s) => {
                        assert_eq!(actual.status, 1);
                        assert!(actual.errorCode.is_empty());
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
                        assert!(actual.errorCode.is_empty());
                        assert_eq!(actual.selectedRouteId, stylus_sdk::alloy_primitives::B256::ZERO);
                        assert_eq!(
                            (
                                actual.grossOut,
                                actual.feeOut,
                                actual.expectedOut,
                                actual.minimumOut,
                                actual.executionCostUsdCents,
                                actual.effectiveExpiry
                            ),
                            (0, 0, 0, 0, 0, 0)
                        );
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
    fn route(
        contract: &mut SyntheticOptimizer,
        input: SyntheticRequest,
    ) -> Result<SyntheticResult, Vec<u8>> {
        use alloy_sol_types::SolCall;
        use stylus_sdk::abi::Router;
        let data = evaluateSyntheticCall { request: input }.abi_encode();
        let selector = u32::from_be_bytes(evaluateSyntheticCall::SELECTOR);
        let output = SyntheticOptimizer::route(contract, selector, &data[4..]).unwrap()?;
        Ok(evaluateSyntheticCall::abi_decode_returns(&output).unwrap())
    }

    #[test]
    fn synthetic_fixture_parity_through_testvm_and_abi_roundtrip() {
        let vm = TestVM::default();
        let contract = SyntheticOptimizer::from(&vm);
        let fixtures = fixture_requests();
        assert_eq!(fixtures.len(), 49);
        for (id, core, expected) in fixtures {
            let core_result = optimize_v1(&core);
            let core_json = ponte_optimizer::format_result_v1_json(&core_result);
            assert_eq!(
                parse_raw_json(&core_json).unwrap(),
                expected,
                "fixture {id}"
            );
            let encoded = request(core.clone()).abi_encode();
            let decoded = SyntheticRequest::abi_decode(&encoded).unwrap();
            let actual = contract.evaluate_synthetic(decoded);
            let result_bytes = actual.abi_encode();
            let roundtrip = SyntheticResult::abi_decode(&result_bytes).unwrap();
            compare(&roundtrip, core_result.clone());
            let routed = route(&mut SyntheticOptimizer::from(&vm), request(core)).unwrap();
            compare(&routed, core_result);
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
        let calldata = evaluateSyntheticCall {
            request: request(core),
        }
        .abi_encode();
        let selector = u32::from_be_bytes(evaluateSyntheticCall::SELECTOR);
        let output = SyntheticOptimizer::route(&mut contract, selector, &calldata[4..])
            .expect("known selector")
            .expect("valid calldata");
        let decoded = evaluateSyntheticCall::abi_decode_returns(&output).unwrap();
        compare(&decoded, expected);
        assert!(SyntheticOptimizer::route(&mut contract, selector ^ 1, &calldata[4..]).is_none());
        assert!(SyntheticOptimizer::route(&mut contract, selector, &[])
            .unwrap()
            .is_err());
    }

    #[test]
    fn candidate_limit_ties_and_maximum_widths_match_core() {
        let vm = TestVM::default();
        let contract = SyntheticOptimizer::from(&vm);
        let (_, mut core, _) = fixture_requests()
            .into_iter()
            .find(|(_, r, _)| r.candidates.len() == 1 && optimize_v1(r).is_ok())
            .unwrap();
        let candidate = core.candidates[0].clone();
        core.candidates = (0..64)
            .map(|i| {
                let mut c = candidate.clone();
                let mut id = [0u8; 32];
                id[31] = i;
                c.route_id = id.into();
                c
            })
            .collect();
        let expected = optimize_v1(&core);
        compare(
            &contract.evaluate_synthetic(request(core.clone())),
            expected,
        );
        core.amount_in = u128::MAX;
        core.user_min_out = u128::MAX;
        core.candidates[0].rate_numerator = u128::MAX;
        core.candidates[0].available_input = u128::MAX;
        core.candidates[0].available_output = u128::MAX;
        core.candidates[0].max_input = u128::MAX;
        compare(
            &contract.evaluate_synthetic(request(core.clone())),
            optimize_v1(&core),
        );
        core.candidates.clear();
        compare(
            &contract.evaluate_synthetic(request(core.clone())),
            optimize_v1(&core),
        );
    }
    #[test]
    fn typed_and_routed_invalid_counts_preserve_validation_precedence() {
        let vm = TestVM::default();
        let mut contract = SyntheticOptimizer::from(&vm);
        let (_, original, _) = fixture_requests()
            .into_iter()
            .find(|(_, r, _)| r.candidates.len() == 1 && optimize_v1(r).is_ok())
            .unwrap();
        for count in [0, 65] {
            let mut base = original.clone();
            base.candidates = (0..count).map(|_| original.candidates[0].clone()).collect();
            // Candidate defects (invalid bps, duplicate IDs, wrong snapshot and zero rate)
            // cannot outrank the invalid count.
            for c in &mut base.candidates {
                c.fee_bps = 10001;
                c.rate_denominator = 0;
                c.snapshot_id = Default::default();
            }
            let mut cases = Vec::new();
            cases.push((base.clone(), "INVALID_CANDIDATE_COUNT"));
            let mut r = base.clone();
            r.version = 2;
            cases.push((r, "UNSUPPORTED_VERSION"));
            let mut r = base.clone();
            r.mode = OptimizerMode::Unsupported;
            cases.push((r, "UNSUPPORTED_MODE"));
            let mut r = base.clone();
            r.input_asset.identifier.clear();
            cases.push((r, "INVALID_ASSET"));
            let mut r = base.clone();
            r.output_asset.decimals = 39;
            cases.push((r, "INVALID_ASSET_DECIMALS"));
            let mut r = base.clone();
            r.amount_in = 0;
            cases.push((r, "INVALID_AMOUNT_IN"));
            let mut r = base.clone();
            r.tolerance_bps = 10001;
            cases.push((r, "INVALID_BPS"));
            let mut r = base.clone();
            r.as_of_unix_seconds = r.expires_at_unix_seconds;
            cases.push((r, "INVALID_REQUEST_EXPIRY"));
            // Earlier invalid fields continue to win even when several coexist.
            let mut r = base.clone();
            r.version = 2;
            r.mode = OptimizerMode::Unsupported;
            r.input_asset.identifier.clear();
            r.amount_in = 0;
            cases.push((r, "UNSUPPORTED_VERSION"));
            for (r, code) in cases {
                let core = optimize_v1(&r);
                assert_eq!(core.as_ref().unwrap_err().code(), code);
                compare(
                    &contract.evaluate_synthetic(request(r.clone())),
                    core.clone(),
                );
                compare(&route(&mut contract, request(r)).unwrap(), core);
            }
        }
        // Candidate bps is checked once the count is valid.
        let mut r = original;
        r.candidates[0].fee_bps = 10001;
        assert_eq!(optimize_v1(&r).unwrap_err().code(), "INVALID_BPS");
        compare(
            &route(&mut contract, request(r.clone())).unwrap(),
            optimize_v1(&r),
        );
    }

    #[test]
    fn sdk_router_alloy_1_5_7_dynamic_decoder_regressions() {
        use alloy_sol_types::SolCall;
        use stylus_sdk::abi::Router;
        fn read_word(data: &[u8], at: usize) -> usize {
            assert!(data[at..at + 24].iter().all(|b| *b == 0));
            u64::from_be_bytes(data[at + 24..at + 32].try_into().unwrap()) as usize
        }
        fn set_word(data: &mut [u8], at: usize, value: u64) {
            data[at..at + 32].fill(0);
            data[at + 24..at + 32].copy_from_slice(&value.to_be_bytes());
        }
        let vm = TestVM::default();
        let mut contract = SyntheticOptimizer::from(&vm);
        let (_, core, _) = fixture_requests().into_iter().next().unwrap();
        let data = evaluateSyntheticCall {
            request: request(core.clone()),
        }
        .abi_encode();
        assert_eq!(<SyntheticRequest as AbiType>::SELECTOR_ABI.as_str(), include_str!("../expected-request-tuple.txt").trim());
        assert_eq!(<SyntheticResult as AbiType>::SELECTOR_ABI.as_str(), include_str!("../expected-result-tuple.txt").trim());
        assert_eq!(evaluateSyntheticCall::SELECTOR, [0x31, 0x63, 0x19, 0x81]);
        let selector = u32::from_be_bytes(evaluateSyntheticCall::SELECTOR);
        let args = &data[4..];
        let request_at = read_word(args, 0);
        let asset_at = request_at + read_word(args, request_at + 2 * 32);
        let string_at = asset_at + read_word(args, asset_at);
        let string_len = read_word(args, string_at);
        assert!(string_len > 0 && string_len % 32 != 0);
        let call = |contract: &mut SyntheticOptimizer, input: &[u8]| {
            SyntheticOptimizer::route(contract, selector, input).expect("selector exists")
        };
        let original = call(&mut contract, args).unwrap();
        let mut padding = args.to_vec();
        padding[string_at + 32 + string_len] = 0x7f;
        assert_eq!(
            call(&mut contract, &padding).unwrap(),
            original,
            "dynamic string padding is accepted"
        );
        let mut trailing = args.to_vec();
        trailing.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
        assert_eq!(
            call(&mut contract, &trailing).unwrap(),
            original,
            "trailing bytes are accepted"
        );
        let mut offset = args.to_vec();
        set_word(&mut offset, request_at + 2 * 32, u64::MAX);
        assert!(
            call(&mut contract, &offset).is_err(),
            "out-of-bounds offset rejected"
        );
        let mut length = args.to_vec();
        set_word(&mut length, string_at, u64::MAX);
        assert!(
            call(&mut contract, &length).is_err(),
            "out-of-bounds string length rejected"
        );
        let mut utf8 = args.to_vec();
        utf8[string_at + 32] = 0xff;
        assert!(
            call(&mut contract, &utf8).is_err(),
            "invalid UTF-8 rejected"
        );
        let mut integer = args.to_vec();
        integer[request_at] = 1;
        assert!(
            call(&mut contract, &integer).is_err(),
            "nonzero uint16 high bits rejected"
        );
    }
}
