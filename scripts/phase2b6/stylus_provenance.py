#!/usr/bin/env python3
"""Provenance tooling for the PONTE Phase 2B.6.0 unactivated Stylus candidate artifact.

Subcommands (standard library only):
  record-command OUT NAME MODE STAGE CWD STARTED ENDED CODE -- ARGV...
  check-tag LS_REMOTE_OUTPUT TAG EXPECTED_COMMIT
  dockerfile REPRODUCIBLE_RS BASE_IMAGE TOOLCHAIN
  assemble EVIDENCE_DIR

The record describes a LOCALLY BUILT, UNACTIVATED candidate. Nothing here deploys, activates,
signs or contacts an RPC endpoint, and nothing here claims Arbitrum Sepolia compatibility.
"""
import hashlib
import json
import os
import re
import sys
from pathlib import Path

LABEL = ('LOCALLY BUILT, UNACTIVATED CANDIDATE ARTIFACT. Not deployed, not activated and not '
         'checked against Arbitrum Sepolia or any other RPC endpoint.')
SCOPE = ('Synthetic-only evaluator: candidate routes, rates, liquidity, expiry and as-of time are '
         'caller-supplied and unauthenticated. The output is not an executable quote, verified '
         'liquidity or settlement functionality.')
NOT_PERFORMED = [
    'cargo stylus check against any RPC endpoint (only `cargo stylus check --help` was run)',
    'cargo stylus deploy, with or without --no-activate (only `cargo stylus deploy --help` was run)',
    'cargo stylus activate, verify, cache, codehash-keepalive, simulate, trace or replay',
    'any transaction, signature, wallet creation or import, key generation or funding',
    'token transfers, payments, settlement, or hosting deployments',
]
WASM_NAME = 'ponte_stylus_wrapper.wasm'
# Commands that must exist and exit 0 for the record to be complete.
REQUIRED = [
    'ponte-head', 'ponte-worktree', 'input-hashes', 'sdk-head', 'sdk-tag', 'sdk-input-hashes',
    'rust-toolchain-install', 'rustc-version', 'cargo-version', 'installed-targets',
    'wrapper-toolchain', 'cli-install', 'sdk-tree-unchanged', 'cli-binary-sha256', 'cli-version',
    'cli-check-help', 'cli-deploy-help', 'advisory-guard-tests', 'advisory-guard-baseline',
    'abi-tools-install', 'client-abi-check', 'client-abi-tests', 'cargo-fmt', 'cargo-test',
    'cargo-clippy', 'sdk-abi-export', 'sdk-abi-check', 'release-build', 'wasm-inspection',
    'wasm-entrypoint-test', 'client-abi-wasm-test', 'cli-build', 'docker-derived-build',
    'lockfiles-unchanged', 'tracked-files-unchanged',
]
TESTS = [
    'advisory-guard-tests', 'advisory-guard-baseline', 'client-abi-check', 'client-abi-tests',
    'cargo-fmt', 'cargo-test', 'cargo-clippy', 'sdk-abi-check', 'wasm-inspection',
    'wasm-entrypoint-test', 'client-abi-wasm-test',
]
PRELUDE_LENGTH = 43  # stylus-tools DeploymentCalldata: 42-byte EVM initcode + 1 version byte
EOF_NO_DICT = bytes.fromhex('eff00000')
MAX_CODE_SIZE = 24_576  # stylus-tools DEFAULT_MAX_CODE_SIZE (EIP-170), used by get-initcode
KINDS = {0: 'function', 1: 'table', 2: 'memory', 3: 'global', 4: 'tag'}


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def escape(value):
    """Escape a GitHub workflow-command property or message."""
    return (str(value).replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
            .replace(':', '%3A').replace(',', '%2C'))


def escape_message(value):
    return str(value).replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')


def notice(title, message, level='notice'):
    print(f'::{level} title={escape(title)}::{escape_message(message)}')


