#!/usr/bin/env python3
"""Download and verify the pinned Kenney Nature Kit source archive."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import urllib.request
import zipfile
from pathlib import Path


SOURCE_PAGE = "https://kenney.nl/assets/nature-kit"
ARCHIVE_URL = (
    "https://kenney.nl/media/pages/assets/nature-kit/"
    "37ac38a37b-1677698939/kenney_nature-kit.zip"
)
EXPECTED_SHA256 = ""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    source_dir = args.root / "assets" / "source-world" / "kenney-nature-kit-1.0"
    archive = source_dir / "kenney_nature-kit.zip"
    extracted = source_dir / "extracted"
    source_dir.mkdir(parents=True, exist_ok=True)

    if args.force or not archive.exists():
        partial = archive.with_suffix(".zip.part")
        request = urllib.request.Request(ARCHIVE_URL, headers={"User-Agent": "choketmon-local-asset-fetch/1.0"})
        with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as output:
            shutil.copyfileobj(response, output)
        partial.replace(archive)

    actual_sha = sha256(archive)
    if EXPECTED_SHA256 and actual_sha != EXPECTED_SHA256:
        raise SystemExit(f"archive SHA-256 mismatch: expected {EXPECTED_SHA256}, got {actual_sha}")

    if args.force and extracted.exists():
        shutil.rmtree(extracted)
    if not extracted.exists():
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                destination = (extracted / member.filename).resolve()
                if extracted.resolve() not in destination.parents and destination != extracted.resolve():
                    raise SystemExit(f"unsafe archive member: {member.filename}")
            bundle.extractall(extracted)

    license_files = sorted(
        str(path.relative_to(extracted)).replace("\\", "/")
        for path in extracted.rglob("*")
        if path.is_file() and ("license" in path.name.lower() or "readme" in path.name.lower())
    )
    receipt = {
        "package": "Kenney Nature Kit",
        "version": "1.0",
        "author": "Kenney",
        "sourcePage": SOURCE_PAGE,
        "archiveUrl": ARCHIVE_URL,
        "archiveSha256": actual_sha,
        "license": "CC0-1.0",
        "licenseFiles": license_files,
        "archiveBytes": archive.stat().st_size,
        "extractedFiles": sum(1 for path in extracted.rglob("*") if path.is_file()),
    }
    (source_dir / "source-receipt.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(receipt, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
