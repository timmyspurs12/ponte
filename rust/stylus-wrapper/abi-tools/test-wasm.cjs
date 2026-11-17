'use strict';

// Independent ethers client -> real release WASM -> ethers result decoder.
// Only in-memory vm_hooks stubs are provided; no RPC or external service.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Interface } = require('ethers');

// Preserve a failing exit code and surface diagnostics on the CI check itself.
process.on('uncaughtException', (error) => {
  console.error(error.stack);
  if (process.env.GITHUB_ACTIONS === 'true') {
    const escaped = String(error.stack).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.log(`::error title=Client ABI WASM compatibility::${escaped}`);
  }
  process.exitCode = 1;
});

const wrapper = path.resolve(__dirname, '..');
const repo = path.resolve(wrapper, '../..');
const iface = new Interface(JSON.parse(fs.readFileSync(path.join(wrapper, 'abi/SyntheticOptimizer.abi.json'), 'utf8')));
const wasmPath = process.argv[2];
const fixturesOnly = wasmPath === '--fixtures-only';
if (!wasmPath) throw new Error('usage: node test-wasm.cjs <release.wasm> | --fixtures-only');
const module_ = fixturesOnly ? null : new WebAssembly.Module(fs.readFileSync(wasmPath));
const ZERO = `0x${'00'.repeat(32)}`;

function execute(hex) {
  const input = Buffer.from(hex.slice(2), 'hex');
  let instance;
  let output;
  const events = [];
  const memory = () => new Uint8Array(instance.exports.memory.buffer);
  const hooks = {
    msg_reentrant() { events.push('msg_reentrant'); return 0; },
    pay_for_memory_grow() { events.push('pay_for_memory_grow'); },
    read_args(ptr) { events.push('read_args'); memory().set(input, ptr >>> 0); },
    msg_value(ptr) { events.push('msg_value'); memory().fill(0, ptr >>> 0, (ptr >>> 0) + 32); },
    storage_flush_cache(clear) { events.push('storage_flush_cache'); assert.equal(clear, 0); },
    write_result(ptr, len) {
      events.push('write_result');
      output = Buffer.from(memory().subarray(ptr >>> 0, (ptr >>> 0) + (len >>> 0)));
    },
  };
  instance = new WebAssembly.Instance(module_, { vm_hooks: hooks });
  const status = instance.exports.user_entrypoint(input.length);
  return { status, output: `0x${output.toString('hex')}`, events };
}

function compareResult(actual, expected, id) {
  if (expected.status === 'ERROR') {
    assert.equal(actual.status, 0n, id);
    assert.equal(actual.errorCode, expected.error.code, id);
    assert.equal(actual.selectedRouteId, ZERO, id);
    for (const field of ['amountIn', 'grossOut', 'feeOut', 'expectedOut', 'minimumOut',
      'executionCostUsdCents', 'effectiveExpiry', 'evaluatedCount']) {
      assert.equal(actual[field], 0n, `${id}: ${field}`);
    }
    assert.equal(actual.snapshotId, ZERO, id);
    assert.equal(actual.rejected.length, 0, id);
    return;
  }
  assert.equal(actual.status, expected.status === 'SELECTED' ? 1n : 2n, id);
  assert.equal(actual.errorCode, '', id);
  for (const field of ['amountIn', 'evaluatedCount']) assert.equal(actual[field], BigInt(expected[field]), `${id}: ${field}`);
  assert.equal(actual.snapshotId, expected.snapshotId, id);
  if (expected.status === 'SELECTED') {
    assert.equal(actual.selectedRouteId, expected.selectedRouteId, id);
    for (const field of ['grossOut', 'feeOut', 'expectedOut', 'minimumOut', 'executionCostUsdCents', 'effectiveExpiry']) {
      assert.equal(actual[field], BigInt(expected[field]), `${id}: ${field}`);
    }
  } else {
    assert.equal(actual.selectedRouteId, ZERO, id);
    for (const field of ['grossOut', 'feeOut', 'expectedOut', 'minimumOut', 'executionCostUsdCents', 'effectiveExpiry']) {
      assert.equal(actual[field], 0n, `${id}: ${field}`);
    }
  }
  assert.equal(actual.rejected.length, expected.rejected.length, id);
  expected.rejected.forEach((rejection, i) => {
    assert.equal(actual.rejected[i].routeId, rejection.routeId, id);
    assert.equal(actual.rejected[i].reason, rejection.reason, id);
  });
}

const classification = fs.readFileSync(path.join(wrapper, 'src/fixture_classification.rs'), 'utf8');
const entries = [...classification.matchAll(/\(\s*"([^"]+)",\s*"([^"]*)",?\s*\)/g)];
const inventory = new Map(entries.map((match) => [match[1], match[2]]));
assert.equal(inventory.size, 60, 'all fixture classifications must be explicit');
let included = 0;
let executed = 0;
let rejected65 = 0;
const seen = new Set();
const counts = new Set();
for (const file of ['edge-cases.json', 'legacy-parity.json', 'regression-minimized.json']) {
  const suite = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/phase2b/fixtures/v1', file), 'utf8'));
  for (const fixture of suite.vectors) {
    assert.ok(inventory.has(fixture.id), `unclassified fixture ${fixture.id}`);
    assert.ok(!seen.has(fixture.id), `duplicate fixture ${fixture.id}`);
    seen.add(fixture.id);
    if (inventory.get(fixture.id)) continue;
    included++;
    const raw = JSON.parse(fixture.rawRequestJson);
    assert.ok(['SYNTHETIC', 'LIVE'].includes(raw.mode));
    const req = { ...raw, mode: raw.mode === 'SYNTHETIC' ? 1 : 0 };
    counts.add(req.candidates.length);
    const call = iface.encodeFunctionData('evaluateSynthetic', [req]);
    assert.equal(call.slice(0, 10), '0x31631981', fixture.id);
    const decoded = iface.decodeFunctionData('evaluateSynthetic', call);
    assert.equal(iface.encodeFunctionData('evaluateSynthetic', decoded), call, fixture.id);
    if (fixturesOnly) continue;
    const result = execute(call);
    if (req.candidates.length > 64) {
      assert.equal(result.status, 1, fixture.id);
      assert.equal(result.output, '0x', fixture.id);
      assert.ok(!result.events.includes('msg_value'), fixture.id);
      rejected65++;
      continue;
    }
    assert.equal(result.status, 0, `${fixture.id}: unexpected revert`);
    assert.ok(result.events.includes('read_args'), fixture.id);
    assert.ok(result.events.includes('msg_value'), fixture.id);
    const decodedResult = iface.decodeFunctionResult('evaluateSynthetic', result.output);
    assert.equal(iface.encodeFunctionResult('evaluateSynthetic', decodedResult), result.output, fixture.id);
    compareResult(decodedResult[0], fixture.expectedResponse, fixture.id);
    executed++;
  }
}
assert.equal(seen.size, inventory.size);
assert.equal(included, 49);
for (const count of [0, 1, 64, 65]) assert.ok(counts.has(count), `missing ${count}-candidate fixture`);
if (fixturesOnly) {
  console.log('PASS: 49 classified fixture requests encode/decode canonically using generated ABI (WASM not executed)');
} else {
  assert.equal(executed, 48);
  assert.equal(rejected65, 1);
  console.log('PASS: generated ABI encodes 49 classified fixtures; 48 execute through release WASM and results decode/match fixtures');
  console.log('PASS: complete canonical 65-candidate fixture reverts at the existing calldata boundary');
}