def leb128(data, offset):
    value = shift = 0
    while True:
        if offset >= len(data):
            raise ValueError('truncated LEB128')
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            return value, offset
        shift += 7
        if shift > 35:
            raise ValueError('oversized LEB128')


def wasm_name(data, offset):
    size, offset = leb128(data, offset)
    end = offset + size
    if end > len(data):
        raise ValueError('truncated name')
    return data[offset:end].decode('utf-8'), end


def skip_limits(data, offset):
    flags = data[offset]
    _, offset = leb128(data, offset + 1)
    if flags & 1:
        _, offset = leb128(data, offset)
    return offset


def parse_wasm(blob):
    """Return section sizes, imports, exports and custom sections of a WebAssembly 1 module."""
    if blob[:8] != b'\0asm\x01\0\0\0':
        raise ValueError('not a WebAssembly 1 module')
    sections, imports, exports, custom = [], [], [], []
    offset = 8
    while offset < len(blob):
        section_id = blob[offset]
        size, start = leb128(blob, offset + 1)
        end = start + size
        if end > len(blob):
            raise ValueError('truncated section')
        data = blob[start:end]
        sections.append({'id': section_id, 'size': size})
        if section_id == 0:
            name, _ = wasm_name(data, 0)
            custom.append({'name': name, 'size': size})
        elif section_id in (2, 7):
            count, cursor = leb128(data, 0)
            for _ in range(count):
                if section_id == 2:
                    module, cursor = wasm_name(data, cursor)
                    item, cursor = wasm_name(data, cursor)
                    kind = data[cursor]
                    cursor += 1
                    if kind in (0, 4):
                        if kind == 4:
                            cursor += 1
                        _, cursor = leb128(data, cursor)
                    elif kind == 1:
                        cursor = skip_limits(data, cursor + 1)
                    elif kind == 2:
                        cursor = skip_limits(data, cursor)
                    elif kind == 3:
                        cursor += 2
                    else:
                        raise ValueError(f'unknown import kind {kind}')
                    imports.append({'module': module, 'name': item, 'kind': KINDS.get(kind)})
                else:
                    item, cursor = wasm_name(data, cursor)
                    kind = data[cursor]
                    index, cursor = leb128(data, cursor + 1)
                    exports.append({'name': item, 'kind': KINDS.get(kind, str(kind)), 'index': index})
            if cursor != len(data):
                raise ValueError('unparsed import/export data')
        offset = end
    return {'sections': sections, 'imports': imports, 'exports': exports, 'custom_sections': custom}


ABSOLUTE_PATH = re.compile(r'/(?:[A-Za-z0-9_.+@-]+/)+[A-Za-z0-9_.+@-]+')


def path_category(path):
    if path.startswith('/rustc/'):
        return 'rust-std (/rustc/<commit>, toolchain-remapped)'
    if '/registry/src/' in path:
        return 'cargo registry source (CARGO_HOME-dependent)'
    if path.startswith(('/home/', '/Users/')):
        return 'host home or checkout directory'
    if path.startswith(('/source/', '/ponte/', '/usr/local/cargo/', '/root/')):
        return 'container path'
    return 'other absolute path'


def embedded_paths(blob, examples=6):
    """Find absolute filesystem paths embedded in printable strings of a binary."""
    categories = {}
    for run in re.finditer(rb'[\x20-\x7e]{6,}', blob):
        for path in ABSOLUTE_PATH.findall(run.group().decode('ascii')):
            category = categories.setdefault(path_category(path), set())
            category.add(path)
    return {
        name: {'count': len(paths), 'examples': sorted(paths)[:examples]}
        for name, paths in sorted(categories.items())
    }


