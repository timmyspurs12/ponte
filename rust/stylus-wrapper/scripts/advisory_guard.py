#!/usr/bin/env python3
"""Offline, deliberately limited guard for two documented Cargo advisories."""

import argparse
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"
RULES = {
    "crypto-bigint": {
        "advisory": "RUSTSEC-2026-0387",
        "issued": "2026-10-23",
        "fixed": "0.7.6",
    },
    "lru": {
        "advisory": "RUSTSEC-2026-0253",
        "issued": "2026-08-11",
        "fixed": "0.18.2",
    },
}
# This records observed identities, NOT a vulnerability waiver or a release approval.
BASELINE = {
    ("rust/Cargo.lock", "crypto-bigint", "0.5.5", REGISTRY),
    ("rust/Cargo.lock", "lru", "0.16.4", REGISTRY),
}
SCOPE = (
    "Only RUSTSEC-2026-0387 and RUSTSEC-2026-0253 are checked using pinned "
    "rules; advisory data is not refreshed. Lockfile presence does not establish "
    "target-specific reachability or exploitability. This is not a complete audit."
)
SEMVER = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)


class GuardError(Exception):
    pass


def version_parts(version):
    match = SEMVER.fullmatch(version)
    if not match:
        raise GuardError(f"invalid package version: {version!r}")
    prerelease = match.group(4)
    if prerelease and any(
        part.isdigit() and len(part) > 1 and part.startswith("0")
        for part in prerelease.split(".")
    ):
        raise GuardError(f"invalid prerelease version: {version!r}")
    try:
        return tuple(int(match.group(i)) for i in (1, 2, 3)), prerelease
    except ValueError as exc:
        raise GuardError(f"invalid package version: {version!r}") from exc


def tracked_lockfiles():
    try:
        proc = subprocess.run(
            ["git", "ls-files", "-z", "--", "Cargo.lock", "*/Cargo.lock"],
            cwd=ROOT,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise GuardError(f"cannot enumerate tracked Cargo lockfiles: {exc}") from exc
    paths = [ROOT / p.decode("utf-8") for p in proc.stdout.split(b"\0") if p]
    if not paths:
        raise GuardError("no tracked Cargo lockfiles found")
    return paths


def resolve_path(path):
    try:
        return path.resolve()
    except (OSError, RuntimeError) as exc:
        raise GuardError(f"cannot resolve lockfile path {path}: {exc}") from exc


def path_label(path):
    resolved = resolve_path(path)
    try:
        return resolved.relative_to(ROOT).as_posix()
    except ValueError:
        return resolved.as_posix()


def inspect(paths):
    if not paths:
        raise GuardError("no lockfiles provided")
    results = []
    seen_paths = set()
    observed = set()
    for path in paths:
        path = Path(path)
        resolved = resolve_path(path)
        if resolved in seen_paths:
            raise GuardError(f"duplicate lockfile path: {path_label(path)}")
        seen_paths.add(resolved)
        label = path_label(path)
        try:
            with path.open("rb") as handle:
                lock = tomllib.load(handle)
        except (OSError, tomllib.TOMLDecodeError, UnicodeDecodeError) as exc:
            raise GuardError(f"cannot read lockfile {label}: {exc}") from exc
        packages = lock.get("package")
        format_version = lock.get("version")
        if (type(format_version) is not int or format_version not in (3, 4)
                or not isinstance(packages, list) or not packages):
            raise GuardError(f"invalid or unsupported Cargo lockfile: {label}")
        seen_packages = set()
        for package in packages:
            if not isinstance(package, dict):
                raise GuardError(f"invalid package entry in {label}")
            name, version, source = package.get("name"), package.get("version"), package.get("source")
            if not isinstance(name, str) or not name or not isinstance(version, str):
                raise GuardError(f"package missing name or version in {label}")
            if source is not None and (not isinstance(source, str) or not source):
                raise GuardError(f"invalid package source for {name} in {label}")
            parts, prerelease = version_parts(version)
            identity = (name, version, source)
            if identity in seen_packages:
                raise GuardError(f"duplicate package entry in {label}: {name} {version} {source}")
            seen_packages.add(identity)
            if name not in RULES:
                continue
            rule = RULES[name]
            baseline_id = (label, name, version, source)
            observed.add(baseline_id)
            if source != REGISTRY or prerelease:
                status = "unknown"
            elif parts < version_parts(rule["fixed"])[0]:
                status = "affected"
            else:
                status = "not_affected_by_pinned_rule"
            results.append({
                "lockfile": label,
                "package": name,
                "version": version,
                "source": source,
                "advisory": rule["advisory"],
                "issued": rule["issued"],
                "fixed": f">={rule['fixed']}",
                "status": status,
                "classification": "documented_baseline" if baseline_id in BASELINE else "unclassified",
                "reachability": "unknown",
            })
    results.sort(key=lambda x: (x["lockfile"], x["package"], x["version"], x["source"] or ""))
    missing = [
        {"lockfile": path, "package": package, "version": version, "source": source}
        for path, package, version, source in sorted(BASELINE - observed)
    ]
    return {
        "scope": SCOPE,
        "lockfiles": sorted(path_label(p) for p in paths),
        "findings": results,
        "baseline_missing": missing,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lockfile", action="append", type=Path,
                        help="inspect this file (repeatable); default: all tracked Cargo.lock files")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    parser.add_argument("--check-baseline", action="store_true", help="fail if tracked identities differ from baseline")
    parser.add_argument("--release-gate", action="store_true", help="also fail when any finding is affected or unknown")
    args = parser.parse_args(argv)
    try:
        report = inspect(args.lockfile if args.lockfile is not None else tracked_lockfiles())
    except (GuardError, UnicodeError) as exc:
        if args.json:
            print(json.dumps({"scope": SCOPE, "status": "error", "error": str(exc)}, sort_keys=True))
        else:
            print(f"ERROR: {exc}\n{SCOPE}", file=sys.stderr)
        return 2

    findings = report["findings"]
    drift = bool(report["baseline_missing"] or any(x["classification"] == "unclassified" for x in findings))
    unknown = any(x["status"] == "unknown" for x in findings)
    affected = any(x["status"] == "affected" for x in findings)
    report["status"] = "unknown" if unknown else "affected" if affected else "not_affected_by_pinned_rules"
    report["baseline_status"] = "changed" if drift else "matches"
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(SCOPE)
        for path in report["lockfiles"]:
            print(f"Lockfile: {path}")
        for item in findings:
            print(f"{item['status'].upper()} {item['advisory']} {item['package']} {item['version']} "
                  f"in {item['lockfile']} source={item['source'] or '<none>'} "
                  f"fixed={item['fixed']} classification={item['classification']} reachability=unknown")
        for item in report["baseline_missing"]:
            print(f"BASELINE MISSING {item['package']} {item['version']} in {item['lockfile']}")
        print(f"Result: {report['status']}; baseline: {report['baseline_status']}")
        if not findings:
            print("No matching packages found; this does not mean the dependencies are safe.")
    if unknown or (args.check_baseline and drift) or (args.release_gate and (affected or drift)):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
