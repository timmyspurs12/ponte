#!/usr/bin/env bash
set -Eeuo pipefail

: "${EVIDENCE_DIR:?EVIDENCE_DIR is required}"
: "${DEVNODE_DIR:?DEVNODE_DIR is required}"
: "${NITRO_SOURCE_DIR:?NITRO_SOURCE_DIR is required}"
: "${SDK_DIR:?SDK_DIR is required}"
: "${CLI_ROOT:?CLI_ROOT is required}"
: "${CHAIN_INFO_OUT:?CHAIN_INFO_OUT is required}"
: "${NITRO_IMAGE:?NITRO_IMAGE is required}"

readonly RPC_URL="http://127.0.0.1:8547"
readonly NITRO_VERSION="v3.12.2-5f02f3f"
readonly EXPECTED_NITRO_IMAGE="offchainlabs/nitro-node:v3.12.2-5f02f3f"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly ABI_TOOLS_PACKAGE="$REPO_ROOT/rust/stylus-wrapper/abi-tools/package.json"
readonly CANDIDATE="$EVIDENCE_DIR/official-container-1.wasm"
readonly DEVNODE_LOG="$EVIDENCE_DIR/nitro-devnode.log"
readonly DEPLOY_LOG="$EVIDENCE_DIR/cargo-stylus-deploy.log"

