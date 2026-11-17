#!/usr/bin/env python3
"""Compare SDK output with an independent expected declaration and result layout.

The SDK's output-only type-declaration limitation is separately documented; the
input canonical tuple and selector are checked by the native SDK router test.
"""
import json
from pathlib import Path
import re
import sys

expected = json.loads(Path('expected-abi.json').read_text())
abi = Path(sys.argv[1]).read_text()
normalize = lambda s: re.sub(r'\s+', ' ', s.strip())
methods = re.findall(r'function\s+evaluateSynthetic\s*\([^;]+;', abi)
if len(methods) != 1 or normalize(methods[0]) != normalize(expected['method']):
    raise SystemExit(f'method mismatch: {methods!r}')
for name, fields in expected['result_structs'].items():
    matches = re.findall(r'\bstruct\s+' + re.escape(name) + r'\s*\{([^{}]*)\}', abi)
    if len(matches) != 1:
        raise SystemExit(f'missing or duplicate {name} in SDK ABI')
    actual = [normalize(f) for f in matches[0].split(';') if f.strip()]
    if actual != fields:
        raise SystemExit(f'{name} mismatch: {actual!r} != {fields!r}')
print('Verified SDK method declaration:', normalize(methods[0]))
print('Verified SDK result and rejection field order/types against expected-abi.json')
missing = [n for n in ('SyntheticRequest', 'SyntheticAsset', 'SyntheticCandidate')
           if not re.search(r'\bstruct\s+' + n + r'\s*\{', abi)]
if missing:
    print('SDK export does not declare input-only structs:', ', '.join(missing))
