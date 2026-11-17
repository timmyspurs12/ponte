import contextlib
import importlib.util
import io
import json
import socket
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('evidence.py')
spec = importlib.util.spec_from_file_location('macro_isolation_evidence', SCRIPT)
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)

REG = '/home/runner/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f'
REPO = '/home/runner/work/ponte/ponte'
TOOLCHAIN = '/home/runner/.rustup/toolchains/1.91.0-x86_64-unknown-linux-gnu'
VERBOSE_LOG = f"""   Compiling proc-macro2 v1.0.101
     Running `CARGO={TOOLCHAIN}/bin/cargo CARGO_CRATE_NAME=build_script_build CARGO_PKG_DESCRIPTION='A substitute implementation of the compiler'"'"'s `proc_macro` API.' CARGO_PKG_NAME=proc-macro2 CARGO_PKG_VERSION=1.0.101 {TOOLCHAIN}/bin/rustc --crate-name build_script_build --edition=2021 {REG}/proc-macro2-1.0.101/build.rs --error-format=json --crate-type bin --emit=dep-info,link -C embed-bitcode=no --cfg 'feature="default"' --cfg 'feature="proc-macro"' -C metadata=6b1d1e5d4c1a0e3f -C extra-filename=-77c1d6a0e0b9e1aa --out-dir {REPO}/rust/stylus-wrapper/target/release/build/proc-macro2-77c1d6a0e0b9e1aa -L dependency={REPO}/rust/stylus-wrapper/target/release/deps --cap-lints allow`
     Running `CARGO_PKG_NAME=proc-macro2 CARGO_PKG_VERSION=1.0.101 HOST=x86_64-unknown-linux-gnu TARGET=wasm32-unknown-unknown {REPO}/rust/stylus-wrapper/target/release/build/proc-macro2-77c1d6a0e0b9e1aa/build-script-build`
[proc-macro2 1.0.101] cargo:rustc-cfg=wrap_proc_macro
     Running `CARGO_PKG_DESCRIPTION='line one
line two with `tick`' CARGO_PKG_NAME=multi CARGO_PKG_VERSION=0.1.0 {TOOLCHAIN}/bin/rustc --crate-name multi --edition=2021 {REG}/multi-0.1.0/src/lib.rs --crate-type lib --target wasm32-unknown-unknown --cfg 'feature="std"' -C opt-level=3 -C metadata=abc -C extra-filename=-0123456789abcdef --out-dir {REPO}/rust/stylus-wrapper/target/wasm32-unknown-unknown/release/deps --extern foo={REPO}/x/libfoo-0123456789abcdef.rlib --extern bar=/x/libbar-0123456789abcdef.so`
     Running `CARGO_PKG_NAME=ponte-stylus-wrapper CARGO_PKG_VERSION=0.1.0 CARGO_PRIMARY_PACKAGE=1 {TOOLCHAIN}/bin/rustc --crate-name ponte_stylus_wrapper --edition=2021 src/lib.rs --crate-type lib --crate-type cdylib --target wasm32-unknown-unknown -C opt-level=3 -C metadata=feed --extern alloy_sol_types=/x/liba-0123456789abcdef.rlib`
"""