mkdir -p "$EVIDENCE_DIR"
[[ "$NITRO_IMAGE" == "$EXPECTED_NITRO_IMAGE" ]] || { echo "refusing an unpinned Nitro image: $NITRO_IMAGE" >&2; exit 1; }
[[ "$(git -C "$DEVNODE_DIR" rev-parse HEAD)" == "ebb523d4ed9c04d4183743af844a038e9843f352" ]] || { echo "official nitro-devnode checkout is not pinned" >&2; exit 1; }
[[ "$(git -C "$NITRO_SOURCE_DIR" rev-parse HEAD)" == "5f02f3f03076343061f167e81b8e82ec5518064b" ]] || { echo "Nitro v3.12.2 source checkout is not pinned" >&2; exit 1; }
[[ "$(git -C "$SDK_DIR" rev-parse HEAD)" == "76f8b055ec0bf421edd542b164dc2917c9e4e0bd" ]] || { echo "cargo-stylus SDK checkout is not pinned" >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker is required for the disposable local Nitro devnet" >&2; exit 1; }
command -v cargo >/dev/null || { echo "Rust/Cargo is required for pinned cargo-stylus" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
command -v node >/dev/null || { echo "Node.js is required for ABI fixture execution" >&2; exit 1; }

python3 - "$CANDIDATE" "$EVIDENCE_DIR/artifact.json" <<'PY'
import hashlib, json, pathlib, sys
wasm = pathlib.Path(sys.argv[1]).read_bytes()
manifest = json.loads(pathlib.Path(sys.argv[2]).read_text())
actual = hashlib.sha256(wasm).hexdigest()
if len(wasm) != 90731 or actual != "42d8a474d8762aa37df09c9c415dcec1ff7e904e8bfcdcfa365669ad30cd93d2":
    raise SystemExit(f"refusing non-exact candidate: size={len(wasm)}, sha256={actual}")
if manifest.get("candidate_sha256") != actual or manifest.get("source_commit") != "d3dae37f6032fbdea39d1834ef053c5676fb6a43":
    raise SystemExit("candidate manifest does not match the immutable source candidate")
print(f"Using exact artifact bytes only: {len(wasm)} bytes, SHA-256 {actual}; no build step")
PY

# Use the development-only key and launch parameters from the checked-out official devnode source.
DEV_PRIVATE_KEY=$(sed -n 's/^PRIVATE_KEY=//p' "$DEVNODE_DIR/run-dev-node.sh")
if [[ ! $DEV_PRIVATE_KEY =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "could not read the official Nitro disposable development key" >&2
  exit 1
fi
echo "::add-mask::$DEV_PRIVATE_KEY"
export NITRO_DEV_PRIVATE_KEY="$DEV_PRIVATE_KEY"
# Dependencies are intentionally installed under abi-tools, rather than the repository root.
# Bind Node's CommonJS resolver to that lockfile's package boundary so this early address check
# does not depend on an undeclared root-level ethers installation.
export ABI_TOOLS_PACKAGE
DEV_ADDRESS=$(node --input-type=module -e 'import { createRequire } from "node:module"; const require = createRequire(process.env.ABI_TOOLS_PACKAGE); const { Wallet } = require("ethers"); console.log(new Wallet(process.env.NITRO_DEV_PRIVATE_KEY).address)')
if [[ ${DEV_ADDRESS,,} != "0x3f1eae7d46d88f08fc2f8ed27fcb2ab183eb2d0e" ]]; then
  echo "official devnode development account address mismatch: $DEV_ADDRESS" >&2
  exit 1
fi

# The official helper's only supported launch override is the Nitro image tag. The exact pinned
# Nitro 3.12.2 source chain config is copied to ArbOS 61 by prepare_devnode.py, and its stock
# container invocation receives the off-chain activation opt-in. This patch is confined to this
# disposable CI checkout; no public network configuration is modified.
export NITRO_NODE_VERSION="$NITRO_VERSION"
export TARGET_IMAGE="$NITRO_IMAGE"
export CHAIN_INFO_JSON="$(cat "$CHAIN_INFO_OUT")"
# The official helper resolves stylus-deployer-bytecode.txt relative to its working directory.
# Run its patched CI copy from that directory; invoking it by an absolute pathname from PONTE's
# root makes the helper terminate after its cache-manager setup, before it reports readiness.
(
  cd "$DEVNODE_DIR"
  exec bash ./run-dev-node.sh
) >"$DEVNODE_LOG" 2>&1 &
DEVNODE_PID=$!
cleanup() {
  set +e
  if kill -0 "$DEVNODE_PID" 2>/dev/null; then
    kill -TERM "$DEVNODE_PID" 2>/dev/null
    wait "$DEVNODE_PID" 2>/dev/null
  fi
  docker rm -f nitro-dev >/dev/null 2>&1
  if [[ -f $DEVNODE_LOG ]]; then
    python3 - "$DEVNODE_LOG" "$DEV_PRIVATE_KEY" <<'PY'
import pathlib, sys
log = pathlib.Path(sys.argv[1])
key = sys.argv[2]
log.write_text(log.read_text(errors="replace").replace(key, "[REDACTED DISPOSABLE DEVNET KEY]"))
PY
  fi
}
trap cleanup EXIT INT TERM

# The upstream script reports ready only after its local precompile setup/deployer setup finishes.
ready=0
for _ in $(seq 1 600); do
  if ! kill -0 "$DEVNODE_PID" 2>/dev/null; then
    cat "$DEVNODE_LOG" >&2
    echo "official Nitro devnode script exited before setup completed" >&2
    exit 1
  fi
  if grep -q 'Nitro node is running... (press Ctrl-C to stop)' "$DEVNODE_LOG"; then
    ready=1
    break
  fi
  sleep 1
done
if [[ $ready != 1 ]]; then
  cat "$DEVNODE_LOG" >&2
  echo "timed out waiting for official Nitro devnode setup" >&2
  exit 1
fi

docker inspect nitro-dev > "$EVIDENCE_DIR/node-container-inspect.json"
docker image inspect "$NITRO_IMAGE" > "$EVIDENCE_DIR/nitro-image-inspect.json"
python3 "$SCRIPT_DIR/inspect_devnet.py" \
  "$EVIDENCE_DIR/node-container-inspect.json" "$EVIDENCE_DIR/local-chain.json"

# All cargo-stylus RPC commands below explicitly point at the one fixed loopback endpoint.
export PATH="$CLI_ROOT/bin:$PATH"
CLI_VERSION=$(cargo stylus --version)
echo "$CLI_VERSION" | tee "$EVIDENCE_DIR/cargo-stylus-version.txt"
grep -Eq '(^| )0\.10\.10$' <<<"$CLI_VERSION" || {
  echo "unexpected cargo-stylus version: $CLI_VERSION" >&2
  exit 1
}
export CARGO_STYLUS_VERSION=0.10.10
cargo stylus check --help > "$EVIDENCE_DIR/cargo-stylus-check-help.txt"
grep -q -- '--wasm-file' "$EVIDENCE_DIR/cargo-stylus-check-help.txt"
grep -q -- '--endpoint' "$EVIDENCE_DIR/cargo-stylus-check-help.txt"
cargo stylus deploy --help > "$EVIDENCE_DIR/cargo-stylus-deploy-help.txt"
grep -q -- '--wasm-file' "$EVIDENCE_DIR/cargo-stylus-deploy-help.txt"
grep -q -- '--no-verify' "$EVIDENCE_DIR/cargo-stylus-deploy-help.txt"

# An empty Cargo workspace prevents cargo-stylus from discovering or rebuilding PONTE source.
# check's --wasm-file path is the exact archived candidate; the CLI does its own required
# processing/compression and local activation simulation, but it never compiles or replaces WASM.
CHECK_WORKSPACE="$EVIDENCE_DIR/empty-cargo-workspace"
mkdir -p "$CHECK_WORKSPACE"
printf '[workspace]\nmembers = []\nresolver = "2"\n' > "$CHECK_WORKSPACE/Cargo.toml"
printf '[workspace]\nnetworks = {}\n' > "$CHECK_WORKSPACE/Stylus.toml"
cd "$CHECK_WORKSPACE"
cargo stylus check --wasm-file "$CANDIDATE" --endpoint "$RPC_URL" \
  > "$EVIDENCE_DIR/cargo-stylus-check.log" 2>&1 || {
    cat "$EVIDENCE_DIR/cargo-stylus-check.log" >&2
    echo "pinned cargo-stylus 0.10.10 check failed against the exact candidate and local RPC" >&2
    exit 1
  }
cat "$EVIDENCE_DIR/cargo-stylus-check.log"

BASE_BLOCK=$(python3 - "$EVIDENCE_DIR/local-chain.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["block_number_at_inspection"])
PY
)
printf '%s\n' "$BASE_BLOCK" > "$EVIDENCE_DIR/deployment-start-block.txt"

# `--wasm-file` uses the candidate bytes, `--no-verify` prevents any container rebuild, and
# absence of `--no-activate` deliberately requests deploy + activation on this disposable chain.
# Never replace this with the project-build path or continue after a CLI failure.
cargo stylus deploy --no-verify --wasm-file "$CANDIDATE" \
  --endpoint "$RPC_URL" --private-key "$DEV_PRIVATE_KEY" \
  > "$DEPLOY_LOG" 2>&1 || {
    cat "$DEPLOY_LOG" >&2
    echo "pinned cargo-stylus 0.10.10 deployment/activation failed on the local devnet" >&2
    exit 1
  }
cat "$DEPLOY_LOG"

# The deployed root address is taken from cargo-stylus' emitted address, after which a tracked
# fixture from the repository's actual ABI is sent as a local transaction and checked via eth_call.
CONTRACT_ADDRESS=$(python3 - "$DEPLOY_LOG" <<'PY'
import pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text(errors="replace")
text = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", text)
matches = re.findall(r"deployed code at address:\s*(0x[0-9a-fA-F]{40})", text)
if not matches:
    raise SystemExit("cargo-stylus deploy output has no deployed contract address")
print(matches[-1])
PY
)
cd "$REPO_ROOT"
node "$SCRIPT_DIR/execute_fixture.mjs" "$CONTRACT_ADDRESS" "$EVIDENCE_DIR/method-execution.json" \
  | tee "$EVIDENCE_DIR/method-execution.log"

export SDK_COMMIT="76f8b055ec0bf421edd542b164dc2917c9e4e0bd"
export NITRO_DEVNODE_COMMIT="ebb523d4ed9c04d4183743af844a038e9843f352"
export NITRO_SOURCE_COMMIT="5f02f3f03076343061f167e81b8e82ec5518064b"
export RUNNER_OS="${RUNNER_OS:-unknown}"
export RUNNER_ARCH="${RUNNER_ARCH:-unknown}"
export GITHUB_SHA="${GITHUB_SHA:-unknown}"
export CHAIN_INFO_SHA256="$(sha256sum "$CHAIN_INFO_OUT" | awk '{print $1}')"
export DEVNODE_SCRIPT_SHA256="$(sha256sum "$DEVNODE_DIR/run-dev-node.sh" | awk '{print $1}')"
python3 "$SCRIPT_DIR/collect_evidence.py" \
  "$EVIDENCE_DIR" "$DEV_ADDRESS" "$DEPLOY_LOG" \
  "$EVIDENCE_DIR/node-container-inspect.json" "$EVIDENCE_DIR/nitro-image-inspect.json"

printf '\nLocal Stylus proof complete. Full evidence: %s\n' "$EVIDENCE_DIR/REPORT.md"
