#!/usr/bin/env bash
# PONTE Phase 2B.6.0: wallet-free build of a LOCALLY BUILT, UNACTIVATED Stylus candidate artifact.
#
# Usage: stylus-candidate.sh STAGE   (the workflow runs the stages in order)
#
# Every command runs through record(), which stores its argv, working directory, UTC start and end
# timestamps, exit status, stdout and stderr under $EVIDENCE_DIR/commands. record() also refuses
# any `cargo stylus` invocation outside a small offline allowlist (including one nested in
# `docker run`), so this script cannot run `cargo stylus check`, deploy, activate, verify or any
# other command that contacts an RPC endpoint, submits a transaction or needs a key.
set -euo pipefail

STAGE=${1:?usage: stylus-candidate.sh STAGE}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
: "${EVIDENCE_DIR:?}" "${PONTE_DIR:?}" "${SDK_DIR:?}" "${CLI_ROOT:?}" "${TOOLCHAIN:?}"
: "${SDK_REPOSITORY:?}" "${SDK_RELEASE:?}" "${SDK_COMMIT:?}" "${CLI_VERSION:?}"
COMMANDS=$EVIDENCE_DIR/commands
WASM_REL=../target/wasm32-unknown-unknown/release
DEPS_WASM_REL=wasm32-unknown-unknown/release/deps/ponte_stylus_wrapper.wasm
mkdir -p "$COMMANDS"
LAST=''
LAST_CODE=0

fail() {
  echo "::error title=Candidate build check failed::$*"
  exit 1
}

