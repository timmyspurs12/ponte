'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Interface } = require('ethers');
const { generate, artifactPath } = require('./generate.cjs');
const root = path.resolve(__dirname, '..');

// Independent expected inventory. The Rust sol! declarations and the compiler
// ABI are each checked against it, so changing either side alone fails closed.
const structs = {
  SyntheticAsset: [
    ['string', 'namespace'], ['string', 'identifier'], ['uint8', 'decimals'],
  ],
  SyntheticCandidate: [
    ['bytes32', 'routeId'], ['bytes32', 'snapshotId'], ['uint128', 'rateNumerator'],
    ['uint128', 'rateDenominator'], ['uint16', 'feeBps'], ['uint16', 'estimatedImpactBps'],
    ['uint128', 'minInput'], ['uint128', 'maxInput'], ['uint128', 'availableInput'],
    ['uint128', 'availableOutput'], ['uint128', 'executionCostUsdCents'],
    ['uint64', 'expiresAtUnixSeconds'],
  ],
  SyntheticRequest: [
    ['uint16', 'version'], ['uint8', 'mode'], ['SyntheticAsset', 'inputAsset'],
    ['SyntheticAsset', 'outputAsset'], ['uint128', 'amountIn'], ['uint128', 'userMinOut'],
    ['uint16', 'toleranceBps'], ['uint64', 'asOfUnixSeconds'],
    ['uint64', 'expiresAtUnixSeconds'], ['bytes32', 'snapshotId'],
    ['SyntheticCandidate[]', 'candidates'],
  ],
  Rejection: [['bytes32', 'routeId'], ['string', 'reason']],
  SyntheticResult: [
    ['uint8', 'status'], ['string', 'errorCode'], ['bytes32', 'selectedRouteId'],
    ['uint128', 'amountIn'], ['uint128', 'grossOut'], ['uint128', 'feeOut'],
    ['uint128', 'expectedOut'], ['uint128', 'minimumOut'],
    ['uint128', 'executionCostUsdCents'], ['uint64', 'effectiveExpiry'],
    ['bytes32', 'snapshotId'], ['uint8', 'evaluatedCount'], ['Rejection[]', 'rejected'],
  ],
};

function assertComponents(actual, structName) {
  const expected = structs[structName];
  assert.equal(actual.length, expected.length, `${structName} component count`);
  expected.forEach(([type, name], i) => {
    const component = actual[i];
    const isArray = type.endsWith('[]');
    const base = isArray ? type.slice(0, -2) : type;
    const nested = Object.hasOwn(structs, base);
    assert.equal(component.name, name, `${structName}[${i}] name`);
    assert.equal(component.type, nested ? `tuple${isArray ? '[]' : ''}` : type, `${structName}.${name} type`);
    assert.equal(component.internalType,
      nested ? `struct ISyntheticOptimizer.${type}` : type, `${structName}.${name} internalType`);
    if (nested) assertComponents(component.components, base);
    else assert.equal(component.components, undefined);
  });
}

function assertAbi(abi) {
  assert.equal(abi.length, 1, 'no unexpected methods, events, errors or constructors');
  const method = abi[0];
  assert.equal(method.type, 'function');
  assert.equal(method.name, 'evaluateSynthetic');
  assert.equal(method.stateMutability, 'view');
  assert.equal(method.inputs.length, 1);
  assert.equal(method.inputs[0].name, 'request');
  assert.equal(method.inputs[0].type, 'tuple');
  assert.equal(method.inputs[0].internalType, 'struct ISyntheticOptimizer.SyntheticRequest');
  assertComponents(method.inputs[0].components, 'SyntheticRequest');
  assert.equal(method.outputs.length, 1);
  assert.equal(method.outputs[0].type, 'tuple');
  assert.equal(method.outputs[0].internalType, 'struct ISyntheticOptimizer.SyntheticResult');
  assertComponents(method.outputs[0].components, 'SyntheticResult');
  const iface = new Interface(abi);
  const methodFragment = iface.getFunction('evaluateSynthetic');
  assert.equal(methodFragment.selector, '0x31631981');
  const expectedRequest = fs.readFileSync(path.join(root, 'expected-request-tuple.txt'), 'utf8').trim();
  const expectedResult = fs.readFileSync(path.join(root, 'expected-result-tuple.txt'), 'utf8').trim();
  assert.equal(methodFragment.inputs[0].format('sighash'), expectedRequest);
  assert.equal(methodFragment.outputs[0].format('sighash'), expectedResult);
  assert.equal(methodFragment.format('sighash'), `evaluateSynthetic(${expectedRequest})`);
}

