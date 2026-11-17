import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('summarize-dependency-evidence.py')
spec = importlib.util.spec_from_file_location('evidence_summary', SCRIPT)
summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)


class EvidenceSummaryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.addCleanup(self.directory.cleanup)

    def test_graph_does_not_treat_absence_as_artifact_proof(self):
        (self.root / 'wasm.size').write_text('42\n')
        (self.root / 'wasm.sha256').write_text('abcd  contract.wasm\n')
        for target in ('x86_64-unknown-linux-gnu', 'wasm32-unknown-unknown'):
            (self.root / f'stylus-wrapper-{target}-package-list.txt').write_text('crypto-bigint v0.5.5\n')
            for name, version in (('crypto-bigint', '0.5.5'), ('lru', '0.16.4')):
                prefix = self.root / f'wrapper-inverse-{name}@{version}-{target}-normal-build'
                for suffix, value in (('.exit', '0'), ('.txt', ''), ('.stderr', 'nothing to print')):
                    Path(f'{prefix}{suffix}').write_text(value)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            summary.graph(self.root)
        self.assertIn('crypto-bigint 0.5.5: True', output.getvalue())
        self.assertIn('lru 0.16.4: False', output.getvalue())
        self.assertIn('does not establish linkage or runtime reachability', output.getvalue())

    def test_audit_failure_and_findings_remain_visible(self):
        def write(workspace, code, data):
            (self.root / f'{workspace}.exit').write_text(str(code))
            (self.root / f'{workspace}.json').write_text(json.dumps(data))
        clean = {'vulnerabilities': {'list': []}, 'warnings': {}, 'database': {'last-commit': 'db'}}
        write('environment-check', 0, clean)
        write('optimizer', 0, clean)
        affected = {'vulnerabilities': {'list': [{'advisory': {'id': 'RUSTSEC-2026-0387'}, 'package': {'name': 'crypto-bigint', 'version': '0.5.5'}}]},
                    'warnings': {'unsound': [{'advisory': {'id': 'RUSTSEC-2026-0253'}, 'package': {'name': 'lru', 'version': '0.16.4'}}]}}
        write('stylus-wrapper', 1, affected)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(summary.audit(self.root), 1)
        self.assertIn('RUSTSEC-2026-0387 crypto-bigint 0.5.5', output.getvalue())
        self.assertIn('RUSTSEC-2026-0253 lru 0.16.4', output.getvalue())
        write('stylus-wrapper', 0, clean)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(summary.audit(self.root), 0)
        (self.root / 'optimizer.json').write_text('not json')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(summary.audit(self.root), 1)

    def test_notice_escapes_workflow_command_characters(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            summary.notice('Audit', 'one%two\nthree')
        self.assertIn('one%25two%0Athree', output.getvalue())


if __name__ == '__main__':
    unittest.main()
