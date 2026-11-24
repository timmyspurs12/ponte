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
                b'\0/home/runner/work/ponte/ponte/rust/optimizer/src/optimizer.rs\0src/lib.rs\0'
                b'/home/runner/.rustup/toolchains/1.91.0-x86_64-unknown-linux-gnu/lib/rustlib/src/rust/library/alloc/src/slice.rs\0')
        found = prov.embedded_paths(blob)
        self.assertEqual(found['cargo registry source (CARGO_HOME-dependent)']['count'], 1)
        self.assertEqual(found['rust-src component (local library source path)']['count'], 1)
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
        self.command('probe-wasm-exists')
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
        self.assertTrue(probe['wasm_exists'])
        self.assertTrue(record['raw_wasm']['matches_main_baseline'])
        self.assertIn(': True.', output)

    def test_no_manifest_probe_records_exit_zero_without_wasm(self):
        self.command('no-manifest-absent')
        self.command('no-manifest-build')
        self.command('no-manifest-no-wasm')
        record, output = self.run_assemble()
        probe = record['cargo_stylus_build_path']['no_manifest_probe']
        self.assertEqual(probe['build_exit_code'], 0)
        self.assertTrue(probe['contract_manifest_absent'])
        self.assertTrue(probe['no_wasm_produced'])
        self.assertIn('no WASM produced True', output)

    def test_project_hash_files_strips_ansi_and_keeps_order(self):
        text = ('\x1b[0;0m\x1b[90mFile used for deployment hash: /source/Cargo.toml\x1b[0;0m\n'
                'File used for deployment hash: /source/optimizer/src/lib.rs\r\n'
                'Compiling ponte-stylus-wrapper\n')
        self.assertEqual(prov.project_hash_files(text), {
            'count': 2,
            'files': ['/source/Cargo.toml', '/source/optimizer/src/lib.rs'],
        })
        self.assertEqual(prov.project_hash_files(''), {'count': 0, 'files': []})

    def test_project_hash_reads_cli_line(self):
        text = '\x1b[0;0m\x1b[90mproject metadata hash computed on deployment: "' + 'a' * 64 + '"\x1b[0;0m\n'
        self.assertEqual(prov.project_hash(text), 'a' * 64)
        self.assertIsNone(prov.project_hash('no hash here'))

    def test_workspace_root_two_container_builds_and_initcode(self):
        self.command('workspace-root', stdout=json.dumps({'workspace_root': '/tmp/ponte/rust'}))
        code = initcode(bytes.fromhex('eff00000') + b'x' * 100)
        (self.root / 'docker' / 'official-container-1.wasm').write_bytes(module())
        (self.root / 'docker' / 'official-container-2.wasm').write_bytes(module())
        (self.root / 'docker' / 'initcode.hex').write_text(code + '\n')
        self.command('official-path-build-2')
        self.command('official-path-wasm-exists')
        self.command('official-path-wasm-exists-2')
        self.command('official-path-identical')
        self.command('container-get-initcode', stdout=(
            'File used for deployment hash: /source/Cargo.toml\n'
            'File used for deployment hash: /source/optimizer/src/lib.rs\n'
            f'project metadata hash computed on deployment: "{"b" * 64}"\n'))
        self.command('container-initcode-copy')
        record, output = self.run_assemble()
        self.assertEqual(record['source']['cargo_metadata_workspace_root'], '/tmp/ponte/rust')
        d = record['reproducible_docker_path']
        self.assertEqual(d['official_path']['second_build_exit_code'], 0)
        self.assertTrue(d['official_path']['wasm_exists'])
        self.assertTrue(d['official_path']['second_wasm_exists'])
        self.assertTrue(d['official_path']['identical'])
        self.assertEqual(d['get_initcode']['project_hash_files']['count'], 2)
        self.assertEqual(d['get_initcode']['project_hash'], 'b' * 64)
        self.assertEqual(d['get_initcode']['brotli_compressed_wasm_bytes'], 100)
        self.assertTrue(d['get_initcode']['fits_single_contract_limit'])
        self.assertIn('identical True', output)
        self.assertIn('hashed files 2', output)

    def test_error_excerpt_keeps_error_lines_only(self):
        text = 'Compiling x\nerror: failed to read `/optimizer/Cargo.toml`\n\nCaused by:\n  No such file\n'
        self.assertEqual(prov.error_excerpt(text), 'error: failed to read `/optimizer/Cargo.toml` | Caused by:')
        self.assertTrue(prov.error_excerpt('error ' * 200).endswith('…'))

    def test_rust_src_probe_and_release_components(self):
        self.command('release-components', stdout=(
            'cargo-x86_64-unknown-linux-gnu\nclippy-x86_64-unknown-linux-gnu\n'
            'rust-std-wasm32-unknown-unknown\nrustc-x86_64-unknown-linux-gnu\n'))
        (self.root / 'reproducibility' / 'with-rust-src.wasm').write_bytes(
            module() + b'\0/home/runner/.rustup/toolchains/1.91.0-x86_64-unknown-linux-gnu'
            b'/lib/rustlib/src/rust/library/alloc/src/raw_vec/mod.rs\0')
        self.command('rust-src-build')
        record, output = self.run_assemble()
        probe = record['reproducibility']['with_rust_src']
        self.assertEqual(probe['build_exit_code'], 0)
        self.assertFalse(probe['identical'])
        self.assertEqual(probe['embedded_absolute_paths']['rust-src component (local library source path)']['count'], 1)
        self.assertFalse(record['toolchain']['rust_src_at_release_build'])
        self.assertIn('clippy-x86_64-unknown-linux-gnu', record['toolchain']['components_at_release_build'])
        self.assertIn('with rust-src added: exit 0, identical False', output)
        self.assertIn('(rust-src: False)', output)
        self.command('release-components', stdout='rust-src\n')
        record, _ = self.run_assemble()
        self.assertTrue(record['toolchain']['rust_src_at_release_build'])

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
