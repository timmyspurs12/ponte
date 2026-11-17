#!/usr/bin/env python3
"""Phase 2B.5.3 macro dependency isolation: offline evidence parsing and comparison.

Reads files written by capture.sh and rustsec.sh. It never runs Cargo, never
contacts a network and never interprets absence from a Cargo graph, compiler log
or WASM section as proof of runtime unreachability or exploitability.
"""
from __future__ import annotations

import argparse
import collections
import difflib
import hashlib
import json
import re
import shlex
import subprocess
import sys
import tomllib
import traceback
from pathlib import Path

MACRO_CRATES = ('alloy-sol-macro', 'alloy-sol-macro-expander', 'alloy-sol-macro-input')
MACRO_REQ = '=1.5.7'
MACRO_VERSION = '1.5.7'
EXPECTED_SELECTOR = '0x31631981'
WASM_TARGET = 'wasm32-unknown-unknown'
HOST_TARGET = 'x86_64-unknown-linux-gnu'
WRAPPER_MANIFEST = 'rust/stylus-wrapper/Cargo.toml'
LOCKFILES = (
    'rust/environment-check/Cargo.lock',
    'rust/optimizer/Cargo.lock',
    'rust/stylus-wrapper/Cargo.lock',
)
WORKSPACES = ('environment-check', 'optimizer', 'stylus-wrapper')
SIDES = ('baseline', 'experiment')
ENV_ASSIGNMENT = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*=')
# Legacy Rust symbol hashes, demangled (`::h<16 hex>`) or mangled (`17h<16 hex>E`).
SYMBOL_HASH = re.compile(r'(::h[0-9a-f]{16}|17h[0-9a-f]{16}E)(?=$|[^0-9A-Za-z_])')
SECTION_NAMES = {
    0: 'custom', 1: 'type', 2: 'import', 3: 'function', 4: 'table', 5: 'memory',
    6: 'global', 7: 'export', 8: 'start', 9: 'element', 10: 'code', 11: 'data',
    12: 'datacount', 13: 'tag',
}
# Commands every side must complete successfully for the comparison to be valid.
REQUIRED_COMMANDS = (
    'dependency-evidence', 'wasm-artifacts-json', 'wasm-cold-rebuild',
    'advisory-guard-tests', 'advisory-guard-baseline', 'abi-tools-install',
    'abi-tools-check', 'abi-tools-test', 'fmt', 'test', 'clippy', 'export-abi',
    'check-abi', 'wasm-inspect', 'wasm-entrypoint-tests', 'wasm-client-abi-tests',
    'selector-check', 'wasm-sections', 'lockfiles-unchanged',
)


# --------------------------------------------------------------------------- io

def read_text(path, default=''):
    try:
        return Path(path).read_text(errors='replace')
    except (FileNotFoundError, IsADirectoryError):
        return default


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, ValueError):
        return default


def exit_code(side_dir, name):
    text = read_text(Path(side_dir) / f'{name}.exit').strip()
    try:
        return int(text)
    except ValueError:
        return None


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def first_field(path):
    text = read_text(path).split()
    return text[0] if text else None


# ---------------------------------------------------------- workflow commands

def escape_data(value):
    return str(value).replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')


def escape_property(value):
    return escape_data(value).replace(':', '%3A').replace(',', '%2C')


NOTICE_LIMIT = 3900


def notice(title, message, level='notice'):
    message = str(message)
    if len(message) > NOTICE_LIMIT:
        message = message[:NOTICE_LIMIT] + ' [truncated; complete data is in comparison.json]'
    return f'::{level} title={escape_property(title)}::{escape_data(message)}'


# ------------------------------------------------- Cargo -v/-vv `Running` lines

def iter_running_commands(text):
    """Yield parsed Cargo `Running` commands from -v/-vv output.

    Cargo shell-quotes environment values, which may contain backticks or
    newlines (for example package descriptions), so the closing backtick is the
    one that ends a line *and* leaves balanced shell quoting.
    """
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        match = re.match(r'^\s*Running `(.*)$', lines[i])
        if not match:
            i += 1
            continue
        buffer = match.group(1)
        j = i
        parsed = None
        while True:
            stripped = buffer.rstrip()
            if stripped.endswith('`'):
                try:
                    parsed = shlex.split(stripped[:-1], posix=True)
                except ValueError:
                    parsed = None
                if parsed is not None:
                    break
            j += 1
            if j >= len(lines) or j - i > 400:
                break
            buffer += '\n' + lines[j]
        if parsed is None:
            yield {'error': 'unparsed Running line', 'line': i + 1, 'text': lines[i][:240]}
            i += 1
            continue
        env = {}
        k = 0
        while k < len(parsed) and ENV_ASSIGNMENT.match(parsed[k]):
            key, _, value = parsed[k].partition('=')
            env[key] = value
            k += 1
        yield {'line': i + 1, 'env': env, 'argv': parsed[k:]}
        i = j + 1


def normalize_path(value, repo_root=None):
    value = re.sub(r'\S*/registry/src/[^/\s]+/', '<registry>/', value)
    value = re.sub(r'\S*/toolchains/[^/\s]+/', '<toolchain>/', value)
    if repo_root:
        value = value.replace(repo_root.rstrip('/') + '/', '<repo>/')
    value = re.sub(r'-[0-9a-f]{16}(?=/|\.|$)', '-<hash>', value)
    return value


def package_from_source(path):
    match = re.search(r'/([A-Za-z0-9_.-]+?)-(\d+\.\d+\.\d+[^/]*)/', path)
    return (match.group(1), match.group(2)) if match else (None, None)


def classify_command(command, repo_root=None):
    """Return a normalized compile unit or build-script execution, or None."""
    argv = command.get('argv') or []
    if not argv:
        return None
    env = command.get('env', {})
    program = Path(argv[0]).name
    if program.startswith('build-script-'):
        # TARGET is the triple the package is being built for: host-side packages
        # (proc-macros and their dependencies) see the host triple.
        target = env.get('TARGET')
        kind = 'host' if target == HOST_TARGET else (target or 'unknown')
        name, version = env.get('CARGO_PKG_NAME'), env.get('CARGO_PKG_VERSION')
        return {
            'type': 'build-script-run', 'package': name, 'version': version,
            'kind': kind or 'unknown',
            'key': f'{name} {version} build-script-run {kind or "unknown"}',
        }
    if program not in ('rustc', 'rustc.exe'):
        return None
    args = argv[1:]
    crate_name = target = source = None
    crate_types, features, cfgs, externs, flags = [], [], [], [], []
    value_options = {'--crate-name', '--crate-type', '--target', '--cfg', '--extern', '-C',
                     '-L', '--out-dir', '--check-cfg', '--cap-lints', '-l', '-A', '-W', '-D',
                     '--remap-path-prefix'}
    index = 0
    while index < len(args):
        arg = args[index]
        value = args[index + 1] if index + 1 < len(args) else ''
        if arg in value_options:
            index += 2
            if arg == '--crate-name':
                crate_name = value
            elif arg == '--crate-type':
                crate_types.append(value)
            elif arg == '--target':
                target = value
            elif arg == '--cfg':
                if value.startswith('feature='):
                    features.append(value[len('feature='):].strip('"'))
                else:
                    cfgs.append(value)
            elif arg == '--extern':
                name, _, path = value.partition('=')
                suffix = Path(path).suffix if path else ''
                externs.append(f'{name}{"=" + suffix if suffix else ""}')
            elif arg == '-C':
                key = value.split('=', 1)[0]
                if key in ('metadata', 'extra-filename', 'incremental'):
                    flags.append(f'-C {key}=<hash>')
                else:
                    flags.append(f'-C {normalize_path(value, repo_root)}')
            elif arg in ('-L', '--out-dir'):
                flags.append(f'{arg} {normalize_path(value, repo_root)}')
            else:
                flags.append(f'{arg} {normalize_path(value, repo_root)}')
            continue
        if not arg.startswith('-') and arg.endswith('.rs'):
            source = normalize_path(arg, repo_root)
        else:
            flags.append(normalize_path(arg, repo_root))
        index += 1
    name = env.get('CARGO_PKG_NAME')
    version = env.get('CARGO_PKG_VERSION')
    if not name and source:
        name, version = package_from_source(source)
    kind = target or 'host'
    if kind == HOST_TARGET:
        kind = 'host'
    types = '+'.join(crate_types) or 'unknown'
    return {
        'type': 'rustc', 'package': name, 'version': version, 'crate': crate_name,
        'crate_types': types, 'kind': kind, 'features': sorted(features), 'cfgs': sorted(cfgs),
        'externs': sorted(externs), 'flags': flags, 'source': source,
        'primary': env.get('CARGO_PRIMARY_PACKAGE') == '1',
        'key': f'{name} {version} {crate_name} [{types}] {kind}',
    }


