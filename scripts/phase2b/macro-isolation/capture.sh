#!/usr/bin/env bash
# Phase 2B.5.3 macro dependency isolation: capture ONE side (baseline or
# experiment) from the currently checked-out commit. Offline checks only: there
# is no RPC, chain, wallet, activation, deployment, transaction, payment or
# settlement command here. Every command's argv, working directory, stdout,
# stderr and exit status are recorded; a failure is evidence of failure and is
# never interpreted as a dependency-graph or reachability result.
set -uo pipefail
SIDE=${1:?usage: capture.sh SIDE OUTPUT_DIRECTORY}
OUT=${2:?usage: capture.sh SIDE OUTPUT_DIRECTORY}
HARNESS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(git rev-parse --show-toplevel)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
WRAPPER="$ROOT/rust/stylus-wrapper"
WASM="$WRAPPER/target/wasm32-unknown-unknown/release/ponte_stylus_wrapper.wasm"
# The exact release command used by stylus-wrapper.yml and dependency-evidence.sh.
BUILD=(cargo +1.91.0 build --locked --release --lib --target wasm32-unknown-unknown)
LOCKS=(rust/environment-check/Cargo.lock rust/optimizer/Cargo.lock rust/stylus-wrapper/Cargo.lock)
failures=()

record() {
  local name=$1 cwd=$2
  shift 2
  printf '%q ' "$@" > "$OUT/$name.command"
  printf '\n' >> "$OUT/$name.command"
  printf '%s\n' "$cwd" > "$OUT/$name.cwd"
  local code=0
  (cd "$cwd" && "$@") > "$OUT/$name.stdout" 2> "$OUT/$name.stderr" || code=$?
  printf '%s\n' "$code" > "$OUT/$name.exit"
  if (( code != 0 )); then
    # Optional tooling (wabt) may be unavailable; it never gates the comparison.
    [[ $name == optional-* ]] || failures+=("$name=$code")
    echo "FAILED: $name exited $code" >&2
  else
    echo "ok: $name"
  fi
}

cd "$ROOT" || exit 2
{
  echo "side: $SIDE"
  echo "utc: $(date -u +%FT%TZ)"
  echo "git_head: $(git rev-parse HEAD)"
  echo "repo_root: $ROOT"
  echo "runner_image: ${ImageOS:-unknown} ${ImageVersion:-unknown}"
  echo "host: $(uname -a)"
  rustc +1.91.0 --version --verbose
  cargo +1.91.0 --version --verbose
  rustup target list --toolchain 1.91.0 --installed
  echo "node: $(node --version)"
  echo "npm: $(npm --version)"
  python3 --version
  if command -v wasm2wat > /dev/null; then echo "wasm2wat: $(wasm2wat --version)"; fi
  echo "build-relevant environment (must match between sides):"
  env | grep -E '^(CARGO|RUST)' | grep -v -E 'TOKEN|SECRET' | sort
} > "$OUT/provenance.txt" 2>&1
sha256sum "${LOCKS[@]}" > "$OUT/lockfiles.sha256"
cp rust/stylus-wrapper/Cargo.toml "$OUT/Cargo.toml.snapshot"
git status --porcelain > "$OUT/git-status-before.txt"

# Cold build: nothing from the other side or an earlier step is reused.
rm -rf "$WRAPPER/target"

# 1. Unchanged Phase 2B.5.1 evidence script: locked metadata and cargo trees for
#    all three workspaces, crypto-bigint/lru inverse trees, the cold -vv release
#    build (compiler invocations), the exact CI build, checksum, size, inspection.
record dependency-evidence "$ROOT" bash scripts/phase2b/dependency-evidence.sh "$OUT/dependency-evidence"

# 2. Structured unit inventory from a no-op rebuild (every unit is reported fresh).
record wasm-artifacts-json "$WRAPPER" "${BUILD[@]}" --message-format=json
sha256sum "$WASM" > "$OUT/wasm-after-json-inventory.sha256"

# 3. Direct and inverse graphs for the three macro packages.
for crate in alloy-sol-macro alloy-sol-macro-expander alloy-sol-macro-input; do
  for target in x86_64-unknown-linux-gnu wasm32-unknown-unknown; do
    for edges in normal,build normal,build,dev features; do
      record "tree-inverse-$crate-$target-${edges//,/-}" "$WRAPPER" \
        cargo +1.91.0 tree --locked --target "$target" --edges "$edges" --invert "$crate@1.5.7"
    done
  done
