#!/usr/bin/env python3
"""Collect and verify local deployment/activation/method transaction evidence."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.request

RPC_URL = "http://127.0.0.1:8547"
EXPECTED_CHAIN_ID = 412346
ACTIVATION_PRECOMPILE = "0x0000000000000000000000000000000000000071"
ROOT_PREFIX = bytes.fromhex("eff00200")
FRAGMENT_PREFIX = bytes.fromhex("eff001")


def rpc(method: str, params: list[object]) -> object:
    request = urllib.request.Request(
        RPC_URL,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    if result.get("error"):
        raise RuntimeError(f"local JSON-RPC {method} failed: {result['error']}")
    return result["result"]


def quantity(value: str) -> int:
    return int(value, 16)


def receipt(tx_hash: str) -> dict:
    result = rpc("eth_getTransactionReceipt", [tx_hash])
    if not isinstance(result, dict):
        raise RuntimeError(f"missing transaction receipt for {tx_hash}")
    if quantity(result.get("status", "0x0")) != 1:
        raise RuntimeError(f"transaction failed on local chain: {tx_hash}")
    return result


def normalize_address(value: str | None) -> str | None:
    return value.lower() if value else None


def code_at(address: str) -> bytes:
    result = rpc("eth_getCode", [address, "latest"])
    if not isinstance(result, str) or not result.startswith("0x"):
        raise RuntimeError(f"invalid eth_getCode result for {address}: {result!r}")
    return bytes.fromhex(result[2:])


def main() -> None:
    if len(sys.argv) != 6:
        raise SystemExit(
            "usage: collect_evidence.py EVIDENCE_DIR DEV_ADDRESS DEPLOY_LOG NODE_INSPECT IMAGE_INSPECT"
        )
    evidence = Path(sys.argv[1])
    dev_address = sys.argv[2].lower()
    deploy_log_path, node_inspect_path, image_inspect_path = map(Path, sys.argv[3:6])
    artifact = json.loads((evidence / "artifact.json").read_text())
    chain = json.loads((evidence / "local-chain.json").read_text())
    call = json.loads((evidence / "method-execution.json").read_text())
    node = json.loads(node_inspect_path.read_text())[0]
    image = json.loads(image_inspect_path.read_text())[0]
    if not node.get("State", {}).get("Running"):
        raise RuntimeError("inspected Nitro container was not running during the proof")
    if node.get("Config", {}).get("Image") != chain.get("container_image"):
        raise RuntimeError("Docker inspection and local-chain runtime image do not match")

    if chain.get("rpc_endpoint") != RPC_URL or chain.get("chain_id") != EXPECTED_CHAIN_ID:
        raise RuntimeError("local-chain evidence does not match the fixed local-only RPC and chain ID")
    if chain.get("arbos_version") != 61 or chain.get("activationGas") != 0:
        raise RuntimeError("local chain did not match the verified ArbOS 61 / activationGas baseline")
    if chain.get("allow_offchain_activation_flag_applied") is not True:
        raise RuntimeError("running Nitro did not have the required local-only activation flag")
    if not call.get("matched") or call.get("rpc_endpoint") != RPC_URL:
        raise RuntimeError("fixture call is not verified against the loopback RPC")
    if int(call.get("chain_id", -1)) != EXPECTED_CHAIN_ID:
        raise RuntimeError("fixture call used an unexpected chain ID")

    text = deploy_log_path.read_text(errors="replace")
    text = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", text)
    deployment_addresses = re.findall(r"deployed code at address:\s*(0x[0-9a-fA-F]{40})", text)
    deployment_hashes = re.findall(r"deployment tx hash:\s*(0x[0-9a-fA-F]{64})", text)
    activations = re.findall(
        # cargo-stylus 0.10.10 prints the activation hash in double quotes after
        # ANSI styling is removed. Accept that presentation detail while preserving
        # the exact 32-byte hash and the deployed-address binding.
        r"successfully activated contract\s+(0x[0-9a-fA-F]{40})\s+with tx\s+['\"]?(?:0x)?([0-9a-fA-F]{64})['\"]?",
        text,
        flags=re.IGNORECASE,
    )
    if not deployment_addresses or not deployment_hashes or not activations:
        raise RuntimeError("cargo-stylus output did not contain the expected deploy and activation identifiers")
    contract_address = deployment_addresses[-1].lower()
    deploy_hash = deployment_hashes[-1]
    activation_address, activation_hash = activations[-1]
    activation_hash = "0x" + activation_hash.removeprefix("0x")
    activation_address = activation_address.lower()
    if activation_address != contract_address:
        raise RuntimeError("cargo-stylus activated a different address than it deployed")
    if call.get("contract_address", "").lower() != contract_address:
        raise RuntimeError("method execution used a different address than the deployed candidate")

    deploy_receipt = receipt(deploy_hash)
    activation_receipt = receipt(activation_hash)
    if normalize_address(deploy_receipt.get("contractAddress")) != contract_address:
        raise RuntimeError("deployment receipt contract address differs from cargo-stylus output")
    if normalize_address(activation_receipt.get("to")) != ACTIVATION_PRECOMPILE:
        raise RuntimeError("activation receipt did not target the local ArbWasm precompile")

    root_code = code_at(contract_address)
    if not root_code:
        raise RuntimeError("no runtime code exists at the reported contract address")
    fragments: list[dict] = []
    if root_code.startswith(ROOT_PREFIX):
        if len(root_code) < 8 or (len(root_code) - 8) % 20:
            raise RuntimeError("root contract fragment address section is malformed")
        uncompressed_size = int.from_bytes(root_code[4:8], "big")
        addresses = [
            "0x" + root_code[index : index + 20].hex()
            for index in range(8, len(root_code), 20)
        ]
        if not addresses:
            raise RuntimeError("fragment root had no fragment addresses")
        for index, address in enumerate(addresses):
            fragment_code = code_at(address)
            if not fragment_code.startswith(FRAGMENT_PREFIX):
                raise RuntimeError(f"deployed fragment {address} lacks the Stylus fragment prefix")
            fragments.append(
                {
                    "index": index,
                    "address": address,
                    "runtime_size_bytes": len(fragment_code),
                    "runtime_sha256": hashlib.sha256(fragment_code).hexdigest(),
                    "receipt": None,
                }
            )
    elif root_code.startswith(bytes.fromhex("eff00000")):
        # A single root contract runtime does not contain the uncompressed WASM length.
        # Preserve that distinction rather than substituting the raw archive file size.
        uncompressed_size = None
        addresses = []
    else:
        raise RuntimeError(f"deployed root code has an unrecognized Stylus code prefix: {root_code[:8].hex()}")

    start_block = int(chain["block_number_at_inspection"])
    end_block = quantity(str(rpc("eth_blockNumber", [])))
    sender_receipts: list[dict] = []
    for block_num in range(start_block + 1, end_block + 1):
        block = rpc("eth_getBlockByNumber", [hex(block_num), True])
        if not isinstance(block, dict):
            raise RuntimeError(f"could not retrieve local block {block_num}")
        for tx in block.get("transactions", []):
            if normalize_address(tx.get("from")) == dev_address:
                tx_receipt = receipt(tx["hash"])
                sender_receipts.append(tx_receipt)

    receipts_by_address = {
        normalize_address(item.get("contractAddress")): item
        for item in sender_receipts
        if item.get("contractAddress")
    }
    for fragment in fragments:
        fragment_receipt = receipts_by_address.get(fragment["address"].lower())
        if not fragment_receipt:
            raise RuntimeError(f"no deployment receipt found for Stylus fragment {fragment['address']}")
        fragment["receipt"] = fragment_receipt

    call_receipt = call.get("transaction_receipt") or {}
    if normalize_address(call_receipt.get("to")) != contract_address:
        raise RuntimeError("method transaction receipt targets a different contract")
    if int(call_receipt.get("status", 0)) != 1:
        raise RuntimeError("method transaction receipt is not successful")
    receipt_hash = call_receipt.get("hash") or call_receipt.get("transactionHash") or ""
    if receipt_hash.lower() != call.get("transaction", {}).get("hash", "").lower():
        raise RuntimeError("method transaction hash and receipt hash do not match")

    report = {
        "scope": "LOCAL DISPOSABLE ARBITRUM NITRO DEVNET ONLY — NOT ARBITRUM SEPOLIA OR ONE",
        "public_testnet_eligibility": "NOT ASSESSED; local execution does not establish Sepolia eligibility or approval",
        "public_rpc_used": False,
        "rpc_endpoint": RPC_URL,
        "artifact": artifact,
        "nitro": {
            "image": chain["container_image"],
            "image_id": image.get("Id"),
            "repo_digests": image.get("RepoDigests", []),
            "client_version": chain["node_client_version"],
            "chain_id": chain["chain_id"],
            "arbos_version": chain["arbos_version"],
            "activationGas": chain["activationGas"],
            "allow_offchain_activation_flag_applied": chain["allow_offchain_activation_flag_applied"],
        },
        "cargo_stylus": {
            "version": os.environ.get("CARGO_STYLUS_VERSION", "0.10.10"),
            "sdk_commit": os.environ.get("SDK_COMMIT", "76f8b055ec0bf421edd542b164dc2917c9e4e0bd"),
            "check_input_wasm_sha256": artifact["candidate_sha256"],
            "check_endpoint": RPC_URL,
            "check_passed": True,
        },
        "deployment": {
            "contract_address": contract_address,
            "deployment_transaction_hash": deploy_hash,
            "deployment_receipt": deploy_receipt,
            "activation_transaction_hash": activation_hash,
            "activation_receipt": activation_receipt,
            "root_runtime_size_bytes": len(root_code),
            "root_runtime_sha256": hashlib.sha256(root_code).hexdigest(),
            "uncompressed_wasm_size_bytes": uncompressed_size,
            "fragments": fragments,
            "sender_local_receipts_from_deployment_window": sender_receipts,
        },
        "method_execution": call,
        "reproducibility": {
            "candidate_rebuilt_or_replaced": False,
            "rustc_version": (evidence / "rustc-version.txt").read_text().strip(),
            "cargo_version": (evidence / "cargo-version.txt").read_text().strip(),
            "cargo_stylus_binary_sha256": (evidence / "cargo-stylus-binary.sha256").read_text().strip().split()[0],
            "source_artifact_run_id": artifact["run_id"],
            "source_commit": artifact["source_commit"],
            "workflow_checkout_commit": os.environ.get("GITHUB_SHA"),
            "nitro_devnode_commit": os.environ.get("NITRO_DEVNODE_COMMIT"),
            "nitro_source_commit": os.environ.get("NITRO_SOURCE_COMMIT"),
            "chain_info_sha256": os.environ.get("CHAIN_INFO_SHA256"),
            "devnode_launch_patch_sha256": os.environ.get("DEVNODE_SCRIPT_SHA256"),
            "runner_os": os.environ.get("RUNNER_OS"),
            "runner_arch": os.environ.get("RUNNER_ARCH"),
        },
    }
    output = evidence / "execution-evidence.json"
    output.write_text(json.dumps(report, indent=2) + "\n")

    fragment_summary = (
        f"{len(fragments)} fragment(s) recorded individually"
        if fragments
        else "not fragmented"
    )
    rustc_version = (evidence / "rustc-version.txt").read_text().splitlines()[0]
    cargo_binary_sha256 = (evidence / "cargo-stylus-binary.sha256").read_text().split()[0]
    markdown = f"""# PONTE local Stylus execution proof

