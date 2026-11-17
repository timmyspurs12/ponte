# Phase 2B.5.3 — macro dependency isolation experiment

## Status

**The single approved change was applied and verified. All pre-registered checks passed in four experiment runs, and the A/A control passed before the change.** This is experiment evidence only. It is not a merge decision, a deployment approval or an activation check. Nothing was merged or deployed; PR #11 was not touched; no RPC, chain, wallet, private-key, transaction, payment or settlement activity took place.

| Question | Result |
| --- | --- |
| Only the approved `Cargo.toml` move, exact `=1.5.7` kept? | Yes — 3 entries (and their comment) moved to `[dev-dependencies]`; enforced by the `rust_diff_scope` and `manifest` checks |
| Lockfiles | Unchanged — all three SHA-256 values identical; unchanged after every build |
| Resolved versions | `alloy-sol-macro`, `-expander`, `-input` resolve only to 1.5.7 on both sides; 471 packages both sides |
| wasm32 release build | 14 fewer rustc units (57 → 43) and 2 fewer build-script runs (5 → 3); host unchanged (87 units, 13 build-script runs) |
| ABI generation | SDK `export-abi` output byte-identical (SHA-256 `4308824f…aa7991`); `check_abi.py` verified on both sides |
| Selector `0x31631981` | Verified on both sides (SDK declaration, keccak, client ABI, routed by the release WASM, 32 one-bit variants rejected) |
| Offline WASM and CI tests | All pass on both sides |
| Release WASM size | **90,506 bytes on both sides** |
| Release WASM SHA-256 | **Changed**: `26f536e6…c67d` → `6fd9159d…fefd`; each side deterministic across four builds, including a fully cold rebuild |
| Why the WASM hash changed | Proven equivalent up to symbol renaming and function order (all 137 functions and 31 other module fields identical after a one-to-one renaming); traced to Cargo's `-C metadata` of the root crate, which changed for exactly 1 of 130 compiler units |
| RustSec (no suppressions) | Identical on both sides: environment-check 0 findings; optimizer 1; stylus-wrapper 7 (1 vulnerability, 6 warnings). **The change resolves no advisory** |

## Scope, branches and constraints

- The assigned branch `experiment/phase2b5-3-macro-isolation` was verified at `fe6e928bbacd23948fbe32c492ac42df4ef49b1b`. Following the session's branch rules, the work was committed to `arena/85bd8a06-ponte`, branched from that same commit. `experiment/phase2b5-3-macro-isolation` was not pushed to, and PR #11 (head `arena/962f31b7-ponte`) was not modified.
- The worktree was clean at the start. The only change under `rust/` is the manifest move. Everything else is new evidence tooling under `scripts/phase2b/macro-isolation/`, a dedicated workflow, and this document. No existing file other than `rust/stylus-wrapper/Cargo.toml` was modified, and no existing CI or release gate was changed.
- Specification basis: these acceptance criteria are stated in the task request:
  1. Inspect and preserve existing work.
  2. Use a hosted Rust 1.91.0 runner with `wasm32-unknown-unknown`.
  3. Capture the baseline first.
  4. Make the single manifest move with exact versions.
  5. Use the same build configuration on both sides.
  6. Verify the ABI, the selector `0x31631981`, the offline WASM tests, the compiler invocations, and the WASM checksum and size.
  7. Run RustSec without suppressions.
  8. Write this report.

  The longer "previously supplied" specification was not available in this session.

### Why a hosted runner, and how evidence was read

The sandbox has no `cargo`, `rustc` or `rustup`, and cannot reach `static.rust-lang.org` or crates.io, so no local Rust build was possible. The experiment therefore runs on a GitHub-hosted `ubuntu-latest` runner. It installs Rust 1.91.0 with `rustup toolchain install 1.91.0 --profile minimal --component rustfmt --component clippy --target wasm32-unknown-unknown`. The runner launched without any permission or configuration change: the workflow needs only `contents: read`. The repository's Actions settings endpoints returned HTTP 403 to the sandbox integration, but this blocked nothing.

As in Phase 2B.5.1, the sandbox cannot download Actions logs or artifacts, because the storage hosts are unreachable. All results below come from check-run annotations that the runner wrote and the sandbox read through `api.github.com`. Some long annotations are truncated; the complete data is in each run's `comparison.json` artifact (see [Runs](#runs)).

## The change

```diff
--- a/rust/stylus-wrapper/Cargo.toml   (fe6e928)
+++ b/rust/stylus-wrapper/Cargo.toml   (0f970c4)
@@ -11,14 +11,14 @@ publish = false
 ponte-optimizer = { path = "../optimizer" }
 stylus-sdk = { version = "=0.10.10" }
 alloy-sol-types = { version = "=1.5.7", default-features = false }
+
+[dev-dependencies]
+stylus-sdk = { version = "=0.10.10", features = ["stylus-test"] }
 # Keep the proc-macro family aligned with sol-types; newer generated APIs are incompatible.
 alloy-sol-macro = "=1.5.7"
 alloy-sol-macro-expander = "=1.5.7"
 alloy-sol-macro-input = "=1.5.7"
 
-[dev-dependencies]
-stylus-sdk = { version = "=0.10.10", features = ["stylus-test"] }
-
 [features]
```

