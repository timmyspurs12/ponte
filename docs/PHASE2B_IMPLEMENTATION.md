# Phase 2B.1: offline synthetic optimizer

This is an isolated library and a test adapter, **not** an application integration, contract, pool discovery engine, trade executor, or payment settlement system. All routes, liquidity, costs, assets and rates in the fixtures and benchmarks are synthetic. The existing `src/lib/quotes.ts` and application state machine are unchanged. The synthetic two-decimal USDG convention is not evidence of on-chain token decimals.

## Contract and arithmetic

`rust/optimizer` is a separate Rust 2021 package pinned to Rust 1.91.0. Its `no_std + alloc` library forbids unsafe code in this crate and does not access a filesystem, environment, network, database, process, clock, or blockchain. The host-only `optimizer-v1` binary provides JSON-lines testing and benchmarking; it is not a production API. The caller supplies the evaluation time: timestamps and snapshot IDs are not authenticated and provide no anti-replay guarantee. Consumers must supply trustworthy data and impose their own request-size and resource limits. The JSON-lines adapter expects UTF-8 input.

The V1 JSON format requires the exact field sets implemented in `scripts/phase2b/json.ts`, lowercase `0x`-prefixed bytes32 IDs, canonical unsigned decimal **strings** for amounts, rates, costs and timestamps, and integer JSON tokens for version, decimals and bps. Duplicate keys, malformed JSON, lone surrogates and excessive nesting are rejected. Asset identifiers are printable ASCII, 1–64 bytes, and decimals are metadata in 0–38; no decimal rescaling is performed. Rate numerator and denominator express output base units per input base unit. Amounts, rates, liquidity and costs are bounded by `u128`; timestamps by `u64`; basis points by `u16` and 10,000. Structural errors are distinct typed errors, not route rejections.

For input `F`, numerator `N`, denominator `D`, route fee `f` and tolerance `t`, the implementation preserves these floors and multiplication order:

```text
G      = floor(F * N / D)
O      = floor(F * N * (10000 - f) / (D * 10000))
feeOut = G - O
T      = floor(O * (10000 - t) / 10000)
M      = max(T, userMinOut)
```

All intermediate multiplications are checked against U256 and every output conversion against U128. Overflow rejects the candidate even if cancellation could have made the quotient fit. Displayed estimated impact is descriptive and is not deducted; execution cost in USD cents is only a tie-breaker, not a token deduction. No partial fills or fallback quotes are fabricated.

Validation precedes evaluation: candidate IDs are unique, snapshots match, rates are positive and bounds are ordered. Cross-candidate checks are in canonical route-ID order. Candidate rejection precedence is `EXPIRED`, `BELOW_MIN`, `CAPACITY`, `INPUT_LIQUIDITY`, `ARITHMETIC_RANGE`, `ZERO_OUTPUT`, `OUTPUT_LIQUIDITY`, `USER_MIN_UNMET`; effective expiry is the earlier request/candidate expiry, with equality expired. The winner maximizes expected output, then minimizes execution cost, then uses the lexicographically smallest route ID. Rejections are returned in route-ID order; if none are feasible, the result is `NO_ROUTE`.

## Dependency decision

`alloy-primitives = =1.5.7` with default features disabled follows the documented Stylus SDK v0.10.10 baseline, without depending on the SDK. Cargo generated and locked the full resolver graph in `rust/optimizer/Cargo.lock` (SHA-256 `94194a82e481db48985f8927a9c1b967e17d27dbd2184e06bc2a51f75b19c6d2`); CI uses `--locked` and checks the file remains unchanged. The lockfile includes optional dependencies that are not necessarily built by this feature set. Rust 1.91 native and `wasm32-unknown-unknown` debug and release **library compilation** passed on a standard hosted runner. `#![forbid(unsafe_code)]` applies to our crate, not to third-party dependencies.

A manual comparison of all locked crate versions with the RustSec advisory database at commit `02e2517f457a359fc6d3440ea4560c8ea188fee8` found no applicable vulnerability or unsoundness advisory; this is not a continuously running `cargo audit` and does not guarantee future safety. The informational unmaintained advisory `RUSTSEC-2024-0436` applies to `paste 1.0.15`, a transitive compile-time procedural macro; it is retained for baseline compatibility. Notable patched versions include `bytes 1.12.1`, `keccak 0.1.6`, and `ruint 1.21.1`. Recheck advisories when updating dependencies.

## Correctness tests and reproducibility

The TypeScript BigInt reference independently implements validation, arithmetic bounds and wire encoding. The static fixture sets contain 41 edge cases, 12 legacy parity vectors and 7 minimized boundary/regression cases. Tests cover overflow before cancellation, rounding, liquidity, expiry, duplicate IDs, tie-breaking, 64/65 candidates, malformed JSON and errors. The Rust suite has 8 unit/property tests plus 3 integration tests loading all 60 vectors. The TypeScript suite has 7 deterministic tests. Property checks include repeatability, permutation invariance, conservation, bounds, and selected-route feasibility. These finite tests are not an exhaustive proof; malformed input fuzzing is bounded.

