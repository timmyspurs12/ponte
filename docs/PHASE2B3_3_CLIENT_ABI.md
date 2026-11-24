# Phase 2B.3.3 — Complete synthetic client ABI

## Scope and source of truth

`rust/stylus-wrapper/abi/ISyntheticOptimizer.sol` is a **separately authored and maintained** Solidity interface matching the existing `sol!` types and `#[public]` method in `rust/stylus-wrapper/src/lib.rs`. It is not SDK-generated. It declares every input/output struct, including the nested candidate and rejection arrays, and uses `SyntheticRequest calldata` and `SyntheticResult memory`. The only external method is `evaluateSynthetic`, `view` and nonpayable. Its selector is **`0x31631981`**. Solidity `Rejection` is a result struct; `errorCode` is a result string, not a Solidity custom error declaration.

`abi/SyntheticOptimizer.abi.json` is the canonical client-facing JSON ABI **compiled from that interface**. No wrapper production code, selector, request/result encoding, core arithmetic or calldata gate was changed. The SDK 0.10.10 raw Solidity export remains a separate historical/checking artifact: its current exporter omits input-only struct declarations and the request data location. The CI `check_abi.py` checks selected SDK declarations; it is not the complete client ABI generator. No claim is made that `cargo stylus export-abi --json` repairs those omissions.

## Reproduction and integrity

Requirements: Node (the project currently pins **24.22.1**) and npm, with registry access for the initial install or a preprovisioned npm cache. These commands were originally recorded under Node 22; the Node version does not affect the ABI artefacts. From the repository root:

```sh
npm --prefix rust/stylus-wrapper/abi-tools ci --ignore-scripts --no-audit --no-fund
npm --prefix rust/stylus-wrapper/abi-tools run generate
npm --prefix rust/stylus-wrapper/abi-tools run check
npm --prefix rust/stylus-wrapper/abi-tools test
```

The isolated `abi-tools/package-lock.json` pins npm tarball integrity and versions; it does not alter root or Cargo dependencies. The generator verifies **solc-js 0.8.30+commit.73712a01.Emscripten.clang**, and checks `soljson.js` SHA-256 `3bb491a777f76dff9b2fe73ce29ca20e21a971b59a2f2cf8f73415424f00be06`. It invokes the compiler's standard-JSON interface on the checked-in Solidity source without imports; compilation errors fail the command. It extracts only the named interface's `abi`, verifies the compiler-reported method identifier, serializes JSON with two-space indentation and a final newline, and compiles twice to detect nondeterminism. `--check` compares the exact bytes with the committed artifact. This is compiler-generated output, not a manually assembled SDK export. Ethers **6.16.0**, also isolated and locked, is used only by tests.

The integrity test compares all nested component names, order, types, widths, array structure and internal struct identities against an explicit expected inventory and the wrapper's `sol!` declarations. It separately checks the complete request/result canonical tuple strings against `expected-request-tuple.txt` and `expected-result-tuple.txt`, the method name, `view`, selector, and input/output data locations in the Solidity source. Intentional mutations to nested fields, order, widths, signature and mutability must fail. Ethers encodes and decodes representative request/result values, including dynamic strings and rejection arrays.

The wrapper workflow also tests the generated JSON ABI against the actual release WASM in Node's offline WebAssembly runtime with host stubs:

```sh
# After the existing locked release WASM build:
node rust/stylus-wrapper/abi-tools/test-wasm.cjs \
  rust/stylus-wrapper/target/wasm32-unknown-unknown/release/ponte_stylus_wrapper.wasm
```

The test uses the existing explicit fixture classification: 49 ABI-representable fixture requests are encoded and round-tripped with ethers; the 48 at or below 64 candidates pass through the WASM entrypoint and their decoded results are compared to fixture expectations. The 65-candidate fixture must revert before the typed method, consistent with the merged raw/preflight boundary. The 11 JSON-only or unrepresentable cases stay explicitly skipped. The set includes counts 0, 1, 64 and 65. The existing separate WASM boundary tests remain in place.

## Verified and unverified

Local generation with the pinned compiler, two identical regenerations, ABI inventory/drift tests and fixture client round trips were executed. Rust/Cargo and a compiled wrapper WASM were not available locally. The implementation's [wrapper CI run](https://github.com/timmyspurs12/ponte/actions/runs/44067830993) passed native/TestVM tests, Clippy, WASM compilation and offline host-stub execution, including all generated-ABI fixture comparisons; the [optimizer regression run](https://github.com/timmyspurs12/ponte/actions/runs/44068447937) passed. Consult the PR checks for the final commit. Node host-stub WASM execution is not Nitro runtime execution, gas/memory metering, RPC-based Stylus validation, deployment or activation. The ABI artifact is a compatibility description, not proof of authenticated inputs, safe economic use, chain eligibility, or deployment readiness. No wallet, transactions, RPC or `cargo stylus check` are involved.
