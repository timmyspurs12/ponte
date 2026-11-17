import contextlib
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import advisory_guard as guard


class AdvisoryGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def lock(self, filename, packages):
        path = self.root / filename
        entries = ['version = 4\n']
        for name, version, source in packages:
            entries.append('[[package]]\n')
            entries.append(f'name = {json.dumps(name)}\nversion = {json.dumps(version)}\n')
            if source is not None:
                entries.append(f'source = {json.dumps(source)}\n')
        path.write_text(''.join(entries), encoding='utf-8')
        return path

    def test_known_versions_across_multiple_lockfiles(self):
        crypto = self.lock('one.lock', [('crypto-bigint', '0.5.5', guard.REGISTRY)])
        lru = self.lock('two.lock', [('lru', '0.16.4', guard.REGISTRY)])
        items = guard.inspect([lru, crypto])['findings']
        self.assertEqual([(x['package'], x['version'], x['advisory'], x['status']) for x in items], [
            ('crypto-bigint', '0.5.5', 'RUSTSEC-2026-0387', 'affected'),
            ('lru', '0.16.4', 'RUSTSEC-2026-0253', 'affected'),
        ])
        self.assertEqual([x['lockfile'] for x in items], [crypto.as_posix(), lru.as_posix()])
        self.assertTrue(all(x['classification'] == 'unclassified' and x['reachability'] == 'unknown' for x in items))

    def test_fixed_thresholds_unrelated_and_absent(self):
        path = self.lock('versions.lock', [
            ('crypto-bigint', '0.7.5', guard.REGISTRY),
            ('crypto-bigint', '0.7.6', guard.REGISTRY),
            ('crypto-bigint', '0.8.0', guard.REGISTRY),
            ('lru', '0.18.1', guard.REGISTRY),
            ('lru', '0.18.2', guard.REGISTRY),
            ('lru', '1.0.0+build.1', guard.REGISTRY),
            ('unrelated', '0.5.5', guard.REGISTRY),
        ])
        items = guard.inspect([path])['findings']
        self.assertEqual([(x['package'], x['version'], x['status']) for x in items], [
            ('crypto-bigint', '0.7.5', 'affected'),
            ('crypto-bigint', '0.7.6', 'not_affected_by_pinned_rule'),
            ('crypto-bigint', '0.8.0', 'not_affected_by_pinned_rule'),
            ('lru', '0.18.1', 'affected'),
            ('lru', '0.18.2', 'not_affected_by_pinned_rule'),
            ('lru', '1.0.0+build.1', 'not_affected_by_pinned_rule'),
        ])
        absent = self.lock('absent.lock', [('unrelated', '0.16.4', guard.REGISTRY)])
        self.assertEqual(guard.inspect([absent])['findings'], [])

    def test_other_sources_and_prereleases_are_unknown(self):
        path = self.lock('unknown.lock', [
            ('crypto-bigint', '0.7.6-rc.1', guard.REGISTRY),
            ('lru', '99.0.0', 'git+https://example.invalid/project#abc'),
            ('lru', '0.16.4', None),
        ])
        items = guard.inspect([path])['findings']
        self.assertEqual([x['status'] for x in items], ['unknown'] * 3)
        self.assertTrue(all(x['classification'] == 'unclassified' for x in items))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(guard.main(['--lockfile', str(path)]), 1)

    def test_duplicate_entries_and_duplicate_paths_fail(self):
        path = self.lock('duplicates.lock', [
            ('lru', '0.16.4', guard.REGISTRY),
            ('lru', '0.16.4', guard.REGISTRY),
        ])
        with self.assertRaisesRegex(guard.GuardError, 'duplicate package entry'):
            guard.inspect([path])
        valid = self.lock('valid.lock', [('lru', '0.16.4', guard.REGISTRY)])
        with self.assertRaisesRegex(guard.GuardError, 'duplicate lockfile path'):
            guard.inspect([valid, self.root / '.' / 'valid.lock'])
        # The same identity in different lockfiles is two separate findings.
        other = self.lock('other.lock', [('lru', '0.16.4', guard.REGISTRY)])
        self.assertEqual(len(guard.inspect([valid, other])['findings']), 2)

    def test_missing_malformed_unsupported_and_invalid_versions_fail(self):
        malformed = self.root / 'bad.lock'
        malformed.write_text('not = [toml', encoding='utf-8')
        unsupported = self.root / 'unsupported.lock'
        unsupported.write_text('version = 1\n[[package]]\nname = "lru"\nversion = "1.0.0"\n', encoding='utf-8')
        invalid = self.lock('bad-version.lock', [('lru', '0.18.2-rc.01', guard.REGISTRY)])
        missing_version = self.root / 'missing-version.lock'
        missing_version.write_text('version = 4\n[[package]]\nname = "lru"\n', encoding='utf-8')
        for path in (self.root / 'missing.lock', self.root, malformed, unsupported, invalid, missing_version):
            with self.subTest(path=path), self.assertRaises(guard.GuardError):
                guard.inspect([path])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = guard.main(['--json', '--lockfile', str(malformed)])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(output.getvalue())['status'], 'error')

    def test_strict_lockfile_and_semver_validation(self):
        floating = self.root / 'floating.lock'
        floating.write_text('version = 4.0\n[[package]]\nname = "lru"\nversion = "0.16.4"\n', encoding='utf-8')
        unicode_digits = self.lock('unicode.lock', [('lru', '0.١٨.2', guard.REGISTRY)])
        for path in (floating, unicode_digits):
            with self.subTest(path=path), self.assertRaises(guard.GuardError):
                guard.inspect([path])
        limit = sys.get_int_max_str_digits()
        if 0 < limit < 100000:
            huge = self.lock('huge.lock', [('lru', '1.' + '1' * (limit + 1) + '.0', guard.REGISTRY)])
            with self.assertRaises(guard.GuardError):
                guard.inspect([huge])
        loop = self.root / 'loop.lock'
        loop.symlink_to(loop.name)
        with self.assertRaises(guard.GuardError):
            guard.inspect([loop])
        readable = self.lock('unreadable.lock', [('lru', '0.16.4', guard.REGISTRY)])
        with mock.patch.object(Path, 'open', side_effect=PermissionError('permission denied')):
            with self.assertRaisesRegex(guard.GuardError, 'cannot read lockfile'):
                guard.inspect([readable])
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(guard.main(['--json', '--lockfile', str(readable)]), 2)

    def test_discovers_root_and_deeply_nested_tracked_lockfiles(self):
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True, capture_output=True)
        tracked = ['Cargo.lock', 'one/Cargo.lock', 'deep/one/two/Cargo.lock']
        for name in tracked + ['untracked/Cargo.lock', 'deep/NotCargo.lock']:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('version = 4\n[[package]]\nname = "other"\nversion = "1.0.0"\n', encoding='utf-8')
        subprocess.run(['git', 'add', '--', *tracked], cwd=self.root, check=True, capture_output=True)
        with mock.patch.object(guard, 'ROOT', self.root):
            found = guard.tracked_lockfiles()
        self.assertEqual([p.relative_to(self.root).as_posix() for p in found], sorted(tracked))

    def test_actual_baseline_and_release_gate(self):
        report = guard.inspect(guard.tracked_lockfiles())
        self.assertEqual(report['baseline_missing'], [])
        self.assertEqual([(x['package'], x['version'], x['advisory'], x['status'], x['classification'])
                          for x in report['findings']], [
            ('crypto-bigint', '0.5.5', 'RUSTSEC-2026-0387', 'affected', 'documented_baseline'),
            ('lru', '0.16.4', 'RUSTSEC-2026-0253', 'affected', 'documented_baseline'),
        ])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(guard.main(['--check-baseline']), 0)
            self.assertEqual(guard.main(['--release-gate']), 1)
        path = self.lock('new-version.lock', [('lru', '0.18.2', guard.REGISTRY)])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(guard.main(['--lockfile', str(path), '--check-baseline']), 1)
        new_affected = self.lock('new-affected.lock', [('lru', '0.17.0', guard.REGISTRY)])
        current = [str(p) for p in guard.tracked_lockfiles()]
        args = [part for p in current + [str(new_affected)] for part in ('--lockfile', p)]
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(guard.main(args + ['--json', '--check-baseline']), 1)
        extra = [x for x in json.loads(output.getvalue())['findings'] if x['version'] == '0.17.0']
        self.assertEqual(len(extra), 1)
        self.assertEqual((extra[0]['status'], extra[0]['classification']), ('affected', 'unclassified'))

    def test_stable_json_and_no_socket_access(self):
        script = guard.ROOT / 'rust/stylus-wrapper/scripts/advisory_guard.py'
        # Python startup refuses socket creation; the guard and its git ls-files
        # subprocess still work. No advisory database or network is consulted.
        (self.root / 'sitecustomize.py').write_text(
            'import socket\n'
            'def blocked(*args, **kwargs):\n'
            '    raise RuntimeError("network access forbidden in test")\n'
            'socket.socket = blocked\n', encoding='utf-8')
        env = dict(os.environ, PYTHONPATH=str(self.root))
        command = [sys.executable, str(script), '--json', '--check-baseline']
        with mock.patch.object(socket, 'socket', side_effect=AssertionError('unexpected network')):
            first = subprocess.run(command, cwd=guard.ROOT, env=env, capture_output=True, text=True, check=True)
            second = subprocess.run(command, cwd=guard.ROOT, env=env, capture_output=True, text=True, check=True)
        self.assertEqual(first.stdout, second.stdout)
        parsed = json.loads(first.stdout)
        self.assertEqual(parsed['status'], 'affected')
        self.assertEqual(parsed['baseline_status'], 'matches')
        self.assertIn('does not establish', parsed['scope'])


if __name__ == '__main__':
    unittest.main()