# The only cargo-stylus argument vectors this workflow may execute; none uses the network.
stylus_args_allowed() {
  case "$*" in
    --version | 'check --help' | 'deploy --help' | 'build --help' | 'get-initcode --help' | build) return 0 ;;
  esac
  [[ $# -eq 3 && ($1 == get-initcode || $1 == export-abi) && $2 == --output ]]
}

offline_guard() {
  local -a argv=("$@")
  local i j
  [[ $(basename -- "${argv[0]}") != cargo-stylus ]] || return 1
  for ((i = 0; i < ${#argv[@]}; i++)); do
    [[ ${argv[i]} == cargo ]] || continue
    j=$((i + 1))
    [[ ${argv[j]:-} == +* ]] && j=$((j + 1))
    if [[ ${argv[j]:-} == stylus ]]; then
      stylus_args_allowed "${argv[@]:j+1}" || return 1
    fi
  done
}

# record MODE NAME COMMAND...   MODE is `gate` (a failure stops the stage) or `info` (recorded only).
record() {
  local mode=$1 name=$2 shown seq base started ended code=0
  shift 2
  printf -v shown ' %q' "$@"
  offline_guard "$@" || fail "refused non-allowlisted command:$shown"
  seq=$(find "$COMMANDS" -maxdepth 1 -name '*.json' | wc -l)
  base=$COMMANDS/$(printf '%03d' "$seq")-$name
  started=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
  "$@" > "$base.stdout" 2> "$base.stderr" || code=$?
  ended=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
  python3 "$HERE/stylus_provenance.py" record-command "$base.json" "$name" "$mode" "$STAGE" "$PWD" \
    "$started" "$ended" "$code" -- "$@"
  LAST=$base
  LAST_CODE=$code
  echo "::group::[$mode] $name -> exit $code"
  echo "+$shown"
  tail -n 150 "$base.stdout"
  tail -n 150 "$base.stderr"
  echo '::endgroup::'
  if ((code != 0)); then
    # The annotation carries the error lines: annotations stay readable through the API even
    # where the run log and the artifact are not. Full output is in the artifact under commands/.
    local why
    why=$(python3 "$HERE/stylus_provenance.py" excerpt "$base") || why='(no excerpt)'
    if [[ $mode == gate ]]; then
      echo "::error title=$name failed::exit $code (gating): $why"
      exit "$code"
    fi
    echo "::warning title=$name (informational)::exit $code, recorded in the provenance, not gating: $why"
  fi
}

stage_init() {
  mkdir -p "$EVIDENCE_DIR"/{abi,cli,docker,reproducibility}
  cat > "$EVIDENCE_DIR/UNACTIVATED-CANDIDATE.txt" << 'EOF'
LOCALLY BUILT, UNACTIVATED CANDIDATE ARTIFACT

This GitHub Actions artifact holds a raw Stylus WASM built from source on a GitHub-hosted runner,
with its provenance record. It has NOT been deployed or activated, and it has NOT been checked
against Arbitrum Sepolia or any other RPC endpoint. The contract is the synthetic-only PONTE
evaluator: candidate routes, rates, liquidity, expiry and as-of time are caller-supplied and
unauthenticated, so its output is not an executable quote, verified liquidity or settlement.
See provenance.json and docs/PHASE2B6_TESTNET_ARTIFACT_READINESS.md.
EOF
  cd "$PONTE_DIR"
  mkdir -p "$EVIDENCE_DIR/inputs/stylus-wrapper"
  # The Cargo workspace root moved from rust/stylus-wrapper to rust/. Keep the same basenames
  # apart so both workspace and package inputs remain identifiable in the artifact.
  cp rust/Cargo.toml rust/Cargo.lock rust/Stylus.toml rust/rust-toolchain.toml \
    "$EVIDENCE_DIR/inputs/"
  cp rust/stylus-wrapper/Cargo.toml rust/stylus-wrapper/Stylus.toml \
    "$EVIDENCE_DIR/inputs/stylus-wrapper/"
  record gate ponte-head git rev-parse HEAD
  [[ $(< "$LAST.stdout") == "$GITHUB_SHA" ]] || fail "checked-out PONTE commit differs from GITHUB_SHA"
  record gate ponte-worktree git status --porcelain=v1 --untracked-files=all
  [[ ! -s $LAST.stdout ]] || fail "PONTE worktree is not clean before the build"
  record gate input-hashes sha256sum rust/Cargo.toml rust/Cargo.lock rust/Stylus.toml \
    rust/rust-toolchain.toml rust/stylus-wrapper/Cargo.toml rust/stylus-wrapper/Stylus.toml \
    rust/optimizer/Cargo.toml rust/optimizer/Cargo.lock
  record info runner-kernel uname -a
  record info runner-image printenv ImageOS ImageVersion
  # The pinned CLI source is cloned outside the PONTE tree so PONTE keeps the checkout path that
  # the existing CI uses (absolute paths can end up in the WASM; see the reproducibility stage).
  record gate sdk-init git init --quiet "$SDK_DIR"
  cd "$SDK_DIR"
  record gate sdk-fetch git fetch --quiet --depth 1 "https://github.com/$SDK_REPOSITORY" "$SDK_COMMIT"
  record gate sdk-checkout git checkout --quiet --detach FETCH_HEAD
  record gate sdk-head git rev-parse HEAD
  [[ $(< "$LAST.stdout") == "$SDK_COMMIT" ]] || fail "Stylus SDK checkout is not $SDK_COMMIT"
  record gate sdk-tag git ls-remote "https://github.com/$SDK_REPOSITORY" "refs/tags/$SDK_RELEASE" \
    "refs/tags/$SDK_RELEASE^{}"
  python3 "$HERE/stylus_provenance.py" check-tag "$LAST.stdout" "$SDK_RELEASE" "$SDK_COMMIT" ||
    fail "$SDK_RELEASE does not resolve to $SDK_COMMIT"
  record gate sdk-input-hashes sha256sum Cargo.lock Cargo.toml cargo-stylus/Cargo.toml \
    rust-toolchain.toml Dockerfile stylus-tools/src/core/build/reproducible.rs
}

stage_toolchain() {
  record gate rustup-version rustup --version
  # The component set of stylus-wrapper.yml, which builds the main baseline. Not rust-src: with
  # rust-src installed, rustc embeds the local library source path instead of /rustc/<commit>/library
  # in the WASM (the reproducibility stage measures that separately).
  record gate rust-toolchain-install rustup toolchain install "$TOOLCHAIN" --profile minimal \
    --component rustfmt --component clippy --target wasm32-unknown-unknown
  record gate rustc-version rustc "+$TOOLCHAIN" --version --verbose
  record gate cargo-version cargo "+$TOOLCHAIN" --version --verbose
  record gate installed-targets rustup target list --toolchain "$TOOLCHAIN" --installed
  grep -qx wasm32-unknown-unknown "$LAST.stdout" || fail "wasm32-unknown-unknown is not installed for $TOOLCHAIN"
  cd "$PONTE_DIR/rust/stylus-wrapper"
  record gate wrapper-toolchain rustup show active-toolchain
  grep -q "^$TOOLCHAIN-" "$LAST.stdout" || fail "rust/stylus-wrapper does not select $TOOLCHAIN"
  # Read the pinned SDK's toolchain file instead of resolving it with rustup inside the checkout:
  # the file lists rust-src, which rustup could add to the shared toolchain. The CLI is built with
  # an explicit +$TOOLCHAIN, which bypasses that file.
  cd "$SDK_DIR"
  record gate sdk-toolchain-file cat rust-toolchain.toml
  grep -qxF "channel = \"$TOOLCHAIN\"" "$LAST.stdout" || fail "the pinned SDK's rust-toolchain.toml does not pin $TOOLCHAIN"
}

stage_cli() {
  cd "$SDK_DIR"
  # The command upstream CI uses (smoke-test.yml, integration.yml), with the workspace Cargo.lock.
  record gate cli-install cargo "+$TOOLCHAIN" install --locked --path ./cargo-stylus --root "$CLI_ROOT"
  record gate sdk-tree-unchanged git status --porcelain=v1 --untracked-files=no
  [[ ! -s $LAST.stdout ]] || fail "building cargo-stylus modified tracked files in the pinned SDK checkout"
  record gate cli-binary-sha256 sha256sum "$CLI_ROOT/bin/cargo-stylus"
}

stage_verify_cli() {
  export PATH="$CLI_ROOT/bin:$PATH"
  cd "$PONTE_DIR/rust/stylus-wrapper"
  record gate cli-on-path bash -c 'command -v cargo-stylus'
  [[ $(< "$LAST.stdout") == "$CLI_ROOT/bin/cargo-stylus" ]] || fail "cargo-stylus on PATH is not the pinned build"
  record gate cli-version cargo stylus --version
  grep -Eq "(^| )$CLI_VERSION\$" "$LAST.stdout" || fail "cargo stylus --version does not report $CLI_VERSION"
  record gate cli-check-help cargo stylus check --help
  grep -q -- '--endpoint' "$LAST.stdout" || fail "check --help does not document --endpoint"
  record gate cli-deploy-help cargo stylus deploy --help
  grep -q -- '--no-activate' "$LAST.stdout" || fail "deploy --help does not document --no-activate"
  grep -q -- '--no-verify' "$LAST.stdout" || fail "deploy --help does not document --no-verify"
  record gate cli-build-help cargo stylus build --help
  record gate cli-get-initcode-help cargo stylus get-initcode --help
  local name
  for name in check deploy build get-initcode; do
    cp "$(find "$COMMANDS" -name "*-cli-$name-help.stdout" | sort | tail -n 1)" "$EVIDENCE_DIR/cli/$name-help.txt"
  done
}

stage_wrapper_tests() {
  cd "$PONTE_DIR/rust/stylus-wrapper"
  # Same checks, in the same order, as .github/workflows/stylus-wrapper.yml.
  record gate advisory-guard-tests python3 -m unittest discover -s scripts -p 'test_advisory_guard.py' -v
  record gate advisory-guard-baseline python3 scripts/advisory_guard.py --check-baseline
  record gate abi-tools-install npm --prefix abi-tools ci --ignore-scripts --no-audit --no-fund
  record gate client-abi-check npm --prefix abi-tools run check
  record gate client-abi-tests npm --prefix abi-tools test
  record gate cargo-fmt cargo "+$TOOLCHAIN" fmt --all -- --check
  record gate cargo-test cargo "+$TOOLCHAIN" test --locked
  record gate cargo-clippy cargo "+$TOOLCHAIN" clippy --locked --all-targets -- -D warnings
  record gate sdk-abi-export cargo "+$TOOLCHAIN" run --locked --features export-abi
  cp "$LAST.stdout" "$EVIDENCE_DIR/abi/ponte-synthetic-abi.sol"
  record gate sdk-abi-check python3 scripts/check_abi.py "$EVIDENCE_DIR/abi/ponte-synthetic-abi.sol"
  cp abi/SyntheticOptimizer.abi.json abi/ISyntheticOptimizer.sol "$EVIDENCE_DIR/abi/"
}

stage_release_wasm() {
  cd "$PONTE_DIR/rust/stylus-wrapper"
  record gate release-components rustup component list --toolchain "$TOOLCHAIN" --installed
  # The exact release command of stylus-wrapper.yml and dependency-evidence.sh.
  record gate release-build cargo "+$TOOLCHAIN" build --locked --release --lib --target wasm32-unknown-unknown
  local wasm=$WASM_REL/ponte_stylus_wrapper.wasm
  cp "$wasm" "$EVIDENCE_DIR/ponte_stylus_wrapper.wasm"
  record gate raw-wasm-sha256 sha256sum "$wasm"
  record gate wasm-inspection python3 scripts/inspect_wasm.py "$wasm"
  record gate wasm-entrypoint-test node scripts/test_wasm_entrypoint.cjs "$wasm"
  record gate client-abi-wasm-test node abi-tools/test-wasm.cjs "$wasm"
}

stage_cli_build() {
  export PATH="$CLI_ROOT/bin:$PATH"
  # Control probe: the contract's own Stylus.toml is now the minimal `[contract]` file, while the
  # [workspace] table lives at rust/Stylus.toml. This must still find and build the contract.
  local probe=$RUNNER_TEMP/prefix-manifest-probe
  mkdir -p "$probe"
  cd "$PONTE_DIR"
  record gate probe-export bash -c "git archive --format=tar HEAD rust | tar -x -C '$probe'"
  record gate probe-manifest-sha256 sha256sum "$probe/rust/stylus-wrapper/Stylus.toml"
  cd "$probe/rust/stylus-wrapper"
  record info prefix-manifest-probe env CARGO_TARGET_DIR="$RUNNER_TEMP/probe-target" cargo stylus build
  record gate probe-wasm-exists test -f "$RUNNER_TEMP/probe-target/$DEPS_WASM_REL"

  # Contract detection only checks for a Stylus.toml beside the package. With none, the CLI finds
  # zero contracts, exits 0 and builds nothing: gate on the WASM file, not just the exit status.
  local absent=$RUNNER_TEMP/no-manifest-probe
  mkdir -p "$absent"
  cd "$PONTE_DIR"
  record gate no-manifest-export bash -c "git archive --format=tar HEAD rust | tar -x -C '$absent'"
  rm -f "$absent/rust/stylus-wrapper/Stylus.toml"
  record gate no-manifest-absent test ! -f "$absent/rust/stylus-wrapper/Stylus.toml"
  cd "$absent/rust/stylus-wrapper"
  record info no-manifest-build env CARGO_TARGET_DIR="$RUNNER_TEMP/no-manifest-target" cargo stylus build
  record gate no-manifest-no-wasm test ! -f "$RUNNER_TEMP/no-manifest-target/$DEPS_WASM_REL"

  cd "$PONTE_DIR/rust/stylus-wrapper"
  # A fresh target directory makes the CLI compile from scratch instead of reusing the build above.
  local fresh=$RUNNER_TEMP/cargo-stylus-build-target
  record gate cli-build env CARGO_TARGET_DIR="$fresh" cargo stylus build
  record gate cli-build-wasm-exists test -f "$fresh/$DEPS_WASM_REL"
  cp "$fresh/$DEPS_WASM_REL" "$EVIDENCE_DIR/cli/cargo-stylus-build.wasm"
  record info cli-build-identical cmp "$EVIDENCE_DIR/ponte_stylus_wrapper.wasm" "$EVIDENCE_DIR/cli/cargo-stylus-build.wasm"
  # Offline processing: strip metadata, add project_hash, Brotli-compress, wrap in deployment init code.
  record info cli-get-initcode cargo stylus get-initcode --output "$EVIDENCE_DIR/cli/initcode.hex"
  # The CLI runs `cargo run` without --locked here; the integrity stage re-checks every lockfile.
  record info cli-export-abi cargo stylus export-abi --output "$EVIDENCE_DIR/abi/cargo-stylus-export-abi.sol"
}

stage_reproducibility() {
  # Same toolchain and CARGO_HOME, different absolute checkout path and target directory.
  local alt=$RUNNER_TEMP/relocated-checkout/ponte
  mkdir -p "$alt"
  cd "$PONTE_DIR"
  record gate relocated-export bash -c "git archive --format=tar HEAD rust | tar -x -C '$alt'"
  cd "$alt/rust/stylus-wrapper"
  record info relocated-build env CARGO_TARGET_DIR="$RUNNER_TEMP/relocated-target" \
    cargo "+$TOOLCHAIN" build --locked --release --lib --target wasm32-unknown-unknown
  if ((LAST_CODE == 0)); then
    cp "$RUNNER_TEMP/relocated-target/wasm32-unknown-unknown/release/ponte_stylus_wrapper.wasm" \
      "$EVIDENCE_DIR/reproducibility/relocated-checkout.wasm"
    record info relocated-identical cmp "$EVIDENCE_DIR/ponte_stylus_wrapper.wasm" \
      "$EVIDENCE_DIR/reproducibility/relocated-checkout.wasm"
  fi
  # Same checkout path, CARGO_HOME and toolchain, plus the rust-src component, which the CLI's
  # reproducible Docker image installs. Removed again afterwards; no later stage builds on the host.
  record info rust-src-add rustup component add rust-src --toolchain "$TOOLCHAIN"
  cd "$PONTE_DIR/rust/stylus-wrapper"
  record info rust-src-build env CARGO_TARGET_DIR="$RUNNER_TEMP/rust-src-target" \
    cargo "+$TOOLCHAIN" build --locked --release --lib --target wasm32-unknown-unknown
  if ((LAST_CODE == 0)); then
    cp "$RUNNER_TEMP/rust-src-target/wasm32-unknown-unknown/release/ponte_stylus_wrapper.wasm" \
      "$EVIDENCE_DIR/reproducibility/with-rust-src.wasm"
    record info rust-src-identical cmp "$EVIDENCE_DIR/ponte_stylus_wrapper.wasm" \
      "$EVIDENCE_DIR/reproducibility/with-rust-src.wasm"
  fi
  record info rust-src-remove rustup component remove rust-src --toolchain "$TOOLCHAIN"
}

stage_docker() {
  local base="offchainlabs/cargo-stylus-base:$CLI_VERSION"
  local image="cargo-stylus-base-$CLI_VERSION-toolchain-$TOOLCHAIN" # the name create_image() uses
  local work=$RUNNER_TEMP/docker-path
  mkdir -p "$work/context" "$work/repository" "$work/target"
  record gate docker-version docker version
  # The CLI checks Docker Hub with `docker manifest inspect` before building its derived image.
  record info docker-hub-manifest docker manifest inspect "$base"
  if ((LAST_CODE == 0)); then
    record gate docker-base-pull docker pull "$base"
    echo 'published image pulled from Docker Hub' > "$EVIDENCE_DIR/docker/base-image-source.txt"
  else
    echo "::warning title=Published base image unavailable::$base is not on Docker Hub; building it from the pinned SDK Dockerfile for diagnostics"
    record gate docker-base-build docker build --target cargo-stylus-base --tag "$base" "$SDK_DIR"
    echo 'built locally from the pinned SDK Dockerfile (published image unavailable)' > "$EVIDENCE_DIR/docker/base-image-source.txt"
  fi
  record gate docker-base-inspect docker image inspect --format '{{.Id}} {{json .RepoDigests}}' "$base"
  # Render the derived-image Dockerfile from the pinned CLI's own template (create_image()).
  python3 "$HERE/stylus_provenance.py" dockerfile "$SDK_DIR/stylus-tools/src/core/build/reproducible.rs" \
    "$base" "$TOOLCHAIN" > "$EVIDENCE_DIR/docker/Dockerfile.reproducible"
  cd "$work/context"
  record gate docker-derived-build docker build --tag "$image" --file "$EVIDENCE_DIR/docker/Dockerfile.reproducible" .
  record gate docker-derived-inspect docker image inspect --format '{{.Id}}' "$image"
  record gate container-cli-version docker run --rm "$image" cargo stylus --version
  record gate container-rust-version docker run --rm "$image" rustc --version --verbose
  # run_in_container() mounts cargo metadata's workspace_root at /source. Derive it from that
  # command rather than assuming it is the package directory, and verify the layout under test.
  cd "$PONTE_DIR/rust/stylus-wrapper"
  record gate workspace-root cargo "+$TOOLCHAIN" metadata --no-deps --format-version 1
  local root
  root=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["workspace_root"])' < "$LAST.stdout")
  [[ $root == "$PONTE_DIR/rust" ]] || fail "cargo metadata workspace root is $root, expected $PONTE_DIR/rust"
  cd "$PONTE_DIR"

  # (1) Exactly what run_in_container() mounts, twice from two clean exports: a fresh rust/
  # workspace root at /source. The CLI uses --network host for RPC commands; this build is offline.
  local root1=$work/workspace-root-1 root2=$work/workspace-root-2
  mkdir -p "$root1" "$root2"
  record gate official-path-export bash -c "git archive --format=tar HEAD rust | tar -x -C '$root1'"
  record gate official-path-export-2 bash -c "git archive --format=tar HEAD rust | tar -x -C '$root2'"
  record gate official-path-build docker run --rm --network host --workdir /source \
    --volume "$root1/rust:/source" "$image" cargo stylus build
  record gate official-path-wasm-exists test -f "$root1/rust/target/$DEPS_WASM_REL"
  cp "$root1/rust/target/$DEPS_WASM_REL" "$EVIDENCE_DIR/docker/official-container-1.wasm"
  record gate official-container-wasm-sha256 sha256sum "$EVIDENCE_DIR/docker/official-container-1.wasm"
  record gate official-path-build-2 docker run --rm --network host --workdir /source \
    --volume "$root2/rust:/source" "$image" cargo stylus build
  record gate official-path-wasm-exists-2 test -f "$root2/rust/target/$DEPS_WASM_REL"
  cp "$root2/rust/target/$DEPS_WASM_REL" "$EVIDENCE_DIR/docker/official-container-2.wasm"
  record gate official-path-identical cmp "$EVIDENCE_DIR/docker/official-container-1.wasm" \
    "$EVIDENCE_DIR/docker/official-container-2.wasm"

  # The same container path computes and embeds the project hash. Capture the init code and the
  # CLI's own list of every file it hashed (absolute /source paths inside the container).
  record info container-get-initcode docker run --rm --network host --workdir /source \
    --volume "$root1/rust:/source" "$image" cargo stylus get-initcode --output /source/initcode.hex
  record gate container-initcode-copy cp "$root1/rust/initcode.hex" "$EVIDENCE_DIR/docker/initcode.hex"

  # (2) Diagnostic only (not a cargo-stylus code path): whole repository, read-only, fixed path.
  record gate diagnostic-export bash -c "git archive --format=tar HEAD | tar -x -C '$work/repository'"
  record info diagnostic-container-build docker run --rm --network host --workdir /ponte/rust/stylus-wrapper \
    --volume "$work/repository:/ponte:ro" --volume "$work/target:/target" --env CARGO_TARGET_DIR=/target \
    "$image" cargo stylus build
  if ((LAST_CODE == 0)); then
    cp "$work/target/$DEPS_WASM_REL" "$EVIDENCE_DIR/docker/diagnostic-container.wasm"
    record info diagnostic-identical cmp "$EVIDENCE_DIR/ponte_stylus_wrapper.wasm" "$EVIDENCE_DIR/docker/diagnostic-container.wasm"
  fi
}

stage_integrity() {
  cd "$PONTE_DIR"
  record gate lockfiles-unchanged git diff --exit-code -- rust/Cargo.lock \
    rust/optimizer/Cargo.lock rust/environment-check/Cargo.lock
  record gate tracked-files-unchanged git diff --exit-code --stat
  cd "$SDK_DIR"
  record gate sdk-still-pinned git rev-parse HEAD
  [[ $(< "$LAST.stdout") == "$SDK_COMMIT" ]] || fail "the SDK checkout moved during the run"
}

case $STAGE in
  init) stage_init ;;
  toolchain) stage_toolchain ;;
  cli) stage_cli ;;
  verify-cli) stage_verify_cli ;;
  wrapper-tests) stage_wrapper_tests ;;
  release-wasm) stage_release_wasm ;;
  cli-build) stage_cli_build ;;
  reproducibility) stage_reproducibility ;;
  docker) stage_docker ;;
  integrity) stage_integrity ;;
  *) fail "unknown stage $STAGE" ;;
esac