done
for target in x86_64-unknown-linux-gnu wasm32-unknown-unknown; do
  record "tree-direct-$target-normal-build" "$WRAPPER" \
    cargo +1.91.0 tree --locked --target "$target" --edges normal,build --depth 1
  record "tree-direct-$target-dev" "$WRAPPER" \
    cargo +1.91.0 tree --locked --target "$target" --edges dev --depth 1
done

# 4. A second, fully cold build with the exact CI command: within-side determinism.
rm -rf "$WRAPPER/target"
record wasm-cold-rebuild "$WRAPPER" "${BUILD[@]}"
sha256sum "$WASM" > "$OUT/wasm-cold-rebuild.sha256"

# 5. The Local Stylus wrapper CI checks, with the same commands as stylus-wrapper.yml.
record advisory-guard-tests "$WRAPPER" python3 -m unittest discover -s scripts -p 'test_advisory_guard.py' -v
record advisory-guard-baseline "$WRAPPER" python3 scripts/advisory_guard.py --check-baseline
record abi-tools-install "$WRAPPER" npm --prefix abi-tools ci --ignore-scripts --no-audit --no-fund
record abi-tools-check "$WRAPPER" npm --prefix abi-tools run check
record abi-tools-test "$WRAPPER" npm --prefix abi-tools test
record fmt "$WRAPPER" cargo +1.91.0 fmt --all -- --check
record test "$WRAPPER" cargo +1.91.0 test --locked
record test-artifacts-json "$WRAPPER" cargo +1.91.0 test --locked --no-run --message-format=json
record clippy "$WRAPPER" cargo +1.91.0 clippy --locked --all-targets -- -D warnings
record export-abi "$WRAPPER" cargo +1.91.0 run --locked --features export-abi
cp "$OUT/export-abi.stdout" "$OUT/sdk-abi.sol"
record check-abi "$WRAPPER" python3 scripts/check_abi.py "$OUT/sdk-abi.sol"
record export-abi-artifacts-json "$WRAPPER" cargo +1.91.0 build --locked --features export-abi --message-format=json

# 6. Offline WASM checks on the first (verbose) release artifact, which steps 2
#    and 4 must reproduce byte-for-byte. In-memory host stubs only.
ARTIFACT="$OUT/dependency-evidence/ponte_stylus_wrapper.wasm"
record wasm-inspect "$WRAPPER" python3 scripts/inspect_wasm.py "$ARTIFACT"
record wasm-entrypoint-tests "$WRAPPER" node scripts/test_wasm_entrypoint.cjs "$ARTIFACT"
record wasm-client-abi-tests "$WRAPPER" node abi-tools/test-wasm.cjs "$ARTIFACT"
record selector-check "$WRAPPER" node "$HARNESS/selector_check.cjs" "$ARTIFACT" "$OUT/sdk-abi.sol"
record wasm-sections "$ROOT" python3 "$HARNESS/evidence.py" wasm-sections "$ARTIFACT" "$OUT/wasm-sections.json"
if command -v wasm2wat > /dev/null; then
  record optional-wasm2wat "$ROOT" wasm2wat --enable-all "$ARTIFACT" -o "$OUT/release.wat"
  record optional-wasm-objdump "$ROOT" wasm-objdump --headers --details "$ARTIFACT"
fi

# 7. Every lockfile must be untouched by all commands above.
record lockfiles-unchanged "$ROOT" git diff --exit-code -- "${LOCKS[@]}"
git status --porcelain > "$OUT/git-status-after.txt"

printf '%s\n' "${failures[@]}" > "$OUT/failures.txt"
sha=$(awk '{print $1}' "$OUT/dependency-evidence/wasm.sha256" 2> /dev/null)
size=$(cat "$OUT/dependency-evidence/wasm.size" 2> /dev/null)
rebuild=$(awk '{print $1}' "$OUT/wasm-cold-rebuild.sha256" 2> /dev/null)
same=NO
[[ -n $sha && $sha == "$rebuild" ]] && same=yes
echo "::notice title=Captured ${SIDE}::commit=$(git rev-parse HEAD); release WASM sha256=${sha:-missing} bytes=${size:-missing}; fully cold rebuild identical=${same}; failed commands=${failures[*]:-none}"
(( ${#failures[@]} == 0 ))
