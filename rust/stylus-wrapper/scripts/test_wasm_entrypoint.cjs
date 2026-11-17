'use strict';

// Offline host-stub execution of the exact release WASM. This is not Nitro,
// activation, metering, a network simulation, or client ABI generation.
const assert = require('node:assert/strict');
const fs = require('node:fs');

const MAX_CALLDATA = 25_572;
const SELECTOR = Buffer.from('31631981', 'hex');
const WORD = 32;
const wasm = fs.readFileSync(process.argv[2]);
const module_ = new WebAssembly.Module(wasm);

// Verify the actual exported function type, not just its export name. The
// current artifact imports only functions and uses standard function types.
function checkEntrypointSignature(bytes) {
  let cursor = 8;
  function uint() {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = bytes[cursor++];
      assert.notEqual(b, undefined, 'truncated LEB128');
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return value;
      shift += 7;
      assert.ok(shift <= 35, 'oversized LEB128');
    }
  }
  function name() {
    const length = uint();
    const end = cursor + length;
    assert.ok(end <= bytes.length, 'truncated name');
    const value = bytes.subarray(cursor, end).toString('utf8');
    cursor = end;
    return value;
  }
  let types = [];
  let importedTypes = [];
  let definedTypes = [];
  let entryIndex;
  while (cursor < bytes.length) {
    const section = bytes[cursor++];
    const size = uint();
    const end = cursor + size;
    assert.ok(end <= bytes.length, 'truncated WASM section');
    if (section === 1) {
      types = Array.from({ length: uint() }, () => {
        assert.equal(bytes[cursor++], 0x60, 'expected function type');
        const params = Array.from({ length: uint() }, () => bytes[cursor++]);
        const results = Array.from({ length: uint() }, () => bytes[cursor++]);
        return { params, results };
      });
    } else if (section === 2) {
      importedTypes = Array.from({ length: uint() }, () => {
        name();
        name();
        assert.equal(bytes[cursor++], 0, 'expected function import');
        return uint();
      });
    } else if (section === 3) {
      definedTypes = Array.from({ length: uint() }, uint);
    } else if (section === 7) {
      const count = uint();
      for (let i = 0; i < count; i++) {
        const item = name();
        const kind = bytes[cursor++];
        const index = uint();
        if (item === 'user_entrypoint') {
          assert.equal(kind, 0, 'entrypoint must be a function');
          entryIndex = index;
        }
      }
    }
    assert.ok(cursor <= end, 'section overrun');
    cursor = end;
  }
  assert.notEqual(entryIndex, undefined, 'missing entrypoint');
  const typeIndex = [...importedTypes, ...definedTypes][entryIndex];
  assert.deepEqual(types[typeIndex], { params: [0x7f], results: [0x7f] });
}
checkEntrypointSignature(wasm);

const imports = WebAssembly.Module.imports(module_);
assert.deepEqual(
  imports.map(({ module, name, kind }) => `${module}.${name}:${kind}`).sort(),
  [
    'vm_hooks.msg_reentrant:function',
    'vm_hooks.msg_value:function',
    'vm_hooks.pay_for_memory_grow:function',
    'vm_hooks.read_args:function',
    'vm_hooks.storage_flush_cache:function',
    'vm_hooks.write_result:function',
  ].sort(),
);

