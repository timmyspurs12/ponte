#!/usr/bin/env python3
"""Inspect the raw local artifact, not a cargo-stylus deployment/activation check."""
from pathlib import Path
import sys

blob = Path(sys.argv[1]).read_bytes()
if blob[:8] != b'\0asm\x01\0\0\0':
    raise SystemExit('not a WebAssembly 1 module')

def uint(data, offset):
    value = shift = 0
    while True:
        b = data[offset]
        offset += 1
        value |= (b & 127) << shift
        if b < 128:
            return value, offset
        shift += 7
        if shift > 35:
            raise ValueError('invalid LEB128')

def name(data, offset):
    size, offset = uint(data, offset)
    return data[offset:offset + size].decode('utf-8'), offset + size

imports, exports = [], {}
offset = 8
while offset < len(blob):
    section = blob[offset]
    size, start = uint(blob, offset + 1)
    data = blob[start:start + size]
    if len(data) != size:
        raise ValueError('truncated section')
    offset = start + size
    if section not in (2, 7):
        continue
    count, cursor = uint(data, 0)
    for _ in range(count):
        if section == 2:
            module, cursor = name(data, cursor)
            item, cursor = name(data, cursor)
            kind = data[cursor]
            cursor += 1
            if kind != 0:
                raise ValueError('unexpected non-function import')
            _, cursor = uint(data, cursor)
            imports.append((module, item))
        else:
            item, cursor = name(data, cursor)
            kind = data[cursor]
            _, cursor = uint(data, cursor + 1)
            exports[item] = kind
    if cursor != len(data):
        raise ValueError('unparsed import/export data')
print('WASM bytes:', len(blob))
print('WASM imports:', imports)
print('WASM exports:', exports)
if exports.get('user_entrypoint') != 0 or exports.get('memory') != 2:
    raise SystemExit('missing function user_entrypoint or memory export')
if any(module != 'vm_hooks' for module, _ in imports):
    raise SystemExit('unexpected import module')
if not {'read_args', 'write_result'}.issubset({item for _, item in imports}):
    raise SystemExit('missing expected SDK I/O hooks')
# SDK v0.10.10 entrypoint unconditionally flushes its cache; no load or
# cache-write imports are allowed. Fail closed on any newly introduced hook.
allowed = {'pay_for_memory_grow', 'msg_reentrant', 'msg_value',
           'storage_flush_cache', 'write_result', 'read_args'}
if any(item not in allowed for _, item in imports):
    raise SystemExit('unexpected SDK hook; review artifact and allowlist')
print('Local entrypoint/import checks passed; this is not an activation check.')
