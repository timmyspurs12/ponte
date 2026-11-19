#!/usr/bin/env node
// Executes the repository's classified ABI fixture against the fixed loopback Nitro RPC only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Interface, JsonRpcProvider, Wallet } = require('../../rust/stylus-wrapper/abi-tools/node_modules/ethers');

const RPC_URL = 'http://127.0.0.1:8547';
const CHAIN_ID = 412346n;
const FIXTURE_ID = 'edge-001-normal-two-candidate-selection';
const FIXTURE_PATH = 'scripts/phase2b/fixtures/v1/edge-cases.json';
const ABI_PATH = 'rust/stylus-wrapper/abi/SyntheticOptimizer.abi.json';

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
}

function normalizeResult(result) {
  const row = result[0];
  return {
    status: row.status.toString(),
    errorCode: row.errorCode,
    selectedRouteId: row.selectedRouteId.toLowerCase(),
    amountIn: row.amountIn.toString(),
    grossOut: row.grossOut.toString(),
    feeOut: row.feeOut.toString(),
    expectedOut: row.expectedOut.toString(),
    minimumOut: row.minimumOut.toString(),
    executionCostUsdCents: row.executionCostUsdCents.toString(),
    effectiveExpiry: row.effectiveExpiry.toString(),
    snapshotId: row.snapshotId.toLowerCase(),
    evaluatedCount: row.evaluatedCount.toString(),
    rejected: [...row.rejected].map((rejection) => ({
      routeId: rejection.routeId.toLowerCase(),
      reason: rejection.reason,
    })),
  };
}

function expectedResult(expected) {
  return {
    status: expected.status === 'SELECTED' ? '1' : expected.status === 'NO_ROUTE' ? '2' : '0',
    errorCode: expected.error?.code ?? '',
    selectedRouteId: (expected.selectedRouteId ?? `0x${'00'.repeat(32)}`).toLowerCase(),
    amountIn: String(expected.amountIn ?? '0'),
    grossOut: String(expected.grossOut ?? '0'),
    feeOut: String(expected.feeOut ?? '0'),
    expectedOut: String(expected.expectedOut ?? '0'),
    minimumOut: String(expected.minimumOut ?? '0'),
    executionCostUsdCents: String(expected.executionCostUsdCents ?? '0'),
    effectiveExpiry: String(expected.effectiveExpiry ?? '0'),
    snapshotId: (expected.snapshotId ?? `0x${'00'.repeat(32)}`).toLowerCase(),
    evaluatedCount: String(expected.evaluatedCount ?? '0'),
    rejected: (expected.rejected ?? []).map((rejection) => ({
      routeId: rejection.routeId.toLowerCase(),
      reason: rejection.reason,
    })),
  };
}

async function main() {
  const [contractAddress, evidencePath] = process.argv.slice(2);
  const privateKey = process.env.NITRO_DEV_PRIVATE_KEY;
  if (!contractAddress || !evidencePath || !privateKey) {
    throw new Error('usage: execute_fixture.mjs CONTRACT_ADDRESS EVIDENCE_JSON (with NITRO_DEV_PRIVATE_KEY)');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) throw new Error('invalid local deployed address');
  const evidenceDir = process.env.EVIDENCE_DIR ?? 'evidence';
  const candidate = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'artifact.json'), 'utf8'));
  assert.equal(candidate.candidate_sha256, '42d8a474d8762aa37df09c9c415dcec1ff7e904e8bfcdcfa365669ad30cd93d2');
  assert.equal(candidate.candidate_size_bytes, 90731);

  const fixtureFile = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const fixture = fixtureFile.vectors.find((vector) => vector.id === FIXTURE_ID);
  assert.ok(fixture, `fixture ${FIXTURE_ID} was not found in the tracked fixture suite`);
  const abi = JSON.parse(fs.readFileSync(ABI_PATH, 'utf8'));
  const iface = new Interface(abi);
  const fragment = iface.getFunction('evaluateSynthetic');
  assert.ok(fragment, 'evaluateSynthetic method is absent from the tracked ABI');
  assert.equal(fragment.selector.toLowerCase(), '0x31631981', 'ABI selector changed unexpectedly');

  const request = JSON.parse(fixture.rawRequestJson);
  assert.equal(request.mode, 'SYNTHETIC', 'fixture must remain synthetic-only');
  const abiRequest = { ...request, mode: request.mode === 'SYNTHETIC' ? 1 : 0 };
  const calldata = iface.encodeFunctionData('evaluateSynthetic', [abiRequest]);
  const decodedCall = iface.decodeFunctionData('evaluateSynthetic', calldata);
  assert.equal(iface.encodeFunctionData('evaluateSynthetic', decodedCall), calldata, 'ABI calldata must round-trip exactly');

  const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
  const wallet = new Wallet(privateKey, provider);
  const network = await provider.getNetwork();
  assert.equal(network.chainId, CHAIN_ID, 'refusing to transact on an unexpected local chain id');
  const balance = await provider.getBalance(wallet.address);
  assert.ok(balance > 0n, 'disposable Nitro development account is not funded');

  const transactionRequest = { to: contractAddress, from: wallet.address, data: calldata };
  const gasEstimate = await provider.estimateGas(transactionRequest);
  const tx = await wallet.sendTransaction({
    to: contractAddress,
    data: calldata,
    gasLimit: gasEstimate + gasEstimate / 5n + 50_000n,
  });
  const receipt = await tx.wait();
  assert.ok(receipt, 'local call transaction did not produce a receipt');
  assert.equal(receipt.status, 1, 'local Stylus method transaction reverted');

  const rawOutput = await provider.call({ to: contractAddress, data: calldata, from: wallet.address });
  const decodedOutput = iface.decodeFunctionResult('evaluateSynthetic', rawOutput);
  const actual = normalizeResult(decodedOutput);
  const expected = expectedResult(fixture.expectedResponse);
  assert.deepEqual(actual, expected, 'local Stylus method result differs from the tracked fixture expectation');

  const record = {
    execution_scope: 'LOCAL DISPOSABLE ARBITRUM NITRO DEVNET ONLY; no public RPC was configured',
    rpc_endpoint: RPC_URL,
    chain_id: CHAIN_ID.toString(),
    candidate_sha256: candidate.candidate_sha256,
    candidate_size_bytes: candidate.candidate_size_bytes,
    contract_address: contractAddress.toLowerCase(),
    fixture_id: FIXTURE_ID,
    fixture_file: FIXTURE_PATH,
    method: {
      name: fragment.name,
      selector: fragment.selector,
      signature: fragment.format('sighash'),
      state_mutability: fragment.stateMutability,
    },
    caller: wallet.address,
    request: request,
    calldata: calldata,
    raw_call_output: rawOutput,
    expected: expected,
    actual: actual,
    matched: true,
    gas_estimate: gasEstimate.toString(),
    transaction: {
      hash: tx.hash,
      from: wallet.address,
      to: contractAddress.toLowerCase(),
      nonce: tx.nonce,
      chain_id: tx.chainId.toString(),
      gas_limit: tx.gasLimit.toString(),
    },
    transaction_receipt: jsonSafe(receipt),
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Verified ${FIXTURE_ID}: evaluateSynthetic returned the tracked expected result on local chain ${CHAIN_ID}`);
  console.log(`Method transaction ${tx.hash}; contract ${contractAddress}; receipt status ${receipt.status}`);
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