def initcode_summary(hex_text):
    """Summarize `cargo stylus get-initcode` output (stylus-tools DeploymentCalldata layout)."""
    text = hex_text.strip()
    if text.startswith('0x'):
        text = text[2:]
    data = bytes.fromhex(text)
    if len(data) <= PRELUDE_LENGTH + len(EOF_NO_DICT) or data[0] != 0x7F:
        raise ValueError('not stylus-tools deployment init code')
    code = data[PRELUDE_LENGTH:]
    declared = int.from_bytes(data[1:33], 'big')
    if declared != len(code):
        raise ValueError(f'prelude declares {declared} code bytes, found {len(code)}')
    if code[:4] != EOF_NO_DICT:
        raise ValueError('code does not start with the Stylus EOF prefix EFF00000')
    return {
        'initcode_bytes': len(data), 'initcode_sha256': sha256_bytes(data),
        'deployed_code_bytes': len(code), 'deployed_code_sha256': sha256_bytes(code),
        'brotli_compressed_wasm_bytes': len(code) - 4,
        'fits_single_contract_limit': len(code) <= MAX_CODE_SIZE,
    }


def classify_container_failure(text):
    lowered = text.lower()
    if 'missing field `workspace`' in lowered or 'missing field `networks`' in lowered:
        return 'Stylus.toml lacks the [workspace] table that cargo-stylus 0.10.10 requires'
    if 'optimizer' in lowered and any(s in lowered for s in (
            'failed to read', 'failed to load manifest', 'no such file or directory')):
        return ('path dependency ../optimizer is outside the mounted Cargo workspace root '
                '(rust/stylus-wrapper), so it does not exist inside the container')
    if 'not found locally nor on docker hub' in lowered or 'manifest unknown' in lowered:
        return 'cargo-stylus base image is unavailable'
    return 'unclassified failure; see stderr in the artifact'


def check_tag(ls_remote_text, tag, expected):
    refs = {}
    for line in ls_remote_text.splitlines():
        if '\t' in line:
            sha, ref = line.split('\t', 1)
            refs[ref.strip()] = sha.strip()
    resolved = refs.get(f'refs/tags/{tag}^{{}}') or refs.get(f'refs/tags/{tag}')
    return resolved == expected, resolved


def rust_format_template(source):
    """Extract the Dockerfile template that stylus-tools create_image() formats."""
    match = re.search(r'let dockerfile_content = format!\(\s*r#"(.*?)"#\s*\);', source, re.S)
    if not match:
        raise ValueError('Dockerfile template not found in reproducible.rs')
    return match.group(1)


def render_dockerfile(source, base_image, toolchain):
    # Rust and Python share `{name}` placeholders and `{{`/`}}` escapes for this template.
    return rust_format_template(source).format(
        base_image=base_image, toolchain_version=toolchain, binaryen_layer='')


def load_commands(directory):
    commands = []
    for path in sorted(Path(directory).glob('*.json')):
        entry = json.loads(path.read_text())
        entry['stdout_file'] = path.with_suffix('.stdout').name
        entry['stderr_file'] = path.with_suffix('.stderr').name
        commands.append(entry)
    return commands


def sha256sum_lines(text):
    result = {}
    for line in text.splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2 and re.fullmatch(r'[0-9a-f]{64}', parts[0]):
            result[parts[1].strip().lstrip('*')] = parts[0]
    return result


def key_values(text):
    return dict(line.split(': ', 1) for line in text.splitlines() if ': ' in line)


class Evidence:
    def __init__(self, directory):
        self.dir = Path(directory)
        self.commands = load_commands(self.dir / 'commands') if (self.dir / 'commands').is_dir() else []
        self.by_name = {c['name']: c for c in self.commands}

    def exit(self, name):
        entry = self.by_name.get(name)
        return None if entry is None else entry['exit_code']

    def out(self, name, stream='stdout'):
        entry = self.by_name.get(name)
        if entry is None:
            return ''
        path = self.dir / 'commands' / entry[f'{stream}_file']
        return path.read_text(errors='replace') if path.exists() else ''

    def file_sha(self, relative):
        path = self.dir / relative
        return sha256_bytes(path.read_bytes()) if path.is_file() else None


