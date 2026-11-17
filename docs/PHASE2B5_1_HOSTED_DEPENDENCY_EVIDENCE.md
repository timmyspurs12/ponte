# Phase 2B.5.1 — hosted dependency and WASM evidence

## Status

**Evidence collection is not yet verified.** The workflow added in this change captures fresh evidence on GitHub-hosted `ubuntu-latest`. A completed run, its result, a downloadable artifact, RustSec results and a WASM checksum must be verified before they can be asserted here. Failure to produce those is a blocker, not a clean audit. No deployment, activation or RPC validation is in scope.

Baseline: this branch starts from `main` commit `666da3e602a4fff6838f64e939db4dd1c22b3bc0`. Three separate workspaces and lockfiles are covered: `rust/environment-check`, `rust/optimizer`, and `rust/stylus-wrapper`. The existing `stylus-wrapper.yml` release build is `cargo build --locked --release --lib --target wasm32-unknown-unknown`. No existing CI or release gate is changed.

## Method and boundaries

The separately triggered workflow `.github/workflows/dependency-evidence.yml` installs Rust 1.91.0 and the WASM target. `scripts/phase2b/dependency-evidence.sh` records commit, toolchain, lock hashes, locked `cargo metadata` for all targets, host and WASM; `cargo tree` for host and WASM with normal/build, normal/build/dev and feature edges; and inverse trees for the exact locked `crypto-bigint@0.5.5` and `lru@0.16.4`. Each command's stdout, stderr and exit status are saved. Metadata platform filtering is a Cargo resolution view, not a compiled artifact inventory. Normal/build trees include host build dependencies, so they are not a list of crates linked into WASM. A failure or empty inverse tree is not a runtime reachability proof. Feature edges and dev trees should be read separately from the normal/build tree.

The wrapper's exact release CI build is preceded by the same command with `-vv`; its output captures compiler invocations. Both builds' SHA-256 values must match. The generated `.wasm`, size, SHA-256, build logs and offline WASM inspection are uploaded alongside the graphs, subject to runner and artifact success. The matching second build is incremental and not an independent reproducibility test. Imports/exports and Cargo trees cannot establish the complete linked dependency set or prove exploitable/unreachable code. This build alone does not validate Nitro, chain behavior or activation.

`scripts/phase2b/rustsec-evidence.sh` downloads the official cargo-audit 0.23.0 Linux x86-64 musl release, verifies SHA-256 `4f01c74ed84b2dffd0b1d37012a62cdf2a92c96e25bdf8eec7fcc0d4d3eb7811`, clones current RustSec advisory-db and records its commit. Each lockfile is independently audited with `--no-fetch --deny warnings --json`, using that same cloned revision and no ignore or target filters. The script saves commands, JSON, stderr, and exit status even if earlier audits report findings. Informational warnings fail the job alongside vulnerabilities; tool and report errors also fail. Artifact upload is attempted on failure, not a suppression of it. The `--no-fetch` mode only opens an existing crates.io index for yanked checks; missing/stale index can make yanked checks incomplete. Inspect stderr; a clean RustSec advisory result is not a guarantee of complete yanked detection. Freshness is tied to the recorded run date and database revision, not perpetual.

## Preliminary investigation, not hosted cargo-audit findings

A previous custom semver scan of advisory-db commit `233155b4025b854c68a4b199c0e32d7fd53291a2` identified candidates including vulnerability [RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html) for `crypto-bigint 0.5.5` and unsoundness warning [RUSTSEC-2026-0253](https://rustsec.org/advisories/RUSTSEC-2026-0253.html) for `lru 0.16.4`. That scan is not authoritative cargo-audit output. The lru advisory requires a panicking key destructor, caught unwinding and subsequent cache operations; the inspected Alloy provider call uses a `u64` block-number key. No general exploitability or unreachability conclusion follows. The crypto-bigint timing advisory requires relevant operations on secrets and observable timing; neither has been established. Determine actual target-specific Cargo paths from uploaded evidence; they do not establish machine-code reachability. No dependency was upgraded or removed.

## Open evidence

- Hosted run and commit: **not yet verified**.
- RustSec revision, audit JSON, findings, exit codes and yanked-index coverage: **not yet verified**.
- WASM SHA-256, byte size and artifact download: **not yet verified**.
- Exploitability, full linked-crate inventory, chain/Nitro behavior and activation eligibility: **not established**.

Deployment/activation is not authorized by this evidence and remains blocked pending appropriate security review and separately authorized validation.