def compile_inventory(text, repo_root=None):
    units, runs, errors, other = {}, {}, [], 0
    for command in iter_running_commands(text):
        if 'error' in command:
            errors.append(command)
            continue
        item = classify_command(command, repo_root)
        if item is None:
            other += 1
            continue
        bucket = units if item['type'] == 'rustc' else runs
        key = item['key']
        suffix = 2
        while key in bucket:
            key = f"{item['key']} #{suffix}"
            suffix += 1
        bucket[key] = item
    return {'units': units, 'build_script_runs': runs, 'parse_errors': errors, 'other_commands': other}


def inventory_counts(inventory):
    counts = collections.Counter()
    for unit in inventory['units'].values():
        counts[f"rustc:{unit['kind']}"] += 1
    for run in inventory['build_script_runs'].values():
        counts[f"build-script-run:{run['kind']}"] += 1
    counts['rustc:total'] = len(inventory['units'])
    counts['build-script-run:total'] = len(inventory['build_script_runs'])
    return dict(sorted(counts.items()))


def compare_inventories(base, exp):
    bu, eu = base['units'], exp['units']
    br, er = base['build_script_runs'], exp['build_script_runs']
    common = sorted(set(bu) & set(eu))
    feature_changes, flag_changes, extern_changes = [], [], []
    for key in common:
        if bu[key]['features'] != eu[key]['features']:
            feature_changes.append({'unit': key, 'baseline': bu[key]['features'], 'experiment': eu[key]['features']})
        if bu[key]['flags'] != eu[key]['flags'] or bu[key]['cfgs'] != eu[key]['cfgs']:
            flag_changes.append({'unit': key,
                                 'only_baseline': sorted(set(bu[key]['flags'] + bu[key]['cfgs']) - set(eu[key]['flags'] + eu[key]['cfgs'])),
                                 'only_experiment': sorted(set(eu[key]['flags'] + eu[key]['cfgs']) - set(bu[key]['flags'] + bu[key]['cfgs']))})
        if bu[key]['externs'] != eu[key]['externs']:
            extern_changes.append({'unit': key,
                                   'removed': sorted(set(bu[key]['externs']) - set(eu[key]['externs'])),
                                   'added': sorted(set(eu[key]['externs']) - set(bu[key]['externs']))})
    return {
        'counts': {'baseline': inventory_counts(base), 'experiment': inventory_counts(exp)},
        'units_only_baseline': sorted(set(bu) - set(eu)),
        'units_only_experiment': sorted(set(eu) - set(bu)),
        'build_script_runs_only_baseline': sorted(set(br) - set(er)),
        'build_script_runs_only_experiment': sorted(set(er) - set(br)),
        'feature_changes': feature_changes,
        'flag_changes': flag_changes,
        'extern_changes': extern_changes,
        'parse_errors': {'baseline': len(base['parse_errors']), 'experiment': len(exp['parse_errors'])},
    }


def macro_units(inventory):
    """Compile units/build-script runs for the three macro packages, by kind."""
    found = collections.defaultdict(list)
    for unit in inventory['units'].values():
        if unit['package'] in MACRO_CRATES:
            found[unit['package']].append(f"{unit['version']} [{unit['crate_types']}] {unit['kind']}")
    return {name: sorted(found.get(name, [])) for name in MACRO_CRATES}


# -------------------------------------------------- cargo --message-format=json

def parse_package_id(package_id):
    if ' (' in package_id and package_id.endswith(')'):
        name, version = package_id.split(' ')[:2]
        return name, version
    url, _, fragment = package_id.partition('#')
    if '@' in fragment:
        name, _, version = fragment.rpartition('@')
        return name, version
    name = url.rstrip('/').rsplit('/', 1)[-1]
    return name, fragment


def artifact_inventory(text):
    units = collections.Counter()
    features = {}
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith('{'):
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        reason = message.get('reason')
        if reason == 'compiler-artifact':
            name, version = parse_package_id(message.get('package_id', ''))
            target = message.get('target') or {}
            files = message.get('filenames') or []
            kind = WASM_TARGET if any(f'/{WASM_TARGET}/' in f for f in files) else 'host'
            profile = message.get('profile') or {}
            key = (f"{name} {version} {str(target.get('name', '')).replace('-', '_')} "
                   f"[{'+'.join(target.get('crate_types') or [])}] {kind} "
                   f"opt={profile.get('opt_level')} debug={profile.get('debuginfo')} test={profile.get('test')}")
            units[key] += 1
            features[key] = sorted(message.get('features') or [])
        elif reason == 'build-script-executed':
            name, version = parse_package_id(message.get('package_id', ''))
            out_dir = message.get('out_dir') or ''
            kind = WASM_TARGET if f'/{WASM_TARGET}/' in out_dir else 'host'
            units[f'{name} {version} build-script-run {kind}'] += 1
    return {'units': dict(sorted(units.items())), 'features': features}


def compare_artifact_inventories(base_text, exp_text):
    base, exp = artifact_inventory(base_text), artifact_inventory(exp_text)
    bset, eset = set(base['units']), set(exp['units'])
    changed = [key for key in sorted(bset & eset) if base['features'].get(key) != exp['features'].get(key)]
    return {
        'count': [sum(base['units'].values()), sum(exp['units'].values())],
        'only_baseline': sorted(bset - eset),
        'only_experiment': sorted(eset - bset),
        'only_counts': [sum(base['units'][k] for k in bset - eset), sum(exp['units'][k] for k in eset - bset)],
        'multiplicity_changes': [f"{k} x{base['units'][k]}->x{exp['units'][k]}" for k in sorted(bset & eset)
                                 if base['units'][k] != exp['units'][k]],
        'feature_changes': changed,
    }


# ----------------------------------------------------------------------- WASM

def read_uleb(data, offset):
    result = shift = 0
    while True:
        if offset >= len(data):
            raise ValueError('truncated LEB128')
        byte = data[offset]
        offset += 1
        result |= (byte & 0x7F) << shift
        if byte < 0x80:
            return result, offset
        shift += 7
        if shift > 63:
            raise ValueError('oversized LEB128')


def read_sleb(data, offset):
    result = shift = 0
    while True:
        if offset >= len(data):
            raise ValueError('truncated LEB128')
        byte = data[offset]
        offset += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if byte < 0x80:
            if byte & 0x40:
                result -= 1 << shift
            return result, offset
        if shift > 70:
            raise ValueError('oversized LEB128')


def read_name(data, offset):
    size, offset = read_uleb(data, offset)
    end = offset + size
    if end > len(data):
        raise ValueError('truncated name')
    return data[offset:end].decode('utf-8', errors='replace'), end


def read_limits(data, offset):
    flags, offset = read_uleb(data, offset)
    minimum, offset = read_uleb(data, offset)
    maximum = None
    if flags & 1:
        maximum, offset = read_uleb(data, offset)
    return (minimum, maximum), offset