The code uses `sol!` only through the `alloy_sol_types` re-export. `[dependencies]` keeps `ponte-optimizer` (path), `stylus-sdk =0.10.10` and `alloy-sol-types =1.5.7` with `default-features = false`. `Cargo.lock` was not regenerated or edited.

## Method

### Harness

| File | Purpose |
| --- | --- |
| `.github/workflows/macro-isolation-experiment.yml` | Runs on push to this branch (wrapper manifest, harness or workflow paths) and on `workflow_dispatch` with input `base`, default `fe6e928…`. One job, `ubuntu-latest`, `contents: read`. |
| `scripts/phase2b/macro-isolation/capture.sh SIDE OUT` | Captures one side from the checked-out commit and records argv, cwd, stdout, stderr and exit status of every command. |
| `scripts/phase2b/macro-isolation/rustsec.sh OUT` | Runs unsuppressed `cargo audit` on the baseline and experiment lockfiles against one advisory-db snapshot. |
| `scripts/phase2b/macro-isolation/selector_check.cjs` | Verifies the selector from the SDK ABI, keccak, client ABI and release WASM. |
| `scripts/phase2b/macro-isolation/evidence.py` | Records the design, parses WASM sections, compares the two sides, writes notices and compares RustSec results. |
| `scripts/phase2b/macro-isolation/test_evidence.py` | 20 offline unit tests of the parsers and comparisons. They run first in every job. |

The existing Phase 2B.5.1 script `scripts/phase2b/dependency-evidence.sh` is reused unchanged inside the capture.

### Same-job A/B design

1. Check out the head commit with full history, then run the harness unit tests.
2. **Freeze the harness:** copy `scripts/phase2b/macro-isolation` to `$RUNNER_TEMP/harness`, so both sides run the identical harness from the head commit. Then record the design: base is an ancestor of head, and the list of changed files under `rust/` determines the mode (`control` if there are none, `experiment` otherwise).
3. Install Node 22, Rust 1.91.0 with `wasm32-unknown-unknown`, and optionally wabt from the Ubuntu archive for `wasm2wat`. The wabt step does not gate the result.
4. **Baseline:** `git checkout --detach fe6e928…`, then run `capture.sh baseline`.
5. **Experiment:** `git checkout --detach <head>`, then run `capture.sh experiment`. Both sides use the same runner, checkout path, toolchain, environment and commands. `rm -rf rust/stylus-wrapper/target` runs before each side, so nothing is reused across sides.
6. Compare the two sides, publish notices and the step summary, run RustSec, and upload the artifact even on failure.

**The baseline was captured before the change.** The A/A control runs on harness commits `1647a79` and `ebde9d3` ran while `rust/` was identical to `fe6e928`. The manifest move was committed only after control run 44169483918 had passed with every compared item identical. Each experiment run also re-captures the baseline in the same job, so that both sides share one runner.

The capture, RustSec and selector scripts have been unchanged since `1647a79`, and the workflow since `ebde9d3`. Every run from the passing control onward therefore collected evidence with identical commands. The later commits `a6b16a0`, `082ba10` and `a2eb24a` changed only the analysis in `evidence.py` and its tests.

### Commands per side

All commands run with `CARGO_TERM_COLOR=never`, and wrapper commands run in `rust/stylus-wrapper`. `BUILD` is the exact release command used by `stylus-wrapper.yml` and `dependency-evidence.sh`: `cargo +1.91.0 build --locked --release --lib --target wasm32-unknown-unknown`.

```sh
rm -rf rust/stylus-wrapper/target                               # cold
bash scripts/phase2b/dependency-evidence.sh OUT/dependency-evidence  # unchanged 2B.5.1 script:
#   locked metadata + cargo trees for all three workspaces and both targets,
#   crypto-bigint/lru inverse trees, cold `BUILD -vv` (compiler invocations), exact `BUILD`, checksum
BUILD --message-format=json                                     # structured unit inventory (no-op rebuild)
cargo +1.91.0 tree --locked --target {x86_64-unknown-linux-gnu,wasm32-unknown-unknown} \
  --edges {normal,build | normal,build,dev | features} --invert {alloy-sol-macro,alloy-sol-macro-expander,alloy-sol-macro-input}@1.5.7
cargo +1.91.0 tree --locked --target <both> --edges normal,build --depth 1
cargo +1.91.0 tree --locked --target <both> --edges dev --depth 1
rm -rf rust/stylus-wrapper/target && BUILD                      # second fully cold build
python3 -m unittest discover -s scripts -p 'test_advisory_guard.py' -v
python3 scripts/advisory_guard.py --check-baseline
npm --prefix abi-tools ci --ignore-scripts --no-audit --no-fund
npm --prefix abi-tools run check
npm --prefix abi-tools test
cargo +1.91.0 fmt --all -- --check
cargo +1.91.0 test --locked
cargo +1.91.0 test --locked --no-run --message-format=json
cargo +1.91.0 clippy --locked --all-targets -- -D warnings
cargo +1.91.0 run --locked --features export-abi > OUT/sdk-abi.sol
python3 scripts/check_abi.py OUT/sdk-abi.sol
cargo +1.91.0 build --locked --features export-abi --message-format=json
python3 scripts/inspect_wasm.py <release wasm>
node scripts/test_wasm_entrypoint.cjs <release wasm>
node abi-tools/test-wasm.cjs <release wasm>
node $HARNESS/selector_check.cjs <release wasm> OUT/sdk-abi.sol
python3 $HARNESS/evidence.py wasm-sections <release wasm> OUT/wasm-sections.json
wasm2wat --enable-all <release wasm> -o OUT/release.wat         # optional
git diff --exit-code -- rust/{environment-check,optimizer,stylus-wrapper}/Cargo.lock
```

