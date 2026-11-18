#!/usr/bin/env python3
"""Print small, explicitly scoped CI notices; full evidence remains in artifacts."""
import json
import sys
from pathlib import Path


def notice(title, message):
    def escape(value):
        return str(value).replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
    print(f'::notice title={escape(title)}::{escape(message)}')


def graph(out):
    size = (out / 'wasm.size').read_text().strip()
    sha = (out / 'wasm.sha256').read_text().split()[0]
    notice('Release WASM', f'SHA-256={sha}; bytes={size}; artifact build evidence, not Nitro/activation validation')
    for target in ('x86_64-unknown-linux-gnu', 'wasm32-unknown-unknown'):
        listing = (out / f'stylus-wrapper-{target}-package-list.txt').read_text()
        for name, version in (('crypto-bigint', '0.5.5'), ('lru', '0.16.4')):
            found = any(line.startswith(f'{name} v{version}') for line in listing.splitlines())
            prefix = out / f'wrapper-inverse-{name}@{version}-{target}-normal-build'
            code = Path(f'{prefix}.exit').read_text().strip()
            inverse = Path(f'{prefix}.txt').read_text().strip()
            stderr = Path(f'{prefix}.stderr').read_text().strip()
            # Inverse output can be empty even on success; that is a graph result,
            # not a statement about the linked binary or code-level reachability.
            message = (f'{target}: normal+build tree lists {name} {version}: {found}; '
                       f'inverse exit={code}; inverse={inverse[:1300] or "<empty>"}; '
                       f'stderr={stderr[:400] or "<empty>"}. This tree includes host build dependencies; '
                       'it does not establish linkage or runtime reachability.')
            notice('Cargo graph', message)
        for name, version in (('crypto-bigint', '0.5.5'), ('lru', '0.16.4')):
            prefix = out / f'wrapper-inverse-{name}@{version}-{target}-normal-build-dev'
            inverse = Path(f'{prefix}.txt').read_text().strip()
            code = Path(f'{prefix}.exit').read_text().strip()
            notice('Cargo dev-inclusive inverse', f'{target}: {name} {version}: exit={code}; {inverse[:2500] or "<empty>"}')


def audit(out):
    failed = False
    for workspace in ('environment-check', 'optimizer', 'stylus-wrapper'):
        code = int((out / f'{workspace}.exit').read_text())
        try:
            data = json.loads((out / f'{workspace}.json').read_text())
            vulnerabilities = data['vulnerabilities']['list']
            warnings = data['warnings']
            findings = []
            for item in vulnerabilities:
                findings.append(('vulnerability', item['advisory']['id'], item['package']['name'], item['package']['version']))
            for category, items in warnings.items():
                for item in items:
                    advisory = item.get('advisory') or {}
                    findings.append((category, advisory.get('id', '<no advisory ID>'), item['package']['name'], item['package']['version']))
            detail = '; '.join(f'{category} {advisory} {name} {version}' for category, advisory, name, version in findings) or 'none'
            notice('RustSec audit', f'{workspace}: exit={code}; vulnerabilities={len(vulnerabilities)}; warnings={sum(len(x) for x in warnings.values())}; findings: {detail}; database={data.get("database", {})}')
            if findings and code == 0:
                print(f'::error title=RustSec status inconsistent::{workspace}: findings with a zero audit exit')
                failed = True
        except (ValueError, KeyError, TypeError) as exc:
            print(f'::error title=RustSec report invalid::{workspace}: {exc}')
            failed = True
        if code != 0:
            failed = True
    return 1 if failed else 0


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ('graph', 'audit'):
        raise SystemExit('usage: summarize-dependency-evidence.py graph|audit DIRECTORY')
    directory = Path(sys.argv[2])
    if sys.argv[1] == 'graph':
        graph(directory)
    else:
        raise SystemExit(audit(directory))
