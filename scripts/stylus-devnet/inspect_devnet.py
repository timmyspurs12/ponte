#!/usr/bin/env python3
"""Fail-closed local-only Nitro, chain, ArbOS and activationGas inspection."""
from __future__ import annotations

import json
from pathlib import Path
import sys
import urllib.request

RPC_URL = "http://127.0.0.1:8547"
CHAIN_ID = 412346
NITRO_VERSION = "v3.12.2-5f02f3f"
ARBOS_VERSION = 61
ARBOS_VERSION_SELECTOR = "0x051038f2"  # ArbSys.arbOSVersion(), pinned Nitro v3.12.2 ABI
ACTIVATION_GAS_SELECTOR = "0x2278c278"  # ArbWasm.activationGas(), pinned Nitro v3.12.2 ABI
ALLOW_OFFCHAIN_FLAG = "--execution.stylus-target.allow-offchain-activation=true"


def rpc(method: str, params: list[object]) -> object:
    request = urllib.request.Request(
        RPC_URL,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        result = json.load(response)
    if result.get("error"):
        raise RuntimeError(f"local JSON-RPC {method} failed: {result['error']}")
    return result["result"]


def int_word(value: str) -> int:
    if not isinstance(value, str) or not value.startswith("0x"):
        raise RuntimeError(f"expected hex ABI word, got {value!r}")
    return int(value, 16)


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: inspect_devnet.py DOCKER_INSPECT.json OUTPUT.json")
    docker = json.loads(Path(sys.argv[1]).read_text())
    if not isinstance(docker, list) or len(docker) != 1:
        raise RuntimeError("expected exactly one running Nitro devnode container")
    container = docker[0]
    config = container.get("Config") or {}
    command = [str(part) for part in (config.get("Cmd") or [])]
    image = str(config.get("Image") or "")
    if NITRO_VERSION not in image:
        raise RuntimeError(f"running node container image is not pinned: {image!r}")
    if ALLOW_OFFCHAIN_FLAG not in command:
        raise RuntimeError("required off-chain activation flag is not present in the running container command")
    if "--chain.id=412346" not in command:
        raise RuntimeError("running Nitro command lacks the isolated local chain ID override")
    if "--chain.info-json" not in command:
        raise RuntimeError("running Nitro command lacks the ArbOS 61 local chain configuration")
    if not container.get("State", {}).get("Running"):
        raise RuntimeError("Nitro container is not running")

    chain_id = int_word(str(rpc("eth_chainId", [])))
    if chain_id != CHAIN_ID:
        raise RuntimeError(f"local chain ID mismatch: {chain_id} != {CHAIN_ID}")
    client_version = str(rpc("web3_clientVersion", []))
    if NITRO_VERSION not in client_version:
        raise RuntimeError(f"Nitro client version mismatch: {client_version!r}")

    arbos_return = str(
        rpc("eth_call", [{"to": "0x0000000000000000000000000000000000000064", "data": ARBOS_VERSION_SELECTOR}, "latest"])
    )
    arbos_reported = int_word(arbos_return)
    # ArbSys returns 55 + ArbOS format version (Nitro's first version is 56).
    actual_arbos = arbos_reported - 55
    if actual_arbos != ARBOS_VERSION:
        raise RuntimeError(f"local chain ArbOS version mismatch: {actual_arbos} != {ARBOS_VERSION}")

    activation_gas_return = str(
        rpc("eth_call", [{"to": "0x0000000000000000000000000000000000000071", "data": ACTIVATION_GAS_SELECTOR}, "latest"])
    )
    activation_gas = int_word(activation_gas_return)
    if activation_gas != 0:
        raise RuntimeError(
            f"unexpected local activationGas {activation_gas}; this proof does not mutate the value"
        )
    block_number = int_word(str(rpc("eth_blockNumber", [])))
    result = {
        "scope": "LOCAL DISPOSABLE ARBITRUM NITRO DEVNET ONLY",
        "rpc_endpoint": RPC_URL,
        "rpc_host_is_loopback": True,
        "container_image": image,
        "running_container_command": command,
        "allow_offchain_activation_flag_applied": True,
        "node_client_version": client_version,
        "chain_id": chain_id,
        "nitro_arbos_version_reported_by_arbSys": arbos_reported,
        "arbos_version": actual_arbos,
        "activationGas": activation_gas,
        "activationGas_hex_result": activation_gas_return,
        "block_number_at_inspection": block_number,
    }
    Path(sys.argv[2]).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