### Pre-registered checks

Overall PASS requires every check to be `ok`:

| Check | What it requires |
| --- | --- |
| `rust_diff_scope` | Experiment mode: the only change under `rust/` is `rust/stylus-wrapper/Cargo.toml`. Control mode: no `rust/` change. |
| `baseline_commands`, `experiment_commands` | Every non-optional captured command exits 0. |
| `manifest` | Experiment: the 3 `=1.5.7` entries moved exactly to `[dev-dependencies]` and all other manifest content is identical. Control: identical manifests. |
| `lockfiles_identical` | All three lockfile SHA-256 values are identical across sides and unchanged after the builds. |
| `resolved_macro_versions` | The three macro crates resolve only to 1.5.7 on both sides. |
| `direct_dependency_kinds` | Their direct kind changes from normal to dev, and no other direct dependency changes. |
| `compiler_logs_parsed` | Both `-vv` logs parse with 0 errors. |
| `baseline_wasm_deterministic`, `experiment_wasm_deterministic` | The verbose, exact-CI, JSON-inventory and fully cold rebuild WASM hashes are identical within each side. |
| `abi_identical` | The SDK `export-abi` output is byte-identical. |
| `selector` | `selector_check.cjs` passes on both sides. |

Control mode adds 4 identity checks: `cargo_graphs_control`, `compiler_invocations_control`, `json_inventories_control` and `wasm_identical_control`. **WASM identity is deliberately not required in experiment mode.** The checksum is reported and explained, but a changed checksum was a possible legitimate outcome of a changed dependency declaration.

### RustSec procedure

`rustsec.sh` takes these steps:
1. Downloads the official `cargo-audit` 0.23.0 `x86_64-unknown-linux-musl` release and verifies its SHA-256, `4f01c74ed84b2dffd0b1d37012a62cdf2a92c96e25bdf8eec7fcc0d4d3eb7811`. This is the same tool and digest as Phase 2B.5.1.
2. Creates a detached baseline worktree at `BASE_SHA`.
3. Clones advisory-db once, so both sides use one snapshot.
4. Refuses to run if any global or workspace audit configuration exists, since one could hide findings.
5. Runs 6 audits (3 lockfiles × 2 sides): `cargo audit --file <lock> --db <clone> --no-fetch --deny warnings --json`.

No `--ignore` flags or target filters are used. The step exits 1 whenever findings exist. That is why every run's job conclusion is `failure` even though the comparison passed; this matches every historical Phase 2B.5.1 evidence run.

## Runs

All runs are on `ubuntu-latest` with Rust 1.91.0. Each run took about 8 minutes, with about 4 minutes per side.

