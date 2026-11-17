'use strict';

// Build a client ABI from the independently maintained Solidity interface.
// solc-js standard JSON input has no imports, timestamps or network access.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const solc = require('solc');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'abi/ISyntheticOptimizer.sol');
const artifactPath = path.join(root, 'abi/SyntheticOptimizer.abi.json');
const expectedVersion = '0.8.30+commit.73712a01.Emscripten.clang';
const expectedHash = '3bb491a777f76dff9b2fe73ce29ca20e21a971b59a2f2cf8f73415424f00be06';

function generate() {
  if (solc.version() !== expectedVersion) throw new Error(`unexpected solc ${solc.version()}`);
  const hash = crypto.createHash('sha256')
    .update(fs.readFileSync(require.resolve('solc/soljson.js'))).digest('hex');
  if (hash !== expectedHash) throw new Error(`unexpected soljson.js SHA-256: ${hash}`);
  const input = {
    language: 'Solidity',
    sources: { 'ISyntheticOptimizer.sol': { content: fs.readFileSync(sourcePath, 'utf8') } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.methodIdentifiers'] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((entry) => entry.severity === 'error');
  if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'));
  const contract = output.contracts['ISyntheticOptimizer.sol'].ISyntheticOptimizer;
  const methods = Object.values(contract.evm.methodIdentifiers);
  if (methods.length !== 1 || methods[0] !== '31631981') {
    throw new Error(`unexpected method identifiers: ${JSON.stringify(contract.evm.methodIdentifiers)}`);
  }
  return `${JSON.stringify(contract.abi, null, 2)}\n`;
}

if (require.main === module) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check')) {
    throw new Error('usage: node generate.cjs [--check]');
  }
  const first = generate();
  if (first !== generate()) throw new Error('compiler output was not deterministic');
  if (process.argv[2] === '--check') {
    if (fs.readFileSync(artifactPath, 'utf8') !== first) throw new Error('ABI artifact is stale');
    console.log(`ABI is reproducible; solc ${expectedVersion}; selector 0x31631981`);
  } else {
    fs.writeFileSync(artifactPath, first);
    console.log(`Wrote ${artifactPath}; solc ${expectedVersion}; selector 0x31631981`);
  }
}
module.exports = { generate, artifactPath };