function word(value) {
  let n = BigInt(value);
  assert.ok(n >= 0n && n < 1n << 256n);
  const result = Buffer.alloc(WORD);
  for (let i = WORD - 1; i >= 0; i--) {
    result[i] = Number(n & 255n);
    n >>= 8n;
  }
  return result;
}
function abiString(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([word(bytes.length), bytes, Buffer.alloc((WORD - bytes.length % WORD) % WORD)]);
}
function asset(namespace, identifier) {
  const first = abiString(namespace);
  const second = abiString(identifier);
  return Buffer.concat([word(3 * WORD), word(3 * WORD + first.length), word(18), first, second]);
}
function candidate(index) {
  return Buffer.concat([
    word(index), word(0), word(1), word(1), word(0), word(0),
    word(1), word(100), word(100), word(100), word(0), word(100),
  ]);
}
function request(count, stringBytes, aliasAssets = false) {
  const input = asset('a'.repeat(stringBytes), 'b'.repeat(stringBytes));
  const output = asset('c'.repeat(stringBytes), 'd'.repeat(stringBytes));
  const array = Buffer.concat([word(count), ...Array.from({ length: count }, (_, i) => candidate(i))]);
  const inputOffset = 11 * WORD;
  const outputOffset = aliasAssets ? inputOffset : inputOffset + input.length;
  const arrayOffset = inputOffset + input.length + (aliasAssets ? 0 : output.length);
  const head = Buffer.concat([
    word(1), word(1), word(inputOffset), word(outputOffset), word(1), word(0),
    word(0), word(1), word(100), word(0), word(arrayOffset),
  ]);
  return Buffer.concat([
    SELECTOR, word(WORD), head, input, ...(aliasAssets ? [] : [output]), array,
  ]);
}
function readWord(bytes, at) {
  assert.ok(at >= 0 && at + WORD <= bytes.length, 'truncated ABI word');
  let value = 0n;
  for (const byte of bytes.subarray(at, at + WORD)) value = (value << 8n) | BigInt(byte);
  return value;
}
function offset(bytes, at) {
  const value = readWord(bytes, at);
  assert.ok(value <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(value);
}
function decodeResult(bytes, expectedCount) {
  const base = offset(bytes, 0);
  assert.equal(base, WORD, 'expected single dynamic result tuple');
  assert.ok(base + 13 * WORD <= bytes.length, 'truncated result head');
  assert.equal(readWord(bytes, base), 1n, 'selected status');
  const errorAt = base + offset(bytes, base + WORD);
  assert.equal(readWord(bytes, errorAt), 0n, 'empty error code');
  assert.equal(readWord(bytes, base + 2 * WORD), 0n, 'selected route ID');
  assert.equal(readWord(bytes, base + 3 * WORD), 1n, 'amount in');
  assert.equal(readWord(bytes, base + 4 * WORD), 1n, 'gross output');
  assert.equal(readWord(bytes, base + 5 * WORD), 0n, 'fee output');
  assert.equal(readWord(bytes, base + 6 * WORD), 1n, 'expected output');
  assert.equal(readWord(bytes, base + 7 * WORD), 1n, 'minimum output');
  assert.equal(readWord(bytes, base + 8 * WORD), 0n, 'execution cost');
  assert.equal(readWord(bytes, base + 9 * WORD), 100n, 'effective expiry');
  assert.equal(readWord(bytes, base + 10 * WORD), 0n, 'snapshot');
  assert.equal(readWord(bytes, base + 11 * WORD), BigInt(expectedCount));
  const rejectionsAt = base + offset(bytes, base + 12 * WORD);
  assert.equal(readWord(bytes, rejectionsAt), 0n, 'empty rejection array');
}

function execute(input, { reentrant = false, value = 0 } = {}) {
  const events = [];
  let output;
  let instance;
  const memory = () => new Uint8Array(instance.exports.memory.buffer);
  const hooks = {
    msg_reentrant() { events.push(['msg_reentrant']); return Number(reentrant); },
    pay_for_memory_grow(pages) { events.push(['pay_for_memory_grow', pages]); },
    read_args(ptr) { events.push(['read_args']); memory().set(input, ptr >>> 0); },
    msg_value(ptr) {
      events.push(['msg_value']);
      const bytes = memory();
      bytes.fill(0, ptr >>> 0, (ptr >>> 0) + WORD);
      bytes[(ptr >>> 0) + WORD - 1] = value;
    },
    storage_flush_cache(clear) { events.push(['storage_flush_cache', clear]); },
    write_result(ptr, len) {
      events.push(['write_result', len >>> 0]);
      output = Buffer.from(memory().subarray(ptr >>> 0, (ptr >>> 0) + (len >>> 0)));
    },
  };
  instance = new WebAssembly.Instance(module_, { vm_hooks: hooks });
  const status = instance.exports.user_entrypoint(input.length);
  return { status, output, events };
}
function names(result) { return result.events.map(([name]) => name); }
function rejected(result, readExpected) {
  assert.equal(result.status, 1);
  assert.deepEqual(result.output, Buffer.alloc(0));
  assert.deepEqual(names(result), [
    'msg_reentrant', 'pay_for_memory_grow', ...(readExpected ? ['read_args'] : []),
    'storage_flush_cache', 'write_result',
  ]);
  assert.deepEqual(result.events.find(([name]) => name === 'pay_for_memory_grow'), ['pay_for_memory_grow', 0]);
  assert.deepEqual(result.events.find(([name]) => name === 'storage_flush_cache'), ['storage_flush_cache', 0]);
  assert.deepEqual(result.events.find(([name]) => name === 'write_result'), ['write_result', 0]);
}
function accepted(input, count) {
  const result = execute(input);
  assert.equal(result.status, 0);
  assert.deepEqual(names(result), [
    'msg_reentrant', 'pay_for_memory_grow', 'read_args', 'msg_value',
    'storage_flush_cache', 'write_result',
  ]);
  assert.deepEqual(result.events[1], ['pay_for_memory_grow', 0]);
  assert.deepEqual(result.events[4], ['storage_flush_cache', 0]);
  assert.equal(result.events[5][1], result.output.length);
  decodeResult(result.output, count);
}

rejected(execute(Buffer.alloc(MAX_CALLDATA + 1)), false);
console.log('PASS: over-cap input reverts before read_args; flushes and writes empty result');
accepted(request(1, 1), 1);
console.log('PASS: in-budget input is read, routed and returns a decodable result');
const alias65 = request(65, 0, true);
assert.equal(alias65.length, 25_540);
rejected(execute(alias65), true);
console.log('PASS: complete aliased 65-candidate input below cap reverts before matched router');
const malformed = request(1, 1);
word(353).copy(malformed, 4 + WORD + 2 * WORD);
rejected(execute(malformed), true);
console.log('PASS: malformed nested asset offset reverts before matched router');
const maximum = request(64, 64);
assert.equal(maximum.length, MAX_CALLDATA);
accepted(maximum, 64);
console.log('PASS: canonical maximum 64-candidate request is read, routed and decoded');
const nonpayable = execute(request(1, 1), { value: 1 });
assert.equal(nonpayable.status, 1);
assert.deepEqual(nonpayable.output, Buffer.alloc(0));
assert.deepEqual(names(nonpayable), [
  'msg_reentrant', 'pay_for_memory_grow', 'read_args', 'msg_value',
  'storage_flush_cache', 'write_result',
]);
assert.deepEqual(nonpayable.events[4], ['storage_flush_cache', 0]);
console.log('PASS: matched non-payable method reverts on nonzero value');
const reentry = execute(request(1, 1), { reentrant: true });
assert.equal(reentry.status, 1);
assert.equal(reentry.output, undefined);
assert.deepEqual(names(reentry), ['msg_reentrant']);
console.log('PASS: reentrancy returns immediately without read, flush or result write');
console.log('PASS: WASM entrypoint is (i32) -> i32; all six expected vm_hooks exercised');
