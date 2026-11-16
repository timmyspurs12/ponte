//! Integration test verifying versioned static fixture suites directly inside Cargo tests.

#![forbid(unsafe_code)]
#![deny(clippy::float_arithmetic)]

use ponte_optimizer::{RawJsonValue, evaluate_json_line, parse_raw_json};

const EDGE_CASES_JSON: &str =
    include_str!("../../../scripts/phase2b/fixtures/v1/edge-cases.json");
const LEGACY_PARITY_JSON: &str =
    include_str!("../../../scripts/phase2b/fixtures/v1/legacy-parity.json");
const REGRESSION_MINIMIZED_JSON: &str =
    include_str!("../../../scripts/phase2b/fixtures/v1/regression-minimized.json");

fn assert_fixture_suite(raw_suite_json: &str, expected_min_vectors: usize) {
    let root = parse_raw_json(raw_suite_json).expect("valid static fixture JSON");
    let RawJsonValue::Object(suite_obj) = root else {
        panic!("suite root must be object");
    };
    assert_eq!(
        suite_obj.get("schemaVersion"),
        Some(&RawJsonValue::Int("1".to_string())),
    );
    assert_eq!(
        suite_obj.get("syntheticOnly"),
        Some(&RawJsonValue::Bool(true)),
    );

    let Some(RawJsonValue::Array(vectors)) = suite_obj.get("vectors") else {
        panic!("missing vectors array");
    };
    assert!(vectors.len() >= expected_min_vectors);

    for item in vectors {
        let RawJsonValue::Object(vec_obj) = item else {
            panic!("vector entry must be object");
        };
        let Some(RawJsonValue::String(id)) = vec_obj.get("id") else {
            panic!("missing vector id");
        };
        let Some(RawJsonValue::String(raw_req)) = vec_obj.get("rawRequestJson") else {
            panic!("missing rawRequestJson on {id}");
        };
        let Some(expected_resp) = vec_obj.get("expectedResponse") else {
            panic!("missing expectedResponse on {id}");
        };

        let actual_line = evaluate_json_line(raw_req);
        let actual_parsed =
            parse_raw_json(&actual_line).expect("optimizer output must be valid JSON");
        assert_eq!(
            &actual_parsed, expected_resp,
            "static fixture mismatch on vector {id}",
        );
    }
}

#[test]
fn edge_case_static_fixtures_match_expected_outcomes() {
    assert_fixture_suite(EDGE_CASES_JSON, 36);
}

#[test]
fn legacy_parity_static_fixtures_match_expected_outcomes() {
    assert_fixture_suite(LEGACY_PARITY_JSON, 12);
}

#[test]
fn regression_minimized_static_fixtures_match_expected_outcomes() {
    assert_fixture_suite(REGRESSION_MINIMIZED_JSON, 6);
}
