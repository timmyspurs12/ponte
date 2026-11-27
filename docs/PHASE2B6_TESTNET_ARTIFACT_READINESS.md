# Phase 2B.6.0 — Reproducible Stylus testnet artifact readiness

> **Follow-up:** [Phase 2B.6.1](PHASE2B6_1_WORKSPACE_LAYOUT.md) moves the Cargo workspace root to `rust/`, fixes the CLI's reproducible-container path and re-measures the artifact. The measurements below describe the **original** layout and remain historical.

> **Build and packaging only.** This phase prepares a locally built, **unactivated candidate artifact** of the existing synthetic-only PONTE Stylus wrapper and documents a controlled path toward Arbitrum Sepolia. Nothing was deployed or activated. No `cargo stylus check` ran against any RPC endpoint, and no transaction or signature was requested. No wallet, key, funding, payment, settlement or hosting deployment was involved, and nobody was contacted on PONTE's behalf.

## Status

| Item | Status |
| --- | --- |
| Contract | The existing synthetic-only evaluator in `rust/stylus-wrapper`. Rust source, `Cargo.toml` and `Cargo.lock` are unchanged from `main` `2049497485364e1ad4e11644d0972820a9b4ce06` |
| Stylus CLI | `cargo-stylus` 0.10.10 built from `cargo-stylus/` of the official [`OffchainLabs/stylus-sdk-rs` `v0.10.10`](https://github.com/OffchainLabs/stylus-sdk-rs/tree/76f8b055ec0bf421edd542b164dc2917c9e4e0bd/cargo-stylus) at commit `76f8b055ec0bf421edd542b164dc2917c9e4e0bd`, with the SDK workspace lockfile and `--locked`. The archived standalone `OffchainLabs/cargo-stylus` (v0.6.3) is not used |
| Workflow | [`.github/workflows/stylus-testnet-artifact.yml`](../.github/workflows/stylus-testnet-artifact.yml): `workflow_dispatch` only, `contents: read`, no secrets, pinned action SHAs. Registered with GitHub from this branch (workflow ID `422931157`) without any change to `main` ([§4](#4-the-workflow)) |
| **Candidate artifact run** | **Succeeded.** [Run 44367877896](https://github.com/timmyspurs12/ponte/actions/runs/44367877896), `workflow_dispatch` on `arena/7643001c-ponte` at commit `735445f04255ae5ec5d43041d69db8338eba5361`: all 17 steps passed and the provenance record is `complete` ([§5](#5-artifact-run-results)) |
| **Artifact** | [`ponte-stylus-unactivated-candidate-735445f04255ae5ec5d43041d69db8338eba5361-44367877896-1`](https://github.com/timmyspurs12/ponte/actions/runs/44367877896/artifacts/14457443066), artifact ID `14457443066`, 334,403-byte zip, digest `sha256:df20469a2bd1d2d1cf7293706f1de47e4accabadedaa6af094d40c7605c1f739`, expires 2027-02-16 |
| Confirmation run | [Run 44370571297](https://github.com/timmyspurs12/ponte/actions/runs/44370571297) on the documentation-only commit `0d2a5e610523699ccea52d841bebe2c0b9656165` reproduced every recorded result exactly. Artifact ID `14459786175`, digest `sha256:664698aa89b11f7797f35944d089cff600ace8b2a048c04f9de66e46588c9b31`, expires 2027-02-16 |
| **Raw WASM (historical, original layout)** | 90,506 bytes, SHA-256 `6fd9159dfa148837be88249deaf1cb8f04f0c4787d05b5340790051cf2c8fefd`, measured under the original workspace layout. This hash is a historical measurement; current values after the Phase 2B.6.1 workspace-root change are host `b3574ee3…` and container `42d8a474…` in [Phase 2B.6.1](PHASE2B6_1_WORKSPACE_LAYOUT.md) ([§5](#5-artifact-run-results)) |
| Configuration change | `rust/stylus-wrapper/Stylus.toml` gains the `[workspace]` table that cargo-stylus 0.10.10 requires, plus a declarative `arbitrum-sepolia` network entry. **Confirmed by the pinned CLI:** `cargo stylus build` succeeds; the former file fails with ``missing field `workspace` `` ([§6](#6-stylustoml-configuration-change)) |
| Reproducible Docker path | **Historical finding:** under the original layout the CLI's container path **failed** on the `../optimizer` path dependency (the base image `offchainlabs/cargo-stylus-base:0.10.10` exists, digest recorded). Phase 2B.6.1 moved the Cargo workspace root to `rust/` and recorded two byte-identical container builds plus a successful offline `get-initcode`; see [Phase 2B.6.1](PHASE2B6_1_WORKSPACE_LAYOUT.md) §5.2. Deployment and on-chain verification remain unperformed ([§7](#7-reproducibility-findings)) |
| Arbitrum Sepolia | **Not checked.** Chain ID `421614`, published RPC `https://sepolia-rollup.arbitrum.io/rpc` ([§8](#8-path-to-arbitrum-sepolia-documented-not-performed)) |
| Activation | Paused on Arbitrum One and Nova. The pending activation AIP says Arbitrum Sepolia will follow the same audited, signed process. Must be freshly verified ([§9](#9-activation-policy-as-read-on-2026-11-18)) |

## 1. What the artifact is, and what it is not

Each workflow run uploads `ponte-stylus-unactivated-candidate-<commit>-<run>-<attempt>` (retention 90 days) containing:

- `ponte_stylus_wrapper.wasm`: the raw release WASM from the exact release command used by existing CI;
- `provenance.json` and `provenance.md`: the record described in [§3](#3-provenance);
- `UNACTIVATED-CANDIDATE.txt`: the label stated below;
- `commands/`: argv, working directory, UTC start and end times, exit status, stdout and stderr of every command;
- `inputs/` (the contract's `Cargo.toml`, `Cargo.lock`, `Stylus.toml`, `rust-toolchain.toml`), `abi/` (SDK export, committed client ABI, the CLI's ABI export), `cli/` (help texts, the CLI-built WASM, `get-initcode` output), `reproducibility/` (relocated-checkout and rust-src builds) and `docker/` (rendered Dockerfile, base-image source, diagnostic container build).

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
5. **WASM imports and exports**, as measured in the candidate run:
   - **Exports:** `memory`, `user_entrypoint` (function), `__heap_base` and `__data_end`.
   - **Imports:** six `vm_hooks`: `pay_for_memory_grow`, `msg_reentrant`, `msg_value`, `storage_flush_cache`, `write_result` and `read_args`. `scripts/inspect_wasm.py` fails closed on any other hook.

## 3. Provenance

**Source:**
- The branch is based on `main` `2049497485364e1ad4e11644d0972820a9b4ce06`.
- Each run records the exact commit it built (`GITHUB_SHA`, checked against `git rev-parse HEAD`) and confirms the worktree was clean beforehand.
- The PONTE checkout keeps the absolute path existing CI uses (`/home/runner/work/ponte/ponte`), so raw hashes stay comparable ([§7](#7-reproducibility-findings)).

| Input | SHA-256 (candidate run) |
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
- Each run re-checks the commit and the tag with `git ls-remote`. The candidate run confirmed both, and `cargo stylus --version` reported `stylus 0.10.10`.

| Pinned SDK file | SHA-256 |
| --- | --- |
| `Cargo.lock` | `6554a798777f6ff4b86e2513ea0c7c5d07e5c88fc1ec588b0169937cc127862f` |
| `cargo-stylus/Cargo.toml` | `8c7ffd6bab254a1948285d0eeb9561cc2136724ae1b17c935e880d2f77bff320` |
| `rust-toolchain.toml` | `7da4e0d76696d9e790a8c7907932c58839de073e08c66b9af33b9f91d49d73ee` |
| `Dockerfile` (the `cargo-stylus-base` image) | `33bbf0762ad1ea591d6783faf649f671061ed62037e3c488975e19fea9433bff` |
| `stylus-tools/src/core/build/reproducible.rs` | `47092f653f3b04d512a188150db9a1a42babaaf70a3cbd2c3850cd567dc1bbda` |

**Installation and invocation**, checked in the pinned source and exercised by the candidate run:
- **Install:** `cargo +1.91.0 install --locked --path ./cargo-stylus --root <dir>`, run from the SDK checkout root (about 3 minutes on the runner). Upstream CI (`smoke-test.yml`, `integration.yml`) uses the same command. The README's `install.sh` does not exist at this commit.
- **Invoke:** the binary is used as `cargo stylus …` from `rust/stylus-wrapper`, whose `rust-toolchain.toml` selects 1.91.0.
- **Binary hash:** `2593325f5dd651951807a5ebe79c90fd603ac5e3162deb9e9d582ffa2d6eb522` in runs 44367877896 and 44370571297. Superseded run 44365360692, which had `rust-src` installed, produced `63e0d259f4cf96d3d0bfcda14fe7f6e9b2c2e487deef6f07d4e87f6c190a4688` from the same source and lockfile. That is consistent with the `rust-src` path effect described in [§7](#7-reproducibility-findings), which applies to any binary built with the toolchain, but it was not separately verified. The CLI is identified primarily by its source commit, lockfile and toolchain.

**Toolchain** (candidate run):
- `rustc 1.91.0 (f8297e351 2025-10-28)`, commit `f8297e351a40c1439a467bbbb6879088047f50b3`, host `x86_64-unknown-linux-gnu`; `cargo 1.91.0 (ea2d97820 2025-10-10)`; on GitHub-hosted `ubuntu-24.04`.
- Installed with `rustup` exactly as `stylus-wrapper.yml` does it: minimal profile plus `rustfmt`, `clippy` and the `wasm32-unknown-unknown` target.
- Components present at the release build, recorded by the run: `cargo`, `clippy`, `rust-std` (`wasm32-unknown-unknown` and `x86_64-unknown-linux-gnu`), `rustc` and `rustfmt`. **No `rust-src`.** Installing it changes the WASM ([§7](#7-reproducibility-findings)).

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
rustup component list --toolchain 1.91.0 --installed    # components at the release build
cargo +1.91.0 build --locked --release --lib --target wasm32-unknown-unknown   # the artifact
python3 scripts/inspect_wasm.py <wasm>
node scripts/test_wasm_entrypoint.cjs <wasm>
node abi-tools/test-wasm.cjs <wasm>
CARGO_TARGET_DIR=<fresh dir> cargo stylus build         # CLI build from scratch, compared byte for byte
cargo stylus get-initcode --output <file>               # offline processing; informational
cargo stylus export-abi --output <file>                 # informational; lockfiles re-checked after
```

**Per-run provenance record** (`provenance.json`):
- the PONTE commit and the SDK/CLI commit, tag resolution, binary hash and reported version;
- Rust and Cargo versions, the installed targets and the components present at the release build;
- SHA-256 of the manifest, lockfile, `Stylus.toml` and toolchain file;
- every command with exit code and timestamps;
- raw WASM size and SHA-256, compared with `main`'s `6fd9159d…`;
- exports, `vm_hooks` imports, custom sections and embedded absolute paths;
- ABI hashes and test outcomes;
- the reproducibility and Docker results in [§7](#7-reproducibility-findings).

## 4. The workflow

| Stage | What it does | Gating |
| --- | --- | --- |
| Provenance tooling tests | 16 offline unit tests of `scripts/phase2b6/stylus_provenance.py` | yes |
| `init` | Checks the source commit and clean worktree; hashes inputs; clones the SDK at the exact commit and verifies the tag | yes |
| `toolchain` | Installs Rust 1.91.0 with the baseline component set and `wasm32-unknown-unknown`; checks that the wrapper selects 1.91.0 and that the SDK's toolchain file pins it | yes |
| `cli` | Installs `cargo-stylus` from the pinned source with `--locked`; checks the SDK tree is unchanged | yes |
| `verify-cli` | `cargo stylus --version`, `check --help`, `deploy --help`, `build --help`, `get-initcode --help` | yes |
| `wrapper-tests` | The existing `stylus-wrapper.yml` checks, in the same order | yes |
| `release-wasm` | Records the toolchain components; exact release build; WASM inspection; host-stub entrypoint tests; client ABI tests | yes |
| `cli-build` | Pre-fix manifest probe (informational); `cargo stylus build` into a fresh target directory (gating) and byte comparison; `get-initcode`; `export-abi` | build only |
| `reproducibility` | Rebuilds from a relocated checkout, then with the `rust-src` component added (removed again afterwards); byte comparisons | no |
| `docker` | Base image availability and digest; the CLI's derived image; the CLI-equivalent container run; a diagnostic full-repository container build | images only |
| `integrity` | All lockfiles and tracked files unchanged; SDK still at the pinned commit | yes |

**Safety properties** (re-validated for this run):
- The only trigger is `workflow_dispatch`, so the workflow runs only when someone with write access starts it. Permissions are `contents: read`.
- No secrets are used, checkouts do not persist credentials, and nothing is pushed.
- Every action is pinned by SHA: `checkout` v5.1.0, `setup-node` v5.0.0 and `upload-artifact` v6.0.0.
- `record()` in `scripts/phase2b6/stylus-candidate.sh` refuses any `cargo stylus` argument vector outside an offline allowlist, including one nested in `docker run`. The allowlist is `--version`, the four `--help` forms above, `build`, `get-initcode --output <file>` and `export-abi --output <file>`. `check`, `deploy`, `activate`, `verify`, `cache` and the rest cannot run.
- A failed command's annotation carries its error lines, because check-run annotations stay readable through the GitHub API even where run logs and artifacts are not. The full output stays in the artifact.

**Registration without changing `main`.** GitHub dispatches only workflows it has registered, and dispatching this file earlier returned HTTP 404. The usual fix is to put the file on the default branch. That needs a separate bootstrap branch and pull request, which the session that prepared this branch could not create. GitHub also registers a workflow the first time it runs from any branch: the Phase 2B.5.3 `macro-isolation-experiment.yml` (workflow ID `421818583`) was registered that way from a feature branch. So:

1. Commit `bb87fd5` temporarily added a `push` trigger limited to this branch and to this workflow file, plus a job condition `github.event_name == 'workflow_dispatch'`.
2. Pushing it created [registration run 44365215853](https://github.com/timmyspurs12/ponte/actions/runs/44365215853). Its conclusion is `skipped`: one job, zero steps, no runner. GitHub registered the workflow as ID `422931157`.
3. Commit `38f395c` reverted `bb87fd5`. Its tree is identical to `5317414`, so the workflow is `workflow_dispatch`-only again.
4. Dispatches against this branch then returned HTTP 204.

`main` was not changed. To dispatch again: `gh workflow run stylus-testnet-artifact.yml --ref arena/7643001c-ponte`, or the REST dispatch endpoint with workflow ID `422931157`. GitHub reads the workflow file from that ref.

**Fixes made while preparing and running the workflow** (no change to Rust sources, manifests, lockfiles or `Stylus.toml`):

| Commit | Fix | Why |
| --- | --- | --- |
| `5317414` | `PYTHONDONTWRITEBYTECODE=1` for the job | The provenance unit tests ran before `init` and wrote `scripts/phase2b6/__pycache__/*.pyc`. That directory is not gitignored, so `init`'s clean-worktree gate would have failed on every run (reproduced locally before the first run) |
| `5317414` | Error lines in failure annotations (`excerpt` subcommand) | Run logs and artifacts were not reachable from the environment that diagnosed the runs; annotations were |
| `f28e99a` | Baseline toolchain components; SDK toolchain file read instead of resolved by rustup; components recorded; `rust-src` probe; full base-image digest | Run 44365360692 built `d690eb6b…` instead of the baseline, because this workflow had added `rust-src` ([§5](#5-artifact-run-results)) |
| `735445f` | Removed a Python bytecode file that `f28e99a` added by mistake | Not a source file; the workflow never writes bytecode |

## 5. Artifact run results

| Run | Commit | Result | Raw WASM | Artifact |
| --- | --- | --- | --- | --- |
| [44365360692](https://github.com/timmyspurs12/ponte/actions/runs/44365360692) (superseded) | `38f395c` | success; record complete | 90,775 bytes, `d690eb6b9598ab80baec31cd5f84a7d4efb05436792a8b9501f9411750c01d20` (built with `rust-src` installed) | ID `14456029933`, `sha256:9d4a6a8fd79eb007141d24509ddeb4ecf699528697a4791db9e8ee9230f487d9`, expires 2027-02-16 |
| **[44367877896](https://github.com/timmyspurs12/ponte/actions/runs/44367877896) (candidate)** | **`735445f`** | **success, 17/17 steps; record complete** | **90,506 bytes, `6fd9159dfa148837be88249deaf1cb8f04f0c4787d05b5340790051cf2c8fefd`** | **ID `14457443066`, `sha256:df20469a2bd1d2d1cf7293706f1de47e4accabadedaa6af094d40c7605c1f739`, expires 2027-02-16** |
| [44370571297](https://github.com/timmyspurs12/ponte/actions/runs/44370571297) (confirmation) | `0d2a5e6` (documentation only) | success, 17/17 steps; record complete; every notice and warning identical to the candidate run apart from the commit | 90,506 bytes, `6fd9159d…2c8fefd` | ID `14459786175`, `sha256:664698aa89b11f7797f35944d089cff600ace8b2a048c04f9de66e46588c9b31`, expires 2027-02-16 |

All three are `workflow_dispatch` runs on `arena/7643001c-ponte`, attempt 1, on `ubuntu-24.04`. The candidate run took 8 minutes 20 seconds (2026-11-18T18:16:25Z to 18:24:45Z). Commits after `735445f` change only this document.

**Candidate run, step by step:**

| Stage | Outcome |
| --- | --- |
| Provenance tooling | 16 unit tests passed |
| `init` | Commit `735445f04255ae5ec5d43041d69db8338eba5361` checked against `GITHUB_SHA`; worktree clean; SDK at `76f8b055…`; tag `v0.10.10` resolves to it |
| `toolchain` | Rust 1.91.0 as in [§3](#3-provenance); the wrapper selects `1.91.0-x86_64-unknown-linux-gnu`; the SDK's toolchain file pins 1.91.0 |
| `cli` | `cargo install --locked` exit 0; SDK tree unchanged; binary SHA-256 `2593325f…6eb522` |
| `verify-cli` | `stylus 0.10.10`; `check --help` documents `--endpoint`; `deploy --help` documents `--no-activate` and `--no-verify` |
| `wrapper-tests` | All passed: advisory-guard tests and baseline, client ABI check and tests, `cargo fmt`, `cargo test`, `cargo clippy -D warnings`, SDK ABI export and `check_abi.py` |
| `release-wasm` | Release build exit 0; WASM inspection, host-stub entrypoint tests and client ABI WASM tests passed |
| `cli-build` | Pre-fix probe failed as expected; `cargo stylus build` exit 0, byte-identical to the direct build; `get-initcode` and `export-abi` exit 0 |
| `reproducibility` | Relocated checkout and `rust-src` builds both differ, as explained below |
| `docker` | Published base image pulled; derived image built; container CLI `stylus 0.10.10`; CLI-equivalent run failed as predicted; diagnostic container build succeeded |
| `integrity` | All lockfiles and tracked files unchanged; SDK still pinned |

**The raw WASM, cross-checked:**

| Build | Run | SHA-256 |
| --- | --- | --- |
| `main` baseline (`2049497`), dependency evidence | [44268381103](https://github.com/timmyspurs12/ponte/actions/runs/44268381103) | `6fd9159d…2c8fefd` |
| This branch (`735445f`), dependency evidence | [44367870528](https://github.com/timmyspurs12/ponte/actions/runs/44367870528) | `6fd9159d…2c8fefd` |
| **Candidate artifact** (direct release build) | 44367877896 | **`6fd9159d…2c8fefd`** |
| `cargo stylus build`, fresh target directory | 44367877896 | identical |
| Same build with `rust-src` added | 44367877896 | `d690eb6b…c01d20` (same as superseded run 44365360692) |
| Relocated checkout (`/home/runner/work/_temp/relocated-checkout/ponte`) | 44367877896 | `304e882c3530707b29caf757ef0d12d1647b532461be01792b6fa0468698fce0` |
| Whole repository in the CLI's image at `/ponte` (diagnostic) | 44365360692 and 44367877896 | `ea7da59380a64625ede15cecd74a458d7d5cc95ad7e17ed961ce8120dc6a18aa` in both runs |

**Other measured values (candidate run):**
- **Custom sections:** `name` (11,210 bytes), `producers` (77) and `target_features` (148).
- **ABI:** the SDK export SHA-256 is `4308824fc1b641a1395da5f0a58106b9e337ae5b7a6cc3a2ae541bc520aa7991`, and `cargo stylus export-abi` is byte-identical. Committed client ABI JSON: `15d6ff23d699e84b2841b69b5cababeedb3fa66fac353ba3c6c36fe44141b38b`; interface: `6a67311b65d364c6a1b4a634caa7cd0c22eea2317dca34131f3f044e417bac99`.
- **Offline processing (`get-initcode`), host build:**
  - Init code is 24,169 bytes, SHA-256 `d8e89984f33ac0b1b0c29a59a812fbab949f6beed17e046986cd81d6c3b7b040`.
  - Deployed code is 24,126 bytes, SHA-256 `558967431fec39aad87ad01fa1ff2ab40315b33e883cb9544a537633829da1af`: the 4-byte `EFF00000` prefix plus 24,122 bytes of Brotli.
  - That fits the 24,576-byte single-contract limit with 450 bytes to spare, so it is **not fragmented**.
  - It embeds a host-path-dependent `project_hash`, so it is **not** the reproducible deployment payload ([§7](#7-reproducibility-findings)).
- **Docker base image:** `offchainlabs/cargo-stylus-base:0.10.10`, image ID `sha256:f35f28e7201ae429952c0a7c62f67c3ebfe624120692ff50b20ab3a11d2aa5a8`, repository digest `offchainlabs/cargo-stylus-base@sha256:7ec994ea0d065859389d3e433b7a1efc163ad5415d40bb4ed9b323ddc636c57d`.

**Pull request checks on `735445f`:** Application quality, Local Stylus wrapper and Rust optimizer validation passed. Dependency and release WASM evidence is red only at its RustSec step, by design ([§10](#10-known-rustsec-findings)).

**How these results were read.** They come from the runs' check-run annotations and the GitHub REST API, which show every step, notice and warning. The artifact itself was not downloaded and re-hashed independently: run logs and artifacts are served from a storage host the preparing environment could not reach. GitHub's artifact digest above is the integrity anchor for a later download.

## 6. `Stylus.toml` configuration change

**Problem.** The pinned CLI loads the `Stylus.toml` at the Cargo workspace root as a `WorkspaceManifest` (`stylus-tools/src/core/project/workspace.rs` L65–72), and its types require a `[workspace]` table with a `networks` map:

```rust
pub struct WorkspaceManifest { pub workspace: TomlWorkspace }
pub struct TomlWorkspace { pub networks: HashMap<String, TomlNetwork> }
pub struct TomlNetwork { pub endpoint: String }
```

`rust/stylus-wrapper` is its own Cargo workspace, and its `Stylus.toml` contained only `[contract]`. Every project command (`build`, `get-initcode`, `check`, `deploy`, `verify`) therefore stopped while loading the project. The SDK's own examples carry the same one-line file, but they sit under the SDK's root `Stylus.toml`, which has the tables.

**Change.** This is the only change under `rust/`:

```toml
[workspace]

[workspace.networks.arbitrum-sepolia]
endpoint = "https://sepolia-rollup.arbitrum.io/rpc"

[contract]
```

A three-line comment explains its scope. The existing `[contract]` table is preserved.

**Checked against the pinned v0.10.10 source and template:**
- **Shape:** the file deserializes into the types above. Unknown top-level keys such as `[contract]` are ignored, because the types carry no `deny_unknown_fields`. The `ContractManifest` type, whose `deployments` field would be required, is never loaded by any 0.10.10 code path; `[contract]` only marks the package as a contract (`Contract::is_contract` checks that the file exists).
- **Template:** the official contract template (`stylus-tools/templates/contract/Stylus.toml`) uses the same `[workspace]`, `[workspace.networks]` and `[contract]` layout, with an empty networks table.
- **Network entry:** no fixture in the pinned repository has an `endpoint` key. **No code reads the parsed workspace manifest or its networks.** Commands that use RPC take only `--endpoint`, which defaults to `http://localhost:8547`. The entry is declarative, makes no command contact Sepolia, and changes no default.
- **No deployment data:** no deployment record, deployer address, key or activation setting was added.

**Scope:**
- Rust source, `Cargo.toml`, `Cargo.lock` and `rust-toolchain.toml` are unchanged.
- `Stylus.toml` is not a cargo build input.
- It is not part of the cargo-stylus project hash, which covers `.rs` files, `Cargo.toml`, `Cargo.lock` and `rust-toolchain.toml` (`stylus-tools/src/core/project/hash.rs`).
- It has no `[wasm-opt]` table, so no optimization step is enabled.

**Validation:**
- **Pinned CLI, candidate run 44367877896:**
  - Against the former one-line file (SHA-256 `6e21fc54…`), `cargo stylus build` exits 1 with ``error: toml read error: TOML parse error at line 1, column 1 … missing field `workspace` ``.
  - With the new file, `cargo stylus build` exits 0 and its WASM is byte-identical to the direct release build. `get-initcode` and `export-abi` also exit 0.
- **WASM unchanged:** 90,506 bytes, `6fd9159d…`, the same as `main` ([§5](#5-artifact-run-results)). Earlier branch runs agree: [Local Stylus wrapper 44357382168](https://github.com/timmyspurs12/ponte/actions/runs/44357382168) (all 18 steps) and [dependency evidence 44357382273](https://github.com/timmyspurs12/ponte/actions/runs/44357382273) on commit `993b4ed`, whose Cargo graph output was also identical to `main`'s.

## 7. Reproducibility findings

Each of these was measured by the candidate run unless stated otherwise.

1. **The raw WASM depends on the build environment, not only on the source.** The binary scan of the candidate WASM finds 16 absolute file-path strings, the kind panic locations embed:
   - 7 cargo registry sources under `CARGO_HOME`, for example `/home/runner/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/alloy-sol-types-1.5.7/src/abi/encoder.rs`;
   - 1 checkout path, `/home/runner/work/ponte/ponte/rust/optimizer/src/optimizer.rs`, from the `../optimizer` path dependency;
   - 5 standard-library paths `/rustc/f8297e351a40c1439a467bbbb6879088047f50b3/library/…`;
   - 3 path fragments such as `/alloc/src/string.rs`.

   Consequences:
   - The hash matches only when the checkout path, `CARGO_HOME` and toolchain components all match: same path and same toolchain give the same hash across runs and workflows ([§5](#5-artifact-run-results)), and a fresh target directory changes nothing.
   - A relocated checkout gives a different hash (`304e882c…`).
2. **The `rust-src` component changes the WASM.** With `rust-src` installed, rustc embeds the local library source path (`/home/runner/.rustup/toolchains/1.91.0-x86_64-unknown-linux-gnu/lib/rustlib/src/rust/library/…`) instead of `/rustc/<commit>/library/…`. The same build with `rust-src` added gives 90,775 bytes and `d690eb6b…`.
   - This is what made superseded run 44365360692 miss the baseline: that version of the workflow installed `rust-src`, and the baseline CI does not.
   - **The CLI's reproducible Docker image installs `rust-src`**, so container builds differ from host builds without it.
3. **The CLI's Docker path is only used by `deploy` and `verify`** (`run_reproducible`; `build`, `get-initcode` and `check` run on the host).
   - **Base image:** the derived image comes from `offchainlabs/cargo-stylus-base:0.10.10`, which is published on Docker Hub. Its digest is in [§5](#5-artifact-run-results).
   - **Template:** the derived image uses the template in `reproducible.rs` and installs the toolchain named in `rust-toolchain.toml`, plus `rust-src` and `wasm32-unknown-unknown`.
   - **Container run:** `docker run --network host --workdir /source --volume <cargo workspace root>:/source <image> cargo stylus <cmd> --no-verify`.
   - **What the workflow does:** builds the same image from the CLI's own template and runs the offline `cargo stylus build` with the same mount. It never runs `deploy` or `verify`.
4. **The CLI's container path fails for this repository layout.** Only the Cargo workspace root is mounted: for this contract that is `rust/stylus-wrapper`, while the path dependency `ponte-optimizer` is `../optimizer`, outside the mount. The CLI-equivalent run fails with ``cargo metadata error: … failed to load manifest for dependency `ponte-optimizer` … failed to read `/optimizer/Cargo.toml` … No such file or directory (os error 2)``.
   - A reproducible `deploy` or `verify` would fail the same way.
   - Fixing it needs a separately reviewed layout change, for example a Cargo workspace that contains both crates or a non-path dependency. Either would change lockfile placement or content, and the WASM's embedded paths.
5. **Container builds are deterministic, but not equal to host builds.** With the whole repository mounted at `/ponte` (a diagnostic, not a cargo-stylus code path), the container build succeeded and gave `ea7da593…` in both runs, with the same image digest. It differs from the host build because of the path, `CARGO_HOME` and `rust-src` differences above. An auditor rebuilding "with cargo stylus" ([§9](#9-activation-policy-as-read-on-2026-11-18)) would compare container builds with the deployed code, so the deployed program must itself come from the container path.
6. **The init code is path-dependent.** The `project_hash` section that `cargo-stylus` adds hashes the cargo version string and **absolute** source paths of the current directory (`hash_project`). A host `get-initcode` is therefore not the verifiable deployment payload.
7. **Size.** The host build's compressed code is 24,126 bytes with prefix, under the 24,576-byte limit at which `cargo-stylus` splits programs into fragments, with 450 bytes to spare.
   - A container build or any code growth must be re-measured. Above the limit, `get-initcode` refuses the program, and `deploy` sends fragment transactions plus a root, which needs the chain's `getMaxStylusContractFragments`.
   - The [check/deploy guide](https://developer.arbitrum.io/stylus/cli-tools/check-and-deploy) gives a decompressed `MaxWasmSize` of 128 KB by default and 256 KB from ArbOS 61. The 90,506-byte raw WASM is below that before processing.
8. **The upstream base image is mutable.** It is referenced by tag, and upstream's `Dockerfile` builds `cargo-stylus` without `--locked` from a floating `rust:1.91` image. The digest recorded here must be compared before relying on it.

## 8. Path to Arbitrum Sepolia (documented, not performed)

**Network** ([official chain information](https://developer.arbitrum.io/chain-info)):
- Arbitrum Sepolia, chain ID **`421614`**, published RPC **`https://sepolia-rollup.arbitrum.io/rpc`**.
- Explorers are [Arbiscan](https://sepolia.arbiscan.io/) and [Blockscout](https://arbitrum-sepolia.blockscout.com/).
- The public RPC offers no uptime or rate-limit guarantees and no WebSocket. The sequencer endpoint accepts only raw transaction submission.

| Operation | What it does | Needs | Changes chain state? |
| --- | --- | --- | --- |
| **Read-only `cargo stylus check`** | Builds and processes on the host. Then `eth_call`s ArbWasm `activateProgram` (`0x…71`) with a state override that spoofs the code and a funded sender, to validate activation and estimate the data fee. Reports `ActivationsPaused` when activation gas is raised | An RPC that supports `eth_call` state overrides. No key | No |
| **Unactivated deployment** (`cargo stylus deploy --no-activate`) | Runs the same check first, checks the balance against the estimated data fee, then sends a contract-creation transaction with the init code (plus fragment transactions if fragmented). The program **cannot be called until activated** | A funded key; by default the reproducible Docker path, which failed for the original layout (now fixed by [Phase 2B.6.1](PHASE2B6_1_WORKSPACE_LAYOUT.md); see [§7](#7-reproducibility-findings)) | **Yes**, one or more transactions |
| **Activation** (`cargo stylus activate --address …`) | A transaction to ArbWasm `activateProgram` paying the data fee. It compiles the program onchain and makes it callable for a limited period (365 days by default, renewable with `codehashKeepalive`) | A funded key and **whatever activation policy applies on Sepolia at that time** ([§9](#9-activation-policy-as-read-on-2026-11-18)) | **Yes** |

**Later read-only check.** This is a separate step that needs approval:

```sh
cd rust/stylus-wrapper
cargo stylus check --endpoint https://sepolia-rollup.arbitrum.io/rpc
```

- **Always pass `--endpoint`.** The [check/deploy guide](https://developer.arbitrum.io/stylus/cli-tools/check-and-deploy) says `check` defaults to Sepolia, but the pinned 0.10.10 source defaults to `http://localhost:8547`.
- **It rebuilds on the host.** With the same checkout path, `CARGO_HOME` and component set (no `rust-src`), the rebuild should hash to `6fd9159d…`. Compare before trusting the result.
- **`--wasm-file <artifact>` checks the exact artifact bytes first**, and then still checks the workspace's contracts when run inside the project.

## 9. Activation policy, as read on 2026-11-18

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
  - Codehash matching makes a working reproducible build path a prerequisite ([§7](#7-reproducibility-findings), findings 4 and 5).
  - Any submission or contact is a separate decision; none was made.

## 10. Known RustSec findings

These are unsuppressed and unchanged by this branch. They come from `main`'s post-merge [Dependency and release WASM evidence run 44268381103](https://github.com/timmyspurs12/ponte/actions/runs/44268381103) (commit `2049497`): `cargo-audit` 0.23.0, advisory-db `233155b4025b854c68a4b199c0e32d7fd53291a2`, audited 2026-11-18T08:36:41Z, `--deny warnings`, no ignores.

| Lockfile | Findings |
| --- | --- |
| `rust/environment-check` | none |
| `rust/optimizer` | unmaintained `RUSTSEC-2024-0436` (`paste` 1.0.15) |
| `rust/stylus-wrapper` | **vulnerability** `RUSTSEC-2026-0387` (`crypto-bigint` 0.5.5); **unsound** `RUSTSEC-2026-0253` (`lru` 0.16.4); unmaintained `RUSTSEC-2024-0370` (`proc-macro-error` 1.0.4), `RUSTSEC-2024-0388` (`derivative` 2.2.0), `RUSTSEC-2024-0436` (`paste` 1.0.15), `RUSTSEC-2026-0173` (`proc-macro-error2` 2.0.1), `RUSTSEC-2026-0543` (`chrono` 0.4.45) |

- **Scope:** findings cover each whole lockfile. Phase 2B.5.1 observed that `crypto-bigint` and `lru` resolve only through host dev-dependency paths. That is a Cargo graph observation, not proof of absence from the binary or of non-exploitability.
- **Newer advisory database:** on this branch, [run 44357382273](https://github.com/timmyspurs12/ponte/actions/runs/44357382273) (`993b4ed`) and [run 44367870528](https://github.com/timmyspurs12/ponte/actions/runs/44367870528) (`735445f`, audited 2026-11-18T18:17:25Z) used advisory-db `472a4c9a785030434f15d7da84964d60fbe789ab` (1,533 advisories) and found exactly the same findings.
- **Check status:** the evidence check stays red by design.
- **Offline guard:** `advisory_guard.py --check-baseline` (run by this workflow, passed) tracks the two advisories offline.

## 11. Limitations

- **Synthetic evaluator.** Its inputs, including the as-of time, are unauthenticated and replayable. It reads no environment timestamp and verifies no price, liquidity or asset metadata. ABI decoding still allocates dynamic data inside the 25,572-byte cap. Nothing about gas, ink, memory high-water marks or throughput is measured.
- **Manual entrypoint design.** The contract depends on hand-written lifecycle code and an `unsafe` marker whose correctness is argued, not proven ([§2](#2-the-contract-being-prepared)). The SDK's ABI export omits the input structs.
- **Evidence.**
  - Host-stub WASM tests, native and TestVM tests and import inspection do not reproduce Nitro activation or metering.
  - Results were read from check-run annotations and the REST API, not from an independently downloaded artifact ([§5](#5-artifact-run-results)).
- **Reproducibility.**
  - The raw WASM is reproducible only for the same checkout path, `CARGO_HOME` and toolchain components.
  - The CLI's own reproducible path did not work for the original layout; Phase 2B.6.1 moved the Cargo workspace root and recorded two byte-identical container builds ([§7](#7-reproducibility-findings), [Phase 2B.6.1](PHASE2B6_1_WORKSPACE_LAYOUT.md)).
  - The CLI binary hash depends on the toolchain components in the same way ([§3](#3-provenance)).
- **Toolchain.** The CLI image used for reproducible builds comes from Docker Hub by tag. Upstream's base-image `Dockerfile` builds `cargo-stylus` without `--locked` from a floating `rust:1.91` image.

## 12. Remaining blockers

**Before a read-only Sepolia check:**
1. Review the candidate run's provenance and artifact ([§5](#5-artifact-run-results)). The run itself succeeded; the earlier blocker, getting the workflow dispatched, is resolved.
2. Get explicit approval for a read-only RPC step, including the endpoint and where it runs (for example, a separate manually dispatched job with no keys or secrets).
3. Freshly verify Sepolia's chain ID, ArbOS and Stylus versions, activation status and size limits, and the endpoint's support for `eth_call` state overrides.
4. Decide whether to check the exact artifact bytes (`--wasm-file`) or the host rebuild, and compare hashes with `6fd9159d…` first ([§8](#8-path-to-arbitrum-sepolia-documented-not-performed)).

**Before an unactivated deployment:**
1. Get explicit approval for Sepolia transactions, and set a key-management policy: no keys in CI or the repository, plus a funded testnet account for gas and the data-fee balance check.
2. A successful, reviewed read-only check.
3. **A working reproducible build.** The CLI's container path failed for the original layout; Phase 2B.6.1 moved the Cargo workspace root and recorded two byte-identical container builds plus a successful offline `get-initcode` ([§7](#7-reproducibility-findings), finding 4; [Phase 2B.6.1](PHASE2B6_1_WORKSPACE_LAYOUT.md) §5.2). Before any deployment the artifact, its hashes and its size must still be freshly re-measured, and `--no-verify` would bypass reproducibility, which is not acceptable.
4. Pin the base image by the recorded digest, or record the digest at deployment time and compare it.
5. Re-measure the compressed size for the container build. The host build fits the single-contract limit by 450 bytes; plan multi-transaction deployment if a later build does not.
6. Sepolia activations are not paused. If they are, the pinned CLI stops before deploying even with `--no-activate`.

**Activation policy and security:**
1. Freshly verify the current Sepolia and One activation policy and the AIP's execution status, terms, signer, Activation Contract address and any audit or submission process. Contacting the Foundation or an auditor is a separate decision.
2. If the limited audit applies, an auditor must rebuild with `cargo stylus` and match the deployed codehash, which requires the reproducible path.
3. Independently review the manual entrypoint, the `unsafe` marker, the calldata preflight, the ABI and the import surface.
4. Triage the RustSec findings, especially `RUSTSEC-2026-0387` and `RUSTSEC-2026-0253`.
5. Define a data-provenance and replay policy before any non-synthetic use.
6. Plan for expiry (365 days), keepalive and reactivation after Stylus version changes.
7. **Protect `main`.** On 2026-11-18 it had no branch protection and no rulesets, so anyone with write access could push to it directly. Provenance claims about "the commit on `main`" depend on that being controlled.

## 13. Not performed

- `cargo stylus check` against any endpoint, `deploy` (with or without `--no-activate`), `activate`, `verify`, `cache` or `codehash-keepalive`.
- Any transaction or signature; wallet creation, import or funding; key generation.
- Token transfers, payments or settlement; Vercel, Render or other hosting deployments.
- Contact with the Arbitrum Foundation, an auditor or anyone else.
- Changes to `main`, Rust source, `Cargo.toml`, `Cargo.lock` or existing workflows and scripts. The registration trigger lived only on this branch and was reverted.