def assemble(directory):
    ev = Evidence(directory)
    wasm_path = ev.dir / WASM_NAME
    record = {
        'schema': 'ponte-stylus-unactivated-candidate-provenance/v1',
        'label': LABEL, 'scope': SCOPE, 'not_performed': NOT_PERFORMED,
        'sepolia': ('Not checked. A later, separately approved read-only `cargo stylus check` '
                    'against Arbitrum Sepolia (chain ID 421614) is a different step.'),
        'github': {k: os.environ.get(v) for k, v in {
            'repository': 'GITHUB_REPOSITORY', 'workflow': 'GITHUB_WORKFLOW', 'run_id': 'GITHUB_RUN_ID',
            'run_attempt': 'GITHUB_RUN_ATTEMPT', 'event': 'GITHUB_EVENT_NAME', 'ref': 'GITHUB_REF',
            'sha': 'GITHUB_SHA', 'runner_os': 'RUNNER_OS', 'image_os': 'ImageOS',
            'image_version': 'ImageVersion'}.items()},
    }
    inputs = sha256sum_lines(ev.out('input-hashes'))
    record['source'] = {
        'ponte_commit': ev.out('ponte-head').strip() or None,
        'worktree_clean_before_build': ev.exit('ponte-worktree') == 0 and not ev.out('ponte-worktree').strip(),
        'input_sha256': inputs,
    }
    tag_ok, tag_commit = check_tag(ev.out('sdk-tag'), os.environ.get('SDK_RELEASE', 'v0.10.10'),
                                   os.environ.get('SDK_COMMIT', ''))
    cli_version = ev.out('cli-version').strip()
    record['stylus_cli'] = {
        'repository': os.environ.get('SDK_REPOSITORY'), 'release': os.environ.get('SDK_RELEASE'),
        'expected_commit': os.environ.get('SDK_COMMIT'), 'checked_out_commit': ev.out('sdk-head').strip() or None,
        'release_tag_resolves_to': tag_commit, 'release_tag_matches': tag_ok,
        'source_directory': 'cargo-stylus/', 'sdk_input_sha256': sha256sum_lines(ev.out('sdk-input-hashes')),
        'install_command': ev.by_name.get('cli-install', {}).get('argv'),
        'install_exit_code': ev.exit('cli-install'),
        'binary_sha256': next(iter(sha256sum_lines(ev.out('cli-binary-sha256')).values()), None),
        'reported_version': cli_version or None,
        'help_checked': {n: ev.exit(f'cli-{n}-help') for n in ('check', 'deploy', 'build', 'get-initcode')},
    }
    rustc, cargo = key_values(ev.out('rustc-version')), key_values(ev.out('cargo-version'))
    record['toolchain'] = {
        'rustc': (ev.out('rustc-version').splitlines() or [None])[0], 'rustc_commit': rustc.get('commit-hash'),
        'host': rustc.get('host'), 'llvm': rustc.get('LLVM version'),
        'cargo': (ev.out('cargo-version').splitlines() or [None])[0], 'cargo_commit': cargo.get('commit-hash'),
        'installed_targets': ev.out('installed-targets').split(),
        'wrapper_active_toolchain': ev.out('wrapper-toolchain').strip() or None,
        'rustup': (ev.out('rustup-version').splitlines() or [None])[0],
    }
    artifact = {'file': WASM_NAME, 'present': wasm_path.is_file()}
    if wasm_path.is_file():
        blob = wasm_path.read_bytes()
        artifact.update({'bytes': len(blob), 'sha256': sha256_bytes(blob),
                         'build_command': ev.by_name.get('release-build', {}).get('argv'),
                         'build_cwd': ev.by_name.get('release-build', {}).get('cwd')})
        try:
            parsed = parse_wasm(blob)
            artifact.update(parsed)
            artifact['vm_hooks'] = [i['name'] for i in parsed['imports'] if i['module'] == 'vm_hooks']
        except ValueError as exc:
            artifact['parse_error'] = str(exc)
        artifact['embedded_absolute_paths'] = embedded_paths(blob)
    record['raw_wasm'] = artifact
    abi = {
        'sdk_export_sha256': ev.file_sha('abi/ponte-synthetic-abi.sol'),
        'sdk_export_check_exit_code': ev.exit('sdk-abi-check'),
        'client_abi_json_sha256': ev.file_sha('abi/SyntheticOptimizer.abi.json'),
        'client_interface_sol_sha256': ev.file_sha('abi/ISyntheticOptimizer.sol'),
        'cargo_stylus_export_abi_exit_code': ev.exit('cli-export-abi'),
        'cargo_stylus_export_abi_sha256': ev.file_sha('abi/cargo-stylus-export-abi.sol'),
    }
    abi['cargo_stylus_export_abi_matches_sdk_export'] = (
        abi['cargo_stylus_export_abi_sha256'] is not None
        and abi['cargo_stylus_export_abi_sha256'] == abi['sdk_export_sha256'])
    record['abi'] = abi
    record['tests'] = [{'name': n, 'exit_code': ev.exit(n)} for n in TESTS]
    cli_build = {
        'command': ev.by_name.get('cli-build', {}).get('argv'), 'exit_code': ev.exit('cli-build'),
        'raw_wasm_sha256': ev.file_sha('cli/cargo-stylus-build.wasm'),
        'identical_to_direct_build': ev.exit('cli-build-identical') == 0 if ev.exit('cli-build-identical') is not None else None,
    }
    if ev.exit('cli-build') not in (None, 0):
        cli_build['failure'] = classify_container_failure(ev.out('cli-build', 'stderr'))
    initcode = {'command': ev.by_name.get('cli-get-initcode', {}).get('argv'), 'exit_code': ev.exit('cli-get-initcode'),
                'note': ('Host-path-dependent: cargo-stylus hashes absolute source paths into the '
                         'project_hash section, so this is not the reproducible deployment payload.')}
    hex_path = ev.dir / 'cli' / 'initcode.hex'
    if ev.exit('cli-get-initcode') == 0 and hex_path.is_file() and hex_path.stat().st_size:
        try:
            initcode.update(initcode_summary(hex_path.read_text()))
        except ValueError as exc:
            initcode['parse_error'] = str(exc)
    elif ev.exit('cli-get-initcode') not in (None, 0):
        stderr = ev.out('cli-get-initcode', 'stderr')
        initcode['failure'] = ('compressed program exceeds the 24,576-byte single-contract limit; '
                               'cargo-stylus would deploy it as fragments' if 'fragmented' in stderr
                               else classify_container_failure(stderr))
    cli_build['get_initcode'] = initcode
    record['cargo_stylus_build_path'] = cli_build
    relocated_sha = ev.file_sha('reproducibility/relocated-checkout.wasm')
    record['reproducibility'] = {
        'relocated_checkout_build_exit_code': ev.exit('relocated-build'),
        'relocated_checkout_sha256': relocated_sha,
        'relocated_checkout_identical': None if relocated_sha is None else relocated_sha == artifact.get('sha256'),
        'fresh_target_dir_identical': cli_build['identical_to_direct_build'],
    }
    base_inspect = ev.out('docker-base-inspect').strip()
    docker = {
        'base_image': f"offchainlabs/cargo-stylus-base:{os.environ.get('CLI_VERSION', '0.10.10')}",
        'published_on_docker_hub': ev.exit('docker-hub-manifest') == 0 if ev.exit('docker-hub-manifest') is not None else None,
        'base_image_source': (ev.dir / 'docker' / 'base-image-source.txt').read_text().strip()
        if (ev.dir / 'docker' / 'base-image-source.txt').is_file() else None,
        'base_image_id_and_digests': base_inspect or None,
        'derived_image_dockerfile_sha256': ev.file_sha('docker/Dockerfile.reproducible'),
        'derived_image_build_exit_code': ev.exit('docker-derived-build'),
        'derived_image_id': ev.out('docker-derived-inspect').strip() or None,
        'container_cli_version': ev.out('container-cli-version').strip() or None,
        'container_rustc': (ev.out('container-rust-version').splitlines() or [None])[0],
        'official_path': {
            'description': ('Same image, --network host, --workdir /source and single '
                            '<cargo workspace root>:/source volume as cargo-stylus run_in_container(); '
                            'offline `cargo stylus build` instead of deploy/verify; --rm added.'),
            'command': ev.by_name.get('official-path-build', {}).get('argv'),
            'exit_code': ev.exit('official-path-build'),
        },
        'diagnostic_full_repository_build': {
            'description': 'Diagnostic only, not a cargo-stylus code path: whole repository mounted read-only at /ponte.',
            'command': ev.by_name.get('diagnostic-container-build', {}).get('argv'),
            'exit_code': ev.exit('diagnostic-container-build'),
            'raw_wasm_sha256': ev.file_sha('docker/diagnostic-container.wasm'),
        },
    }
    if docker['official_path']['exit_code'] not in (None, 0):
        docker['official_path']['failure'] = classify_container_failure(ev.out('official-path-build', 'stderr'))
    diag = docker['diagnostic_full_repository_build']
    diag['identical_to_host_build'] = None if diag['raw_wasm_sha256'] is None else diag['raw_wasm_sha256'] == artifact.get('sha256')
    if diag['exit_code'] not in (None, 0):
        diag['failure'] = classify_container_failure(ev.out('diagnostic-container-build', 'stderr'))
    record['reproducible_docker_path'] = docker
    record['integrity'] = {n: ev.exit(n) for n in ('lockfiles-unchanged', 'tracked-files-unchanged', 'sdk-tree-unchanged')}
    missing = [n for n in REQUIRED if ev.exit(n) is None]
    failed = [n for n in REQUIRED if ev.exit(n) not in (None, 0)]
    record['status'] = 'complete' if not missing and not failed and artifact['present'] else 'incomplete'
    record['missing_required_commands'], record['failed_required_commands'] = missing, failed
    record['commands'] = [{k: c.get(k) for k in ('name', 'mode', 'stage', 'argv', 'cwd', 'started_utc',
                                                   'ended_utc', 'exit_code', 'stdout_file', 'stderr_file')}
                          for c in ev.commands]
    (ev.dir / 'provenance.json').write_text(json.dumps(record, indent=2) + '\n')
    markdown = render_markdown(record)
    (ev.dir / 'provenance.md').write_text(markdown)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
            summary.write(markdown)
    annotate(record)
    return record