| Run (job) | Commit | Mode | Comparison | Notes |
| --- | --- | --- | --- | --- |
| [44166894625](https://github.com/timmyspurs12/ponte/actions/runs/44166894625) (134335247785) | `1647a79` | control | crashed | Both captures succeeded, WASM `26f536e6…` on both sides, RustSec identical. `compare` raised a `KeyError`: build-script units carry no feature list. Fixed in `ebde9d3`. |
| [44169483918](https://github.com/timmyspurs12/ponte/actions/runs/44169483918) (134344420738) | `ebde9d3` | control | **PASS 16/16** | Baseline evidence before the change. Identical WASM, all 13 sections, 131 code bodies, 137 names and the WAT; identical 144 + 18 compiler units, JSON inventories 162/354/139, package lists, trees and inverse trees. |
| [44171151965](https://github.com/timmyspurs12/ponte/actions/runs/44171151965) (134350273360) | `0f970c4` | experiment | **PASS 12/12** | The Cargo.toml move. |
| [44173225545](https://github.com/timmyspurs12/ponte/actions/runs/44173225545) (134357596137) | `a6b16a0` | experiment | **PASS 12/12** | Adds per-function attribution notices. |
| [44175243662](https://github.com/timmyspurs12/ponte/actions/runs/44175243662) (134364736907) | `082ba10` | experiment | **PASS 12/12** | Adds the exact-renaming equivalence proof. |
| [44175556816](https://github.com/timmyspurs12/ponte/actions/runs/44175556816) (134365824832) | `a2eb24a` | experiment | **PASS 12/12** | Adds raw `-C metadata` reporting. |
| [44171151876](https://github.com/timmyspurs12/ponte/actions/runs/44171151876) | `0f970c4` | `Local Stylus wrapper` | success | Existing wrapper CI on the changed manifest. |
| [44171151888](https://github.com/timmyspurs12/ponte/actions/runs/44171151888) | `0f970c4` | `Dependency and release WASM evidence` | RustSec step failed (findings) | Existing 2B.5.1 workflow. Graph and WASM capture succeeded: WASM `6fd9159d…`, 90,506 bytes. RustSec is identical to the previous runs. |

The four experiment runs share 26 notice titles. With commit SHAs and audit timestamps masked, 24 are identical. The other 2 are the notices whose format later commits extended ("macro packages and root" and "Other build inventories"). Their first-run content is unchanged: it is a prefix of the later text, or identical once the added fields are removed.

Artifacts (30-day retention, expiring 2026-12-17; GitHub archive digests, not inspected from this sandbox):

| Run | Artifact ID | Name | Archive digest |
| --- | --- | --- | --- |
| 44166894625 | 14366541607 | `ponte-macro-isolation-evidence-44166894625-1` | `sha256:7e1276e3496204589c8ced92c2468f9020a2d9ad207d4c5174222ceb59a427af` |
| 44169483918 | 14366798212 | `ponte-macro-isolation-evidence-44169483918-1` | `sha256:fa54bf43ac24cd8b6454612e71f29c8e40ed534b4952d17ac779cfaff0ec3ea2` |
| 44171151965 | 14368810853 | `ponte-macro-isolation-evidence-44171151965-1` | `sha256:a145bcc14e9ae48a8d415cc7bd5e46a591b412df46666774b15979855f749b94` |
| 44173225545 | 14367834783 | `ponte-macro-isolation-evidence-44173225545-1` | `sha256:7cb071ba78e499116a308e73d0caa683ab07aeb88e94aec7a5d953b942423ab5` |
| 44175243662 | 14368978947 | `ponte-macro-isolation-evidence-44175243662-1` | `sha256:1a208413fd9f3a2f78e08f9fae7489ab1d5915c1c3b4416048e146cbd3661b1b` |
| 44175556816 | 14370067288 | `ponte-macro-isolation-evidence-44175556816-1` | `sha256:01fb12a89e4344a2bf4f59cdf461e0cbc6e5f8bf22dc851419daea704af7e1dc` |
| 44171151888 | 14367782368 | `ponte-dependency-evidence-44171151888-1` | `sha256:973e9e09c85ea71c167bcdf63032de7e082c38f33a93e1f29e9c714722c093f1` |

## Results

Unless stated otherwise, values are from the experiment runs, comparing the experiment with its same-job baseline. All four experiment runs agree.

### Manifest, lockfiles and resolution

- **Manifest:** `moved_exactly=True`; all other content is identical.
- **Lockfiles:** identical on both sides and unchanged after every build (`git diff --exit-code`).

  | Workspace | Lockfile SHA-256 (both sides) |
  | --- | --- |
  | environment-check | `1ae77bd29d16cd5ab236b72fba1ea4352304098cab1741e4d01b6c30b5598a7f` |
  | optimizer | `94194a82e481db48985f8927a9c1b967e17d27dbd2184e06bc2a51f75b19c6d2` |
  | stylus-wrapper | `a8e5be8a261b729008383353d4f6aaa11fff5763263ef6923771e4c32d842f50` |

- **`cargo metadata` (locked, all targets):**
  - 471 packages on each side.
  - `alloy-sol-macro`, `alloy-sol-macro-expander` and `alloy-sol-macro-input` resolve only to 1.5.7, with `alloy-sol-types` 1.5.7 and `syn-solidity` 1.7.3, unchanged.
  - The three crates' direct dependency kind changed from **normal** to **dev**. No other direct dependency changed.

### Cargo graphs

- **Normal+build package lists:** identical sets for both targets, 92 = 92 packages each for host and wasm32.
  - No package leaves the normal+build graph. `alloy-sol-types` 1.5.7 has a normal dependency on `alloy-sol-macro`, so the macro and its dependencies remain reachable as a host proc-macro.
- **Trees:**
  - Normal+build trees shrink from 268 to 229 lines (host) and from 267 to 228 lines (wasm32). The root no longer lists the three macro crates as direct children.
  - Normal+build+dev trees keep their line counts (861 host, 269 wasm32), with the crates now under `[dev-dependencies]`.
  - Feature trees have an identical line multiset in a different order.
- **Inverse trees (normal+build), the same for both targets:**

  | Package | Baseline dependents | Experiment dependents |
  | --- | --- | --- |
  | `alloy-sol-macro` | `alloy-sol-types`, wrapper | `alloy-sol-types` |
  | `alloy-sol-macro-expander` | `alloy-sol-macro`, wrapper | `alloy-sol-macro` |
  | `alloy-sol-macro-input` | `alloy-sol-macro`, `alloy-sol-macro-expander`, wrapper | `alloy-sol-macro`, `alloy-sol-macro-expander` |

  With dev edges included, the wrapper reappears only through `[dev-dependencies]`.
- **Direct dependencies (`--depth 1`):**
  - wasm32 normal+build changes from 6 entries (the 3 macro crates, `alloy-sol-types`, `ponte-optimizer`, `stylus-sdk`) to 3 (`alloy-sol-types`, `ponte-optimizer`, `stylus-sdk`).
  - Dev changes from `stylus-sdk` alone to the 3 macro crates plus `stylus-sdk`.
- **2B.5.1 advisory paths, re-run by run 44171151888, unchanged:**
  - `crypto-bigint 0.5.5` and `lru 0.16.4` appear only in host dev-inclusive inverse trees, for example `lru → alloy-provider 1.8.3 → stylus-test 0.10.10 → stylus-sdk 0.10.10 → wrapper [dev-dependencies]`.
  - Both are absent from the wasm32 inverse trees and from the normal+build trees.

### Compiler invocations (cold `-vv` release WASM build)

| Side | rustc units | host | wasm32 | build-script runs (host / wasm32) | parse errors |
| --- | ---: | ---: | ---: | --- | ---: |
| Baseline | 144 | 87 | 57 | 18 (13 / 5) | 0 |
| Experiment | 130 | 87 | 43 | 16 (13 / 3) | 0 |

- **Removed: 14 wasm32 `[lib]` units**:
  - `alloy-sol-macro-expander` 1.5.7, `alloy-sol-macro-input` 1.5.7
  - `dunce` 1.0.5, `equivalent` 1.0.3, `hashbrown` 0.17.1, `heck` 0.5.0, `indexmap` 2.14.2, `macro-string` 0.1.4
  - `proc-macro-error2` 2.0.1, `proc-macro2` 1.0.107, `quote` 1.0.47, `syn` 2.0.119, `syn-solidity` 1.7.3, `unicode-ident` 1.0.27

  Also removed: the wasm32 build-script runs of `proc-macro2` and `quote`.
- **Added units: none. Feature changes: none.** Normalized flag changes: none. Hash-valued `-C metadata`, `-C extra-filename` and incremental paths are deliberately normalized here and reported separately below.
- **Root crate** (`ponte_stylus_wrapper [lib+cdylib]`, wasm32): it lost the externs `alloy_sol_macro` (`.so`), `alloy_sol_macro_expander` and `alloy_sol_macro_input` (`.rlib`), and keeps `alloy_sol_types`, `ponte_optimizer` and `stylus_sdk`.
- **Macro units:**
  - `alloy-sol-macro` is still built once as a host `[proc-macro]` on both sides, via `alloy-sol-types`.
  - Expander and input were built for host **and** wasm32 in the baseline, and only for host in the experiment.
- **Raw `-C metadata`** (run 44175556816): changed for **exactly 1 of 130 shared rustc units**, the root wasm32 crate, from `f1f1384dc7af2cbe` to `0aa7dcddcabb76df`. No other unit's metadata changed.

### Cargo JSON unit inventories

| Build | Baseline | Experiment | Only in baseline | Only in experiment |
| --- | ---: | ---: | --- | --- |
| Release WASM (`BUILD --message-format=json`) | 162 | 146 | 16: the same 14 wasm32 libraries and 2 wasm32 build-script runs | none |
| `cargo test --locked --no-run` | 354 | 354 | none | none |
| `export-abi` host build | 139 | 133 | 19 compilations across 14 macro-chain host libraries at `opt=0 debug=2` | 13 compilations of 13 of those libraries at `opt=0 debug=0` |

No multiplicity changes and no feature changes occurred in any inventory.

In the host `export-abi` build, the macro-chain libraries were previously compiled as ordinary dependencies with the dev profile's `debug=2`. Now they are compiled only as proc-macro build dependencies at `debug=0`. The `syn` `debug=0` unit already existed on both sides. This is consistent with Cargo's build-override defaults. `cargo test` is unaffected because dev-dependencies are part of test builds on both sides.

### Release WASM checksum and size

| | Baseline (`fe6e928`) | Experiment |
| --- | --- | --- |
| SHA-256 | `26f536e6e2ca6eb219b011b4f353d43222e4a09df12cc39397e383ede18fc67d` | `6fd9159dfa148837be88249deaf1cb8f04f0c4787d05b5340790051cf2c8fefd` |
| Size | 90,506 bytes | 90,506 bytes |
| Within-side determinism | identical across verbose cold, exact CI, JSON no-op and second fully cold builds | identical, same 4 builds |

**Reproducibility across runs:**
- **Baseline hash:** found on both sides of both control runs, on the baseline side of all four experiment runs, and in Phase 2B.5.1 runs 44099488399, 44099896720, 44100241033 and 44106361911.
- **Experiment hash:** found in all four experiment runs and in the separate `Dependency and release WASM evidence` run 44171151888, which uses the unchanged 2B.5.1 script.

The exact-CI and JSON builds that follow the verbose build are no-op rebuilds. The independent within-side reproduction is the second fully cold build.

**Section comparison:**
- The section layout and every section size are identical.
- Only two sections differ in content: `code` (73,750 bytes on both sides) and the `name` custom section (11,210 bytes on both sides).
- Data segments, imports and exports are identical. The 6 `vm_hooks` imports are `pay_for_memory_grow`, `msg_reentrant`, `msg_value`, `storage_flush_cache`, `write_result` and `read_args`; the exports are `memory`, `user_entrypoint`, `__heap_base` and `__data_end`.
- Raw differences:
  - 9 of 131 code bodies differ by position.
  - 27 of 137 function names differ, 3 of them beyond legacy symbol hashes.
  - `wasm2wat` output is 34,663 lines on both sides, with 5 differing lines in each direction.

### Release WASM attribution — equivalent up to symbol renaming and function order

Runs 44175243662 and 44175556816 executed an informational exact-renaming proof. It is not one of the pre-registered checks. The steps:
1. Pair every function one-to-one across builds. A function's identity is its name with the legacy symbol hash and any ThinLTO `.llvm.N` suffix removed. Monomorphizations sharing an identity are paired by normalized content.
2. Rename every baseline symbol to its paired experiment symbol.
3. Compare the `wasm2wat` output **exactly**. This covers every function and every other module field (types, imports, table, memory, globals, exports, element and data segments, other custom sections).
4. Attribute each differing binary body. A function that calls a moved function must have different call-index immediates; any other difference counts as "unexplained".

Results (both runs):
- `equivalent_up_to_renaming_and_order = True`.
- **All 137 functions paired** (6 imported, 131 defined); none unpaired.
- **27 symbols renamed.** After renaming, **137/137 functions and 31/31 other module fields are identical**. Only the debug `name` section differs.
- **5 functions moved.** Positions count defined functions; the absolute index is position + 6.

  | Function (demangled, hash removed) | Body size | Baseline position | Experiment position | Binary body |
  | --- | ---: | ---: | ---: | --- |
  | `<(T1,) as alloy_sol_types::abi::token::TokenSeq>::encode_sequence`, instance A | 3,926 | 0 | 2 | identical |
  | `<(T1,) as alloy_sol_types::abi::token::TokenSeq>::encode_sequence`, instance B | 4,044 | 1 | 0 | differs only in the call to `tail_append` (moved) |
  | `<(T1,T2,T3) as alloy_sol_types::abi::token::Token>::tail_append` | 1,159 | 2 | 1 | identical |
  | `<alloc::vec::into_iter::IntoIter<T,A> as Iterator>::fold`, instance A | 398 | 22 | 23 | identical |
  | `<alloc::vec::into_iter::IntoIter<T,A> as Iterator>::fold`, instance B | 2,002 | 23 | 22 | identical |

- **Binary bodies:**
  - 126 of 131 are byte-identical, including 4 of the moved functions.
  - 5 differ only because they call a moved function: the moved `encode_sequence` instance B above, and the four unmoved callers below.
  - **Unexplained: 0.**

  | Unmoved function whose body differs | Size (both sides) | Calls moved function |
  | --- | ---: | --- |
  | `alloy_sol_types::abi::encoder::encode_sequence` | 562 | `<(T1,) as TokenSeq>::encode_sequence` |
  | `<impl alloy_sol_types::SolType for (T1,)>::detokenize` | 1,157 | `IntoIter::fold` |
  | `alloy_sol_types::errors::Error::type_check_fail_token` | 616 | `<(T1,) as TokenSeq>::encode_sequence` |
  | `ponte_stylus_wrapper::SyntheticOptimizer::evaluate_synthetic` | 2,508 | `IntoIter::fold` |

- **Why the size is unchanged:**
  - All affected call targets have absolute indices 6–8 and 28–29, below 128, so each one is encoded as a single LEB128 byte on both sides.
  - The renamed symbols keep their width: legacy hashes are fixed-length, and the changed ThinLTO suffix on `alloc::raw_vec::finish_grow` (`.llvm.11446447751178323770` → `.llvm.14612765242449278279`) has 20 digits on both sides.

**Mechanism.** Each step below is grounded in the toolchain's own source, and the first is evidenced directly:

1. **Cargo** (bundled with Rust 1.91.0, commit `ea2d978`): `compute_metadata` collects the metadata of a unit's dependencies and hashes their sorted `c_metadata` values into the unit's own `c_metadata`. The source documents it as "used for symbol mangling" ([`compilation_files.rs` L616–627, L721–728, L80–81](https://github.com/rust-lang/cargo/blob/ea2d97820c16195b0ca3fadb4319fe512c199a43/src/cargo/core/compiler/build_runner/compilation_files.rs#L616-L627)). Removing three dependency units from the root crate changes its `-C metadata`. This is observed directly: exactly one unit, the root, changed.
2. **rustc 1.91.0 legacy mangling:** generic instances take the instantiating crate into account, and their symbol hash includes that crate's `stable_crate_id` ([`rustc_symbol_mangling/src/lib.rs` L268–270](https://github.com/rust-lang/rust/blob/1.91.0/compiler/rustc_symbol_mangling/src/lib.rs#L268-L270); [`legacy.rs` L114–160](https://github.com/rust-lang/rust/blob/1.91.0/compiler/rustc_symbol_mangling/src/legacy.rs#L114-L160)). Local items hash their `def_path_hash`, which is also crate-qualified. A new root `-C metadata` therefore renames the wrapper's own functions and every generic instance it instantiates, which accounts for the 27 renamed symbols. Upstream non-generic symbols keep their names.
3. **rustc item order:** within a codegen unit, `items_in_deterministic_order` sorts by `(Option<Span>, SymbolName)`. Instances of upstream generics have no local span, so they sort by symbol name, hash included ([`rustc_middle/src/mir/mono.rs` L505–545](https://github.com/rust-lang/rust/blob/1.91.0/compiler/rustc_middle/src/mir/mono.rs#L505-L545)). This is consistent with the observation that every moved function is an instance of an upstream generic.
4. **ThinLTO:** the wrapper has no `[profile]` overrides, so Cargo's default release profile applies: 16 codegen units with thin-local LTO. The promotion suffix on `finish_grow` depends on its containing module, so it is expected to change when that module's symbol names change.

**What this establishes, and what it does not.** The two binaries are identical up to a consistent permutation of function indices and the contents of the debug `name` section. The renaming is applied to every call, export and element reference, and all are identical afterwards. A consistent index permutation does not change WebAssembly execution semantics, and the `name` section has none. The 14 removed wasm32 compilations contributed no code to the binary. It does **not** establish anything about Stylus activation, ink or gas pricing, or Nitro behavior, none of which was evaluated. The changed SHA-256 makes this a different artifact for any activation or code-hash purpose.

### ABI generation and selector

- **ABI:** the SDK `export-abi` output is byte-identical on both sides, SHA-256 `4308824fc1b641a1395da5f0a58106b9e337ae5b7a6cc3a2ae541bc520aa7991`. On both sides, `check_abi.py` verified the declaration `function evaluateSynthetic(SyntheticRequest request) external view returns (SyntheticResult memory);` and verified the result and rejection field order and types against `expected-abi.json`.
- **Selector** `selector_check.cjs` printed 5 PASS lines on both sides:
  1. The SDK export declares `evaluateSynthetic`.
  2. `keccak256` of the canonical signature, bytes `[0..4]`, equals `0x31631981`.
  3. The client ABI selector and canonical signature match.
  4. The release WASM routes `0x31631981`, and the result decodes as SELECTED with `expectedOut=1`.
  5. All 32 one-bit variants of `0x31631981` revert with empty output before reaching any method. The wrapper defines no fallback, and `stylus-sdk` 0.10.10's router returns an empty error for unknown selectors.

### Offline tests

All of the following exit 0 on both sides:
- the advisory guard unit tests and `advisory_guard.py --check-baseline`
- `abi-tools`: `npm ci`, `npm run check`, `npm test` (complete generated client ABI)
- `cargo fmt --check`
- `cargo test --locked` (11 passed)
- `cargo clippy --all-targets -D warnings`
- `export-abi` with `check_abi.py`
- `inspect_wasm.py` (entrypoint and imports)
- `test_wasm_entrypoint.cjs` (8 PASS lines; host stubs)
- `abi-tools/test-wasm.cjs` (49 fixtures: 48 executed through the release WASM, and the 65-candidate fixture reverts as designed)
- `selector_check.cjs`

The separate `Local Stylus wrapper` run 44171151876 on the changed manifest also succeeded.

All of these are offline checks against host stubs. None is a Nitro, chain or activation test.

### RustSec (unsuppressed)

Run with `cargo-audit` 0.23.0 against advisory-db `233155b4025b854c68a4b199c0e32d7fd53291a2` (commit date 2026-11-17T11:14:35+01:00), using one snapshot for both sides. Audit times included 2026-11-17T20:44:46Z (run 44171151965) and 2026-11-17T21:07:44Z (run 44175556816). Flags: `--no-fetch --deny warnings --json`. No ignores.

Baseline and experiment results are **identical** in every run, and identical to Phase 2B.5.1:

| Workspace | Exit | Findings |
| --- | ---: | --- |
| environment-check | 0 | none |
| optimizer | 1 | unmaintained `RUSTSEC-2024-0436` (`paste 1.0.15`) |
| stylus-wrapper | 1 | 7 findings, listed below |

The 7 stylus-wrapper findings:
- vulnerability `RUSTSEC-2026-0387` (`crypto-bigint 0.5.5`)
- unsound `RUSTSEC-2026-0253` (`lru 0.16.4`)
- unmaintained:
  - `RUSTSEC-2024-0370` (`proc-macro-error 1.0.4`)
  - `RUSTSEC-2024-0388` (`derivative 2.2.0`)
  - `RUSTSEC-2024-0436` (`paste 1.0.15`)
  - `RUSTSEC-2026-0173` (`proc-macro-error2 2.0.1`)
  - `RUSTSEC-2026-0543` (`chrono 0.4.45`)

The lockfiles are byte-identical, so a lockfile-wide audit cannot differ.

`proc-macro-error2 2.0.1` illustrates the limit of this change. Its wasm32 compilation was removed, but it remains in the lockfile and in the host proc-macro build, as a dependency of `alloy-sol-macro` and the expander. These are lockfile-wide findings, not claims that the affected crates are linked into the WASM.

## Interpretation

1. **The isolation works at the declaration level.** The three macro crates are now dev-only direct dependencies. The wasm32 release build no longer compiles the expander/input chain: 144 → 130 rustc units, 18 → 16 build-script runs. The ABI, selector routing and all offline behavior are unchanged.
2. **It cannot remove the macro from the normal graph.** `alloy-sol-types` 1.5.7 depends on `alloy-sol-macro` as a normal dependency. The proc-macro and its host dependencies are therefore still compiled, and the lockfile, package lists and RustSec findings do not change. The change gives build-graph hygiene; it brings no security improvement.
3. **The WASM checksum changes for naming and order reasons only.** The binaries are proven equivalent up to symbol renaming and function order, and the cause is traced to the root crate's Cargo metadata. If the change is adopted, any record pinned to `26f536e6…c67d` (Phase 2B.5.1 and later evidence) must be updated to `6fd9159d…fefd`. Any activation would be for that new code hash.
4. **The pins should keep protecting resolution, but this was not exercised.** Cargo resolves the dev-dependencies of workspace members into the same lockfile, and allows only one semver-compatible version of a package in a resolve. The `=1.5.7` dev-dependency pins should therefore still keep `alloy-sol-macro*` at 1.5.7 when the lockfile is re-resolved; this is the protection Phase 2B.2 added after macro 1.7.3 broke the build. No `cargo update` or lockfile regeneration was run, because unrelated changes were out of scope.
5. Merging and deployment are not authorized by this evidence. Activation remains blocked pending the security review and separately authorized validation recorded in Phase 2B.5.1.

## Limitations

- **Evidence access.** Every value in this report comes from annotations written by the runner and read here through the GitHub API. Logs and artifacts could not be downloaded, and the WASM binaries were not re-hashed independently in this sandbox. Some annotations are truncated; the complete data is in each run's `comparison.json`.
- **Equivalence proof.**
  - It depends on wabt's `wasm2wat` from the Ubuntu archive (optional and non-gating) and on the harness's text comparison.
  - It is informational, not a pre-registered check, and was added after the first experiment run showed the hash change.
  - It shows structural identity up to renaming and index permutation. It is not a statement about the toolchain in general.
- **Compiler invocations.** These come from parsing Cargo's `-vv` output, with paths and hashes normalized. Raw `-C metadata` values are compared separately.
- **Graph evidence.** Cargo trees and metadata are resolution views. They do not establish linkage, reachability or exploitability.
- **RustSec.**
  - Findings are lockfile-wide and not filtered by target.
  - Coverage of yanked crates under `--no-fetch` depends on the runner's local index cache and is unknown.
  - Freshness is tied to advisory-db `233155b4…` and the recorded audit times.
- **Platform coverage.** Only `ubuntu-latest` x86-64 with Rust 1.91.0 and Cargo's default release profile was tested. The runner image version is recorded in each artifact's `provenance.txt`, which was not read here.
- **Not evaluated:** Nitro or Stylus activation, ink or gas, on-chain behavior, advisory exploitability, and the behavior of `cargo update` or lockfile regeneration with the moved pins.

## Reproducing

```sh
gh workflow run macro-isolation-experiment.yml --ref arena/85bd8a06-ponte            # base defaults to fe6e928…
gh workflow run macro-isolation-experiment.yml --ref arena/85bd8a06-ponte -f base=<sha>
```

Results appear in three places: the job's step summary (`comparison.md`), check-run annotations ("Verification checks", "Release WASM attribution (exact renaming proof)", "RustSec comparison" and others), and the `ponte-macro-isolation-evidence-<run>-<attempt>` artifact. The artifact holds every command's argv, cwd, stdout, stderr and exit code, plus `comparison.json`, `wasm-sections.json`, `release.wat` and the RustSec JSON.
