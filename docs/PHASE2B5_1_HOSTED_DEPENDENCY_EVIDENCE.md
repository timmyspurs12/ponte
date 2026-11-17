# Phase 2B.5.1 — hosted dependency and WASM evidence

## Status

**The hosted audit found advisories and failed; this is not a clean audit or deployment approval.** GitHub reports successful evidence uploads, but this sandbox could not download the archive or full logs because the artifact storage endpoint returned EOF. Run metadata and check annotations were independently inspected; the compiler-log observation below is user-supplied and was not independently checked here. No deployment, activation or RPC validation is in scope.

Baseline: this branch starts from `main` commit `666da3e602a4fff6838f64e939db4dd1c22b3bc0`. Three separate workspaces and lockfiles are covered: `rust/environment-check`, `rust/optimizer`, and `rust/stylus-wrapper`. The existing `stylus-wrapper.yml` release build is `cargo build --locked --release --lib --target wasm32-unknown-unknown`. No existing CI or release gate is changed.

## Method and boundaries

The separately triggered workflow `.github/workflows/dependency-evidence.yml` installs Rust 1.91.0 and the WASM target. `scripts/phase2b/dependency-evidence.sh` records commit, toolchain, lock hashes, locked `cargo metadata` for all targets, host and WASM; `cargo tree` for host and WASM with normal/build, normal/build/dev and feature edges; and inverse trees for the exact locked `crypto-bigint@0.5.5` and `lru@0.16.4`. Each command's stdout, stderr and exit status are saved. Metadata platform filtering is a Cargo resolution view, not a compiled artifact inventory. Normal/build trees include host build dependencies, so they are not a list of crates linked into WASM. A failure or empty inverse tree is not a runtime reachability proof. Feature edges and dev trees should be read separately from the normal/build tree.

The wrapper's exact release CI build is preceded by the same command with `-vv`; its output captures compiler invocations. Both builds' SHA-256 values must match. The generated `.wasm`, size, SHA-256, build logs and offline WASM inspection are uploaded alongside the graphs, subject to runner and artifact success. The matching second build is incremental and not an independent reproducibility test. Imports/exports and Cargo trees cannot establish the complete linked dependency set or prove exploitable/unreachable code. This build alone does not validate Nitro, chain behavior or activation.

`scripts/phase2b/rustsec-evidence.sh` downloads the official cargo-audit 0.23.0 Linux x86-64 musl release, verifies SHA-256 `4f01c74ed84b2dffd0b1d37012a62cdf2a92c96e25bdf8eec7fcc0d4d3eb7811`, clones current RustSec advisory-db and records its commit. Each lockfile is independently audited with `--no-fetch --deny warnings --json`, using that same cloned revision and no ignore or target filters. The script saves commands, JSON, stderr, and exit status even if earlier audits report findings. Informational warnings fail the job alongside vulnerabilities; tool and report errors also fail. Artifact upload is attempted on failure, not a suppression of it. The `--no-fetch` mode only opens an existing crates.io index for yanked checks; missing/stale index can make yanked checks incomplete. Inspect stderr; a clean RustSec advisory result is not a guarantee of complete yanked detection. Freshness is tied to the recorded run date and database revision, not perpetual.

## Preliminary investigation, not hosted cargo-audit findings

