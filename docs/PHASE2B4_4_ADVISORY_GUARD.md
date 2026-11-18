# Phase 2B.4.4 — Offline Rust advisory guard

This narrowly scoped guard checks **tracked Cargo.lock files** against two pinned RustSec rules, with Python 3.11+ and Git only. It does not use Cargo, a network, a live advisory database, wallets, RPC, or a deployment. It never updates a dependency.

| Package | Advisory / issued | Fixed according to the pinned rule | Documented baseline |
|---|---|---|---|
| `crypto-bigint` | [RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html), 2026-10-23 | `>=0.7.6` | `0.5.5`, `rust/Cargo.lock` |
| `lru` | [RUSTSEC-2026-0253](https://rustsec.org/advisories/RUSTSEC-2026-0253.html), 2026-08-11 | `>=0.18.2` | `0.16.4`, `rust/Cargo.lock` |

Phase 2B.6.1 moved the workspace lockfile from `rust/stylus-wrapper/Cargo.lock` to `rust/Cargo.lock`. The baseline identities are unchanged; only the recorded path label moved.

The rules classify stable crates.io registry releases below each fixed threshold as `affected` and releases at or above it as `not_affected_by_pinned_rule`. Prerelease versions and other sources for either tracked package are `unknown`; invalid versions and malformed/unreadable/unsupported lockfiles are errors. Multiple package versions and separate lockfiles are examined independently. Repeating the same lockfile path or identical package entry is an error. Unrelated package names are outside this narrow check. `not_affected_by_pinned_rule` is **not** a clean bill of health for any other advisory.

Each tracked package instance is separately classified as `documented_baseline` only when its lockfile path, package, version and registry source exactly match the checked-in baseline. Anything else is `unclassified`, even if its version appears fixed by a pinned rule. A missing baseline entry also requires review. The baseline records known facts, **not a waiver, suppression, or release approval**.

## Run from the repository root

```sh
# Report known and unclassified occurrences; JSON is optional.
python3 rust/stylus-wrapper/scripts/advisory_guard.py
python3 rust/stylus-wrapper/scripts/advisory_guard.py --json

# CI-style regression check: known affected baseline is visible but not a CI failure.
python3 rust/stylus-wrapper/scripts/advisory_guard.py --check-baseline
python3 -m unittest discover -s rust/stylus-wrapper/scripts -p 'test_advisory_guard.py' -v

# Stronger release gate: current known affected versions make this fail.
python3 rust/stylus-wrapper/scripts/advisory_guard.py --release-gate

# Inspect explicit files instead of all git-tracked Cargo.lock files.
python3 rust/stylus-wrapper/scripts/advisory_guard.py --lockfile rust/Cargo.lock
```

`--lockfile` may be repeated; relative paths are resolved from the current working directory. The default uses local `git ls-files` to discover tracked files, including additional future Cargo.lock files; it does not contact a remote. Paths in output are repository-relative where possible. Output and ordering are deterministic. `--json` returns the same findings, status, baseline differences and scope note in machine-readable form.

Exit code **0** means the requested check completed without an unknown/error or applicable gate failure; it does **not** mean there are no vulnerabilities. **1** means an unknown finding, a baseline change with `--check-baseline`, or any affected/unknown/unclassified/missing baseline finding with `--release-gate`. **2** means unreadable, malformed, duplicate-path/entry, unsupported input, or failed tracked-file discovery. The normal report returns 0 for documented affected entries while showing them prominently. The current `--release-gate` returns 1: these findings remain unresolved. No exception mechanism exists.

The `Local Stylus wrapper` workflow runs the guard unit tests and `--check-baseline` before its existing Rust checks. Thus a matching known baseline can pass this **regression check** while still reporting `affected`; new tracked versions, sources, locations, or removal of the baseline require review. Green CI is **not** a passing release gate. The workflow triggers on any tracked `Cargo.lock` path as well as its existing paths.

## Interpretation and follow-up

The lockfile is a resolver inventory across targets and features. **Presence does not establish release-WASM inclusion, target reachability, secret-bearing use, or exploitability**; absence from these two rules is not a complete RustSec audit. The offline rules are pinned and cannot detect new, withdrawn or revised advisories. The tests prohibit Python socket creation while exercising the checker, but are not an operating-system network-isolation test.

When dependencies, lockfile locations, or advisory status change, a maintainer should review the official RustSec records and affected/patched ranges, run a current comprehensive semver-aware audit on all relevant lockfiles, and capture target-specific Cargo feature/inverse trees and build/artifact attribution. Investigate native/build/dev paths separately from release WASM; document uncertainty, and determine compatible upgrades or narrowly scoped accountable risk decisions. Only then update the guard rules, exact baseline and tests together in a reviewed change. An upgrade does not automatically make this limited check a full audit, and no version is assumed unreachable merely because of a lockfile or WASM import list. Production and deployment remain blocked by the wider readiness gates.
