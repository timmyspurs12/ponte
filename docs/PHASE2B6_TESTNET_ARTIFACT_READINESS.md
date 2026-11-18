# Phase 2B.6.0 — Reproducible Stylus testnet artifact readiness

> **Build and packaging only.** This phase prepares a locally built, **unactivated candidate artifact** of the existing synthetic-only PONTE Stylus wrapper and documents a controlled path toward Arbitrum Sepolia. Nothing was deployed or activated. No `cargo stylus check` ran against any RPC endpoint, and no transaction or signature was requested. No wallet, key, funding, payment, settlement or hosting deployment was involved, and nobody was contacted on PONTE's behalf.

## Status

| Item | Status |
| --- | --- |
| Contract | The existing synthetic-only evaluator in `rust/stylus-wrapper`. Rust source, `Cargo.toml` and `Cargo.lock` are unchanged from `main` `2049497485364e1ad4e11644d0972820a9b4ce06` |
| Stylus CLI | `cargo-stylus` 0.10.10 built from `cargo-stylus/` of the official [`OffchainLabs/stylus-sdk-rs` `v0.10.10`](https://github.com/OffchainLabs/stylus-sdk-rs/tree/76f8b055ec0bf421edd542b164dc2917c9e4e0bd/cargo-stylus) at commit `76f8b055ec0bf421edd542b164dc2917c9e4e0bd`, with the SDK workspace lockfile and `--locked`. The archived standalone `OffchainLabs/cargo-stylus` (v0.6.3) is not used |
| Workflow | [`.github/workflows/stylus-testnet-artifact.yml`](../.github/workflows/stylus-testnet-artifact.yml): `workflow_dispatch` only, `contents: read`, no secrets, pinned action SHAs |
| First artifact run | **Not run yet.** GitHub only dispatches a `workflow_dispatch`-only workflow whose file is on the default branch, or one that has already run. Dispatching it on this branch returned HTTP 404. The maintainer will put the workflow on `main` through their own process; the branch run follows |
| Configuration change | `rust/stylus-wrapper/Stylus.toml` gains the `[workspace]` table that cargo-stylus 0.10.10 requires, plus a declarative `arbitrum-sepolia` network entry ([§5](#5-stylustoml-configuration-change)) |
| Raw WASM | **Unchanged**: 90,506 bytes, SHA-256 `6fd9159dfa148837be88249deaf1cb8f04f0c4787d05b5340790051cf2c8fefd` on this branch's commit `993b4ed`, identical to `main` ([§5](#5-stylustoml-configuration-change)) |
| Arbitrum Sepolia | **Not checked.** Chain ID `421614`, published RPC `https://sepolia-rollup.arbitrum.io/rpc` ([§7](#7-path-to-arbitrum-sepolia-documented-not-performed)) |
| Activation | Paused on Arbitrum One and Nova. The pending activation AIP says Arbitrum Sepolia will follow the same audited, signed process. Must be freshly verified ([§8](#8-activation-policy-as-read-on-2026-11-18)) |

## 1. What the artifact is, and what it is not

Each workflow run uploads `ponte-stylus-unactivated-candidate-<commit>-<run>-<attempt>` (retention 90 days) containing:

- `ponte_stylus_wrapper.wasm`: the raw release WASM from the exact release command used by existing CI;
- `provenance.json` and `provenance.md`: the record described in [§3](#3-provenance);
- `UNACTIVATED-CANDIDATE.txt`: the label stated below;
- `commands/`: argv, working directory, UTC start and end times, exit status, stdout and stderr of every command;
- `inputs/` (the contract's `Cargo.toml`, `Cargo.lock`, `Stylus.toml`, `rust-toolchain.toml`), `abi/` (SDK export, committed client ABI, the CLI's ABI export), `cli/` (help texts, the CLI-built WASM, `get-initcode` output when produced), `reproducibility/` and `docker/`.

**Label:** a locally built, unactivated candidate artifact. It is **not** deployed, activated or checked against Arbitrum Sepolia or any other network, and it has **not** passed a Sepolia compatibility check. Passing local tests says nothing about Nitro activation, ink or gas, or live chain behavior.

**It is not a product feature.** The contract evaluates caller-supplied, unauthenticated synthetic candidates. Its output is not an executable quote, verified liquidity, a price guarantee or settlement functionality, and it must not authorize funds.

## 2. The contract being prepared

`evaluateSynthetic(SyntheticRequest) returns (SyntheticResult)` with selector `0x31631981`. Storage is empty, and the contract makes no external calls and no storage reads or writes. The candidate routes, rates, liquidity, expiry, snapshot IDs and `asOfUnixSeconds` are all supplied by the caller and unauthenticated (see [Phase 2B.2](PHASE2B2_IMPLEMENTATION.md)).

**Items for later independent review:**

1. **Manual `user_entrypoint`** (`src/lib.rs` L86–119). The SDK `#[entrypoint]` macro is deliberately not used, because its generated entrypoint reads calldata before application code runs. The function is compiled only for `wasm32` without the `stylus-test` or `contract-client-gen` features. It builds the SDK `VM { WasmVM }`, then:
   - returns `1` immediately on reentrancy, before metering, reading, flushing or writing;
   - calls `pay_for_memory_grow(0)`, then reads at most 25,572 bytes through `calldata::dispatch_bounded`;
   - routes through `stylus_sdk::abi::router_entrypoint::<SyntheticOptimizer, SyntheticOptimizer>`;
   - flushes the storage cache, writes the result and returns status `0` or `1`.

   It mirrors the SDK 0.10.10 lifecycle and the [official minimal-entrypoint pattern](https://developer.arbitrum.io/stylus/advanced/minimal-entrypoint-contracts), so review it as hand-written ABI glue.
2. **`unsafe impl TopLevelStorage`** (`src/lib.rs` L81–84). Its safety argument holds only while `SyntheticOptimizer` is the sole root storage object of the invocation, has no storage fields and makes no external calls. Adding storage, an external call or a second root object invalidates it.
3. **Calldata boundary** (`src/calldata.rs`; [Phase 2B.3.2A](PHASE2B3_2A_BOUNDED_CALLDATA.md)):
   - The 25,572-byte cap includes the selector.
   - For the known selector, a no-allocation bounds-and-alignment preflight checks the dynamic ABI parts (≤ 64 candidates, strings ≤ 64 bytes) before Alloy decodes them.
   - It is not full canonical ABI validation, and unknown or short selectors go to the SDK router.
4. **Generated ABI.** The SDK 0.10.10 export omits the input-only structs, so it is not a compilable Solidity interface. The committed client ABI (`abi/`) is generated and checked by `abi-tools` ([Phase 2B.3.3](PHASE2B3_3_CLIENT_ABI.md)).
5. **WASM imports and exports.**
   - **Exports:** `user_entrypoint` (function), `memory`, `__heap_base` and `__data_end`.
   - **Imports:** six `vm_hooks`: `pay_for_memory_grow`, `msg_reentrant`, `msg_value`, `storage_flush_cache`, `write_result` and `read_args`. `scripts/inspect_wasm.py` fails closed on any other hook.

## 3. Provenance

**Source:**
- The branch is based on `main` `2049497485364e1ad4e11644d0972820a9b4ce06`.
- Each run records the exact commit it built (`GITHUB_SHA`, checked against `git rev-parse HEAD`) and confirms the worktree was clean beforehand.
- The PONTE checkout keeps the absolute path existing CI uses, so raw hashes stay comparable.

| Input | SHA-256 on this branch |
| --- | --- |
| `rust/stylus-wrapper/Cargo.toml` | `3c00c3d92225c97f9e9886b1d78a62108b1e77cb863a83b5143e8f2f7e09a13d` |
| `rust/stylus-wrapper/Cargo.lock` | `a8e5be8a261b729008383353d4f6aaa11fff5763263ef6923771e4c32d842f50` |
| `rust/stylus-wrapper/Stylus.toml` | `06a40c47e01439987287c94d3626c7a77e2fb88fc272bb5298ce517dbe5fca95` (was `6e21fc54…f0f84e`) |
| `rust/stylus-wrapper/rust-toolchain.toml` | `c035cac193ded05cf0c2f2b241336a6240b888f279bd303bc1636582fd5ab8c8` |
| `rust/optimizer/Cargo.toml` | `7d415188428820ac4b72b1fc5045c59e23ced2c10ba3201fba5e0d6cca06233f` |
| `rust/optimizer/Cargo.lock` | `94194a82e481db48985f8927a9c1b967e17d27dbd2184e06bc2a51f75b19c6d2` |

**Stylus SDK/CLI:**
- Release `v0.10.10` was published on 2026-10-02. Its tag is lightweight and points directly at commit `76f8b055ec0bf421edd542b164dc2917c9e4e0bd` (`Merge pull request #459 from OffchainLabs/rel/0.10.10`, signature verified by GitHub).
- `cargo-stylus` takes the workspace version 0.10.10 and requires Rust 1.91.0 or later. The SDK's own `rust-toolchain.toml` pins 1.91.0.
- Each run re-checks the commit and the tag with `git ls-remote`.

| Pinned SDK file | SHA-256 |
| --- | --- |
| `Cargo.lock` | `6554a798777f6ff4b86e2513ea0c7c5d07e5c88fc1ec588b0169937cc127862f` |
| `cargo-stylus/Cargo.toml` | `8c7ffd6bab254a1948285d0eeb9561cc2136724ae1b17c935e880d2f77bff320` |
| `rust-toolchain.toml` | `7da4e0d76696d9e790a8c7907932c58839de073e08c66b9af33b9f91d49d73ee` |
| `Dockerfile` (the `cargo-stylus-base` image) | `33bbf0762ad1ea591d6783faf649f671061ed62037e3c488975e19fea9433bff` |
| `stylus-tools/src/core/build/reproducible.rs` | `47092f653f3b04d512a188150db9a1a42babaaf70a3cbd2c3850cd567dc1bbda` |

**Installation and invocation**, checked in the pinned source:
- **Install:** `cargo +1.91.0 install --locked --path ./cargo-stylus --root <dir>`, run from the SDK checkout root. Upstream CI (`smoke-test.yml`, `integration.yml`) uses the same command. The README's `install.sh` does not exist at this commit.
- **Invoke:** the binary is used as `cargo stylus …` from `rust/stylus-wrapper`, whose `rust-toolchain.toml` selects 1.91.0.
- **Recorded per run:** the binary SHA-256 and `cargo stylus --version`.

**Toolchain:**
- Rust 1.91.0 installed with `rustup` (minimal profile plus `rustfmt`, `clippy`, `rust-src` and the `wasm32-unknown-unknown` target) on `ubuntu-24.04`.
- Each run records `rustc -vV`, `cargo -vV`, the installed targets, the active toolchain per directory, and the runner image version.

**Build and test commands.** Each is recorded with its exit code and timestamps:

```sh
cd rust/stylus-wrapper
python3 -m unittest discover -s scripts -p 'test_advisory_guard.py' -v
python3 scripts/advisory_guard.py --check-baseline
npm --prefix abi-tools ci --ignore-scripts --no-audit --no-fund
npm --prefix abi-tools run check && npm --prefix abi-tools test
cargo +1.91.0 fmt --all -- --check
cargo +1.91.0 test --locked
cargo +1.91.0 clippy --locked --all-targets -- -D warnings
cargo +1.91.0 run --locked --features export-abi        # SDK ABI, checked by scripts/check_abi.py
cargo +1.91.0 build --locked --release --lib --target wasm32-unknown-unknown   # the artifact
python3 scripts/inspect_wasm.py <wasm>
node scripts/test_wasm_entrypoint.cjs <wasm>
node abi-tools/test-wasm.cjs <wasm>
CARGO_TARGET_DIR=<fresh dir> cargo stylus build         # CLI build from scratch, compared byte for byte
cargo stylus get-initcode --output <file>               # offline processing; informational
cargo stylus export-abi --output <file>                 # informational; lockfiles re-checked after
```

**Per-run provenance record** (`provenance.json`):
- the PONTE commit and the SDK/CLI commit, tag resolution and reported version;
- Rust and Cargo versions and the installed targets;
- SHA-256 of the manifest, lockfile, `Stylus.toml` and toolchain file;
- every command with exit code and timestamps;
- raw WASM size and SHA-256, compared with `main`'s `6fd9159d…`;
- exports, `vm_hooks` imports and custom sections;
- ABI hashes and test outcomes;
- the reproducibility and Docker results described in [§6](#6-reproducibility-findings).

## 4. The workflow

| Stage | What it does | Gating |
| --- | --- | --- |
| Provenance tooling tests | Offline unit tests of `scripts/phase2b6/stylus_provenance.py` | yes |
| `init` | Checks the source commit and clean worktree; hashes inputs; clones the SDK at the exact commit and verifies the tag | yes |
| `toolchain` | Installs Rust 1.91.0 with `wasm32-unknown-unknown`; checks that both trees select 1.91.0 | yes |
| `cli` | Installs `cargo-stylus` from the pinned source with `--locked`; checks the SDK tree is unchanged | yes |
| `verify-cli` | `cargo stylus --version`, `check --help`, `deploy --help`, `build --help`, `get-initcode --help` | yes |
| `wrapper-tests` | The existing `stylus-wrapper.yml` checks, in the same order | yes |
| `release-wasm` | Exact release build; WASM inspection; host-stub entrypoint tests; client ABI tests | yes |
| `cli-build` | Pre-fix manifest probe (informational); `cargo stylus build` into a fresh target directory (gating) and byte comparison; `get-initcode`; `export-abi` | build only |
| `reproducibility` | Rebuild from a relocated checkout and target directory; byte comparison | no |
| `docker` | Base image availability and digest; the CLI's derived image; the CLI-equivalent container run; a diagnostic full-repository container build | images only |
| `integrity` | All lockfiles and tracked files unchanged; SDK still at the pinned commit | yes |

**Safety properties:**
- Permissions are `contents: read`.
- No secrets are used, and checkouts do not persist credentials.
- Every action is pinned by SHA: `checkout` v5.1.0, `setup-node` v5.0.0 and `upload-artifact` v6.0.0.
- `record()` in `scripts/phase2b6/stylus-candidate.sh` refuses any `cargo stylus` argument vector outside an offline allowlist, including one nested in `docker run`. The allowlist is `--version`, the four `--help` forms above, `build`, `get-initcode --output <file>` and `export-abi --output <file>`. `check`, `deploy`, `activate`, `verify`, `cache` and the rest cannot run.

**Dispatching.** Once the file is on `main`, dispatch the branch run with `gh workflow run stylus-testnet-artifact.yml --ref arena/7643001c-ponte`. GitHub reads the workflow file from that ref.

## 5. `Stylus.toml` configuration change

**Problem.** The pinned CLI loads the `Stylus.toml` at the Cargo workspace root as a `WorkspaceManifest` (`stylus-tools/src/core/project/workspace.rs` L65–72), and its types require a `[workspace]` table with a `networks` map:

```rust
pub struct WorkspaceManifest { pub workspace: TomlWorkspace }
pub struct TomlWorkspace { pub networks: HashMap<String, TomlNetwork> }
pub struct TomlNetwork { pub endpoint: String }
```

`rust/stylus-wrapper` is its own Cargo workspace, and its `Stylus.toml` contained only `[contract]`. Every project command (`build`, `get-initcode`, `check`, `deploy`, `verify`) therefore stops while loading the project. The SDK's own examples carry the same one-line file, but they sit under the SDK's root `Stylus.toml`, which has the tables. The workflow's pre-fix probe records the exact CLI error against the old file.

**Change.** This is the only change under `rust/`:

```toml
[workspace]

[workspace.networks.arbitrum-sepolia]
endpoint = "https://sepolia-rollup.arbitrum.io/rpc"

[contract]
```

A three-line comment explains its scope. The existing `[contract]` table is preserved.

**Checked against the pinned v0.10.10 source and template:**
- **Shape:** the file deserializes into the types above. Unknown top-level keys such as `[contract]` are ignored, because the types carry no `deny_unknown_fields`.
- **Template:** the official contract template (`stylus-tools/templates/contract/Stylus.toml`) uses the same `[workspace]`, `[workspace.networks]` and `[contract]` layout, with an empty networks table.
- **Network entry:** no fixture in the pinned repository has an `endpoint` key. **No code reads the parsed workspace manifest or its networks.** Commands that use RPC take only `--endpoint`, which defaults to `http://localhost:8547`. The entry is declarative, makes no command contact Sepolia, and changes no default.
- **No deployment data:** no deployment record, deployer address, key or activation setting was added. The unused `TomlDeployment` type would hold such data.

**Scope:**
- Rust source, `Cargo.toml`, `Cargo.lock` and `rust-toolchain.toml` are unchanged.
- `Stylus.toml` is not a cargo build input.
- It is not part of the cargo-stylus project hash, which covers `.rs` files, `Cargo.toml`, `Cargo.lock` and `rust-toolchain.toml` (`stylus-tools/src/core/project/hash.rs`).
- It has no `[wasm-opt]` table, so no optimization step is enabled.
- The compiled WASM should therefore not change. The checks below confirm this.

**Validation on this branch.** Commit `993b4ed` triggered both of these runs:

- **[Local Stylus wrapper run 44357382168](https://github.com/timmyspurs12/ponte/actions/runs/44357382168): success on all 18 steps.**
  - Covers the advisory guard, client ABI checks, formatting, tests, Clippy, SDK ABI export and check, release build, WASM inspection, host-stub entrypoint tests, and client ABI tests through the WASM.
  - WASM is 90,506 bytes, with the same exports and six `vm_hooks` imports.
- **[Dependency and release WASM evidence run 44357382273](https://github.com/timmyspurs12/ponte/actions/runs/44357382273): graph capture, release build and artifact upload succeeded.**
  - Release WASM SHA-256 is `6fd9159dfa148837be88249deaf1cb8f04f0c4787d05b5340790051cf2c8fefd`, 90,506 bytes, **unchanged** from `main` `2049497` ([run 44268381103](https://github.com/timmyspurs12/ponte/actions/runs/44268381103)).
  - Cargo graph output is identical to `main`'s.
  - The RustSec step is red by design, with findings identical to [§9](#9-known-rustsec-findings).

The pinned CLI's acceptance of the new file will be confirmed by the artifact workflow's `cargo stylus build` step once that runs. Until then, the evidence is the source-level check above.

## 6. Reproducibility findings

These come from the pinned source; the workflow measures each one.

1. **The CLI's Docker path is only used by `deploy` and `verify`** (`run_reproducible`; `build`, `get-initcode` and `check` run on the host).
   - **Base image:** it builds a derived image from `offchainlabs/cargo-stylus-base:0.10.10` on Docker Hub, using the template in `reproducible.rs`, which installs the toolchain named in `rust-toolchain.toml`.
   - **Container run:** `docker run --network host --workdir /source --volume <cargo workspace root>:/source <image> cargo stylus <cmd> --no-verify`.
   - **What the workflow does:** builds the same image from the CLI's own template and runs the offline `cargo stylus build` with the same mount. It never runs `deploy` or `verify`.
2. **Only the Cargo workspace root is mounted.** For this contract that is `rust/stylus-wrapper`, while its path dependency `ponte-optimizer` is `../optimizer`, outside the mount. A reproducible `deploy` or `verify` is therefore expected to fail in the container. The workflow records the actual outcome as the CLI-equivalent container run. Fixing it needs a separately reviewed layout change, for example a Cargo workspace that contains both crates or a non-path dependency, which would change lockfile placement or content.
3. **The init code is path-dependent.** The `project_hash` section that `cargo-stylus` adds hashes the cargo version string and **absolute** source paths of the current directory (`hash_project`). The verifiable deployment payload therefore comes only from the fixed container path, and a host `get-initcode` is not the reproducible payload.
4. **The raw WASM may embed absolute paths** of path dependencies and registry sources in panic-location strings. The workflow rebuilds from a relocated checkout, rebuilds into a fresh target directory, scans the binary for absolute paths, and makes a diagnostic container build of the whole repository at a fixed path.
5. **Size.** `get-initcode` and `check` split programs whose Brotli-compressed code plus the 4-byte `EFF00000` prefix exceeds 24,576 bytes into fragments, and `get-initcode` refuses fragmented programs. A fragmented `deploy` sends fragment transactions plus a root, and requires the chain's `getMaxStylusContractFragments`. The [check/deploy guide](https://developer.arbitrum.io/stylus/cli-tools/check-and-deploy) gives a decompressed `MaxWasmSize` of 128 KB by default and 256 KB from ArbOS 61. The 90,506-byte raw WASM is below that before processing.

## 7. Path to Arbitrum Sepolia (documented, not performed)

**Network** ([official chain information](https://developer.arbitrum.io/chain-info)):
- Arbitrum Sepolia, chain ID **`421614`**, published RPC **`https://sepolia-rollup.arbitrum.io/rpc`**.
- Explorers are [Arbiscan](https://sepolia.arbiscan.io/) and [Blockscout](https://arbitrum-sepolia.blockscout.com/).
- The public RPC offers no uptime or rate-limit guarantees and no WebSocket. The sequencer endpoint accepts only raw transaction submission.

| Operation | What it does | Needs | Changes chain state? |
| --- | --- | --- | --- |
| **Read-only `cargo stylus check`** | Builds and processes on the host. Then `eth_call`s ArbWasm `activateProgram` (`0x…71`) with a state override that spoofs the code and a funded sender, to validate activation and estimate the data fee. Reports `ActivationsPaused` when activation gas is raised | An RPC that supports `eth_call` state overrides. No key | No |
| **Unactivated deployment** (`cargo stylus deploy --no-activate`) | Runs the same check first, checks the balance against the estimated data fee, then sends a contract-creation transaction with the init code (plus fragment transactions if fragmented). The program **cannot be called until activated** | A funded key; by default the reproducible Docker path ([§6](#6-reproducibility-findings)) | **Yes**, one or more transactions |
| **Activation** (`cargo stylus activate --address …`) | A transaction to ArbWasm `activateProgram` paying the data fee. It compiles the program onchain and makes it callable for a limited period (365 days by default, renewable with `codehashKeepalive`) | A funded key and **whatever activation policy applies on Sepolia at that time** ([§8](#8-activation-policy-as-read-on-2026-11-18)) | **Yes** |

**Later read-only check.** This is a separate step that needs approval:

```sh
cd rust/stylus-wrapper
cargo stylus check --endpoint https://sepolia-rollup.arbitrum.io/rpc
```

- **Always pass `--endpoint`.** The [check/deploy guide](https://developer.arbitrum.io/stylus/cli-tools/check-and-deploy) says `check` defaults to Sepolia, but the pinned 0.10.10 source defaults to `http://localhost:8547`.
- **It rebuilds on the host.** Compare its build with this artifact's hash first.
- **`--wasm-file <artifact>` checks the exact artifact bytes first**, and then still checks the workspace's contracts when run inside the project.

## 8. Activation policy, as read on 2026-11-18

Re-verify this before any network step.

- **Paused on One and Nova:**
  - The Security Council paused new and expired-program activations on Arbitrum One and Nova on 2026-10-02 by raising the activation gas ([pause notice](https://developer.arbitrum.io/notices/stylus-activation-pause-notice); [Security Council action](https://forum.arbitrum.foundation/t/security-council-emergency-action-2-10-2026/31530)).
  - Already-active programs keep running until they expire, and can be renewed.
  - The notice does not name Arbitrum Sepolia.
- **[Constitutional AIP: Stylus Activation Contract](https://forum.arbitrum.foundation/t/constitutional-aip-stylus-activation-contract/31605)** (posted 2026-10-23) proposes a Stylus Activation Contract on Arbitrum One. The contract would activate code only with an Arbitrum Foundation activation signature, and the signature would follow a pass from a limited audit by an Arbitrum Security Program auditor.
  - At minimum the auditor would *"rebuild the program with cargo stylus from the submitted commit, confirming the bytecode matches the deployed codehash"*.
  - The AIP says *"Arbitrum Sepolia is outside the scope of this proposal but will follow the same activation process (limited audit and activation signature)"*.
  - As of 2026-11-18 it is still in governance discussion. A temperature check was underway, a Trail of Bits summary of the activation contract was published on 2026-11-06, and contract addresses and signer configuration are to be published before the on-chain vote.
- **Implications for PONTE:**
  - Sepolia activation may require the audited, signed process, and Sepolia activations may also be paused.
  - A read-only check would show `ActivationsPaused` if so, and `deploy --no-activate` would then also stop at its built-in check.
  - Codehash matching makes the reproducible build path in [§6](#6-reproducibility-findings) a prerequisite.
  - Any submission or contact is a separate decision; none was made.

## 9. Known RustSec findings

These are unsuppressed and unchanged by this branch. They come from `main`'s post-merge [Dependency and release WASM evidence run 44268381103](https://github.com/timmyspurs12/ponte/actions/runs/44268381103) (commit `2049497`): `cargo-audit` 0.23.0, advisory-db `233155b4025b854c68a4b199c0e32d7fd53291a2`, audited 2026-11-18T08:36:41Z, `--deny warnings`, no ignores.

| Lockfile | Findings |
| --- | --- |
| `rust/environment-check` | none |
| `rust/optimizer` | unmaintained `RUSTSEC-2024-0436` (`paste` 1.0.15) |
| `rust/stylus-wrapper` | **vulnerability** `RUSTSEC-2026-0387` (`crypto-bigint` 0.5.5); **unsound** `RUSTSEC-2026-0253` (`lru` 0.16.4); unmaintained `RUSTSEC-2024-0370` (`proc-macro-error` 1.0.4), `RUSTSEC-2024-0388` (`derivative` 2.2.0), `RUSTSEC-2024-0436` (`paste` 1.0.15), `RUSTSEC-2026-0173` (`proc-macro-error2` 2.0.1), `RUSTSEC-2026-0543` (`chrono` 0.4.45) |

- **Scope:** findings cover each whole lockfile. Phase 2B.5.1 observed that `crypto-bigint` and `lru` resolve only through host dev-dependency paths. That is a Cargo graph observation, not proof of absence from the binary or of non-exploitability.
- **Newer advisory database:** on this branch, [run 44357382273](https://github.com/timmyspurs12/ponte/actions/runs/44357382273) audited the same lockfiles against advisory-db `472a4c9a785030434f15d7da84964d60fbe789ab` (1,533 advisories, 2026-11-18T17:20:27Z) and found exactly the same findings.
- **Check status:** the evidence check stays red by design.
- **Offline guard:** `advisory_guard.py --check-baseline` (run by this workflow) tracks the two advisories offline.

## 10. Limitations

- **Synthetic evaluator.** Its inputs, including the as-of time, are unauthenticated and replayable. It reads no environment timestamp and verifies no price, liquidity or asset metadata. ABI decoding still allocates dynamic data inside the 25,572-byte cap. Nothing about gas, ink, memory high-water marks or throughput is measured.
- **Manual entrypoint design.** The contract depends on hand-written lifecycle code and an `unsafe` marker whose correctness is argued, not proven ([§2](#2-the-contract-being-prepared)). The SDK's ABI export omits the input structs.
- **Evidence.**
  - Host-stub WASM tests, native and TestVM tests and import inspection do not reproduce Nitro activation or metering.
  - Results in this repository are read from check-run annotations. Artifacts are not independently downloaded and re-hashed by the sandbox that prepared this branch.
  - The first artifact run is still pending.
- **Toolchain.** The CLI image used for reproducible builds comes from Docker Hub. Upstream's base-image `Dockerfile` builds `cargo-stylus` without `--locked` from a floating `rust:1.91` image, so the image digest must be recorded and compared.

## 11. Remaining blockers

**Before a read-only Sepolia check:**
1. Put the workflow on `main` (maintainer), dispatch it on this branch, and review a successful run's provenance and artifact.
2. Get explicit approval for a read-only RPC step, including the endpoint and where it runs.
3. Freshly verify Sepolia's chain ID, ArbOS and Stylus versions, activation status and size limits, and the endpoint's support for `eth_call` state overrides.
4. Decide whether to check the exact artifact bytes (`--wasm-file`) or the host rebuild, and compare hashes first.

**Before an unactivated deployment:**
1. Get explicit approval for Sepolia transactions, and set a key-management policy: no keys in CI or the repository, plus a funded testnet account for gas and the data-fee balance check.
2. A successful, reviewed read-only check.
3. A working reproducible build. The CLI's container path is expected to fail for the current layout ([§6](#6-reproducibility-findings)), and `--no-verify` would bypass reproducibility, which is not acceptable here.
4. The `cargo-stylus-base:0.10.10` image is available and its digest recorded.
5. The fragmentation outcome is understood, and multi-transaction deployment is planned if needed.
6. Sepolia activations are not paused. If they are, the pinned CLI stops before deploying even with `--no-activate`.

**Activation policy and security:**
1. Freshly verify the current Sepolia and One activation policy and the AIP's execution status, terms, signer, Activation Contract address and any audit or submission process. Contacting the Foundation or an auditor is a separate decision.
2. If the limited audit applies, an auditor must rebuild with `cargo stylus` and match the deployed codehash, which requires the reproducible path.
3. Independently review the manual entrypoint, the `unsafe` marker, the calldata preflight, the ABI and the import surface.
4. Triage the RustSec findings, especially `RUSTSEC-2026-0387` and `RUSTSEC-2026-0253`.
5. Define a data-provenance and replay policy before any non-synthetic use.
6. Plan for expiry (365 days), keepalive and reactivation after Stylus version changes.

## 12. Not performed

- `cargo stylus check` against any endpoint, `deploy` (with or without `--no-activate`), `activate`, `verify`, `cache` or `codehash-keepalive`.
- Any transaction or signature; wallet creation, import or funding; key generation.
- Token transfers, payments or settlement; Vercel, Render or other hosting deployments.
- Contact with the Arbitrum Foundation, an auditor or anyone else.
- Changes to `main`, Rust source, `Cargo.toml`, `Cargo.lock` or existing workflows and scripts.
