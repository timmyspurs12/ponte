#!/usr/bin/env bash
# Audit each lockfile against one fresh RustSec snapshot; no advisory suppressions.
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
OUT=${1:?usage: rustsec-evidence.sh OUTPUT_DIRECTORY}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# Fail rather than inherit a config that could ignore advisories or filter targets.
if [[ -e "${CARGO_HOME:-$HOME/.cargo}/audit.toml" ]]; then
  echo 'Unexpected global cargo-audit configuration; refusing an audit that may hide findings.' >&2
  exit 2
fi
cd "$TMP"

VERSION=0.23.0
ASSET="cargo-audit-x86_64-unknown-linux-musl-v${VERSION}.tgz"
EXPECTED=4f01c74ed84b2dffd0b1d37012a62cdf2a92c96e25bdf8eec7fcc0d4d3eb7811
URL="https://github.com/rustsec/rustsec/releases/download/cargo-audit/v${VERSION}/${ASSET}"
printf 'Tool: cargo-audit %s\nURL: %s\nExpected SHA-256: %s\n' "$VERSION" "$URL" "$EXPECTED" > "$OUT/tool-provenance.txt"
curl --fail --location --silent --show-error "$URL" -o "$TMP/$ASSET"
printf '%s  %s\n' "$EXPECTED" "$TMP/$ASSET" | sha256sum --check
sha256sum "$TMP/$ASSET" >> "$OUT/tool-provenance.txt"
tar -xzf "$TMP/$ASSET" -C "$TMP"
mapfile -t bins < <(find "$TMP" -type f -name cargo-audit)
if [[ ${#bins[@]} != 1 ]]; then echo 'Unable to identify the official cargo-audit executable' >&2; exit 2; fi
AUDIT=${bins[0]}
"$AUDIT" audit --version | tee -a "$OUT/tool-provenance.txt"

git clone --quiet --depth 1 https://github.com/RustSec/advisory-db.git "$TMP/advisory-db"
git -C "$TMP/advisory-db" rev-parse HEAD > "$OUT/advisory-db.commit"
git -C "$TMP/advisory-db" show -s --format='%cI %s' HEAD > "$OUT/advisory-db.date"
date -u +%FT%TZ > "$OUT/audit-date.txt"
cat "$OUT/advisory-db.commit" "$OUT/advisory-db.date" "$OUT/audit-date.txt"

# Audits must run for all three locks even when an earlier one has findings.
# --deny warnings includes unsound/unmaintained/yanked; no ID or target is ignored.
for workspace in environment-check optimizer stylus-wrapper; do
  lock="$ROOT/rust/$workspace/Cargo.lock"
  cmd=("$AUDIT" audit --file "$lock" --db "$TMP/advisory-db" --no-fetch --deny warnings --json)
  printf '%q ' "${cmd[@]}" > "$OUT/$workspace.command"
  printf '\n' >> "$OUT/$workspace.command"
  code=0
  "${cmd[@]}" > "$OUT/$workspace.json" 2> "$OUT/$workspace.stderr" || code=$?
  printf '%s\n' "$code" > "$OUT/$workspace.exit"
done

# This returns nonzero for any audit finding or invalid/error report, after all
# reports have been written. The workflow uploads them even on failure.
python3 "$ROOT/scripts/phase2b/summarize-dependency-evidence.py" audit "$OUT"
