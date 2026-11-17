#!/usr/bin/env bash
# Phase 2B.5.3: unsuppressed RustSec audit of the baseline and experiment
# lockfiles against ONE advisory-db snapshot. Same official cargo-audit release,
# checksum and flags as scripts/phase2b/rustsec-evidence.sh; no advisory IDs are
# ignored and no target filter is applied. Downloads are limited to the tool,
# the advisory database; no RPC or chain access.
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
HARNESS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OUT=${1:?usage: rustsec.sh OUTPUT_DIRECTORY}
BASE=${BASE_SHA:?BASE_SHA must name the baseline commit}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
TMP=$(mktemp -d)
# shellcheck disable=SC2329  # invoked by the EXIT trap below
cleanup() {
  git -C "$ROOT" worktree remove --force "$TMP/baseline" > /dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
# Fail rather than inherit a configuration that could ignore advisories or filter targets.
if [[ -e "${CARGO_HOME:-$HOME/.cargo}/audit.toml" ]]; then
  echo 'Unexpected global cargo-audit configuration; refusing an audit that may hide findings.' >&2
  exit 2
fi

HEAD_SHA=$(git -C "$ROOT" rev-parse HEAD)
git -C "$ROOT" worktree add --detach "$TMP/baseline" "$BASE" > /dev/null
tree_for() { if [[ $1 == baseline ]]; then echo "$TMP/baseline"; else echo "$ROOT"; fi; }

for side in baseline experiment; do
  tree=$(tree_for "$side")
  mkdir -p "$OUT/$side"
  git -C "$tree" rev-parse HEAD > "$OUT/$side/commit"
  (cd "$tree" && sha256sum rust/environment-check/Cargo.lock rust/optimizer/Cargo.lock rust/stylus-wrapper/Cargo.lock) \
    > "$OUT/$side/lockfiles.sha256"
  for workspace in environment-check optimizer stylus-wrapper; do
    if [[ -e "$tree/rust/$workspace/.cargo/audit.toml" ]]; then
      echo "Unexpected $side $workspace cargo-audit configuration; refusing an audit that may hide findings." >&2
      exit 2
    fi
  done
done
# As in rustsec-evidence.sh, no separate fetch: the preceding graph captures on
# this runner already populated the local crates.io index cache.
printf 'baseline=%s\nexperiment=%s\n' "$BASE" "$HEAD_SHA" > "$OUT/commits.txt"

VERSION=0.23.0
ASSET="cargo-audit-x86_64-unknown-linux-musl-v${VERSION}.tgz"
EXPECTED=4f01c74ed84b2dffd0b1d37012a62cdf2a92c96e25bdf8eec7fcc0d4d3eb7811
URL="https://github.com/rustsec/rustsec/releases/download/cargo-audit/v${VERSION}/${ASSET}"
printf 'Tool: cargo-audit %s\nURL: %s\nExpected SHA-256: %s\n' "$VERSION" "$URL" "$EXPECTED" > "$OUT/tool-provenance.txt"
curl --fail --location --silent --show-error "$URL" -o "$TMP/$ASSET"
printf '%s  %s\n' "$EXPECTED" "$TMP/$ASSET" | sha256sum --check
sha256sum "$TMP/$ASSET" >> "$OUT/tool-provenance.txt"
tar -xzf "$TMP/$ASSET" -C "$TMP"
mapfile -t bins < <(find "$TMP" -path "$TMP/baseline" -prune -o -type f -name cargo-audit -print)
if [[ ${#bins[@]} != 1 ]]; then echo 'Unable to identify the official cargo-audit executable' >&2; exit 2; fi
AUDIT=${bins[0]}
"$AUDIT" audit --version | tee -a "$OUT/tool-provenance.txt"

git clone --quiet --depth 1 https://github.com/RustSec/advisory-db.git "$TMP/advisory-db"
git -C "$TMP/advisory-db" rev-parse HEAD > "$OUT/advisory-db.commit"
git -C "$TMP/advisory-db" show -s --format='%cI %s' HEAD > "$OUT/advisory-db.date"
date -u +%FT%TZ > "$OUT/audit-date.txt"
echo "::notice title=RustSec database::revision=$(cat "$OUT/advisory-db.commit"); audited=$(cat "$OUT/audit-date.txt"); one snapshot for baseline and experiment; --no-fetch yanked coverage depends on the local index cache"

# All six audits run even when earlier ones report findings. --deny warnings
# includes unsound/unmaintained/yanked notices; nothing is ignored.
for side in baseline experiment; do
  tree=$(tree_for "$side")
  for workspace in environment-check optimizer stylus-wrapper; do
    cmd=("$AUDIT" audit --file "$tree/rust/$workspace/Cargo.lock" --db "$TMP/advisory-db" --no-fetch --deny warnings --json)
    printf '%q ' "${cmd[@]}" > "$OUT/$side/$workspace.command"
    printf '\n' >> "$OUT/$side/$workspace.command"
    code=0
    "${cmd[@]}" > "$OUT/$side/$workspace.json" 2> "$OUT/$side/$workspace.stderr" || code=$?
    printf '%s\n' "$code" > "$OUT/$side/$workspace.exit"
  done
done

# The established summarizer's semantics (nonzero for any finding or invalid
# report) are kept; its unlabeled notices are saved to files and replaced by
# side-labelled notices from evidence.py.
status=0
for side in baseline experiment; do
  python3 "$ROOT/scripts/phase2b/summarize-dependency-evidence.py" audit "$OUT/$side" > "$OUT/$side/summary.txt" || status=1
done
python3 "$HARNESS/evidence.py" rustsec-compare "$OUT" || status=1
exit "$status"