def parse_imports(payload):
    count, cursor = read_uleb(payload, 0)
    imports = []
    for _ in range(count):
        module, cursor = read_name(payload, cursor)
        field, cursor = read_name(payload, cursor)
        kind = payload[cursor]
        cursor += 1
        if kind == 0:
            _, cursor = read_uleb(payload, cursor)
        elif kind == 1:
            cursor += 1
            _, cursor = read_limits(payload, cursor)
        elif kind == 2:
            _, cursor = read_limits(payload, cursor)
        elif kind == 3:
            cursor += 2
        elif kind == 4:
            cursor += 1
            _, cursor = read_uleb(payload, cursor)
        else:
            raise ValueError(f'unknown import kind {kind}')
        imports.append({'module': module, 'name': field, 'kind': kind})
    return imports


def parse_exports(payload):
    count, cursor = read_uleb(payload, 0)
    exports = []
    for _ in range(count):
        name, cursor = read_name(payload, cursor)
        kind = payload[cursor]
        index, cursor = read_uleb(payload, cursor + 1)
        exports.append({'name': name, 'kind': kind, 'index': index})
    return exports


def parse_code(payload):
    count, cursor = read_uleb(payload, 0)
    bodies = []
    for _ in range(count):
        size, cursor = read_uleb(payload, cursor)
        body = payload[cursor:cursor + size]
        if len(body) != size:
            raise ValueError('truncated function body')
        bodies.append({'size': size, 'sha256': sha256_bytes(body)})
        cursor += size
    return bodies


def read_const_expr(payload, cursor):
    opcode = payload[cursor]
    cursor += 1
    value = None
    if opcode in (0x41, 0x42):
        value, cursor = read_sleb(payload, cursor)
    elif opcode == 0x23:
        value, cursor = read_uleb(payload, cursor)
        value = f'global.get {value}'
    else:
        raise ValueError(f'unsupported constant expression opcode {opcode:#x}')
    if payload[cursor] != 0x0B:
        raise ValueError('unterminated constant expression')
    return value, cursor + 1


def parse_data(payload):
    count, cursor = read_uleb(payload, 0)
    segments = []
    for _ in range(count):
        flags, cursor = read_uleb(payload, cursor)
        offset = None
        if flags == 2:
            _, cursor = read_uleb(payload, cursor)
        if flags in (0, 2):
            offset, cursor = read_const_expr(payload, cursor)
        size, cursor = read_uleb(payload, cursor)
        data = payload[cursor:cursor + size]
        if len(data) != size:
            raise ValueError('truncated data segment')
        cursor += size
        segments.append({'flags': flags, 'offset': offset, 'size': size, 'sha256': sha256_bytes(data)})
    return segments


def parse_name_section(payload):
    names = []
    cursor = 0
    while cursor < len(payload):
        subsection = payload[cursor]
        size, start = read_uleb(payload, cursor + 1)
        end = start + size
        if subsection == 1:
            count, inner = read_uleb(payload, start)
            for _ in range(count):
                index, inner = read_uleb(payload, inner)
                name, inner = read_name(payload, inner)
                names.append([index, name])
        cursor = end
    return names


def parse_wasm(blob):
    if blob[:8] != b'\0asm\x01\0\0\0':
        raise ValueError('not a WebAssembly 1 module')
    report = {'sha256': sha256_bytes(blob), 'size': len(blob), 'sections': [], 'function_names': [],
              'code_bodies': [], 'data_segments': [], 'imports': [], 'exports': [],
              'function_import_count': 0}
    offset = 8
    while offset < len(blob):
        section_id = blob[offset]
        size, start = read_uleb(blob, offset + 1)
        end = start + size
        if end > len(blob):
            raise ValueError('truncated section')
        payload = blob[start:end]
        entry = {'index': len(report['sections']), 'id': section_id,
                 'name': SECTION_NAMES.get(section_id, f'unknown-{section_id}'),
                 'offset': offset, 'size': size, 'sha256': sha256_bytes(payload)}
        if section_id == 0:
            custom, cursor = read_name(payload, 0)
            entry['name'] = f'custom:{custom}'
            if custom == 'name':
                report['function_names'] = parse_name_section(payload[cursor:])
        elif section_id == 2:
            report['imports'] = parse_imports(payload)
            report['function_import_count'] = sum(1 for item in report['imports'] if item['kind'] == 0)
        elif section_id == 7:
            report['exports'] = parse_exports(payload)
        elif section_id == 10:
            report['code_bodies'] = parse_code(payload)
        elif section_id == 11:
            report['data_segments'] = parse_data(payload)
        report['sections'].append(entry)
        offset = end
    return report


def strip_symbol_hashes(text):
    return SYMBOL_HASH.sub(lambda m: '::h<hash>' if m.group(1).startswith('::') else '17h<hash>E', text)


def keyed_sections(report):
    seen = collections.Counter()
    keyed = {}
    for section in report['sections']:
        seen[section['name']] += 1
        keyed[f"{section['name']}#{seen[section['name']]}"] = section
    return keyed


def compare_wasm(base, exp):
    result = {
        'identical': base['sha256'] == exp['sha256'],
        'sha256': [base['sha256'], exp['sha256']],
        'size': [base['size'], exp['size']],
        'section_layout': [[s['name'] for s in base['sections']], [s['name'] for s in exp['sections']]],
    }
    result['section_layout_identical'] = result['section_layout'][0] == result['section_layout'][1]
    bs, es = keyed_sections(base), keyed_sections(exp)
    rows = []
    for key in list(bs) + [k for k in es if k not in bs]:
        b, e = bs.get(key), es.get(key)
        rows.append({'section': key, 'baseline_size': b and b['size'], 'experiment_size': e and e['size'],
                     'identical': bool(b and e and b['sha256'] == e['sha256'])})
    result['sections'] = rows
    result['differing_sections'] = [row['section'] for row in rows if not row['identical']]
    names_b, names_e = dict(base['function_names']), dict(exp['function_names'])
    raw = [i for i in sorted(set(names_b) & set(names_e)) if names_b[i] != names_e[i]]
    normalized = [i for i in raw if strip_symbol_hashes(names_b[i]) != strip_symbol_hashes(names_e[i])]
    result['function_names'] = {
        'count': [len(names_b), len(names_e)],
        'index_sets_identical': set(names_b) == set(names_e),
        'differing_raw': len(raw),
        'differing_after_hash_normalization': len(normalized),
        'examples_hash_only': [[names_b[i], names_e[i]] for i in raw if i not in normalized][:3],
        'examples_other': [[names_b[i], names_e[i]] for i in normalized][:5],
    }
    cb = [body['sha256'] for body in base['code_bodies']]
    ce = [body['sha256'] for body in exp['code_bodies']]
    offset = base['function_import_count']
    differing = [i for i, (x, y) in enumerate(zip(cb, ce)) if x != y]
    result['code'] = {
        'count': [len(cb), len(ce)],
        'identical_in_order': cb == ce,
        'same_position_count': len(cb) - len(differing) if len(cb) == len(ce) else None,
        'multiset_identical': collections.Counter(cb) == collections.Counter(ce),
        'differing_functions': [strip_symbol_hashes(names_b.get(i + offset, f'func[{i + offset}]'))
                                for i in differing][:15],
        'differing_count': len(differing),
    }
    sequence_b = [strip_symbol_hashes(names_b.get(i + offset, f'func[{i + offset}]')) for i in range(len(cb))]
    sequence_e = [strip_symbol_hashes(names_e.get(i + offset, f'func[{i + offset}]')) for i in range(len(ce))]
    result['code']['differing_positions'] = [
        {'index': i + offset, 'baseline': sequence_b[i], 'experiment': sequence_e[i],
         'sizes': [base['code_bodies'][i]['size'], exp['code_bodies'][i]['size']],
         'experiment_body_found_in_baseline': ce[i] in set(cb)} for i in differing][:20]

    def keyed(sequence, bodies):
        out = {}
        for name, body in zip(sequence, bodies):
            key, n = name, 2
            while key in out:
                key, n = f'{name} #{n}', n + 1
            out[key] = body
        return out

    kb, ke = keyed(sequence_b, base['code_bodies']), keyed(sequence_e, exp['code_bodies'])
    by_name = [k for k in sorted(set(kb) & set(ke)) if kb[k]['sha256'] != ke[k]['sha256']]
    result['code']['by_name'] = {
        'order_identical': sequence_b == sequence_e,
        'positions_with_other_function': sum(1 for x, y in zip(sequence_b, sequence_e) if x != y),
        'only_baseline': sorted(set(kb) - set(ke))[:10],
        'only_experiment': sorted(set(ke) - set(kb))[:10],
        'differing_count': len(by_name),
        'differing': [{'function': k, 'sizes': [kb[k]['size'], ke[k]['size']]} for k in by_name][:20],
    }
    result['data_segments_identical'] = base['data_segments'] == exp['data_segments']
    result['imports_identical'] = base['imports'] == exp['imports']
    result['exports_identical'] = base['exports'] == exp['exports']
    return result


