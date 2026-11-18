#!/usr/bin/env bash
# Collect Cargo-resolution and raw release-WASM evidence, never activation/RPC data.
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
OUT=${1:?usage: dependency-evidence.sh OUTPUT_DIRECTORY}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
cd "$ROOT"

{
  echo "UTC: $(date -u +%FT%TZ)"
  echo "Git HEAD: $(git rev-parse HEAD)"
  echo "GitHub event: ${GITHUB_EVENT_NAME:-local}"
  echo "GitHub ref: ${GITHUB_REF:-local}"
  echo "GitHub head SHA: ${GITHUB_SHA:-local}"
  echo "Host: $(uname -a)"
  rustc +1.91.0 --version --verbose
  cargo +1.91.0 --version --verbose
  rustup target list --toolchain 1.91.0 --installed
  sha256sum rust/environment-check/Cargo.lock rust/optimizer/Cargo.lock rust/Cargo.lock
} > "$OUT/provenance.txt"
cat "$OUT/provenance.txt"
python3 rust/stylus-wrapper/scripts/advisory_guard.py --json --check-baseline > "$OUT/offline-baseline.json"

# Capture the command and status for every graph, including inverse queries.
# A failed command is evidence of failure, never interpreted as non-reachability.
failed=0
record() {
  local name=$1; shift
  printf '%q ' "$@" > "$OUT/$name.command"
  printf '\n' >> "$OUT/$name.command"
  local code=0
  "$@" > "$OUT/$name.txt" 2> "$OUT/$name.stderr" || code=$?
  printf '%s\n' "$code" > "$OUT/$name.exit"
  if (( code != 0 )); then
    echo "::error title=Cargo evidence command failed::$name exited $code; see evidence files"
    failed=1
  fi
}

for workspace in environment-check optimizer stylus-wrapper; do
  manifest="$ROOT/rust/$workspace/Cargo.toml"
  record "$workspace-metadata-all" cargo +1.91.0 metadata --locked --format-version 1 --manifest-path "$manifest"
  record "$workspace-metadata-host" cargo +1.91.0 metadata --locked --format-version 1 --filter-platform x86_64-unknown-linux-gnu --manifest-path "$manifest"
  record "$workspace-metadata-wasm" cargo +1.91.0 metadata --locked --format-version 1 --filter-platform wasm32-unknown-unknown --manifest-path "$manifest"
  cp "$OUT/$workspace-metadata-all.txt" "$OUT/$workspace-metadata-all.json"
  cp "$OUT/$workspace-metadata-host.txt" "$OUT/$workspace-metadata-host.json"
  cp "$OUT/$workspace-metadata-wasm.txt" "$OUT/$workspace-metadata-wasm.json"
  for target in x86_64-unknown-linux-gnu wasm32-unknown-unknown; do
    for edges in normal,build normal,build,dev features; do
      label=${edges//,/-}
      record "$workspace-$target-$label" cargo +1.91.0 tree --locked --manifest-path "$manifest" --target "$target" --edges "$edges"
    done
    record "$workspace-$target-package-list" cargo +1.91.0 tree --locked --manifest-path "$manifest" --target "$target" --edges normal,build --prefix none --format '{p}'
  done
done

# These exact versions are currently in the wrapper lock. Keep errors explicit if
# a future lockfile changes rather than claiming an absent target or silently skipping.
for package in crypto-bigint@0.5.5 lru@0.16.4; do
  for target in x86_64-unknown-linux-gnu wasm32-unknown-unknown; do
    for edges in normal,build normal,build,dev features; do
      label=${edges//,/-}
      record "wrapper-inverse-$package-$target-$label" cargo +1.91.0 tree --locked \
        --manifest-path "$ROOT/rust/stylus-wrapper/Cargo.toml" --target "$target" \
        --edges "$edges" --invert "$package"
    done
  done
done

# -vv changes logging, not the release profile or features. Run the exact CI
# command afterward and check that it leaves the same bytes.
cd "$ROOT/rust/stylus-wrapper"
wasm=../target/wasm32-unknown-unknown/release/ponte_stylus_wrapper.wasm
printf '%s\n' 'cargo +1.91.0 build --locked --release --lib --target wasm32-unknown-unknown -vv' > "$OUT/build.command"
cargo +1.91.0 build --locked --release --lib --target wasm32-unknown-unknown -vv > "$OUT/build.verbose.stdout" 2> "$OUT/build.verbose.stderr"
sha256sum "$wasm" > "$OUT/wasm-before-ci-command.sha256"
printf '%s\n' 'cargo +1.91.0 build --locked --release --lib --target wasm32-unknown-unknown' > "$OUT/exact-ci-build.command"
cargo +1.91.0 build --locked --release --lib --target wasm32-unknown-unknown > "$OUT/exact-ci-build.stdout" 2> "$OUT/exact-ci-build.stderr"
sha256sum "$wasm" > "$OUT/wasm.sha256"
cmp "$OUT/wasm-before-ci-command.sha256" "$OUT/wasm.sha256"
wc -c < "$wasm" > "$OUT/wasm.size"
cp "$wasm" "$OUT/ponte_stylus_wrapper.wasm"
python3 scripts/inspect_wasm.py "$wasm" > "$OUT/wasm-inspection.txt"
cd "$ROOT"
git diff --exit-code -- rust/environment-check/Cargo.lock rust/optimizer/Cargo.lock rust/Cargo.lock
python3 scripts/phase2b/summarize-dependency-evidence.py graph "$OUT"
if (( failed != 0 )); then
  echo 'One or more graph commands failed; evidence is incomplete.' >&2
  exit 1
fi
