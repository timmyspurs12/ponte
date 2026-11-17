# Phase 2B.2: local synthetic Stylus wrapper

## Scope and status

This is an isolated, synthetic-only adapter around the existing `rust/optimizer` V1 library. The optimizer remains unchanged; no frontend, API, quote, payment, or settlement integration is introduced. This is not an executable quote, evidence of liquidity, a trade, a payment, or an audit. See [PHASE2B2_READINESS.md](PHASE2B2_READINESS.md) for the separate network-readiness assessment. **Public activation, deployment, RPC calls and transactions were not performed.** Local compilation and SDK tests do not establish network activation or deployability.

## Contract interface

`rust/stylus-wrapper/src/lib.rs` uses the official SDK `#[storage]`, `#[entrypoint]`, `#[public]` and `sol!`/`AbiType` patterns. The empty storage type has no fields; application evaluation neither reads/writes contract storage nor performs external calls. The SDK-generated entrypoint unconditionally invokes `storage_flush_cache` after routing, even for this empty-storage contract; the artifact therefore imports that hook, but does not import storage load/cache-write hooks. `evaluateSynthetic(SyntheticRequest)` accepts Solidity ABI tuples, not JSON. The source is the definitive schema; `cargo run --locked --features export-abi` prints the SDK-generated Solidity interface locally. All route, asset and amount fields represent synthetic data only.

- `version` is uint16 (1); `mode` is uint8 (1 means synthetic; any other value is unsupported).
- Assets contain namespace and identifier strings and uint8 decimals; identifiers and decimals are validated by the core. The decimals are metadata, not a verification of any on-chain token.
- Input and output quantities, rates, limits, liquidity and cost are uint128; times are uint64; bps values uint16; identifiers are bytes32. The adapter maps these to the same core widths without narrowing. Invalid ABI encodings fail at SDK decoding, rather than returning a domain error.
- `asOfUnixSeconds` and all other inputs are **caller-supplied and unauthenticated**. As-of is only a synthetic evaluation parameter. It does not prove freshness, real market state, or execution feasibility; requests can be replayed. No environment timestamp is used.
- The core enforces 1–64 candidates, scalar/asset validity, unique route IDs, snapshot consistency, and its deterministic structural-error precedence. For an invalid count the adapter passes an empty vector to preserve earlier validation precedence while avoiding conversion/sorting of candidate records. Structural errors return status 0 and `errorCode`; status 1 means selected, status 2 means no route. Unused result fields are zero/empty. Selected results include the route, input, gross, fee, expected and minimum output, cost, effective expiry and snapshot; no-route includes input and snapshot. Both include the bounded evaluated count and ordered route IDs and rejection reason strings. The core sorts candidates by route ID and applies its existing tie-breaking and rejection rules.

**Important boundary:** SDK ABI decoding occurs before the method's 64-candidate check. Dynamic arrays and strings may be allocated before application validation; this is not a pre-decode calldata/memory limit and not a denial-of-service defense. Malformed ABI input can revert at the router instead of returning status 0. No gas or throughput bounds are asserted.

## Versions and compatibility

Pinned Rust 1.91.0 and `wasm32-unknown-unknown` in `rust-toolchain.toml`; `stylus-sdk = 0.10.10` with `stylus-test` for native tests; exact Alloy primitives/sol-types and sol macro family 1.5.7; checked-in Cargo.lock for transitive reproducibility. The selected SDK's own source and examples at [v0.10.10](https://github.com/OffchainLabs/stylus-sdk-rs/tree/v0.10.10) were inspected for entrypoint, ABI export and TestVM patterns. Published documentation also mentions older SDK 0.10.7; this implementation targets 0.10.10, not an inferred API from the older documentation.

An initially unconstrained resolution combined `alloy-sol-types` 1.5.7 with macro 1.7.3 and provider 1.8.3; native SDK test/Clippy compilation failed because newer generated code referenced absent ABI decoder APIs. Aligning the ABI macro family with 1.5.7 and committing the resulting lock resolved that observed build failure without changing the core. Updating this dependency graph requires rerunning all checks; the lock is not a security audit.

## Validation

The wrapper test suite uses genuine SDK `TestVM`, including SDK `Router::route` with a generated selector, valid ABI, unknown selector and malformed input, plus typed ABI request/result round trips. It compares representable static Phase 2B fixture requests and their recorded expected JSON results with core output and adapter output, including edge cases, minimized regressions and legacy/TS parity vectors. Fixtures that cannot be parsed to typed core requests (such as malformed JSON and out-of-width integer encodings) cannot be represented by the Solidity ABI and are skipped, not counted as wrapper coverage. Additional tests exercise 0, 64 and 65 candidates, invalid precedence, uint128 extremes, and permutation behavior. The fixture suite contains tie, all rejection reason, expiry and arithmetic boundary vectors; the wrapper's fixture comparisons are not a fresh independent TypeScript execution. Previous core Rust/TS differential evidence is documented separately in `PHASE2B_IMPLEMENTATION.md`.

`.github/workflows/stylus-wrapper.yml` runs on a standard hosted Ubuntu runner: pinned toolchain install, `cargo fmt --check`, `cargo test --locked`, Clippy with warnings denied, SDK ABI export, locked release WASM compilation and `scripts/inspect_wasm.py`. The inspector checks the raw WASM header, function entrypoint and exported memory, SDK import module and basic I/O hooks, and enforces a small observed hook allowlist. SDK-generated `storage_flush_cache` is allowed; storage load/cache-write, external call and creation hooks are not. It prints actual imports and exports. It is a narrow structural inspection, not a complete WASM validator, SDK `cargo stylus check`, gas test, runtime execution of the WASM, chain compatibility check, or activation simulation. `cargo stylus check` was not run because its normal workflow includes network simulation, outside this task's authorization.

Run locally with the pinned toolchain installed:

```sh
cd rust/stylus-wrapper
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo run --locked --features export-abi
cargo build --locked --release --lib --target wasm32-unknown-unknown
python3 scripts/inspect_wasm.py target/wasm32-unknown-unknown/release/ponte_stylus_wrapper.wasm
```

Hosted fail-on-error validation [run 44038113503](https://github.com/timmyspurs12/ponte/actions/runs/44038113503), commit `aefdd5d`, passed all listed steps, including five native/SDK tests and inspection. The raw WASM was 89,625 bytes and exported `user_entrypoint` and `memory`; its six `vm_hooks` imports were `pay_for_memory_grow`, `msg_reentrant`, `msg_value`, `storage_flush_cache`, `write_result`, and `read_args`. This size is not a gas or deployability claim. The initial fail-on-error run [44037129538](https://github.com/timmyspurs12/ponte/actions/runs/44037129538) exposed the SDK-generated cache-flush hook and failed its overly strict inspection, corrected after inspecting the pinned SDK entrypoint source; diagnostic runs that intentionally swallowed failures are not passing CI evidence. No WASM execution on a chain, network permission or current activation state is inferred from these checks.