def wat_blocks(text):
    """Split wasm2wat output into top-level blocks keyed by normalized function name."""
    blocks, order, current = {}, [], None
    for line in strip_symbol_hashes(text).splitlines():
        if line.startswith('  (') and not line.startswith('   '):
            match = re.match(r'  \(func (\$\S+|\(;\d+;\))', line)
            name = f'func {match.group(1)}' if match else line.strip()[:100]
            key, n = name, 2
            while key in blocks:
                key, n = f'{name} #{n}', n + 1
            blocks[key], current = [line], key
            order.append(key)
        elif current is not None:
            blocks[current].append(line)
    return blocks, order


def compare_wat_blocks(base_text, exp_text):
    if not base_text or not exp_text:
        return {'available': False}
    bb, bo = wat_blocks(base_text)
    eb, eo = wat_blocks(exp_text)
    common = [k for k in bo if k in eb]
    differing = [k for k in common if bb[k] != eb[k]]
    details = []
    for key in differing[:10]:
        diff = [d[:220] for d in difflib.unified_diff(bb[key], eb[key], lineterm='', n=0)
                if not d.startswith(('---', '+++', '@@'))]
        details.append({'block': key[:160], 'lines': [len(bb[key]), len(eb[key])], 'diff': diff[:10]})
    return {
        'available': True,
        'blocks': [len(bb), len(eb)],
        'order_identical': common == [k for k in eo if k in bb],
        'only_baseline': [k[:160] for k in bo if k not in eb][:10],
        'only_experiment': [k[:160] for k in eo if k not in bb][:10],
        'differing_count': len(differing),
        'details': details,
    }


def compare_wat(base_text, exp_text):
    if not base_text or not exp_text:
        return {'available': False}
    raw_identical = base_text == exp_text
    nb = strip_symbol_hashes(base_text).splitlines()
    ne = strip_symbol_hashes(exp_text).splitlines()
    cb, ce = collections.Counter(nb), collections.Counter(ne)
    only_b, only_e = cb - ce, ce - cb
    first = next((i for i, (x, y) in enumerate(zip(nb, ne)) if x != y), None)
    if first is None and len(nb) != len(ne):
        first = min(len(nb), len(ne))
    return {
        'available': True,
        'raw_identical': raw_identical,
        'normalized_identical': nb == ne,
        'lines': [len(nb), len(ne)],
        'lines_only_baseline': sum(only_b.values()),
        'lines_only_experiment': sum(only_e.values()),
        'first_difference_line': None if first is None else first + 1,
        'examples': [[x[:160] for x in list(only_b)[:3]], [x[:160] for x in list(only_e)[:3]]],
    }


# ----------------------------------------------------------- manifest/metadata

def manifest_move(base_text, exp_text):
    base, exp = tomllib.loads(base_text), tomllib.loads(exp_text)

    def without_macros(data):
        copy = json.loads(json.dumps(data))
        for section in ('dependencies', 'dev-dependencies'):
            for crate in MACRO_CRATES:
                copy.get(section, {}).pop(crate, None)
        return copy

    rows = {}
    for crate in MACRO_CRATES:
        rows[crate] = {
            side: {section: data.get(section, {}).get(crate) for section in ('dependencies', 'dev-dependencies')}
            for side, data in (('baseline', base), ('experiment', exp))
        }
    moved = all(
        rows[c]['baseline'] == {'dependencies': MACRO_REQ, 'dev-dependencies': None}
        and rows[c]['experiment'] == {'dependencies': None, 'dev-dependencies': MACRO_REQ}
        for c in MACRO_CRATES)
    unchanged = all(rows[c]['baseline'] == rows[c]['experiment'] for c in MACRO_CRATES)
    return {
        'entries': rows,
        'moved_exactly': moved,
        'macro_entries_unchanged': unchanged,
        'other_content_identical': without_macros(base) == without_macros(exp),
        'identical': base == exp,
    }


def metadata_view(text):
    meta = json.loads(text)
    packages = {pkg['id']: pkg for pkg in meta['packages']}
    root = meta['resolve']['root']
    node = next(item for item in meta['resolve']['nodes'] if item['id'] == root)
    direct = {}
    for dep in node['deps']:
        pkg = packages[dep['pkg']]
        kinds = sorted(f"{k.get('kind') or 'normal'}{'@' + k['target'] if k.get('target') else ''}"
                       for k in dep['dep_kinds'])
        direct[pkg['name']] = {'version': pkg['version'], 'kinds': kinds}
    declared = sorted(
        f"{d['name']} {d['req']} {d.get('kind') or 'normal'} default={d.get('uses_default_features')} "
        f"features={','.join(d.get('features') or []) or '-'}"
        for d in packages[root]['dependencies'])
    versions = {name: sorted(p['version'] for p in meta['packages'] if p['name'] == name)
                for name in MACRO_CRATES + ('alloy-sol-types', 'syn-solidity')}
    return {'root': packages[root]['name'], 'direct': direct, 'declared': declared,
            'versions': versions, 'package_count': len(meta['packages'])}


# ----------------------------------------------------------------- cargo tree

def tree_package_set(text):
    return sorted({line.strip().removesuffix(' (*)').strip() for line in text.splitlines() if line.strip()})


def tree_parents(text):
    """Depth-1 entries of an inverted tree (direct dependents), with dev headers."""
    parents = []
    for line in text.splitlines():
        match = re.match(r'^[├└]── (.*)$', line)
        if match:
            parents.append(re.sub(r' \(/[^)]*\)', '', match.group(1)).removesuffix(' (*)'))
        elif line.strip().startswith('[') and not line.startswith(' '):
            parents.append(line.strip())
    return parents


def text_diff_summary(base, exp):
    if base == exp:
        return {'identical': True}
    bl, el = base.splitlines(), exp.splitlines()
    cb, ce = collections.Counter(bl), collections.Counter(el)
    return {
        'identical': False,
        'lines': [len(bl), len(el)],
        'only_baseline': [x.strip()[:140] for x in (cb - ce)][:8],
        'only_experiment': [x.strip()[:140] for x in (ce - cb)][:8],
    }


# ---------------------------------------------------------------- comparison

def side_paths(evidence):
    return {side: Path(evidence) / side for side in SIDES}


def command_status(side_dir):
    """Required commands must exist and succeed; so must every other recorded
    command except explicitly optional tooling."""
    status = {name: exit_code(side_dir, name) for name in REQUIRED_COMMANDS}
    for path in sorted(Path(side_dir).glob('*.exit')):
        if not path.stem.startswith('optional-'):
            status.setdefault(path.stem, exit_code(side_dir, path.stem))
    failures = {name: code for name, code in status.items() if code != 0}
    return status, failures


