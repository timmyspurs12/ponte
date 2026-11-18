"""Offline tests for scripts/phase2b6/stylus_provenance.py (standard library only)."""
import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).with_name('stylus_provenance.py')
spec = importlib.util.spec_from_file_location('stylus_provenance', SCRIPT)
prov = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prov)


def leb(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def name(text):
    raw = text.encode()
    return leb(len(raw)) + raw


def section(section_id, payload):
    return bytes([section_id]) + leb(len(payload)) + payload


def module():
    imports = leb(2) + name('vm_hooks') + name('read_args') + b'\x00' + leb(0) \
        + name('vm_hooks') + name('write_result') + b'\x00' + leb(1)
    exports = leb(3) + name('memory') + b'\x02' + leb(0) + name('user_entrypoint') + b'\x00' + leb(2) \
        + name('__heap_base') + b'\x03' + leb(0)
    custom = name('producers') + b'abc'
    return b'\0asm\x01\0\0\0' + section(2, imports) + section(7, exports) + section(0, custom)


# Verbatim from stylus-tools/src/core/build/reproducible.rs at 76f8b055 (create_image).
TEMPLATE_SOURCE = '''
    // Create temporary Dockerfile
    let dockerfile_content = format!(
        r#"\\
            ARG BUILD_PLATFORM=linux/amd64
            FROM --platform=${{BUILD_PLATFORM}} {base_image} AS base
            RUN rustup toolchain install {toolchain_version}-x86_64-unknown-linux-gnu
            RUN rustup default {toolchain_version}-x86_64-unknown-linux-gnu
            RUN rustup target add wasm32-unknown-unknown
            RUN rustup component add rust-src --toolchain {toolchain_version}-x86_64-unknown-linux-gnu
{binaryen_layer}        "#
    );
'''


def initcode(code):
    prelude = b'\x7f' + len(code).to_bytes(32, 'big') + bytes([0x80, 0x60, 43, 0x60, 0, 0x39, 0x60, 0, 0xF3, 0])
    return (prelude + code).hex()


class WasmTests(unittest.TestCase):
    def test_parse_imports_exports_and_custom_sections(self):
        parsed = prov.parse_wasm(module())
        self.assertEqual([(i['module'], i['name'], i['kind']) for i in parsed['imports']],
                         [('vm_hooks', 'read_args', 'function'), ('vm_hooks', 'write_result', 'function')])
        self.assertEqual([(e['name'], e['kind']) for e in parsed['exports']],
                         [('memory', 'memory'), ('user_entrypoint', 'function'), ('__heap_base', 'global')])
        self.assertEqual(parsed['custom_sections'][0]['name'], 'producers')

    def test_rejects_non_wasm_and_truncation(self):
        with self.assertRaises(ValueError):
            prov.parse_wasm(b'not wasm')
        with self.assertRaises(ValueError):
            prov.parse_wasm(module()[:-2])

    def test_embedded_path_categories(self):
        blob = (b'\0/home/runner/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/ruint-1.21.1/src/lib.rs'
                b'\0/rustc/f8297e351a40c1439a467bbbb6879088047f50b3/library/core/src/panic.rs'
                b'\0/home/runner/work/ponte/ponte/rust/optimizer/src/optimizer.rs\0src/lib.rs\0')
        found = prov.embedded_paths(blob)
        self.assertEqual(found['cargo registry source (CARGO_HOME-dependent)']['count'], 1)
        self.assertEqual(found['rust-std (/rustc/<commit>, toolchain-remapped)']['count'], 1)
        self.assertEqual(found['host home or checkout directory']['examples'],
                         ['/home/runner/work/ponte/ponte/rust/optimizer/src/optimizer.rs'])
        self.assertEqual(prov.embedded_paths(b'\0src/lib.rs relative only\0'), {})


class InitcodeTests(unittest.TestCase):
    def test_layout_and_sizes(self):
        summary = prov.initcode_summary(initcode(bytes.fromhex('eff00000') + b'x' * 100))
        self.assertEqual(summary['initcode_bytes'], 43 + 104)
        self.assertEqual(summary['brotli_compressed_wasm_bytes'], 100)
        self.assertTrue(summary['fits_single_contract_limit'])

    def test_rejects_wrong_prefix_or_length(self):
        with self.assertRaises(ValueError):
            prov.initcode_summary(initcode(b'\x00' * 50))
        broken = bytes.fromhex(initcode(bytes.fromhex('eff00000') + b'x' * 10))[:-1].hex()
        with self.assertRaises(ValueError):
            prov.initcode_summary(broken)


class ClassificationTests(unittest.TestCase):
    def test_known_failures(self):
        self.assertIn('[workspace]', prov.classify_container_failure(
            'error: toml read error: missing field `workspace`'))
        self.assertIn('outside the mounted', prov.classify_container_failure(
            'error: failed to get `ponte-optimizer` as a dependency\n'
            'failed to read `/optimizer/Cargo.toml`\nNo such file or directory (os error 2)'))
        self.assertIn('unclassified', prov.classify_container_failure('something else'))

    def test_tag_resolution(self):
        sha = '76f8b055ec0bf421edd542b164dc2917c9e4e0bd'
        self.assertEqual(prov.check_tag(f'{sha}\trefs/tags/v0.10.10\n', 'v0.10.10', sha), (True, sha))
        annotated = f'1111111111111111111111111111111111111111\trefs/tags/v0.10.10\n{sha}\trefs/tags/v0.10.10^{{}}\n'
        self.assertEqual(prov.check_tag(annotated, 'v0.10.10', sha), (True, sha))
        self.assertFalse(prov.check_tag('', 'v0.10.10', sha)[0])

    def test_dockerfile_matches_cli_template(self):
        rendered = prov.render_dockerfile(TEMPLATE_SOURCE, 'offchainlabs/cargo-stylus-base:0.10.10', '1.91.0')
        self.assertTrue(rendered.startswith('\\\n'))
        self.assertIn('FROM --platform=${BUILD_PLATFORM} offchainlabs/cargo-stylus-base:0.10.10 AS base', rendered)
        self.assertIn('RUN rustup default 1.91.0-x86_64-unknown-linux-gnu', rendered)
        self.assertNotIn('{', rendered.replace('${BUILD_PLATFORM}', ''))


class AssembleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for sub in ('commands', 'abi', 'cli', 'docker', 'reproducibility'):
            (self.root / sub).mkdir()
        (self.root / prov.WASM_NAME).write_bytes(module())
        (self.root / 'abi' / 'ponte-synthetic-abi.sol').write_text('interface X {}\n')

    def command(self, name, code=0, stdout='', stderr='', argv=None):
        index = len(list((self.root / 'commands').glob('*.json')))
        base = self.root / 'commands' / f'{index:03d}-{name}'
        with contextlib.redirect_stdout(io.StringIO()):
            prov.main(['x', 'record-command', f'{base}.json', name, 'gate', 'test', '/w',
                       '2026-11-18T00:00:00.000Z', '2026-11-18T00:00:01.000Z', str(code), '--']
                      + (argv or [name]))
        Path(f'{base}.stdout').write_text(stdout)
        Path(f'{base}.stderr').write_text(stderr)

    def run_assemble(self):
        output = io.StringIO()
        env = {'SDK_RELEASE': 'v0.10.10', 'SDK_COMMIT': 'c' * 40, 'GITHUB_STEP_SUMMARY': ''}
        with mock.patch.dict(os.environ, env), contextlib.redirect_stdout(output):
            record = prov.assemble(self.root)
        return record, output.getvalue()

    def test_complete_record_and_annotation_budget(self):
        for required in prov.REQUIRED:
            self.command(required, stdout=f"{'c' * 40}\trefs/tags/v0.10.10\n" if required == 'sdk-tag' else '')
        self.command('official-path-build', 101, stderr='failed to read `/optimizer/Cargo.toml`')
        record, output = self.run_assemble()
        self.assertEqual(record['status'], 'complete')
        self.assertTrue(record['stylus_cli']['release_tag_matches'])
        self.assertEqual(record['raw_wasm']['vm_hooks'], ['read_args', 'write_result'])
        self.assertIn('outside the mounted', record['reproducible_docker_path']['official_path']['failure'])
        self.assertLessEqual(output.count('::notice '), 10)
        self.assertNotIn('::error', output)
        written = json.loads((self.root / 'provenance.json').read_text())
        self.assertEqual(written['label'], prov.LABEL)
        self.assertIn('not checked against Arbitrum Sepolia', prov.LABEL)

    def test_missing_or_failed_gate_is_incomplete(self):
        for required in prov.REQUIRED[1:]:
            self.command(required, code=1 if required == 'cargo-test' else 0)
        record, output = self.run_assemble()
        self.assertEqual(record['status'], 'incomplete')
        self.assertIn('ponte-head', record['missing_required_commands'])
        self.assertIn('cargo-test', record['failed_required_commands'])
        self.assertIn('::error title=Provenance record incomplete', output)

    def test_fragmentation_is_reported_from_get_initcode(self):
        self.command('cli-get-initcode', 1, stderr='fragmented contracts not currently supported for initcode retrieval')
        record, _ = self.run_assemble()
        self.assertIn('24,576-byte', record['cargo_stylus_build_path']['get_initcode']['failure'])

    def test_prefix_probe_and_baseline_are_recorded(self):
        self.command('probe-manifest-sha256', stdout=f"{'6e21' * 16}  /tmp/probe/Stylus.toml\n")
        self.command('prefix-manifest-probe', 1, stderr=(
            'error: toml read error: TOML parse error at line 1, column 1\n'
            '  |\n1 | [contract]\n  | ^\nmissing field `workspace`\n'))
        sha = prov.sha256_bytes(module())
        with mock.patch.dict(os.environ, {'BASELINE_WASM_SHA256': sha}):
            record, output = self.run_assemble()
        probe = record['cargo_stylus_build_path']['prefix_manifest_probe']
        self.assertIn('[workspace]', probe['failure'])
        self.assertIn('toml read error', probe['error_excerpt'])
        self.assertEqual(probe['stylus_toml_sha256'], '6e21' * 16)
        self.assertTrue(record['raw_wasm']['matches_main_baseline'])
        self.assertIn(': True.', output)

    def test_error_excerpt_keeps_error_lines_only(self):
        text = 'Compiling x\nerror: failed to read `/optimizer/Cargo.toml`\n\nCaused by:\n  No such file\n'
        self.assertEqual(prov.error_excerpt(text), 'error: failed to read `/optimizer/Cargo.toml` | Caused by:')
        self.assertTrue(prov.error_excerpt('error ' * 200).endswith('…'))

    def test_failure_excerpt_for_annotations(self):
        stderr = ('\x1b[1m\x1b[32m   Compiling\x1b[0m openssl-sys v0.9.116\n'
                  'error: failed to run custom build command for `openssl-sys v0.9.116`\n'
                  '  Could not find directory of OpenSSL installation\n'
                  'warning: build failed, waiting for other jobs to finish...\n')
        excerpt = prov.failure_excerpt(stderr, 'test result: FAILED. 1 passed; 1 failed\n')
        self.assertTrue(excerpt.startswith('error: failed to run custom build command'))
        self.assertIn('Could not find directory of OpenSSL installation', excerpt)
        self.assertIn('test result: FAILED', excerpt)
        self.assertNotIn('\x1b', excerpt)
        self.assertEqual(prov.failure_excerpt('', 'only\nstdout\nlines\nhere\n'), 'stdout | lines | here')
        self.assertEqual(prov.failure_excerpt('', ''), 'no output')
        long = prov.failure_excerpt('\n'.join(f'error {i:04d}' for i in range(400)))
        self.assertLessEqual(len(long), 1000)
        self.assertTrue(long.startswith('error 0000') and long.endswith('error 0399') and ' … ' in long)
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / '007-cli-install'
            base.with_suffix('.stderr').write_text('error: x\nCaused by:\n  y: z\n')
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(prov.main(['p', 'excerpt', str(base)]), 0)
            self.assertEqual(out.getvalue(), 'error: x | Caused by: | y: z\n')

    def test_annotation_escaping(self):
        self.assertEqual(prov.escape_message('a%b\nc'), 'a%25b%0Ac')
        self.assertEqual(prov.escape('t:1,2'), 't%3A1%2C2')


if __name__ == '__main__':
    unittest.main()
