# Rust CI environment check — Phase 2B.0.2

This isolated library validates the build environment only. It does not implement
the liquidity optimizer, financial math, a Stylus contract, or application bindings.
The one exact-pinned dependency (`itoa` 1.0.15) exercises crates.io access; Cargo.lock
records its registry checksum. CI validates the committed lock with `--locked`.

## Reproduce

Use Rust 1.91.0 with rustfmt and `wasm32-unknown-unknown`, as pinned in
`rust-toolchain.toml`. From this directory:

```sh
rustc --version
cargo --version
rustup target list --installed
cargo fetch --locked
cargo fmt --check
cargo test --locked
cargo build --locked
cargo build --locked --target wasm32-unknown-unknown
```

Native tests execute on the runner. The WASM command cross-compiles a library;
it does not execute WASM tests, produce a deployable Stylus contract, or establish
activation eligibility. Docker, cargo-stylus, RPC access and wallets are not needed.

## GitHub Actions

`.github/workflows/rust-optimizer.yml` uses only standard `ubuntu-latest`
GitHub-hosted runners, with a 15-minute job timeout and read-only repository
permissions. PRs to main are path-filtered to `rust/**` and the workflow itself;
pushes to the current feature branch use the same filter. Extend the branch filter
explicitly for future feature branches if push validation is wanted there.
Existing application CI is unchanged and may also run on the PR.

`workflow_dispatch` is configured, but GitHub requires the workflow to exist on
the default branch (`main`) before its manual **Run workflow** button is available.
Until reviewed and merged, use the feature-branch push/PR trigger. Do not merge
solely to enable the button.

Logs include exact compiler/Cargo versions, installed targets, dependency fetch,
formatting, tests and native/WASM builds. Only small text logs are uploaded, retained
for three days; no target directories, caches, binaries or secrets are uploaded.
`ubuntu-latest` is a rolling runner image: compiler/dependencies are pinned, but this
is reproducible source compilation, not a claim of bit-for-bit OS reproducibility.

No billing settings, overages, resources, deployments or chain operations are
configured. Standard hosted runners for this public repository avoid larger-runner
usage. Phase 2B.1 requires a separate task after this environment gate passes.