def wasm_hashes(side_dir):
    dep = side_dir / 'dependency-evidence'
    return {
        'verbose_build': first_field(dep / 'wasm-before-ci-command.sha256'),
        'exact_ci_build': first_field(dep / 'wasm.sha256'),
        'json_inventory_noop_build': first_field(side_dir / 'wasm-after-json-inventory.sha256'),
        'cold_rebuild': first_field(side_dir / 'wasm-cold-rebuild.sha256'),
        'size': read_text(dep / 'wasm.size').strip(),
    }


def pass_lines(text, limit=12):
    return [line.strip()[:200] for line in text.splitlines()
            if line.strip().startswith(('PASS', 'Verified', 'ABI is reproducible', 'test result:',
                                        'Result:', 'Local entrypoint', 'WASM bytes'))][:limit]


def check(report, name, ok, detail=''):
    report['checks'][name] = {'ok': bool(ok), 'detail': detail}


def section_scope_and_commands(report, ctx):
    expected = [] if ctx['mode'] == 'control' else [WRAPPER_MANIFEST]
    check(report, 'rust_diff_scope', ctx['rust_changed'] == expected, f"rust changes: {ctx['rust_changed']}")
    statuses = {}
    for side, path in ctx['sides'].items():
        status, failures = command_status(path)
        statuses[side] = status
        check(report, f'{side}_commands', not failures, f'failures: {failures or "none"}')
    report['command_status'] = statuses


def section_manifest_and_lockfiles(report, ctx):
    sides = ctx['sides']
    try:
        move = manifest_move(read_text(sides['baseline'] / 'Cargo.toml.snapshot'),
                             read_text(sides['experiment'] / 'Cargo.toml.snapshot'))
    except (tomllib.TOMLDecodeError, ValueError) as exc:
        move = {'error': str(exc)}
    report['manifest'] = move
    if ctx['mode'] == 'control':
        check(report, 'manifest', move.get('identical'), 'manifests identical in control run')
    else:
        check(report, 'manifest', move.get('moved_exactly') and move.get('other_content_identical'),
              'three =1.5.7 entries moved to [dev-dependencies]; all other manifest content identical')
    locks = {side: read_text(path / 'lockfiles.sha256').strip() for side, path in sides.items()}
    report['lockfiles'] = locks
    check(report, 'lockfiles_identical', locks['baseline'] and locks['baseline'] == locks['experiment'],
          'sha256 of all three Cargo.lock files identical between sides')


def section_metadata(report, ctx):
    metadata = {}
    for side, path in ctx['sides'].items():
        try:
            metadata[side] = metadata_view(read_text(path / 'dependency-evidence' / 'stylus-wrapper-metadata-all.json'))
        except (ValueError, KeyError, StopIteration) as exc:
            metadata[side] = {'error': str(exc)}
    report['metadata'] = metadata
    versions_ok = all(metadata[s]['versions'][c] == [MACRO_VERSION] for s in SIDES for c in MACRO_CRATES)
    kinds = {s: {c: metadata[s]['direct'].get(c, {}).get('kinds') for c in MACRO_CRATES} for s in SIDES}
    others = {s: {k: v for k, v in metadata[s]['direct'].items() if k not in MACRO_CRATES} for s in SIDES}
    if ctx['mode'] == 'control':
        kinds_ok = kinds['baseline'] == kinds['experiment']
    else:
        kinds_ok = (all(kinds['baseline'][c] == ['normal'] for c in MACRO_CRATES)
                    and all(kinds['experiment'][c] == ['dev'] for c in MACRO_CRATES))
    report['direct_kinds'] = kinds
    check(report, 'resolved_macro_versions', versions_ok, 'alloy-sol-macro family resolves only to 1.5.7 on both sides')
    check(report, 'direct_dependency_kinds', kinds_ok and others['baseline'] == others['experiment'],
          f'macro kinds {kinds}; other direct dependencies identical: {others["baseline"] == others["experiment"]}')


def section_trees(report, ctx):
    sides = ctx['sides']
    trees = {}
    for target in (HOST_TARGET, WASM_TARGET):
        for label in ('normal-build', 'normal-build-dev', 'features'):
            name = f'stylus-wrapper-{target}-{label}.txt'
            trees[name] = text_diff_summary(read_text(sides['baseline'] / 'dependency-evidence' / name),
                                            read_text(sides['experiment'] / 'dependency-evidence' / name))
        name = f'stylus-wrapper-{target}-package-list.txt'
        bset = tree_package_set(read_text(sides['baseline'] / 'dependency-evidence' / name))
        eset = tree_package_set(read_text(sides['experiment'] / 'dependency-evidence' / name))
        trees[name] = {'identical_set': bset == eset, 'count': [len(bset), len(eset)],
                       'only_baseline': sorted(set(bset) - set(eset)), 'only_experiment': sorted(set(eset) - set(bset))}
    report['trees'] = trees
    inverse = {}
    for crate in MACRO_CRATES:
        for target in (HOST_TARGET, WASM_TARGET):
            for label in ('normal-build', 'normal-build-dev'):
                name = f'tree-inverse-{crate}-{target}-{label}'
                inverse[name] = {side: tree_parents(read_text(path / f'{name}.stdout')) for side, path in sides.items()}
    report['inverse_parents'] = inverse
    direct_trees = {}
    for target in (HOST_TARGET, WASM_TARGET):
        for label in ('normal-build', 'dev'):
            name = f'tree-direct-{target}-{label}'
            direct_trees[name] = {side: [l.strip() for l in read_text(path / f'{name}.stdout').splitlines()[1:] if l.strip()]
                                  for side, path in sides.items()}
    report['direct_trees'] = direct_trees
    if ctx['mode'] == 'control':
        identical = all(v.get('identical', v.get('identical_set')) for v in trees.values()) and all(
            v['baseline'] == v['experiment'] for v in inverse.values())
        check(report, 'cargo_graphs_control', identical, 'identical manifests must give identical Cargo graphs')


def section_compiler(report, ctx):
    sides = ctx['sides']
    inventories = {side: compile_inventory(read_text(path / 'dependency-evidence' / 'build.verbose.stderr'), ctx['repo_root'])
                   for side, path in sides.items()}
    invocation = compare_inventories(inventories['baseline'], inventories['experiment'])
    invocation['macro_units'] = {side: macro_units(inv) for side, inv in inventories.items()}

    def root_units(inv):
        return [u for u in inv['units'].values() if u['primary'] and u['kind'] == WASM_TARGET]

    invocation['root_units'] = {side: [{'key': u['key'], 'externs': u['externs'], 'features': u['features']}
                                       for u in root_units(inv)] for side, inv in inventories.items()}
    report.setdefault('compiler_invocations', {}).update(invocation)
    parsed_ok = all(inventories[s]['units'] and not inventories[s]['parse_errors'] for s in SIDES)
    check(report, 'compiler_logs_parsed', parsed_ok,
          f"rustc units {[len(inventories[s]['units']) for s in SIDES]}; parse errors {invocation['parse_errors']}")
    if ctx['mode'] == 'control':
        check(report, 'compiler_invocations_control',
              not (invocation['units_only_baseline'] or invocation['units_only_experiment']
                   or invocation['build_script_runs_only_baseline'] or invocation['build_script_runs_only_experiment']
                   or invocation['feature_changes'] or invocation['flag_changes'] or invocation['extern_changes']),
              'identical sources must give identical normalized compiler invocations')


