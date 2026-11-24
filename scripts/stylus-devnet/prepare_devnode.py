#!/usr/bin/env python3
"""Pin the official devnode launch to Nitro v3.12.2 / ArbOS 61 local-only."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys

DEVNET_CHAIN_ID = 412346
ARBOS_VERSION = 61
OFFCHAIN_FLAG = "--execution.stylus-target.allow-offchain-activation=true"
OLD_LAUNCH = (
    'docker run --rm --name "${CONTAINER_NAME}" -p 8547:8547 '
    '"${TARGET_IMAGE}" --dev --http.addr 0.0.0.0 '
    '--http.api=net,web3,eth,debug $EXTRA_ARGS &'
)
NEW_LAUNCH = (
    'docker run --rm --name "${CONTAINER_NAME}" -p 8547:8547 '
    '"${TARGET_IMAGE}" --dev --http.addr 0.0.0.0 '
    '--http.api=net,web3,eth,debug $EXTRA_ARGS '
    + OFFCHAIN_FLAG
    + ' --chain.id=412346 --chain.info-json "$CHAIN_INFO_JSON" &'
)
# Foundry v1.9.0 prints both the address and the salt from `cast create2`; the upstream helper
# passes that complete string to `cast code`, making its post-deploy verification silently fail
# inside a conditional. Keep only the first (address) field in the disposable patched copy.
OLD_DEPLOYER_ADDRESS = "deployer_address=$(cast create2 --salt $SALT --init-code $deployer_code)"
NEW_DEPLOYER_ADDRESS = (
    "deployer_address=$(cast create2 --salt $SALT --init-code $deployer_code "
    "| awk 'NR == 1 { print $1 }')"
)


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: prepare_devnode.py NITRO_CHAIN_INFO.json CHAIN_INFO_OUT DEVNODE_SCRIPT")
    upstream_chain_info, output_path, script_path = map(Path, sys.argv[1:])
    entries = json.loads(upstream_chain_info.read_text())
    matches = [entry for entry in entries if entry.get("chain-name") == "arb-dev-test"]
    if len(matches) != 1:
        raise RuntimeError("pinned Nitro source must contain exactly one arb-dev-test chain config")
    entry = matches[0]
    chain = entry["chain-config"]
    params = chain["arbitrum"]
    if int(chain["chainId"]) != DEVNET_CHAIN_ID:
        raise RuntimeError("upstream arb-dev-test chain id changed; refusing implicit config drift")
    previous_arbos = int(params["InitialArbOSVersion"])
    if previous_arbos != 59:
        raise RuntimeError(f"expected pinned Nitro dev-test baseline ArbOS 59, got {previous_arbos}")
    params["InitialArbOSVersion"] = ARBOS_VERSION
    output_path.write_text(json.dumps([entry], sort_keys=True, separators=(",", ":")) + "\n")

    script = script_path.read_text()
    if script.count(OLD_LAUNCH) != 1:
        raise RuntimeError("official nitro-devnode launch line changed; refusing an unreviewed patch")
    if script.count(OLD_DEPLOYER_ADDRESS) != 1:
        raise RuntimeError("official nitro-devnode create2 parsing changed; refusing an unreviewed patch")
    patched = script.replace(OLD_LAUNCH, NEW_LAUNCH).replace(
        OLD_DEPLOYER_ADDRESS, NEW_DEPLOYER_ADDRESS
    )
    if patched.count(OFFCHAIN_FLAG) != 1:
        raise RuntimeError("off-chain activation flag was not inserted exactly once")
    if patched.count(NEW_DEPLOYER_ADDRESS) != 1:
        raise RuntimeError("pinned Foundry create2 address normalization was not inserted exactly once")
    script_path.write_text(patched)

    print(
        json.dumps(
            {
                "upstream_chain_info_sha256": hashlib.sha256(upstream_chain_info.read_bytes()).hexdigest(),
                "generated_chain_info_sha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
                "devnode_script_sha256_after_patch": hashlib.sha256(script_path.read_bytes()).hexdigest(),
                "chain_id": DEVNET_CHAIN_ID,
                "source_arbos_version": previous_arbos,
                "configured_arbos_version": ARBOS_VERSION,
                "offchain_activation_flag": OFFCHAIN_FLAG,
                "patch_is_ci_only": True,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