const artifact = fs.readFileSync(artifactPath, 'utf8');
assert.equal(generate(), generate(), 'repeated compiler invocations differ');
assert.equal(artifact, generate(), 'committed artifact differs from pinned compiler output');
const abi = JSON.parse(artifact);
assertAbi(abi);

const rust = fs.readFileSync(path.join(root, 'src/lib.rs'), 'utf8');
for (const [name, fields] of Object.entries(structs)) {
  const match = rust.match(new RegExp(`\\bstruct\\s+${name}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing Rust sol! struct ${name}`);
  const actual = match[1].split(';').map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.match(/^(\w+(?:\[\])?)\s+(\w+)$/);
    assert.ok(parts, `unexpected Rust sol! field: ${line}`);
    return [parts[1], parts[2]];
  });
  assert.deepEqual(actual, fields, `Rust ${name} fields drifted`);
}
assert.match(rust, /function\s+evaluateSynthetic\s*\(SyntheticRequest request\)\s+external\s+returns\s*\(SyntheticResult\)/);
assert.match(rust, /#\[public\]\s*impl\s+SyntheticOptimizer\s*\{\s*pub\s+fn\s+evaluate_synthetic\s*\(&self,\s*request:\s*SyntheticRequest\)\s*->\s*SyntheticResult/);
const solidity = fs.readFileSync(path.join(root, 'abi/ISyntheticOptimizer.sol'), 'utf8');
assert.match(solidity, /function\s+evaluateSynthetic\s*\(SyntheticRequest calldata request\)\s*external\s+view\s+returns\s*\(SyntheticResult memory\)/);

// Deliberately corrupt output, nested request and signature; the same integrity
// check used above must reject each drift, not merely produce a different file.
for (const mutate of [
  (a) => { a[0].inputs[0].components[2].components[0].type = 'bytes'; },
  (a) => { a[0].inputs[0].components[10].components.reverse(); },
  (a) => { a[0].outputs[0].components[12].components.pop(); },
  (a) => { a[0].outputs[0].components[3].type = 'uint256'; },
  (a) => { a[0].name = 'evaluateOther'; },
  (a) => { a[0].stateMutability = 'pure'; },
]) {
  const changed = structuredClone(abi);
  mutate(changed);
  assert.throws(() => assertAbi(changed), 'ABI drift must fail the integrity check');
}

const iface = new Interface(abi);
const zero = `0x${'00'.repeat(32)}`;
const req = [1, 1, ['abc', 'é', 2], ['xyz', 'asset', 18], 7, 0, 50, 1, 100, zero, []];
const call = iface.encodeFunctionData('evaluateSynthetic', [req]);
assert.equal(iface.encodeFunctionData('evaluateSynthetic', iface.decodeFunctionData('evaluateSynthetic', call)), call);
const response = [2, 'sample error', zero, 7, 0, 0, 0, 0, 0, 100, zero, 2,
  [[zero, 'EXPIRED'], [`0x${'01'.repeat(32)}`, 'CAPACITY']]];
const encoded = iface.encodeFunctionResult('evaluateSynthetic', [response]);
assert.equal(iface.encodeFunctionResult('evaluateSynthetic', iface.decodeFunctionResult('evaluateSynthetic', encoded)), encoded);
console.log('PASS: deterministic solc output, all nested fields, Rust declarations, tuple signatures, selector and drift detection');
console.log('PASS: ethers request/result round trips including UTF-8 strings and dynamic rejection array');
