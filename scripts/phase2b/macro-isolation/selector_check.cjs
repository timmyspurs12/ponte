'use strict';

// Phase 2B.5.3 offline selector evidence for one release WASM. It uses only
// in-memory vm_hooks stubs: no RPC, chain, wallet, activation, transaction,
// payment or settlement. Run from rust/stylus-wrapper after `npm --prefix
// abi-tools ci`, so ethers comes from the existing locked ABI tooling.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const EXPECTED = '0x31631981';
const [wasmPath, sdkAbiPath] = process.argv.slice(2);
if (!wasmPath || !sdkAbiPath) throw new Error('usage: node selector_check.cjs <release.wasm> <sdk-export-abi.sol>');
const wrapper = process.cwd();
const { Interface, id } = createRequire(path.join(wrapper, 'abi-tools', 'package.json'))('ethers');

// 1. SDK `export-abi` declaration plus the independently recorded canonical
//    request tuple; the SDK export omits input-only struct declarations.
const sdkAbi = fs.readFileSync(sdkAbiPath, 'utf8');
const declarations = sdkAbi.match(/function\s+evaluateSynthetic\s*\(\s*SyntheticRequest\s+(?:calldata\s+|memory\s+)?request\s*\)[^;]*;/g) || [];
assert.equal(declarations.length, 1, 'exactly one SDK-exported evaluateSynthetic(SyntheticRequest) declaration');
const tuple = fs.readFileSync(path.join(wrapper, 'expected-request-tuple.txt'), 'utf8').trim();
const signature = `evaluateSynthetic(${tuple})`;
const keccakSelector = id(signature).slice(0, 10);
assert.equal(keccakSelector, EXPECTED, 'keccak256(canonical signature)[0..4]');
console.log(`PASS: SDK export declares ${declarations[0].replace(/\s+/g, ' ')}`);
console.log(`PASS: keccak256(canonical evaluateSynthetic signature)[0..4] = ${keccakSelector}`);

// 2. Client ABI artifact compiled from the separately maintained interface.
const iface = new Interface(JSON.parse(fs.readFileSync(path.join(wrapper, 'abi/SyntheticOptimizer.abi.json'), 'utf8')));
const fragment = iface.getFunction('evaluateSynthetic');
assert.equal(fragment.selector, EXPECTED);
assert.equal(fragment.format('sighash'), signature);
console.log(`PASS: client ABI selector ${fragment.selector} and canonical signature match`);

// 3. Release WASM dispatch: the expected selector routes, while each of the 32
//    one-bit variants of it is rejected by the SDK router before any method.
const module_ = new WebAssembly.Module(fs.readFileSync(wasmPath));
function execute(input) {
  let instance;
  let output;
  const events = [];
  const memory = () => new Uint8Array(instance.exports.memory.buffer);
  const hooks = {
    msg_reentrant() { events.push('msg_reentrant'); return 0; },
    pay_for_memory_grow() { events.push('pay_for_memory_grow'); },
    read_args(ptr) { events.push('read_args'); memory().set(input, ptr >>> 0); },
    msg_value(ptr) { events.push('msg_value'); memory().fill(0, ptr >>> 0, (ptr >>> 0) + 32); },
    storage_flush_cache() { events.push('storage_flush_cache'); },
    write_result(ptr, len) {
      events.push('write_result');
      output = Buffer.from(memory().subarray(ptr >>> 0, (ptr >>> 0) + (len >>> 0)));
    },
  };
  instance = new WebAssembly.Instance(module_, { vm_hooks: hooks });
  const status = instance.exports.user_entrypoint(input.length);
  return { status, output, events };
}

const ZERO = `0x${'00'.repeat(32)}`;
const request = {
  version: 1,
  mode: 1,
  inputAsset: { namespace: 'a', identifier: 'b', decimals: 18 },
  outputAsset: { namespace: 'c', identifier: 'd', decimals: 18 },
  amountIn: 1n,
  userMinOut: 0n,
  toleranceBps: 0,
  asOfUnixSeconds: 1n,
  expiresAtUnixSeconds: 100n,
  snapshotId: ZERO,
  candidates: [{
    routeId: ZERO,
    snapshotId: ZERO,
    rateNumerator: 1n,
    rateDenominator: 1n,
    feeBps: 0,
    estimatedImpactBps: 0,
    minInput: 1n,
    maxInput: 100n,
    availableInput: 100n,
    availableOutput: 100n,
    executionCostUsdCents: 0n,
    expiresAtUnixSeconds: 100n,
  }],
};
const call = Buffer.from(iface.encodeFunctionData('evaluateSynthetic', [request]).slice(2), 'hex');
assert.equal(`0x${call.subarray(0, 4).toString('hex')}`, EXPECTED);
const accepted = execute(call);
assert.equal(accepted.status, 0, 'the expected selector must route');
assert.ok(accepted.events.includes('msg_value'), 'the matched non-payable method checks value');
const [result] = iface.decodeFunctionResult('evaluateSynthetic', accepted.output);
assert.equal(result.status, 1n, 'single-candidate synthetic request is SELECTED');
assert.equal(result.expectedOut, 1n);
console.log(`PASS: release WASM routes ${EXPECTED}; result decodes as SELECTED with expectedOut=1`);

let rejected = 0;
for (let bit = 0; bit < 32; bit++) {
  const variant = Buffer.from(call);
  variant[bit >> 3] ^= 0x80 >> (bit & 7);
  const outcome = execute(variant);
  const selector = variant.subarray(0, 4).toString('hex');
  assert.equal(outcome.status, 1, `selector 0x${selector} must revert`);
  assert.equal(outcome.output.length, 0, `selector 0x${selector} must return empty data`);
  assert.ok(!outcome.events.includes('msg_value'), `selector 0x${selector} must not reach a method`);
  rejected++;
}
console.log(`PASS: all ${rejected} one-bit variants of ${EXPECTED} revert with empty output before any method`);
