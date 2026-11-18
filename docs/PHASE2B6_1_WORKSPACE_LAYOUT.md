# Phase 2B.6.1 — Cargo workspace root and reproducible container path

> **Build and packaging only.** This is a follow-up to [Phase 2B.6.0](PHASE2B6_TESTNET_ARTIFACT_READINESS.md) on the same PR branch. It changes the Rust workspace layout so the pinned `cargo-stylus` reproducible-container path can build the contract. It performs **no** RPC check, deploy, activation or verification and uses no wallet, key, funding or transaction. Nothing was deployed to Arbitrum Sepolia, and the artifact remains a synthetic-only, unactivated candidate.

## 1. Why the layout changed

The pinned CLI is `cargo-stylus` 0.10.10 from [`OffchainLabs/stylus-sdk-rs` `76f8b055`](https://github.com/OffchainLabs/stylus-sdk-rs/tree/76f8b055ec0bf421edd542b164dc2917c9e4e0bd/cargo-stylus). Its `run_reproducible()` calls `cargo metadata` and mounts **the Cargo workspace root** at `/source` (`stylus-tools/src/core/build/reproducible.rs`). It is used by `cargo stylus deploy` and `verify`; `build`, `check` and `get-initcode` still run on the host.

Before this change the workspace root was `rust/stylus-wrapper`, while `ponte-optimizer` was a path dependency at `../optimizer`. Only `rust/stylus-wrapper` was mounted, so the CLI-equivalent container build failed with `failed to load manifest for dependency ponte-optimizer … failed to read /optimizer/Cargo.toml`. Phase 2B.6.0 measured that failure in [run 44367877896, §7](PHASE2B6_TESTNET_ARTIFACT_READINESS.md#7-reproducibility-findings).

The fix moves the Cargo workspace root up one directory so `optimizer` and `stylus-wrapper` are both inside the mounted source tree. It does **not** change any Rust source, package dependency versions, network target or contract behavior.

## 2. Layout before and after

| Path | Before | After |
| --- | --- | --- |
| `rust/Cargo.toml` | absent | new virtual workspace: `members = ["stylus-wrapper"]`, `exclude = ["optimizer", "environment-check"]`, `resolver = "2"` |
| `rust/Cargo.lock` | absent | pure `git mv` of `rust/stylus-wrapper/Cargo.lock`; byte-identical, SHA-256 `a8e5be8a261b729008383353d4f6aaa11fff5763263ef6923771e4c32d842f50` |
| `rust/Stylus.toml` | absent | new root manifest with the `[workspace]` table and its `networks` entry required by 0.10.10 |
| `rust/stylus-wrapper/Stylus.toml` | `[workspace]` + networks + `[contract]` | back to the minimal `[contract]` file, SHA-256 `6e21fc54067a316879b48697e1b0cf8d2c95c216060c512d40deb6246cf0f84e`; **not deleted** |
| `rust/stylus-wrapper/Cargo.toml` | had an empty `[workspace]` | package manifest only; dependencies unchanged |
| `rust/rust-toolchain.toml` | absent | pure `git mv` of `rust/stylus-wrapper/rust-toolchain.toml`; SHA-256 `c035cac193ded05cf0c2f2b241336a6240b888f279bd303bc1636582fd5ab8c8` |
| `rust/.gitignore` | absent | `/target/`; the release WASM now lands in `rust/target/` |
| `rust/stylus-wrapper/.gitignore` | `/target/` | removed (moved to the workspace root) |
| `rust/optimizer`, `rust/environment-check` | their own `[workspace]`, lockfile, toolchain | unchanged |

Both new workspace-level files are required for the container path: without `rust/Stylus.toml`, `Workspace::current()` cannot load the root Stylus manifest; without the root toolchain file, `get_toolchain_channel()` and `hash_project()` cannot find a pinned toolchain. `rustup` finds the moved toolchain file by walking upward from `rust/stylus-wrapper`.

Neither `Stylus.toml` nor `.gitignore` is a cargo-stylus project-hash input. No `[wasm-opt]` table exists in either Stylus manifest, so no optimization recipe was enabled.

## 3. Project hash: 7 files → 20 files

`hash_project()` walks the directory it is given and includes all `*.rs`, `Cargo.toml` and `Cargo.lock` files (skipping only `target/` and `.git/`), plus the first `rust-toolchain.toml` found walking upward. With the old package workspace root it hashed 7 files under `rust/stylus-wrapper`, none from `optimizer`. With the new workspace root the container's `cargo stylus get-initcode` printed exactly **20** files under `/source`:

```text
Cargo.lock
Cargo.toml
environment-check/Cargo.lock
environment-check/Cargo.toml
environment-check/src/lib.rs
optimizer/Cargo.lock
optimizer/Cargo.toml
optimizer/src/arithmetic.rs
optimizer/src/bin/optimizer-v1.rs
optimizer/src/json.rs
optimizer/src/lib.rs
optimizer/src/model.rs
optimizer/src/optimizer.rs
optimizer/tests/static_fixtures.rs
rust-toolchain.toml
stylus-wrapper/Cargo.toml
stylus-wrapper/src/calldata.rs
stylus-wrapper/src/fixture_classification.rs
stylus-wrapper/src/lib.rs
stylus-wrapper/src/main.rs
```

This includes the optimizer's own lockfile and both crates' previously excluded sources. The CLI's container project hash at `/source` was `dcc4f735fcbfe7fb214d3a3dfda06567f5104684a54d14aebfebe962e5e4f70f`. The hash preimage includes each **absolute** path, so the same source at a different path yields a different project hash; the workflow records the full list in `provenance.json` under `reproducible_docker_path.get_initcode.project_hash_files`.

## 4. What the workflow now checks

The wallet-free workflow [`.github/workflows/stylus-testnet-artifact.yml`](../.github/workflows/stylus-testnet-artifact.yml) is unchanged in its permissions (`contents: read`, no secrets) and still runs only offline commands. The stage script `scripts/phase2b6/stylus-candidate.sh` now:

- derives the Docker source root from `cargo metadata --no-deps --format-version 1` and asserts it is `rust/`;
- exports the whole `rust/` tree twice and mounts each `<export>/rust` at `/source`, exactly as `run_in_container()` does, then compares the two builds with `cmp`;
- runs `cargo stylus get-initcode` in that container, records the CLI's hashed-file list and project hash, and captures the init code;
- gates on the WASM file existing after every `cargo stylus build`. `Contract::is_contract()` only checks for a `Stylus.toml` beside the package: with that file removed, the CLI finds zero contracts and exits **0** without building anything. A control probe with the minimal `[contract]` file must still produce a WASM; the no-manifest probe must produce none.

`stylus_provenance.py` records these commands, their exit codes and outputs, and can mark the record `complete` only when all required gates ran. `advisory_guard.py`'s two baseline identities are unchanged; only their path label moves from `rust/stylus-wrapper/Cargo.lock` to `rust/Cargo.lock`. `rustsec-evidence.sh` audits that lock under the same `stylus-wrapper` label and continues to use each isolated crate's own lockfile for the other two audits. `summarize-dependency-evidence.py` contains no lockfile paths and needed no change.

## 5. Measured results

Source: [successful candidate run 44398147388](https://github.com/timmyspurs12/ponte/actions/runs/44398147388) on the last code commit `d3dae37`, with all 17 steps passing and `status: complete`. The immediately preceding [run 44395466645](https://github.com/timmyspurs12/ponte/actions/runs/44395466645) on `5de4b31` gave identical measurements before the container hash was added to the annotations. Earlier runs on the same branch (44367877896, 44370571297, 44390599314, 44392227814, 44393907939) are the superseded baseline, the path-fix diagnostics and the failed container-path attempts; their failures are recorded in the workflow annotations.

### 5.1 Host build and offline CLI

| Measurement | Old layout | New layout |
| --- | --- | --- |
| Raw WASM size | 90,506 bytes | **90,498 bytes** |
| Raw WASM SHA-256 | `6fd9159d…` | **`b3574ee3ee4c9bbc11c2fe103c101008f5b775b5890ad1fbefe118b8846f3a3f`** |
| Relocated checkout | different hash (`304e882c…`) | **identical** to the normal checkout |
| CLI `cargo stylus build` | byte-identical to direct build | byte-identical to direct build |
| Host `get-initcode` compressed bytes | 24,126 (450 bytes headroom) | 24,104 (472 bytes headroom) |

The raw WASM changed because rustc no longer embeds the checkout-specific `/home/runner/work/ponte/ponte/rust/optimizer/src/optimizer.rs`; its path strings are now generic fragments such as `/src/lib.rs` and `/alloc/src/string.rs` under the `rust/` workspace root. Relocating the checkout therefore no longer changes the raw WASM; the project hash and init code are still absolute-path-dependent. The previously misleading claim that the old WASM was reproducible across checkout paths does not apply to the old layout; see [Phase 2B.6.0 §7](PHASE2B6_TESTNET_ARTIFACT_READINESS.md#7-reproducibility-findings).

Exports, VM-hook imports and the exact release command are unchanged: `memory`, `user_entrypoint`, `__heap_base`, `__data_end`; hooks `pay_for_memory_grow`, `msg_reentrant`, `msg_value`, `storage_flush_cache`, `write_result`, `read_args`. All offline wrapper tests, ABI checks, `advisory-guard --check-baseline`, and the lockfile/tracked-file integrity checks passed.

### 5.2 Reproducible container path

- Base image `offchainlabs/cargo-stylus-base:0.10.10`, digest `sha256:7ec994ea0d065859389d3e433b7a1efc163ad5415d40bb4ed9b323ddc636c57d`, image ID `sha256:f35f28e7201ae429952c0a7c62f67c3ebfe624120692ff50b20ab3a11d2aa5a8`, derived-image ID `sha256:4d9346ebf4cbf57d334b5360375af340c8ac2ed6fd3a144dc6e06e87500d1fbc`.
- Two clean `rust/` exports built at `/source` with exit 0 and byte-identical raw WASM (`cmp` exit 0). Raw WASM SHA-256: `42d8a474d8762aa37df09c9c415dcec1ff7e904e8bfcdcfa365669ad30cd93d2`.
- Container `cargo stylus get-initcode` exit 0: 20 hashed files, project hash `dcc4f735fcbfe7fb214d3a3dfda06567f5104684a54d14aebfebe962e5e4f70f`, init code 24,151 bytes, deployed code 24,108 bytes, Brotli-compressed program **24,084 bytes**. That is **492 bytes** below the 24,576-byte single-contract limit; no fragmentation.
- The container output differs from the host output because the derived image installs `rust-src` and uses `/usr/local/cargo` and `/source` paths. A diagnostic full-repository build gave `42d8a474d8762aa37df09c9c415dcec1ff7e904e8bfcdcfa365669ad30cd93d2`; it is not a `cargo-stylus` container code path. The host build with `rust-src` added gave `d8742755635d68973110c1c7357f2ba0516177befb72c5442dd73c035a0a1003`.
- The base image is still referenced by tag, and upstream's base Dockerfile builds `cargo-stylus` without `--locked` from a floating `rust:1.91` image. Record the digest and compare it before relying on this path.

### 5.3 Dependency evidence

The [dependency evidence run 44398146869](https://github.com/timmyspurs12/ponte/actions/runs/44398146869) on the last code commit reproduced the host WASM hash `b3574ee3…` through both the verbose and exact CI build commands. The RustSec portion remains red by design: `stylus-wrapper` (`rust/Cargo.lock`) and `optimizer` have the same known findings as before, `environment-check` has none. The offline guard still classifies only the two pinned `crypto-bigint` and `lru` identities as documented baselines; it is not a release gate. [Local Stylus wrapper run 44398146837](https://github.com/timmyspurs12/ponte/actions/runs/44398146837) passed all checks, including the new path filters and the relocated `../target/...` WASM inspection.

## 6. Limitations and boundaries

- The compiled program is unchanged in behavior: it still evaluates caller-supplied, unauthenticated synthetic candidates and must not be treated as an executable quote or settlement logic.
- `cargo stylus check --endpoint`, `deploy` (with or without `--no-activate`), `activate`, `verify`, all RPC queries, all transactions and all keys remain out of scope. The container build and `get-initcode` are offline.
- The init code recorded here is not a deployment payload. Do not deploy a host-built artifact and expect a container rebuild to match its codehash; deploy from the reproducible container path and compare hashes.
- The contract's size headroom is only 492 bytes for the container build. Any code or dependency growth requires re-measurement and a fragment-deployment plan.
- Nitro activation compatibility, gas/ink, audit, activation policy and the mutable upstream base image are unchanged blockers from [Phase 2B.6.0 §§8–13](PHASE2B6_TESTNET_ARTIFACT_READINESS.md#8-path-to-arbitrum-sepolia-documented-not-performed).

## 7. Reproduction

```sh
# Offline checks; no RPC, key or transaction.
python3 -m unittest discover -s scripts/phase2b6 -p 'test_*.py' -v
python3 -m unittest discover -s rust/stylus-wrapper/scripts -p 'test_advisory_guard.py' -v
bash -n scripts/phase2b6/stylus-candidate.sh

# The staged workflow itself is dispatched manually; every stage records argv, cwd,
# timestamps, exit code, stdout and stderr in the uploaded artifact.
# cd rust/stylus-wrapper && cargo build --locked --release --lib --target wasm32-unknown-unknown
#   produces rust/target/..., not rust/stylus-wrapper/target/...
```

Confirmation run: [44398147388](https://github.com/timmyspurs12/ponte/actions/runs/44398147388) at `d3dae37f6032fbdea39d1834ef053c5676fb6a43`, all 17 steps passed, `status: complete`. Artifact ID `14471989038`, digest `sha256:cea8a6656c2d92ba4357afa3e0ace23feb4af037f43ce151a33c561a87df80c2`.