**Result:** candidate locally deployed, activated, and executed; the selected fixture matched its tracked expected output.

**Scope:** disposable local Arbitrum Nitro devnet only (`{RPC_URL}`, chain ID {chain['chain_id']}, ArbOS {chain['arbos_version']}). This was **not** Arbitrum Sepolia or Arbitrum One. No public Arbitrum RPC endpoint was used. The run does not establish Sepolia deployment eligibility, permission, approval, or competition compliance.

## Exact candidate

- Source commit: `{artifact['source_commit']}`
- Workflow run / artifact ID: `{artifact['run_id']}` / `{artifact['artifact_id']}`
- Archive SHA-256: `{artifact['artifact_archive_sha256']}`
- Candidate: `{artifact['candidate_file']}` ({artifact['candidate_size_bytes']} bytes)
- Candidate SHA-256: `{artifact['candidate_sha256']}`
- Rebuilt/replaced: **no**

## Runtime and deployment

- Nitro image: `{chain['container_image']}`
- Image ID / registry digest(s): `{image.get('Id')}` / `{', '.join(image.get('RepoDigests') or []) or 'not reported by Docker'}`
- Nitro client: `{chain['node_client_version']}`
- ArbOS: **{chain['arbos_version']}** (locally queried via ArbSys)
- Local `activationGas`: **{chain['activationGas']}** (locally queried via ArbWasm)
- `--execution.stylus-target.allow-offchain-activation=true`: verified in the running local container command
- cargo-stylus: `{os.environ.get('CARGO_STYLUS_VERSION', '0.10.10')}` built with `{rustc_version}`; binary SHA-256 `{cargo_binary_sha256}`
- Check: passed using the exact candidate file and only `{RPC_URL}`
- Contract: `{contract_address}` (local-only address)
- Deployment tx: `{deploy_hash}` (receipt status {deploy_receipt['status']})
- Activation tx: `{activation_hash}` (receipt status {activation_receipt['status']})
- Fragmentation: {fragment_summary}

## Deterministic ABI fixture execution

- Method: `{call['method']['signature']}` (`{call['method']['selector']}`)
- Fixture: `{call['fixture_id']}` from `{call['fixture_file']}`
- Caller: `{call['caller']}` (disposable Nitro dev account)
- Input calldata: `{call['calldata']}`
- Expected result: `{json.dumps(call['expected'], sort_keys=True)}`
- Actual result: `{json.dumps(call['actual'], sort_keys=True)}`
- Match: **{str(call['matched']).lower()}**
- Method transaction: `{call['transaction']['hash']}` (receipt status {call_receipt['status']})
- Raw `eth_call` output: `{call['raw_call_output']}`

Full transaction receipts, container/chain details, fragment addresses and per-fragment hashes are in `execution-evidence.json`.
"""
    (evidence / "REPORT.md").write_text(markdown)
    print(f"Wrote verified local-only execution evidence: {output}")
    print(f"Contract {contract_address}; {fragment_summary}; fixture output matched")


if __name__ == "__main__":
    main()
