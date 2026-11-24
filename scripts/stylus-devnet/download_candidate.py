#!/usr/bin/env python3
"""Download and integrity-check the immutable PONTE Actions WASM candidate."""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = "timmyspurs12/ponte"
RUN_ID = 44398147388
ARTIFACT_ID = 14471989038
SOURCE_SHA = "d3dae37f6032fbdea39d1834ef053c5676fb6a43"
ARTIFACT_NAME = (
    "ponte-stylus-unactivated-candidate-"
    "d3dae37f6032fbdea39d1834ef053c5676fb6a43-44398147388-1"
)
ARTIFACT_SHA256 = "cea8a6656c2d92ba4357afa3e0ace23feb4af037f43ce151a33c561a87df80c2"
ARTIFACT_SIZE = 457057
WASM_MEMBER = "docker/official-container-1.wasm"
WASM_SIZE = 90731
WASM_SHA256 = "42d8a474d8762aa37df09c9c415dcec1ff7e904e8bfcdcfa365669ad30cd93d2"
API = "https://api.github.com"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Keep the GitHub bearer token off the signed artifact-storage URL."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N802
        return None


def api_get(path: str, token: str) -> tuple[bytes, dict[str, str]]:
    req = urllib.request.Request(
        API + path,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "ponte-local-stylus-proof",
        },
    )
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=60) as response:
            return response.read(), dict(response.headers.items())
    except urllib.error.HTTPError as error:
        if error.code in (301, 302, 303, 307, 308):
            return b"", dict(error.headers.items())
        detail = error.read().decode("utf-8", "replace")
        raise RuntimeError(f"GitHub API request failed ({error.code}): {detail}") from error


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: download_candidate.py EVIDENCE_DIR")
    evidence = Path(sys.argv[1])
    evidence.mkdir(parents=True, exist_ok=True)
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        raise SystemExit("GITHUB_TOKEN is required only to read the pinned Actions artifact")

    run_bytes, _ = api_get(f"/repos/{REPOSITORY}/actions/runs/{RUN_ID}", token)
    run = json.loads(run_bytes)
    if run.get("id") != RUN_ID or run.get("head_sha") != SOURCE_SHA:
        raise RuntimeError("artifact run is not tied to the required source commit")
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        raise RuntimeError("source artifact run did not complete successfully")

    artifact_bytes, _ = api_get(f"/repos/{REPOSITORY}/actions/artifacts/{ARTIFACT_ID}", token)
    artifact = json.loads(artifact_bytes)
    expected = {
        "id": ARTIFACT_ID,
        "name": ARTIFACT_NAME,
        "size_in_bytes": ARTIFACT_SIZE,
        "digest": f"sha256:{ARTIFACT_SHA256}",
        "expired": False,
    }
    for field, value in expected.items():
        if artifact.get(field) != value:
            raise RuntimeError(f"artifact metadata mismatch for {field}: {artifact.get(field)!r}")
    workflow_run = artifact.get("workflow_run") or {}
    if workflow_run.get("id") != RUN_ID or workflow_run.get("head_sha") != SOURCE_SHA:
        raise RuntimeError("artifact metadata points to a different workflow run or source SHA")

    status, headers = api_get(
        f"/repos/{REPOSITORY}/actions/artifacts/{ARTIFACT_ID}/zip", token
    )
    # api_get deliberately refuses redirects to avoid forwarding the bearer token. Follow the
    # signed, short-lived URL with an unauthenticated request instead.
    location = headers.get("Location") or headers.get("location")
    if not location:
        raise RuntimeError("GitHub did not return a signed artifact download URL")
    parsed = urllib.parse.urlparse(location)
    if parsed.scheme != "https" or not parsed.netloc:
        raise RuntimeError("GitHub returned an invalid artifact download URL")
    try:
        with urllib.request.urlopen(
            urllib.request.Request(location, headers={"User-Agent": "ponte-local-stylus-proof"}),
            timeout=120,
        ) as response:
            archive = response.read()
    except Exception as error:  # noqa: BLE001
        raise RuntimeError(f"failed to fetch signed GitHub artifact archive: {error}") from error

    archive_sha = hashlib.sha256(archive).hexdigest()
    if len(archive) != ARTIFACT_SIZE:
        raise RuntimeError(f"artifact archive size mismatch: got {len(archive)}, expected {ARTIFACT_SIZE}")
    if archive_sha != ARTIFACT_SHA256:
        raise RuntimeError(f"artifact archive SHA-256 mismatch: {archive_sha}")

    archive_path = evidence / "candidate-artifact.zip"
    archive_path.write_bytes(archive)
    with zipfile.ZipFile(io.BytesIO(archive)) as package:
        matches = [
            info
            for info in package.infolist()
            if info.filename.replace("\\", "/").lstrip("./") == WASM_MEMBER
        ]
        if len(matches) != 1:
            raise RuntimeError(
                f"expected exactly one {WASM_MEMBER} entry in artifact, found {len(matches)}"
            )
        info = matches[0]
        if info.file_size != WASM_SIZE:
            raise RuntimeError(f"candidate size mismatch in archive: {info.file_size} != {WASM_SIZE}")
        wasm = package.read(info)

    wasm_sha = hashlib.sha256(wasm).hexdigest()
    if len(wasm) != WASM_SIZE or wasm_sha != WASM_SHA256:
        raise RuntimeError(
            f"candidate WASM mismatch: size={len(wasm)}, sha256={wasm_sha}; "
            f"expected size={WASM_SIZE}, sha256={WASM_SHA256}"
        )
    candidate_path = evidence / "official-container-1.wasm"
    candidate_path.write_bytes(wasm)
    (evidence / "artifact.json").write_text(
        json.dumps(
            {
                "repository": REPOSITORY,
                "run_id": RUN_ID,
                "source_commit": SOURCE_SHA,
                "run_conclusion": run["conclusion"],
                "artifact_id": ARTIFACT_ID,
                "artifact_name": ARTIFACT_NAME,
                "artifact_archive_size_bytes": len(archive),
                "artifact_archive_sha256": archive_sha,
                "artifact_metadata_digest": artifact["digest"],
                "zip_member": WASM_MEMBER,
                "candidate_file": candidate_path.name,
                "candidate_size_bytes": len(wasm),
                "candidate_sha256": wasm_sha,
                "rebuilt": False,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"Verified artifact archive SHA-256: {archive_sha}")
    print(f"Verified exact candidate: {candidate_path} ({len(wasm)} bytes, {wasm_sha})")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        print(f"candidate retrieval/integrity failure: {error}", file=sys.stderr)
        raise SystemExit(1)