def uleb(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def name(text):
    raw = text.encode()
    return uleb(len(raw)) + raw


def section(section_id, payload):
    return bytes([section_id]) + uleb(len(payload)) + payload


def module(entry_name, body=b'\x00\x20\x00\x0b'):
    types = section(1, uleb(1) + b'\x60\x01\x7f\x01\x7f')
    imports = section(2, uleb(1) + name('vm_hooks') + name('read_args') + b'\x00' + uleb(0))
    functions = section(3, uleb(1) + uleb(0))
    exports = section(7, uleb(1) + name('user_entrypoint') + b'\x00' + uleb(1))
    code = section(10, uleb(1) + uleb(len(body)) + body)
    data = section(11, uleb(1) + uleb(0) + b'\x41' + b'\x80\x08' + b'\x0b' + uleb(2) + b'hi')
    names = uleb(2) + uleb(0) + name('read_args') + uleb(1) + name(entry_name)
    custom = section(0, name('name') + b'\x01' + uleb(len(names)) + names)
    return b'\0asm\x01\0\0\0' + types + imports + functions + exports + code + data + custom


class NoNetwork(unittest.TestCase):
    def setUp(self):
        self.original = socket.socket

        def blocked(*args, **kwargs):
            raise AssertionError('network access attempted')
        socket.socket = blocked
        self.addCleanup(setattr, socket, 'socket', self.original)


class RunningLineTests(NoNetwork):
    def test_parses_quoted_backticks_multiline_values_and_build_scripts(self):
        inventory = evidence.compile_inventory(VERBOSE_LOG, REPO)
        self.assertEqual(inventory['parse_errors'], [])
        units = inventory['units']
        self.assertEqual(len(units), 3)
        build = units['proc-macro2 1.0.101 build_script_build [bin] host']
        self.assertEqual(build['features'], ['default', 'proc-macro'])
        self.assertIn('-C metadata=<hash>', build['flags'])
        self.assertIn('--out-dir <repo>/rust/stylus-wrapper/target/release/build/proc-macro2-<hash>', build['flags'])
        multi = units['multi 0.1.0 multi [lib] wasm32-unknown-unknown']
        self.assertEqual(multi['features'], ['std'])
        self.assertEqual(multi['externs'], ['bar=.so', 'foo=.rlib'])
        self.assertEqual(multi['source'], '<registry>/multi-0.1.0/src/lib.rs')
        root = units['ponte-stylus-wrapper 0.1.0 ponte_stylus_wrapper [lib+cdylib] wasm32-unknown-unknown']
        self.assertTrue(root['primary'])
        runs = inventory['build_script_runs']
        self.assertEqual(list(runs), ['proc-macro2 1.0.101 build-script-run wasm32-unknown-unknown'])
        counts = evidence.inventory_counts(inventory)
        self.assertEqual(counts['rustc:wasm32-unknown-unknown'], 2)
        self.assertEqual(counts['rustc:host'], 1)

    def test_inventory_comparison_reports_removed_units_and_extern_changes(self):
        base = evidence.compile_inventory(VERBOSE_LOG, REPO)
        reduced = VERBOSE_LOG.replace(
            "--extern alloy_sol_types=/x/liba-0123456789abcdef.rlib",
            "--extern alloy_sol_types=/x/liba-0123456789abcdef.rlib --extern alloy_sol_macro=/x/libm-0123456789abcdef.so")
        exp = evidence.compile_inventory('\n'.join(l for l in reduced.splitlines() if 'multi' not in l and 'line two' not in l), REPO)
        diff = evidence.compare_inventories(base, exp)
        self.assertEqual(diff['units_only_baseline'], ['multi 0.1.0 multi [lib] wasm32-unknown-unknown'])
        self.assertEqual(diff['extern_changes'][0]['added'], ['alloy_sol_macro=.so'])
        self.assertEqual(diff['metadata_changes'], [])
        self.assertEqual(diff['flag_changes'], [])

    def test_raw_metadata_changes_are_reported_separately_from_flags(self):
        base = evidence.compile_inventory(VERBOSE_LOG, REPO)
        exp = evidence.compile_inventory(VERBOSE_LOG.replace('-C metadata=feed', '-C metadata=beef'), REPO)
        self.assertEqual(base['units']['ponte-stylus-wrapper 0.1.0 ponte_stylus_wrapper [lib+cdylib] wasm32-unknown-unknown']['metadata'], 'feed')
        diff = evidence.compare_inventories(base, exp)
        self.assertEqual(diff['flag_changes'], [])
        self.assertEqual(diff['metadata_changes'], [{'unit': 'ponte-stylus-wrapper 0.1.0 ponte_stylus_wrapper [lib+cdylib] wasm32-unknown-unknown',
                                                     'baseline': 'feed', 'experiment': 'beef'}])
        self.assertEqual(diff['common_units'], 3)


class ArtifactInventoryTests(NoNetwork):
    def test_package_ids_and_kinds(self):
        self.assertEqual(evidence.parse_package_id('registry+https://github.com/rust-lang/crates.io-index#syn@2.0.119'), ('syn', '2.0.119'))
        self.assertEqual(evidence.parse_package_id('path+file:///w/rust/optimizer#0.1.0'), ('optimizer', '0.1.0'))
        self.assertEqual(evidence.parse_package_id('syn 2.0.119 (registry+https://github.com/rust-lang/crates.io-index)'), ('syn', '2.0.119'))
        lines = [
            json.dumps({'reason': 'compiler-artifact', 'package_id': 'registry+x#syn@2.0.119',
                        'target': {'name': 'syn', 'crate_types': ['lib']}, 'features': ['full'],
                        'profile': {'opt_level': '3', 'debuginfo': 0, 'test': False},
                        'filenames': ['/r/target/wasm32-unknown-unknown/release/deps/libsyn-1.rlib']}),
            json.dumps({'reason': 'build-script-executed', 'package_id': 'registry+x#serde@1.0.0',
                        'out_dir': '/r/target/release/build/serde-1/out'}),
            'not json',
        ]
        inventory = evidence.artifact_inventory('\n'.join(lines))
        self.assertIn('syn 2.0.119 syn [lib] wasm32-unknown-unknown opt=3 debug=0 test=False', inventory['units'])
        self.assertIn('serde 1.0.0 build-script-run host', inventory['units'])

    def test_comparison_with_build_scripts_on_both_sides(self):
        # Regression: build-script units have no feature list; hosted run 44166894625 crashed here.
        artifact = {'reason': 'compiler-artifact', 'package_id': 'registry+x#syn@2.0.119',
                    'target': {'name': 'syn', 'crate_types': ['lib']}, 'features': ['full'],
                    'profile': {'opt_level': '3', 'debuginfo': 0, 'test': False},
                    'filenames': ['/r/target/wasm32-unknown-unknown/release/deps/libsyn-1.rlib']}
        script = {'reason': 'build-script-executed', 'package_id': 'registry+x#serde@1.0.0',
                  'out_dir': '/r/target/release/build/serde-1/out'}
        base = '\n'.join(json.dumps(m) for m in (artifact, script))
        same = evidence.compare_artifact_inventories(base, base)
        self.assertEqual(same, {'count': [2, 2], 'only_baseline': [], 'only_experiment': [], 'only_counts': [0, 0],
                                'multiplicity_changes': [], 'feature_changes': []})
        changed = dict(artifact, features=['full', 'extra-traits'])
        diff = evidence.compare_artifact_inventories(base, '\n'.join(json.dumps(m) for m in (changed, script)))
        self.assertEqual(diff['feature_changes'], ['syn 2.0.119 syn [lib] wasm32-unknown-unknown opt=3 debug=0 test=False'])
        removed = evidence.compare_artifact_inventories(base, json.dumps(script))
        self.assertEqual(removed['only_baseline'], ['syn 2.0.119 syn [lib] wasm32-unknown-unknown opt=3 debug=0 test=False'])


class RobustnessTests(NoNetwork):
    def test_crashing_section_becomes_failed_check_and_others_still_run(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'design.json').write_text(json.dumps({'rust_changed_files': []}))
            for side in evidence.SIDES:
                (root / side).mkdir()
                (root / side / 'lockfiles.sha256').write_text('abc  rust/stylus-wrapper/Cargo.lock\n')
            original = evidence.SECTIONS

            def boom(report, ctx):
                raise RuntimeError('synthetic analysis defect')
            evidence.SECTIONS = (('boom', boom),) + tuple(s for s in original if s[0] == 'manifest_and_lockfiles')
            try:
                report = evidence.compare(root)
            finally:
                evidence.SECTIONS = original
            self.assertFalse(report['ok'])
            self.assertIn('synthetic analysis defect', report['checks']['analysis_boom']['detail'])
            self.assertTrue(report['checks']['lockfiles_identical']['ok'])
            groups = evidence.render_notices(report)
            self.assertEqual([len(g) for g in groups], [5, 5, 5, 8])
            flat = '\n'.join(line for group in groups for line in group)
            self.assertIn('CRASHES: analysis_boom', flat)
            self.assertIn('::error title=Cargo trees::rendering failed', flat)

    def test_full_section_list_tolerates_empty_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            report = evidence.compare(Path(directory))
            self.assertFalse(report['ok'])
            groups = evidence.render_notices(report)
            self.assertTrue(all(len(group) <= 10 for group in groups))
            json.dumps(report, sort_keys=True, default=str)
            evidence.render_markdown(report)


class WasmTests(NoNetwork):
    def test_sections_names_code_and_data(self):
        report = evidence.parse_wasm(module('ponte::entry::h0123456789abcdef'))
        self.assertEqual([s['name'] for s in report['sections']],
                         ['type', 'import', 'function', 'export', 'code', 'data', 'custom:name'])
        self.assertEqual(report['function_names'], [[0, 'read_args'], [1, 'ponte::entry::h0123456789abcdef']])
        self.assertEqual(report['function_import_count'], 1)
        self.assertEqual(report['data_segments'][0]['offset'], 1024)
        self.assertEqual(report['exports'], [{'name': 'user_entrypoint', 'kind': 0, 'index': 1}])

    def test_hash_only_name_difference_is_isolated(self):
        base = evidence.parse_wasm(module('ponte::entry::h0123456789abcdef'))
        exp = evidence.parse_wasm(module('ponte::entry::hfedcba9876543210'))
        diff = evidence.compare_wasm(base, exp)
        self.assertFalse(diff['identical'])
        self.assertEqual(diff['differing_sections'], ['custom:name#1'])
        self.assertEqual(diff['function_names']['differing_raw'], 1)
        self.assertEqual(diff['function_names']['differing_after_hash_normalization'], 0)
        self.assertTrue(diff['code']['identical_in_order'])
        self.assertEqual(diff['size'][0], diff['size'][1])

    def test_code_difference_is_attributed_to_named_function(self):
        base = evidence.parse_wasm(module('ponte::entry::h0123456789abcdef'))
        exp = evidence.parse_wasm(module('ponte::entry::h0123456789abcdef', body=b'\x00\x20\x00\x1a\x41\x00\x0b'))
        diff = evidence.compare_wasm(base, exp)
        self.assertEqual(diff['code']['differing_functions'], ['ponte::entry::h<hash>'])
        self.assertFalse(diff['code']['multiset_identical'])

    def test_swapped_functions_are_order_changes_not_body_changes(self):
        def two(first, second):
            bodies = {'a': b'\x00\x20\x00\x0b', 'b': b'\x00\x41\x07\x0b'}
            types = section(1, uleb(1) + b'\x60\x01\x7f\x01\x7f')
            functions = section(3, uleb(2) + uleb(0) + uleb(0))
            code = section(10, uleb(2) + b''.join(uleb(len(bodies[n])) + bodies[n] for n in (first, second)))
            names = uleb(2) + uleb(0) + name(f'crate::{first}::h0123456789abcdef') + uleb(1) + name(f'crate::{second}::hfedcba9876543210')
            custom = section(0, name('name') + b'\x01' + uleb(len(names)) + names)
            return evidence.parse_wasm(b'\0asm\x01\0\0\0' + types + functions + code + custom)
        diff = evidence.compare_wasm(two('a', 'b'), two('b', 'a'))
        self.assertFalse(diff['code']['identical_in_order'])
        self.assertTrue(diff['code']['multiset_identical'])
        self.assertFalse(diff['code']['by_name']['order_identical'])
        self.assertEqual(diff['code']['by_name']['positions_with_other_function'], 2)
        self.assertEqual(diff['code']['by_name']['differing_count'], 0)
        self.assertEqual(diff['code']['differing_positions'][0]['baseline'], 'crate::a::h<hash>')
        self.assertTrue(diff['code']['differing_positions'][0]['experiment_body_found_in_baseline'])

    def test_wat_blocks_separate_reordering_from_instruction_changes(self):
        base = ('(module\n  (type (;0;) (func))\n  (func $a::h0123456789abcdef (type 0)\n    call $b::h1111111111111111)\n'
                '  (func $b::h1111111111111111 (type 0)\n    i32.const 1\n    drop)\n  (export "a" (func $a::h0123456789abcdef)))\n')
        moved = ('(module\n  (type (;0;) (func))\n  (func $b::h2222222222222222 (type 0)\n    i32.const 1\n    drop)\n'
                 '  (func $a::h3333333333333333 (type 0)\n    call $b::h2222222222222222)\n  (export "a" (func $a::h3333333333333333)))\n')
        reordered = evidence.compare_wat_blocks(base, moved)
        self.assertEqual(reordered['differing_count'], 0)
        self.assertFalse(reordered['order_identical'])
        changed = evidence.compare_wat_blocks(base, base.replace('i32.const 1', 'i32.const 2'))
        self.assertEqual(changed['differing_count'], 1)
        self.assertEqual(changed['details'][0]['block'], 'func $b::h<hash>')
        self.assertEqual(changed['details'][0]['diff'], ['-    i32.const 1', '+    i32.const 2'])
        self.assertTrue(changed['order_identical'])

    RENAME_BASE = """(module
  (type (;0;) (func))
  (import "vm_hooks" "read_args" (func $_ZN3sdk9read_args17h0000000000000001E (type 0)))
  (func $_ZN1a1f17h1111111111111111E (type 0)
    call $_ZN1b1g17h2222222222222222E)
  (func $_ZN1b1g17h2222222222222222E (type 0)
    call $_ZN3sdk9read_args17h0000000000000001E)
  (func $_ZN4core4fold17haaaaaaaaaaaaaaaaE (type 0)
    nop)
  (func $_ZN4core4fold17hbbbbbbbbbbbbbbbbE (type 0)
    unreachable)
  (func $_ZN5alloc11finish_grow17hccccccccccccccccE.llvm.111 (type 0)
    nop)
  (export "a" (func $_ZN1a1f17h1111111111111111E))
  (@custom "name" "base"))
"""
    RENAME_EXP = """(module
  (type (;0;) (func))
  (import "vm_hooks" "read_args" (func $_ZN3sdk9read_args17h0000000000000001E (type 0)))
  (func $_ZN1b1g17h4444444444444444E (type 0)
    call $_ZN3sdk9read_args17h0000000000000001E)
  (func $_ZN1a1f17h5555555555555555E (type 0)
    call $_ZN1b1g17h4444444444444444E)
  (func $_ZN4core4fold17hddddddddddddddddE (type 0)
    unreachable)
  (func $_ZN4core4fold17heeeeeeeeeeeeeeeeE (type 0)
    nop)
  (func $_ZN5alloc11finish_grow17hccccccccccccccccE.llvm.222 (type 0)
    nop)
  (export "a" (func $_ZN1a1f17h5555555555555555E))
  (@custom "name" "experiment"))
"""

    def rename_bodies(self, *names):
        return {'code_bodies': [{'sha256': n, 'size': len(n)} for n in names]}

    def test_exact_renaming_proves_reorder_only_change(self):
        result = evidence.compare_wat_renamed(
            self.RENAME_BASE, self.RENAME_EXP,
            self.rename_bodies('F1', 'G', 'NOP', 'UNREACH', 'NOP'), self.rename_bodies('G', 'F2', 'UNREACH', 'NOP', 'NOP'))
        self.assertTrue(result['equivalent_up_to_renaming_and_order'])
        self.assertEqual(result['functions'], [6, 6])
        self.assertEqual(result['paired'], 6)
        self.assertEqual(result['symbols_renamed'], 5)
        self.assertEqual(result['differing_after_renaming_count'], 0)
        self.assertEqual([(m['from'], m['to']) for m in result['moved']], [(0, 1), (1, 0), (2, 3), (3, 2)])
        self.assertFalse(result['name_section_identical'])
        self.assertEqual(result['binary']['identical'], 4)
        self.assertEqual(result['binary']['identical_but_moved'], 3)
        self.assertEqual([e['function'] for e in result['binary']['differs_calls_moved']], ['_ZN1a1f17h<hash>E'])
        self.assertEqual(result['binary']['differs_unexplained'], [])

    def test_exact_renaming_detects_changed_instruction_and_unexplained_bytes(self):
        changed = self.RENAME_EXP.replace('unreachable)', 'i32.const 1\n    drop)')
        result = evidence.compare_wat_renamed(
            self.RENAME_BASE, changed,
            self.rename_bodies('F1', 'G', 'NOP', 'UNREACH', 'NOP'), self.rename_bodies('G', 'F2', 'UNREACH', 'NOP', 'NOP2'))
        self.assertFalse(result['equivalent_up_to_renaming_and_order'])
        self.assertEqual(result['differing_after_renaming_count'], 1)
        self.assertEqual(result['differing_after_renaming'][0]['diff'], ['-    unreachable)', '+    i32.const 1', '+    drop)'])
        self.assertEqual([e['function'] for e in result['binary']['differs_unexplained']], ['_ZN5alloc11finish_grow17h<hash>E.llvm.<n>'])

    def test_rejects_non_wasm_and_normalizes_wat(self):
        with self.assertRaises(ValueError):
            evidence.parse_wasm(b'not wasm')
        wat = evidence.compare_wat('(func $a::h0123456789abcdef)\n', '(func $a::hfedcba9876543210)\n')
        self.assertFalse(wat['raw_identical'])
        self.assertTrue(wat['normalized_identical'])
        self.assertEqual(evidence.strip_symbol_hashes('_ZN1a4main17h0123456789abcdefE'), '_ZN1a4main17h<hash>E')


BASE_MANIFEST = '''[package]
name = "w"
[dependencies]
alloy-sol-types = { version = "=1.5.7", default-features = false }
alloy-sol-macro = "=1.5.7"
alloy-sol-macro-expander = "=1.5.7"
alloy-sol-macro-input = "=1.5.7"
[dev-dependencies]
stylus-sdk = { version = "=0.10.10", features = ["stylus-test"] }
'''
EXP_MANIFEST = '''[package]
name = "w"
[dependencies]
alloy-sol-types = { version = "=1.5.7", default-features = false }
[dev-dependencies]
stylus-sdk = { version = "=0.10.10", features = ["stylus-test"] }
alloy-sol-macro = "=1.5.7"
alloy-sol-macro-expander = "=1.5.7"
alloy-sol-macro-input = "=1.5.7"
'''


class ManifestAndMetadataTests(NoNetwork):
    def test_manifest_move_is_exact(self):
        result = evidence.manifest_move(BASE_MANIFEST, EXP_MANIFEST)
        self.assertTrue(result['moved_exactly'])
        self.assertTrue(result['other_content_identical'])
        self.assertFalse(result['identical'])
        changed = evidence.manifest_move(BASE_MANIFEST, EXP_MANIFEST.replace('"=1.5.7"\nalloy-sol-macro-input', '"=1.5.8"\nalloy-sol-macro-input'))
        self.assertFalse(changed['moved_exactly'])
        upgraded = evidence.manifest_move(BASE_MANIFEST, EXP_MANIFEST.replace('=0.10.10', '=0.10.11'))
        self.assertFalse(upgraded['other_content_identical'])
        self.assertTrue(evidence.manifest_move(BASE_MANIFEST, BASE_MANIFEST)['identical'])

    def test_metadata_direct_kinds(self):
        meta = {
            'packages': [
                {'id': 'root', 'name': 'ponte-stylus-wrapper', 'version': '0.1.0', 'dependencies': [
                    {'name': 'alloy-sol-macro', 'req': '=1.5.7', 'kind': 'dev', 'uses_default_features': True, 'features': []}]},
                {'id': 'm', 'name': 'alloy-sol-macro', 'version': '1.5.7', 'dependencies': []},
            ],
            'resolve': {'root': 'root', 'nodes': [
                {'id': 'root', 'deps': [{'pkg': 'm', 'dep_kinds': [{'kind': 'dev', 'target': None}]}]},
                {'id': 'm', 'deps': []}]},
        }
        view = evidence.metadata_view(json.dumps(meta))
        self.assertEqual(view['direct']['alloy-sol-macro'], {'version': '1.5.7', 'kinds': ['dev']})
        self.assertEqual(view['versions']['alloy-sol-macro'], ['1.5.7'])
        self.assertIn('alloy-sol-macro =1.5.7 dev default=True features=-', view['declared'])


class TreeAndNoticeTests(NoNetwork):
    def test_inverse_tree_parents(self):
        tree = ('alloy-sol-macro-input v1.5.7\n'
                '├── alloy-sol-macro v1.5.7 (proc-macro)\n'
                '│   └── alloy-sol-types v1.5.7\n'
                '└── ponte-stylus-wrapper v0.1.0 (/home/runner/work/ponte/ponte/rust/stylus-wrapper)\n'
                '[dev-dependencies]\n'
                '└── ponte-stylus-wrapper v0.1.0 (/home/runner/work/ponte/ponte/rust/stylus-wrapper) (*)\n')
        self.assertEqual(evidence.tree_parents(tree), [
            'alloy-sol-macro v1.5.7 (proc-macro)', 'ponte-stylus-wrapper v0.1.0', '[dev-dependencies]',
            'ponte-stylus-wrapper v0.1.0'])
        self.assertEqual(evidence.tree_package_set('a v1\nb v2 (*)\na v1\n'), ['a v1', 'b v2'])

    def test_notice_escaping_and_length_cap(self):
        line = evidence.notice('A: b, c', 'one%two\nthree')
        self.assertEqual(line, '::notice title=A%3A b%2C c::one%25two%0Athree')
        self.assertIn('[truncated', evidence.notice('t', 'x' * 5000))

    def test_rustsec_findings_and_comparison(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = {'vulnerabilities': {'list': [{'advisory': {'id': 'RUSTSEC-2026-0387'}, 'package': {'name': 'crypto-bigint', 'version': '0.5.5'}}]},
                      'warnings': {'unsound': [{'advisory': {'id': 'RUSTSEC-2026-0253'}, 'package': {'name': 'lru', 'version': '0.16.4'}}]}}
            for side in evidence.SIDES:
                (root / side).mkdir()
                (root / side / 'lockfiles.sha256').write_text('abc  rust/stylus-wrapper/Cargo.lock\n')
                for workspace in evidence.WORKSPACES:
                    data = report if workspace == 'stylus-wrapper' else {'vulnerabilities': {'list': []}, 'warnings': {}}
                    (root / side / f'{workspace}.json').write_text(json.dumps(data))
                    (root / side / f'{workspace}.exit').write_text('1\n' if workspace == 'stylus-wrapper' else '0\n')
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(evidence.rustsec_compare(root), 0)
            self.assertIn('identical between baseline and experiment=True', output.getvalue())
            self.assertIn('vulnerability RUSTSEC-2026-0387 crypto-bigint 0.5.5', output.getvalue())
            (root / 'experiment' / 'stylus-wrapper.json').write_text(json.dumps({'vulnerabilities': {'list': []}, 'warnings': {}}))
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(evidence.rustsec_compare(root), 1)


if __name__ == '__main__':
    unittest.main()
