// Independent, optional one-shot check; requires externally provisioned ethers 6.16.0.
// This is not client ABI generation and is not required by the Rust build.
const { Interface, version } = require('ethers');
if (version !== '6.16.0') throw new Error(`expected ethers 6.16.0, got ${version}`);
const iface = new Interface([
  'function evaluateSynthetic((uint16,uint8,(string,string,uint8),(string,string,uint8),uint128,uint128,uint16,uint64,uint64,bytes32,(bytes32,bytes32,uint128,uint128,uint16,uint16,uint128,uint128,uint128,uint128,uint128,uint64)[])) view returns ((uint8,string,bytes32,uint128,uint128,uint128,uint128,uint128,uint128,uint64,bytes32,uint8,(bytes32,string)[]))',
]);
const zero = `0x${'00'.repeat(32)}`;
const candidate = [zero, zero, 1n, 1n, 0, 0, 1n, 1n, 1n, 1n, 0n, 2n];
const request = [
  1, 1, ['a'.repeat(64), 'b'.repeat(64), 18],
  ['c'.repeat(64), 'd'.repeat(64), 18],
  1n, 0n, 0, 1n, 2n, zero, Array.from({ length: 64 }, () => candidate),
];
const encoded = iface.encodeFunctionData('evaluateSynthetic', [request]);
const length = (encoded.length - 2) / 2;
const selector = encoded.slice(0, 10);
console.log(`ethers ${version}: ${length} bytes, selector ${selector}`);
if (length !== 25_572 || selector !== '0x31631981') process.exit(1);