On [CI run 43957536859](https://github.com/timmyspurs12/ponte/actions/runs/43957536859), the differential seed `0x504f4e54455f3242` produced 10,760 comparisons: 60 static, 10,000 generated synthetic, 500 permutation cases, and 200 adversarial cases. Results: 5,236 selected, 3,298 no-route, 2,226 errors; 10,760 matches, **0 mismatches**. On a mismatch the harness delta-minimizes candidate lists where possible and writes counterexamples to the summary artifact; review and promote confirmed minimal regressions to the versioned fixture suite. No additional generated discrepancy was found in this run.

Legacy parity uses the untouched `quote()` implementation for inputs 100, 2500000 and 1000000000, with synthetic Direct/Split/Multi fee/impact bps 35/5, 48/8 and 65/12, rate 100/525 and tolerance 50. Rust and TypeScript match all nine per-route gross, fee, expected and minimum values; 18 permutation checks and 27 non-deduction-of-impact checks also passed.

From the repository root (Node 22 and Rust 1.91 with rustfmt, clippy and the WASM target installed):

```sh
npm ci
(cd rust/optimizer && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked)
(cd rust/optimizer && cargo build --locked --release && cargo build --locked --lib --release --target wasm32-unknown-unknown)
node --import tsx --test scripts/phase2b/property.test.ts
node --import tsx scripts/phase2b/legacy-parity.ts --rust-bin rust/optimizer/target/release/optimizer-v1
node --import tsx scripts/phase2b/differential-harness.ts --rust-bin rust/optimizer/target/release/optimizer-v1 --count 10000
node --import tsx scripts/phase2b/benchmark.ts --rust-bin rust/optimizer/target/release/optimizer-v1 --runs 5 --warmup-passes 20 --measure-passes 100 --dataset-size 100
```

## Native host benchmark

These measurements are from [CI run 43958244133](https://github.com/timmyspurs12/ponte/actions/runs/43958244133) at `2026-11-16T21:19:14Z`, on standard `ubuntu-latest` (Ubuntu 26.04.1, Linux x86-64, Intel Xeon Platinum 8370C, 4 logical CPUs, ~16 GiB RAM), Node `v22.23.4`, and a release binary built with rustc `1.91.0` / Cargo `1.91.0`. That run's benchmark report incorrectly displayed the runner's default Rust 1.99.1 because its version probe ran outside the crate; the run's environment log and pinned toolchain establish the compiler actually used, and the probe has since been corrected.

Seed `0x504f4e54455f424d`: each dataset contains 100 identical synthetic requests per implementation, five separate OS process runs, 20 warmup passes and 100 measured passes (2,000 / 10,000 evaluations per run). Core timings use already-parsed requests; JSON roundtrip includes parsing, validation, core evaluation and serialization, but excludes process startup and reading files. JSON measurements use 5 warmup and 20 measured passes (500 / 2,000 evaluations per run). The percentiles are over **batch mean ns per request**, across passes and processes, not individual-request tail latency. Timers are `process.hrtime.bigint()` and `std::time::Instant`. Shared hosted hardware and JIT effects make results variable. The observed native Rust core median was lower in every listed dataset on this run; this is not a universal performance guarantee.

## Pre-parsed Core Evaluation (ns / evaluation)

| Dataset | Candidates | Scenario | TS p50 (ns) | TS p95 (ns) | TS p99 (ns) | Rust p50 (ns) | Rust p95 (ns) | Rust p99 (ns) | TS/Rust p50 |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| valid_01_cand | 1 | all_valid | 2720 | 8088 | 9434 | 111 | 170 | 271 | 24.5x |
| valid_03_cand | 3 | all_valid | 6108 | 8213 | 12620 | 235 | 300 | 565 | 25.99x |
| valid_08_cand | 8 | all_valid | 13495 | 15665 | 16874 | 869 | 1256 | 1501 | 15.53x |
| valid_16_cand | 16 | all_valid | 26054 | 28425 | 30384 | 1173 | 2558 | 3333 | 22.21x |
| valid_32_cand | 32 | all_valid | 51898 | 62036 | 65271 | 2538 | 2649 | 2770 | 20.45x |
| valid_64_cand | 64 | all_valid | 104784 | 108352 | 110439 | 5915 | 6054 | 6226 | 17.71x |
| mixed_16_cand | 16 | mixed_rejected | 20005 | 22713 | 23771 | 1295 | 1955 | 2383 | 15.45x |
| mixed_64_cand | 64 | mixed_rejected | 82576 | 87300 | 92467 | 4587 | 4782 | 5010 | 18x |
| ties_32_cand | 32 | equal_ties | 53030 | 56574 | 66688 | 2626 | 2748 | 2874 | 20.19x |
| ties_64_cand | 64 | equal_ties | 106873 | 111014 | 114470 | 6249 | 7034 | 7240 | 17.1x |
| boundary_16_cand | 16 | numeric_boundary | 30905 | 33476 | 37901 | 1658 | 3349 | 4277 | 18.64x |

## JSON Parse + Core Evaluate + Canonical Serialize (ns / line)

| Dataset | Candidates | TS JSON p50 (ns) | TS JSON p95 (ns) | Rust JSON p50 (ns) | Rust JSON p95 (ns) |
|---|---:|---:|---:|---:|---:|
| valid_01_cand | 1 | 37013 | 50032 | 9647 | 17429 |
| valid_03_cand | 3 | 78873 | 85582 | 18326 | 32488 |
| valid_08_cand | 8 | 176390 | 211516 | 42508 | 44235 |
| valid_16_cand | 16 | 335742 | 374641 | 80440 | 84917 |
| valid_32_cand | 32 | 671200 | 706216 | 156169 | 161017 |
| valid_64_cand | 64 | 1344461 | 1379708 | 305341 | 318857 |
| mixed_16_cand | 16 | 331547 | 361631 | 86015 | 88739 |
| mixed_64_cand | 64 | 1329871 | 1364880 | 327500 | 340591 |
| ties_32_cand | 32 | 669032 | 681419 | 155380 | 160808 |
| ties_64_cand | 64 | 1343785 | 1368225 | 305243 | 309929 |
| boundary_16_cand | 16 | 444128 | 487608 | 91661 | 97203 |

*Note: Host microbenchmark only on synthetic offline inputs. Does not represent WASM execution, Arbitrum Stylus gas/ink, RPC latency, or production settlement throughput.*