A previous custom semver scan of advisory-db commit `233155b4025b854c68a4b199c0e32d7fd53291a2` identified candidates including vulnerability [RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html) for `crypto-bigint 0.5.5` and unsoundness warning [RUSTSEC-2026-0253](https://rustsec.org/advisories/RUSTSEC-2026-0253.html) for `lru 0.16.4`. That scan is not authoritative cargo-audit output. The lru advisory requires a panicking key destructor, caught unwinding and subsequent cache operations; the inspected Alloy provider call uses a `u64` block-number key. No general exploitability or unreachability conclusion follows. The crypto-bigint timing advisory requires relevant operations on secrets and observable timing; neither has been established. Determine actual target-specific Cargo paths from uploaded evidence; they do not establish machine-code reachability. No dependency was upgraded or removed.

## PR merge-test run 44100241033

The [PR-triggered run](https://github.com/timmyspurs12/ponte/actions/runs/44100241033) tested GitHub's **merge-test commit** `30141c37fc7a1edaa8688ec46208151886583724`, not the PR branch head directly. Its parents were base `666da3e602a4fff6838f64e939db4dd1c22b3bc0` and the then-current PR branch head `08c43ab24ee78d862fca90140b6e5c3a9336e182`. This documentation update is a later branch commit; the SHAs above describe the historical run, not the current PR head.

The graph and Rust 1.91.0 release WASM build step succeeded. The audit step **failed** on findings, so the overall evidence job failed; upload succeeded. GitHub lists [artifact `ponte-dependency-evidence-44100241033-1`](https://github.com/timmyspurs12/ponte/actions/runs/44100241033/artifacts/14335881820), ID `14335881820`, archive SHA-256 `1f5038ff82b7b5d68d82ca9ca1c344aedafc08f5020bfdad1ba645c244db9930`, expiring 2026-12-17. The archive contains the full recorded dependency graphs, audit JSON, compiler logs and WASM inspection, plus the release WASM and other supporting evidence. GitHub's archive digest is distinct from the WASM digest. This sandbox could not independently download or inspect the archive.

The runner reported the release WASM as **90,506 bytes**, SHA-256 `26f536e6e2ca6eb219b011b4f353d43222e4a09df12cc39397e383ede18fc67d`. The release command is `cargo +1.91.0 build --locked --release --lib --target wasm32-unknown-unknown`, preceded by the same command with `-vv`. The checksum is from the runner annotation, not an independent hash of a downloaded binary.

### Dependency distinction

- Both `crypto-bigint 0.5.5` and `lru 0.16.4` occur in the **host dev-inclusive** inverse paths. For example, lru appears through `alloy-provider → stylus-test → stylus-sdk → wrapper`; crypto-bigint appears through `elliptic-curve`, including an `alloy-signer → alloy-network → alloy-provider → stylus-test` path.
- Neither package appears in the recorded **WASM-target normal/build package list** or the WASM-target inverse graphs, including dev-inclusive inverse queries. The normal/build inverse queries returned exit 0 with Cargo's `nothing to print` warning.
- The user reports that neither appears as a compiled unit in the verbose WASM build log. This observation was not independently verified in this sandbox because the archive download failed.
- These observations do **not** establish general exploitability or constitute a formal binary-level proof of unreachability. Cargo graph scope and compiler logs do not by themselves prove runtime behavior.

### RustSec results

The unfiltered lockfile audits used advisory-db revision `233155b4025b854c68a4b199c0e32d7fd53291a2` at 2026-11-17 14:11:35 UTC, with `--deny warnings` and no advisory suppressions. The revision was recorded separately by Git; cargo-audit's JSON database commit/date fields were null. The status and findings below are from the run annotations:

| Workspace | Exit | Vulnerabilities | Warnings |
| --- | ---: | ---: | --- |
| environment-check | 0 | 0 | 0 |
| optimizer | 1 | 0 | 1 unmaintained: `RUSTSEC-2024-0436`, `paste 1.0.15` |
| stylus-wrapper | 1 | 1: `RUSTSEC-2026-0387`, `crypto-bigint 0.5.5` | 6: see below |

The wrapper warnings are unsound `RUSTSEC-2026-0253` (`lru 0.16.4`) and five unmaintained advisories: `RUSTSEC-2024-0370` (`proc-macro-error 1.0.4`), `RUSTSEC-2024-0388` (`derivative 2.2.0`), `RUSTSEC-2024-0436` (`paste 1.0.15`), `RUSTSEC-2026-0173` (`proc-macro-error2 2.0.1`) and `RUSTSEC-2026-0543` (`chrono 0.4.45`). Findings are lockfile-wide, not claims that the affected crates are linked into WASM. The `--no-fetch` yanked-index coverage remains unknown.

## Hosted run 44099488399

The [push run](https://github.com/timmyspurs12/ponte/actions/runs/44099488399) on commit `27770e7c45b345f6c4f799da234e0042b2c369c1` finished **failure**: toolchain install and graph/WASM capture succeeded; the audit step failed; artifact upload succeeded. GitHub lists [artifact `ponte-dependency-evidence-44099488399-1`](https://github.com/timmyspurs12/ponte/actions/runs/44099488399/artifacts/14334524551), expiring 2026-12-17, archive digest `sha256:4b2593ef5d7ba732f002112c9128cd1f1c0a49fa4bd6118ffd46c8e01a2b78fb`. This environment could not download the archive or logs (storage endpoint EOF); upload metadata is not independent inspection of the archive.

- The successful graph step annotated **90,506 bytes**, WASM SHA-256 `26f536e6e2ca6eb219b011b4f353d43222e4a09df12cc39397e383ede18fc67d`. This is the first run's build, not a separately reproduced or downloaded binary.
- Normal/build wrapper trees for both host and WASM did not list either `crypto-bigint 0.5.5` or `lru 0.16.4`; their inverse queries returned 0 with Cargo's `nothing to print` warning. This is the captured Cargo graph scope only, not a proof of binary or runtime absence. The detailed feature and dev-inclusive graphs are in the artifact but could not be inspected here.
- RustSec annotations: environment-check exit 0, zero vulnerabilities and zero warnings; optimizer exit 1, zero vulnerabilities and one unmaintained warning, `RUSTSEC-2024-0436` (`paste 1.0.15`); wrapper exit 1, one vulnerability and six warnings. The visible vulnerability is `RUSTSEC-2026-0387` (`crypto-bigint 0.5.5`). Visible unmaintained notices cover `RUSTSEC-2024-0370` (`proc-macro-error 1.0.4`), `RUSTSEC-2024-0388` (`derivative 2.2.0`), `RUSTSEC-2024-0436` (`paste 1.0.15`), `RUSTSEC-2026-0173` (`proc-macro-error2 2.0.1`), and `RUSTSEC-2026-0543` (`chrono 0.4.45`). The remaining warning is **not identifiable from available annotations**; it must be verified in the JSON artifact, not assumed to be the preliminary `lru` candidate. The JSON summary's database fields `last-commit` and `last-updated` were null (1,527 advisories); the separately recorded Git revision could not be inspected in the inaccessible artifact. Yanked-index coverage is unknown.

## Follow-up hosted run 44099896720

The [push run](https://github.com/timmyspurs12/ponte/actions/runs/44099896720) tested commit `95670037692dbc591d58b52c249029870186d34d`: Rust 1.91.0 setup and graph/build steps succeeded, audit failed, and upload succeeded. The [artifact](https://github.com/timmyspurs12/ponte/actions/runs/44099896720/artifacts/14335082686), `ponte-dependency-evidence-44099896720-1`, expires 2026-12-17; GitHub reports archive digest `sha256:9706e69db6854161ae1ffb51d44d82c7ccef7dca45057f18bfad6437e33cd917`. The earlier sandbox artifact/log download limitation applies; these conclusions are from check annotations and job metadata, not inspection of the downloaded archive.

The audit used advisory-db Git revision `233155b4025b854c68a4b199c0e32d7fd53291a2` at 2026-11-17 14:09:43 UTC (the cargo-audit JSON database commit/date fields were null; the separate `git rev-parse HEAD` provided the revision). It confirms the counts and five unmaintained wrapper findings listed above, as well as the sixth wrapper warning: **unsound `RUSTSEC-2026-0253`, `lru 0.16.4`**. Environment-check exit 0; optimizer and wrapper exit 1. These are lockfile-wide findings, not target-filtered vulnerability claims. Yanked-index coverage is unknown.

The host normal/build trees for both packages were empty as in the first run. In the host **dev-inclusive** inverse tree, `lru 0.16.4 → alloy-provider 1.8.3 → stylus-test 0.10.10 → stylus-sdk 0.10.10 → wrapper`, with a dev-dependency edge to the wrapper. `crypto-bigint 0.5.5 → elliptic-curve 0.13.8` appears in the host dev-inclusive graph, including an `alloy-signer → alloy-network → alloy-provider → stylus-test` path. The inverse excerpt was truncated at 2,500 characters in the annotation; the artifact has the complete graph. WASM dev-inclusive inverse queries for both were empty with exit 0. These Cargo trees are resolution views, not proof about linked code or exploitability.

The run again reported WASM **90,506 bytes**, SHA-256 `26f536e6e2ca6eb219b011b4f353d43222e4a09df12cc39397e383ede18fc67d`, matching the earlier hosted run's reported checksum. It is a second hosted build, but verification is limited to runner annotations until the binaries can be downloaded and hashed independently.

## Open evidence

- Inspect downloaded raw JSON, full build/feature/dev graphs, toolchain provenance and audit stderr; independently hash the uploaded WASM. Check yanked-index coverage.
- Exploitability, full linked-crate inventory, chain/Nitro behavior and activation eligibility are **not established**.

Deployment/activation is not authorized by this evidence and remains blocked pending appropriate security review and separately authorized validation.