def short(value, size=12):
    return value[:size] + '…' if isinstance(value, str) and len(value) > size else value


def annotate(r):
    a, cli, tc, d = r['raw_wasm'], r['stylus_cli'], r['toolchain'], r['reproducible_docker_path']
    notice('Unactivated candidate artifact',
           f"{LABEL} Raw WASM {a.get('bytes')} bytes, SHA-256 {a.get('sha256')}. "
           f"PONTE commit {r['source']['ponte_commit']}. Record status: {r['status']}.")
    notice('Stylus CLI (pinned source)',
           f"cargo stylus --version: {cli['reported_version']}; {cli['repository']} {cli['release']} commit "
           f"{cli['checked_out_commit']}; tag resolves to {cli['release_tag_resolves_to']} "
           f"(match={cli['release_tag_matches']}); binary SHA-256 {cli['binary_sha256']}; install exit "
           f"{cli['install_exit_code']}; help exits {cli['help_checked']}.")
    notice('Rust toolchain',
           f"{tc['rustc']} (commit {tc['rustc_commit']}); {tc['cargo']}; host {tc['host']}; installed targets "
           f"{', '.join(tc['installed_targets'])}; wrapper selects {tc['wrapper_active_toolchain']}.")
    notice('Source inputs (SHA-256)', '; '.join(f'{k} {v}' for k, v in r['source']['input_sha256'].items()) or 'missing')
    notice('WASM exports and VM hooks',
           f"exports {[(e['name'], e['kind']) for e in a.get('exports', [])]}; vm_hooks imports {a.get('vm_hooks')}; "
           f"custom sections {[(c['name'], c['size']) for c in a.get('custom_sections', [])]}.")
    ab = r['abi']
    notice('ABI', f"SDK export SHA-256 {ab['sdk_export_sha256']} (check_abi.py exit {ab['sdk_export_check_exit_code']}); "
                  f"cargo stylus export-abi exit {ab['cargo_stylus_export_abi_exit_code']}, SHA-256 "
                  f"{ab['cargo_stylus_export_abi_sha256']}, matches SDK export {ab['cargo_stylus_export_abi_matches_sdk_export']}; "
                  f"client ABI JSON {ab['client_abi_json_sha256']}; interface {ab['client_interface_sol_sha256']}.")
    notice('Offline tests', '; '.join(f"{t['name']}={t['exit_code']}" for t in r['tests']))
    b = r['cargo_stylus_build_path']
    notice('cargo-stylus offline build path',
           f"cargo stylus build (fresh target dir) exit {b['exit_code']}{'; ' + b['failure'] if b.get('failure') else ''}; "
           f"raw WASM identical to direct build: {b['identical_to_direct_build']}; get-initcode: "
           + json.dumps({k: v for k, v in b['get_initcode'].items() if k not in ('command', 'note')}))
    rp = r['reproducibility']
    paths = {k: v['count'] for k, v in a.get('embedded_absolute_paths', {}).items()}
    examples = [e for v in a.get('embedded_absolute_paths', {}).values() for e in v['examples'][:2]]
    notice('Build-path reproducibility',
           f"relocated checkout identical: {rp['relocated_checkout_identical']} (SHA-256 {rp['relocated_checkout_sha256']}); "
           f"fresh target dir identical: {rp['fresh_target_dir_identical']}; embedded absolute paths {paths}; "
           f"examples {examples[:6]}.")
    op, dg = d['official_path'], d['diagnostic_full_repository_build']
    notice('Reproducible Docker path',
           f"{d['base_image']}: on Docker Hub {d['published_on_docker_hub']}, source {d['base_image_source']}, "
           f"{short(d['base_image_id_and_digests'], 160)}; container CLI {d['container_cli_version']}; "
           f"CLI-equivalent run (workspace root only at /source) exit {op['exit_code']}"
           f"{' - ' + op['failure'] if op.get('failure') else ''}; diagnostic full-repository build exit "
           f"{dg['exit_code']}, SHA-256 {dg['raw_wasm_sha256']}, identical to host {dg['identical_to_host_build']}.")
    if r['status'] != 'complete':
        notice('Provenance record incomplete',
               f"missing {r['missing_required_commands']}; failed {r['failed_required_commands']}", 'error')