def section_json_inventories(report, ctx):
    sides = ctx['sides']
    invocation = report.setdefault('compiler_invocations', {})
    for key, name in (('json_inventory', 'wasm-artifacts-json'), ('test_json_inventory', 'test-artifacts-json'),
                      ('export_abi_json_inventory', 'export-abi-artifacts-json')):
        invocation[key] = compare_artifact_inventories(read_text(sides['baseline'] / f'{name}.stdout'),
                                                       read_text(sides['experiment'] / f'{name}.stdout'))
    if ctx['mode'] == 'control':
        check(report, 'json_inventories_control', all(
            not (invocation[k]['only_baseline'] or invocation[k]['only_experiment'] or invocation[k]['feature_changes'])
            for k in ('json_inventory', 'test_json_inventory', 'export_abi_json_inventory')),
            'identical sources must give identical Cargo JSON unit inventories')


def section_wasm(report, ctx):
    sides = ctx['sides']
    hashes = {side: wasm_hashes(path) for side, path in sides.items()}
    report['wasm_hashes'] = hashes
    for side in SIDES:
        values = {k: v for k, v in hashes[side].items() if k != 'size'}
        check(report, f'{side}_wasm_deterministic', None not in values.values() and len(set(values.values())) == 1,
              f'{values}')
    sections = {side: read_json(path / 'wasm-sections.json') for side, path in sides.items()}
    if all(sections.values()):
        report['wasm'] = compare_wasm(sections['baseline'], sections['experiment'])
    else:
        report['wasm'] = {'error': 'missing wasm-sections.json'}
    wat_b, wat_e = read_text(sides['baseline'] / 'release.wat'), read_text(sides['experiment'] / 'release.wat')
    report['wat'] = compare_wat(wat_b, wat_e)
    report['wat_blocks'] = compare_wat_blocks(wat_b, wat_e)
    if ctx['mode'] == 'control':
        check(report, 'wasm_identical_control', report['wasm'].get('identical'), 'identical sources must give identical WASM')


def section_abi_selector_tests(report, ctx):
    sides = ctx['sides']
    abi = {side: read_text(path / 'sdk-abi.sol') for side, path in sides.items()}
    report['abi'] = {
        'sha256': {side: sha256_bytes(text.encode()) if text else None for side, text in abi.items()},
        'identical': bool(abi['baseline']) and abi['baseline'] == abi['experiment'],
        'check_abi': {side: pass_lines(read_text(path / 'check-abi.stdout')) for side, path in sides.items()},
    }
    check(report, 'abi_identical', report['abi']['identical'], 'SDK export-abi output byte-identical between sides')
    report['selector'] = {side: pass_lines(read_text(path / 'selector-check.stdout')) for side, path in sides.items()}
    check(report, 'selector', all(exit_code(path, 'selector-check') == 0 and exit_code(path, 'abi-tools-check') == 0
                                  and exit_code(path, 'abi-tools-test') == 0 and exit_code(path, 'test') == 0
                                  and EXPECTED_SELECTOR in read_text(path / 'selector-check.stdout')
                                  for path in sides.values()),
          f'{EXPECTED_SELECTOR}: SDK declaration + keccak, solc, ethers, native tests and WASM dispatch')
    report['offline_tests'] = {
        side: {name: pass_lines(read_text(path / f'{name}.stdout'), 20)
               for name in ('wasm-inspect', 'wasm-entrypoint-tests', 'wasm-client-abi-tests', 'test',
                            'advisory-guard-baseline', 'abi-tools-check')}
        for side, path in sides.items()}


SECTIONS = (
    ('scope_and_commands', section_scope_and_commands),
    ('manifest_and_lockfiles', section_manifest_and_lockfiles),
    ('metadata', section_metadata),
    ('trees', section_trees),
    ('compiler_invocations', section_compiler),
    ('json_inventories', section_json_inventories),
    ('wasm', section_wasm),
    ('abi_selector_tests', section_abi_selector_tests),
)


def compare(evidence):
    """Run every analysis section; a crash becomes a failed check carrying its
    traceback, so one defect cannot hide the remaining evidence."""
    evidence = Path(evidence)
    design = read_json(evidence / 'design.json', {}) or {}
    rust_changed = design.get('rust_changed_files')
    ctx = {'sides': side_paths(evidence), 'repo_root': design.get('repo_root'), 'rust_changed': rust_changed,
           'mode': 'control' if rust_changed == [] else 'experiment'}
    report = {'mode': ctx['mode'], 'design': design, 'checks': {}}
    for name, section in SECTIONS:
        try:
            section(report, ctx)
        except Exception:  # noqa: BLE001 - reported as a failed check, never a pass
            check(report, f'analysis_{name}', False, 'analysis crashed: ' + traceback.format_exc(limit=8)[-2500:])
    report['ok'] = all(item['ok'] for item in report['checks'].values())
    return report


# ------------------------------------------------------------------ rendering

def short(items, limit=12):
    items = list(items)
    if not items:
        return 'none'
    text = '; '.join(str(x) for x in items[:limit])
    return text + (f'; ... (+{len(items) - limit} more)' if len(items) > limit else '')