def code_list(items, key, detail, suffix=''):
    return ', '.join('`%s` (%s%s)' % (item[key], item[detail], suffix) for item in items)


def render_markdown(r):
    a, cli, tc = r['raw_wasm'], r['stylus_cli'], r['toolchain']
    lines = [
        '# PONTE Stylus candidate artifact — provenance', '',
        f"> **{LABEL}**", '>', f"> {SCOPE}", '',
        f"Record status: **{r['status']}**.", '',
        '## Artifact', '',
        '| Field | Value |', '| --- | --- |',
        f"| Raw WASM | `{a.get('file')}` — {a.get('bytes')} bytes |",
        f"| SHA-256 | `{a.get('sha256')}` |",
        f"| Build command | `{' '.join(a.get('build_command') or [])}` in `{a.get('build_cwd')}` |",
        f"| PONTE commit | `{r['source']['ponte_commit']}` |",
        f"| Exports | {code_list(a.get('exports', []), 'name', 'kind')} |",
        f"| `vm_hooks` imports | {', '.join('`%s`' % h for h in a.get('vm_hooks') or [])} |",
        f"| Custom sections | {code_list(a.get('custom_sections', []), 'name', 'size', ' B') or 'none'} |",
        '', '## Toolchain and CLI', '',
        '| Field | Value |', '| --- | --- |',
        f"| rustc | `{tc['rustc']}` (commit `{tc['rustc_commit']}`), host `{tc['host']}` |",
        f"| cargo | `{tc['cargo']}` |",
        f"| Installed targets | {', '.join('`%s`' % t for t in tc['installed_targets'])} |",
        f"| cargo-stylus | `{cli['reported_version']}` from `{cli['repository']}` `{cli['release']}` at `{cli['checked_out_commit']}` |",
        f"| Release tag resolves to | `{cli['release_tag_resolves_to']}` (match: {cli['release_tag_matches']}) |",
        f"| CLI binary SHA-256 | `{cli['binary_sha256']}` |",
        f"| CLI install command | `{' '.join(cli['install_command'] or [])}` |",
        '', '## Inputs (SHA-256)', '', '| File | SHA-256 |', '| --- | --- |',
    ]
    lines += [f'| `{k}` | `{v}` |' for k, v in r['source']['input_sha256'].items()]
    lines += ['', '## Tests', '', '| Command | Exit |', '| --- | ---: |']
    lines += [f"| `{t['name']}` | {t['exit_code']} |" for t in r['tests']]
    lines += ['', '## ABI', '', '```json', json.dumps(r['abi'], indent=2), '```',
              '', '## cargo-stylus build path, reproducibility and Docker', '', '```json',
              json.dumps({'cargo_stylus_build_path': r['cargo_stylus_build_path'],
                          'reproducibility': r['reproducibility'],
                          'embedded_absolute_paths': a.get('embedded_absolute_paths'),
                          'reproducible_docker_path': r['reproducible_docker_path']}, indent=2), '```',
              '', '## Not performed', '']
    lines += [f'- {item}' for item in r['not_performed']]
    lines += ['', '## Commands', '', '| # | Stage | Name | Mode | Exit | Started (UTC) | Ended (UTC) |',
              '| ---: | --- | --- | --- | ---: | --- | --- |']
    lines += [f"| {i} | {c['stage']} | `{c['name']}` | {c['mode']} | {c['exit_code']} | {c['started_utc']} | {c['ended_utc']} |"
              for i, c in enumerate(r['commands'])]
    lines.append('')
    return '\n'.join(lines)


def main(argv):
    if len(argv) >= 11 and argv[1] == 'record-command' and argv[10] == '--':
        out, name, mode, stage, cwd, started, ended, code = argv[2:10]
        Path(out).write_text(json.dumps({
            'name': name, 'mode': mode, 'stage': stage, 'argv': argv[11:], 'cwd': cwd,
            'started_utc': started, 'ended_utc': ended, 'exit_code': int(code)}, indent=2) + '\n')
        return 0
    if len(argv) == 5 and argv[1] == 'check-tag':
        ok, resolved = check_tag(Path(argv[2]).read_text(), argv[3], argv[4])
        print(f'{argv[3]} resolves to {resolved}')
        return 0 if ok else 1
    if len(argv) == 5 and argv[1] == 'dockerfile':
        sys.stdout.write(render_dockerfile(Path(argv[2]).read_text(), argv[3], argv[4]))
        return 0
    if len(argv) == 3 and argv[1] == 'assemble':
        return 0 if assemble(argv[2])['status'] == 'complete' else 1
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