def render_notices(report):
    """Four groups of at most ten annotations (the per-step budget). Each notice
    is built independently; a rendering defect yields an error annotation."""
    groups = [[], [], [], []]

    def add(group, title, build, level='notice'):
        try:
            groups[group].append(notice(title, build(), level))
        except Exception:  # noqa: BLE001
            groups[group].append(notice(title, 'rendering failed: ' + traceback.format_exc(limit=4)[-1500:], 'error'))

    d = report.get('design', {})
    checks = report.get('checks', {})
    status = report.get('command_status', {})
    add(0, 'Experiment design', lambda: (
        f"mode={report['mode']}; baseline={d.get('base_sha')}; experiment={d.get('head_sha')}; "
        f"base is ancestor={d.get('base_is_ancestor')}; rust/ changes={d.get('rust_changed_files')}; "
        f"all changed files={short(d.get('all_changed_files', []), 20)}"))
    add(0, 'Manifest', lambda: (
        f"identical={report['manifest'].get('identical')}; moved_exactly={report['manifest'].get('moved_exactly')}; "
        f"other content identical={report['manifest'].get('other_content_identical')}; "
        f"entries={json.dumps(report['manifest'].get('entries'), sort_keys=True)}"))
    add(0, 'Lockfiles', lambda: (
        f"identical={checks.get('lockfiles_identical', {}).get('ok')}; unchanged after all builds: "
        f"baseline exit={status['baseline'].get('lockfiles-unchanged')}, "
        f"experiment exit={status['experiment'].get('lockfiles-unchanged')}; "
        f"baseline={report['lockfiles']['baseline'].replace(chr(10), ' | ')}"))
    add(0, 'Cargo metadata', lambda: (
        f"direct macro dependency kinds={json.dumps(report.get('direct_kinds'), sort_keys=True)}; "
        f"resolved versions baseline={json.dumps(report['metadata']['baseline'].get('versions'), sort_keys=True)}; "
        f"experiment={json.dumps(report['metadata']['experiment'].get('versions'), sort_keys=True)}; "
        f"package counts={[report['metadata'][s].get('package_count') for s in SIDES]}"))
    failed = [name for name, item in checks.items() if not item['ok']]
    crashed = '; '.join(f"{name}: {checks[name]['detail'][-700:]}" for name in failed if name.startswith('analysis_'))
    add(0, 'Verification checks', lambda: (
        f"overall={'PASS' if report.get('ok') else 'FAIL'}; failed={failed or 'none'}; "
        + '; '.join(f"{name}={'ok' if item['ok'] else 'FAIL'}" for name, item in checks.items())
        + (f" | CRASHES: {crashed}" if crashed else '')), 'notice' if report.get('ok') else 'error')

    def package_lists():
        return '; '.join(
            f"{k.replace('stylus-wrapper-', '').replace('-package-list.txt', '')}: identical set={v['identical_set']} "
            f"counts={v['count']} only baseline={short(v['only_baseline'])} only experiment={short(v['only_experiment'])}"
            for k, v in report['trees'].items() if k.endswith('package-list.txt'))

    def other_trees():
        return '; '.join(
            f"{k.replace('stylus-wrapper-', '').replace('.txt', '')}: "
            + ('identical' if v.get('identical') else
               f"differs lines={v.get('lines')} -[{short(v.get('only_baseline', []), 4)}] +[{short(v.get('only_experiment', []), 4)}]")
            for k, v in report['trees'].items() if not k.endswith('package-list.txt'))

    def inverse(target):
        inv = report['inverse_parents']
        return '; '.join(
            f"{crate} {label}: baseline<-[{short(inv[f'tree-inverse-{crate}-{target}-{label}']['baseline'], 6)}] "
            f"experiment<-[{short(inv[f'tree-inverse-{crate}-{target}-{label}']['experiment'], 6)}]"
            for crate in MACRO_CRATES for label in ('normal-build', 'normal-build-dev'))

    add(1, 'Cargo package lists (normal+build)', package_lists)
    add(1, 'Cargo trees', other_trees)
    add(1, f'Inverse macro trees {WASM_TARGET}', lambda: inverse(WASM_TARGET))
    add(1, f'Inverse macro trees {HOST_TARGET}', lambda: inverse(HOST_TARGET))
    add(1, 'Direct dependencies (cargo tree --depth 1)', lambda: '; '.join(
        f"{k.replace('tree-direct-', '')}: baseline=[{short(v['baseline'], 10)}] experiment=[{short(v['experiment'], 10)}]"
        for k, v in report['direct_trees'].items() if 'wasm32' in k or k.endswith('-dev')))

    c = report.get('compiler_invocations', {})
    add(2, 'Compiler invocations: counts', lambda: (
        f"baseline={json.dumps(c['counts']['baseline'], sort_keys=True)}; "
        f"experiment={json.dumps(c['counts']['experiment'], sort_keys=True)}; parse errors={c['parse_errors']}"))
    add(2, 'Compiler invocations: units removed by experiment', lambda: (
        f"{len(c['units_only_baseline'])} rustc units: {short(c['units_only_baseline'], 40)}; "
        f"build-script runs removed: {short(c['build_script_runs_only_baseline'], 20)}"))
    add(2, 'Compiler invocations: units added / changed', lambda: (
        f"added rustc units: {short(c['units_only_experiment'], 20)}; added build-script runs: "
        f"{short(c['build_script_runs_only_experiment'], 10)}; feature changes: "
        f"{short([f['unit'] + ' ' + str(f['baseline']) + '->' + str(f['experiment']) for f in c['feature_changes']], 10)}; "
        f"flag changes: {short([f['unit'] + ' -' + str(f['only_baseline']) + ' +' + str(f['only_experiment']) for f in c['flag_changes']], 6)}; "
        f"extern changes: {short([f['unit'] + ' -' + str(f['removed']) + ' +' + str(f['added']) for f in c['extern_changes']], 6)}"))
    add(2, 'Compiler invocations: macro packages and root', lambda: (
        f"macro units baseline={json.dumps(c['macro_units']['baseline'], sort_keys=True)}; "
        f"experiment={json.dumps(c['macro_units']['experiment'], sort_keys=True)}; "
        f"root wasm32 externs baseline={[u['externs'] for u in c['root_units']['baseline']]}; "
        f"experiment={[u['externs'] for u in c['root_units']['experiment']]}"))
    add(2, 'Other build inventories (Cargo JSON, no-op rebuilds)', lambda: ' | '.join(
        f"{label}: units={c[key]['count']} only-counts={c[key].get('only_counts')} "
        f"multiplicity changes={short(c[key].get('multiplicity_changes', []), 8)} "
        f"only baseline={short(c[key]['only_baseline'], 20)} "
        f"only experiment={short(c[key]['only_experiment'], 20)} feature changes={short(c[key]['feature_changes'], 10)}"
        for label, key in (('release wasm', 'json_inventory'), ('cargo test', 'test_json_inventory'),
                           ('export-abi host build', 'export_abi_json_inventory'))))

    w = report.get('wasm', {})
    add(3, 'Release WASM checksum and size', lambda: (
        f"baseline sha256={report['wasm_hashes']['baseline'].get('exact_ci_build')} "
        f"bytes={report['wasm_hashes']['baseline'].get('size')}; "
        f"experiment sha256={report['wasm_hashes']['experiment'].get('exact_ci_build')} "
        f"bytes={report['wasm_hashes']['experiment'].get('size')}; identical={w.get('identical')}; "
        f"per-side determinism (verbose, exact CI, JSON no-op, cold rebuild): "
        f"baseline={checks.get('baseline_wasm_deterministic', {}).get('ok')} "
        f"experiment={checks.get('experiment_wasm_deterministic', {}).get('ok')}"))
    add(3, 'Release WASM sections', lambda: (
        f"layout identical={w['section_layout_identical']}; differing sections={w['differing_sections'] or 'none'}; "
        + '; '.join(f"{r['section']} {r['baseline_size']}/{r['experiment_size']} {'same' if r['identical'] else 'DIFF'}"
                    for r in w['sections'])))
    add(3, 'Release WASM code and names', lambda: (
        f"code bodies={w['code']['count']} identical in order={w['code']['identical_in_order']} multiset identical="
        f"{w['code']['multiset_identical']} differing={w['code']['differing_count']} "
        f"[{short(w['code']['differing_functions'], 6)}]; data identical={w['data_segments_identical']}; "
        f"imports identical={w['imports_identical']}; exports identical={w['exports_identical']}; "
        f"function names={w['function_names']['count']} differing raw={w['function_names']['differing_raw']} "
        f"after hash normalization={w['function_names']['differing_after_hash_normalization']} "
        f"hash-only examples={short(w['function_names']['examples_hash_only'], 2)}; wasm2wat: "
        + json.dumps({k: report['wat'].get(k) for k in ('available', 'raw_identical', 'normalized_identical', 'lines',
                                                       'lines_only_baseline', 'lines_only_experiment',
                                                       'first_difference_line')})))
    add(3, 'Release WASM attribution (binary functions)', lambda: (
        f"by name: order identical={w['code']['by_name']['order_identical']}; positions holding a different "
        f"function={w['code']['by_name']['positions_with_other_function']}; bodies differing when matched by name="
        f"{w['code']['by_name']['differing_count']} [{short(w['code']['by_name']['differing'], 12)}]; only baseline="
        f"{short(w['code']['by_name']['only_baseline'], 4)}; only experiment={short(w['code']['by_name']['only_experiment'], 4)}; "
        f"names differing beyond hash at same index={short(w['function_names']['examples_other'], 5)}; differing positions="
        f"{short(w['code']['differing_positions'], 12)}"))
    add(3, 'Release WASM attribution (wasm2wat by function, calls by name)', lambda: (
        f"blocks={report['wat_blocks']['blocks']} order identical={report['wat_blocks']['order_identical']} "
        f"only baseline={short(report['wat_blocks']['only_baseline'], 4)} only experiment="
        f"{short(report['wat_blocks']['only_experiment'], 4)} differing blocks={report['wat_blocks']['differing_count']}: "
        + ' || '.join(f"{d['block']} lines={d['lines']} diff={short(d['diff'], 10)}" for d in report['wat_blocks']['details'])
        if report['wat_blocks'].get('available') else 'wasm2wat unavailable'))
    add(3, 'ABI generation and selector', lambda: (
        f"SDK export-abi identical={report['abi']['identical']} sha256={json.dumps(report['abi']['sha256'], sort_keys=True)}; "
        f"check_abi baseline={short(report['abi']['check_abi']['baseline'], 3)}; "
        f"experiment={short(report['abi']['check_abi']['experiment'], 3)}; "
        f"selector baseline={short(report['selector']['baseline'], 6)}; "
        f"experiment={short(report['selector']['experiment'], 6)}"))

    def summarize(side, name, lines):
        results = [re.sub(r'\s+finished in .*$', '', line.replace('test result: ', ''))
                   for line in lines if line.startswith('test result:')]
        detail = f" [{short(results, 6)}]" if results else ''
        return f"{name} exit={status[side].get(name)} pass-lines={sum(1 for l in lines if l.startswith('PASS'))}{detail}"

    add(3, 'Offline WASM and Rust tests', lambda: ' | '.join(
        f"{side}: " + '; '.join(summarize(side, name, lines) for name, lines in report['offline_tests'][side].items())
        + f"; clippy exit={status[side].get('clippy')}; fmt exit={status[side].get('fmt')}"
        for side in SIDES))
    return groups


def render_markdown(report):
    lines = ['# Phase 2B.5.3 macro dependency isolation comparison', '',
             f"Mode: **{report['mode']}**. Overall verification: **{'PASS' if report['ok'] else 'FAIL'}**.", '',
             '| Check | Result | Detail |', '| --- | --- | --- |']
    for name, item in report['checks'].items():
        detail = str(item['detail']).replace('|', '\\|')[:400]
        lines.append(f"| {name} | {'ok' if item['ok'] else 'FAIL'} | {detail} |")
    lines += ['', 'Cargo graphs, compiler logs and WASM bytes are different kinds of evidence; none of them '
              'alone proves runtime reachability or exploitability. No RPC, activation or deployment was run.', '',
              '<details><summary>Full comparison JSON</summary>', '', '```json',
              json.dumps({k: v for k, v in report.items() if k != 'design'}, indent=1, sort_keys=True,
                         default=str)[:60000],
              '```', '', '</details>', '']
    return '\n'.join(lines)


# ------------------------------------------------------------------- RustSec

def rustsec_findings(path):
    data = read_json(path)
    if not isinstance(data, dict):
        return None
    findings = []
    for item in data.get('vulnerabilities', {}).get('list', []):
        findings.append(f"vulnerability {item['advisory']['id']} {item['package']['name']} {item['package']['version']}")
    for category, items in (data.get('warnings') or {}).items():
        for item in items:
            advisory = (item.get('advisory') or {}).get('id', '<no advisory ID>')
            findings.append(f"{category} {advisory} {item['package']['name']} {item['package']['version']}")
    return sorted(findings)


def rustsec_compare(out):
    out = Path(out)
    lines = []
    failed = False
    results = {}
    for side in SIDES:
        results[side] = {}
        for workspace in WORKSPACES:
            code = exit_code(out / side, workspace)
            findings = rustsec_findings(out / side / f'{workspace}.json')
            results[side][workspace] = {'exit': code, 'findings': findings}
            if findings is None:
                failed = True
            elif findings and code == 0:
                failed = True
        lines.append(notice(f'RustSec {side}', '; '.join(
            f"{ws}: exit={r['exit']} findings={len(r['findings']) if r['findings'] is not None else 'INVALID'} "
            f"[{short(r['findings'] or [], 10)}]" for ws, r in results[side].items())))
    identical = all(results['baseline'][ws] == results['experiment'][ws] for ws in WORKSPACES)
    locks = [read_text(out / side / 'lockfiles.sha256').strip() for side in SIDES]
    lines.append(notice('RustSec comparison', (
        f"findings and exit codes identical between baseline and experiment={identical}; "
        f"lockfiles identical={locks[0] == locks[1] and bool(locks[0])}; database={read_text(out / 'advisory-db.commit').strip()} "
        f"({read_text(out / 'advisory-db.date').strip()}); audited={read_text(out / 'audit-date.txt').strip()}; "
        "flags: --no-fetch --deny warnings --json; no ignores; lockfile-wide findings, not WASM linkage claims")))
    (out / 'rustsec-comparison.json').write_text(json.dumps({'results': results, 'identical': identical}, indent=2, sort_keys=True))
    print('\n'.join(lines))
    return 1 if failed or not identical else 0


# ------------------------------------------------------------------- design

def git(*args, check=True):
    return subprocess.run(['git', *args], check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True).stdout


def design(base, head, out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    ancestor = subprocess.run(['git', 'merge-base', '--is-ancestor', base, head]).returncode == 0
    report = {
        'base_sha': git('rev-parse', base).strip(),
        'head_sha': git('rev-parse', head).strip(),
        'repo_root': git('rev-parse', '--show-toplevel').strip(),
        'base_is_ancestor': ancestor,
        'rust_changed_files': [x for x in git('diff', '--name-only', base, head, '--', 'rust/').splitlines() if x],
        'all_changed_files': [x for x in git('diff', '--name-only', base, head).splitlines() if x],
        'commits': [x for x in git('log', '--format=%H %s', f'{base}..{head}').splitlines() if x],
        'lockfile_blobs': {lock: {'baseline': git('rev-parse', f'{base}:{lock}').strip(),
                                  'experiment': git('rev-parse', f'{head}:{lock}').strip()} for lock in LOCKFILES},
    }
    (out / 'rust.diff').write_text(git('diff', base, head, '--', 'rust/'))
    (out / 'design.json').write_text(json.dumps(report, indent=2, sort_keys=True))
    mode = 'control (no rust/ changes)' if not report['rust_changed_files'] else 'experiment'
    print(notice('Experiment design', (
        f"mode={mode}; baseline={report['base_sha']}; experiment={report['head_sha']}; "
        f"base is ancestor={ancestor}; rust/ changes={report['rust_changed_files']}")))
    return 0 if ancestor else 1


# ---------------------------------------------------------------------- main

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('design')
    p.add_argument('base')
    p.add_argument('head')
    p.add_argument('out')
    p = sub.add_parser('wasm-sections')
    p.add_argument('wasm')
    p.add_argument('out')
    p = sub.add_parser('compare')
    p.add_argument('evidence')
    p = sub.add_parser('rustsec-compare')
    p.add_argument('out')
    args = parser.parse_args(argv)
    if args.command == 'design':
        return design(args.base, args.head, args.out)
    if args.command == 'wasm-sections':
        report = parse_wasm(Path(args.wasm).read_bytes())
        Path(args.out).write_text(json.dumps(report, indent=1, sort_keys=True))
        print(f"sha256={report['sha256']} bytes={report['size']} sections="
              + ', '.join(f"{s['name']}:{s['size']}" for s in report['sections']))
        print(f"function names={len(report['function_names'])} code bodies={len(report['code_bodies'])} "
              f"data segments={len(report['data_segments'])}")
        return 0
    if args.command == 'compare':
        evidence = Path(args.evidence)
        notices = evidence / 'notices'
        notices.mkdir(parents=True, exist_ok=True)
        try:
            report = compare(evidence)
            (evidence / 'comparison.json').write_text(json.dumps(report, indent=2, sort_keys=True, default=str))
            (evidence / 'comparison.md').write_text(render_markdown(report))
            for index, group in enumerate(render_notices(report), 1):
                if len(group) > 10:
                    raise ValueError(f'notice group {index} exceeds the per-step annotation budget')
                (notices / f'{index}.txt').write_text('\n'.join(group) + '\n')
        except Exception:  # noqa: BLE001 - make the failure visible in every report step
            trace = traceback.format_exc()
            print(trace, file=sys.stderr)
            for index in range(1, 5):
                (notices / f'{index}.txt').write_text(notice('Comparison crashed', trace[-3500:], 'error') + '\n')
            return 1
        print(f"comparison mode={report['mode']} ok={report['ok']}")
        for name, item in report['checks'].items():
            print(f"{'ok  ' if item['ok'] else 'FAIL'} {name}: {item['detail']}")
        return 0 if report['ok'] else 1
    if args.command == 'rustsec-compare':
        return rustsec_compare(args.out)
    return 2


if __name__ == '__main__':
    sys.exit(main())
