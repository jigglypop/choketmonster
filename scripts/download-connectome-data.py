#!/usr/bin/env python3
"""Download and verify the public MaleCNS v1.0 flat-connectome objects.

Downloads are pinned to immutable Google Cloud Storage object generations.
Incomplete transfers stay as ``.part`` files and resume with HTTP Range.
Completed upstream files are never overwritten.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


DATASET = "MaleCNS v1.0"
LICENSE = "CC-BY 4.0"
OFFICIAL_PAGE = "https://male-cns.janelia.org/download/"
BUCKET_PREFIX = "gs://flyem-male-cns/v1.0/connectome-data/flat-connectome/"
HTTPS_PREFIX = "https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome"

# Snapshot of the public GCS object listing on 2026-09-11. Generation and MD5
# pin each object even if a same-named object is later replaced upstream.
OBJECTS = [
    ("body-annotations-male-cns-v1.0-minconf-0.5.feather", 14_483_314, "1780494878811468", "UKdxh3DFciDxYLpPQxq4ng=="),
    ("body-neurotransmitters-male-cns-v1.0.feather", 43_282_834, "1780894899156750", "PYQrEv5cSe763lKNfdJKHw=="),
    ("body-stats-male-cns-v1.0-minconf-0.5.feather", 778_062_826, "1780494888472305", "QEwzScKFgBSOFoFeuZ84Kg=="),
    ("connectome-weights-male-cns-v1.0-minconf-0.5-significant-only.feather", 502_169_298, "1780494884449936", "CfL4M/cWGkatM81vnJBy9g=="),
    ("connectome-weights-male-cns-v1.0-minconf-0.5-traced-only.feather", 508_025_642, "1780494884279095", "ZgHUrQr6mf0D6wh5Ze8kIw=="),
    ("connectome-weights-male-cns-v1.0-minconf-0.5.feather", 1_051_241_946, "1780494887545976", "8w6dzKJc/QIb8eez2XVZng=="),
    ("syn-partners-male-cns-v1.0-minconf-0.5-significant-only.feather", 2_965_702_122, "1780494917774871", "pbz0bYqLglq4yjJzxHeV4w=="),
    ("syn-partners-male-cns-v1.0-minconf-0.5-traced-only.feather", 2_965_367_002, "1780494912394119", "9bwcXONKAbaJVkFLUw7dqA=="),
    ("syn-partners-male-cns-v1.0-minconf-0.5.feather", 6_777_179_098, "1780494942562468", "WO/PcS+MTU3l8q1R6X3vdg=="),
    ("syn-points-male-cns-v1.0-minconf-0.5.feather", 13_061_489_098, "1780494991007477", "xp0IdY3gdYIDXMiENXRJOg=="),
    ("tbar-neurotransmitters-male-cns-v1.0.feather", 2_651_680_218, "1780894927871192", "UbAsEWkGYq7e8o+G05T/DQ=="),
]


def digests(path: Path) -> tuple[str, str]:
    sha256 = hashlib.sha256()
    md5 = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(16 * 1024 * 1024), b""):
            sha256.update(block)
            md5.update(block)
    return sha256.hexdigest(), base64.b64encode(md5.digest()).decode("ascii")


def download(target: Path, size: int, generation: str, expected_md5: str) -> dict[str, object]:
    url = f"{HTTPS_PREFIX}/{target.name}?generation={generation}"
    partial = target.with_name(target.name + ".part")
    if target.exists():
        if target.stat().st_size != size:
            raise RuntimeError(f"refusing to replace wrong-sized completed file: {target}")
        sha256, md5 = digests(target)
        if md5 != expected_md5:
            raise RuntimeError(f"refusing to replace completed file with wrong MD5: {target}")
        print(f"verified existing {target.name} ({size:,} bytes)", flush=True)
        return {"sha256": sha256, "md5Base64": md5}

    offset = partial.stat().st_size if partial.exists() else 0
    if offset > size:
        raise RuntimeError(f"partial file exceeds expected size: {partial}")
    headers = {"Range": f"bytes={offset}-"} if offset else {}
    print(f"downloading {target.name} from byte {offset:,}/{size:,}", flush=True)
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=120) as response:
        if offset and response.status != 206:
            raise RuntimeError(f"server refused Range resume for {target.name}")
        with partial.open("ab" if offset else "wb") as output:
            shutil.copyfileobj(response, output, 16 * 1024 * 1024)
    if partial.stat().st_size != size:
        raise RuntimeError(f"incomplete response retained for resume: {partial}")
    sha256, md5 = digests(partial)
    if md5 != expected_md5:
        raise RuntimeError(f"download MD5 mismatch; retained for inspection: {partial}")
    os.replace(partial, target)
    print(f"verified {target.name} sha256={sha256}", flush=True)
    return {"sha256": sha256, "md5Base64": md5}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=Path("data/local/malecns-v1.0-flat-connectome"))
    parser.add_argument("--inventory-only", action="store_true")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    records = []
    for name, size, generation, md5 in OBJECTS:
        record: dict[str, object] = {
            "name": name,
            "bytes": size,
            "generation": generation,
            "md5Base64": md5,
            "url": f"{HTTPS_PREFIX}/{name}?generation={generation}",
        }
        if not args.inventory_only:
            record.update(download(args.out / name, size, generation, md5))
        records.append(record)

    manifest = {
        "dataset": DATASET,
        "license": LICENSE,
        "officialPage": OFFICIAL_PAGE,
        "bucketPrefix": BUCKET_PREFIX,
        "inventoryCapturedAt": "2026-09-11",
        "verifiedAt": None if args.inventory_only else datetime.now(timezone.utc).isoformat(),
        "objectCount": len(records),
        "totalBytes": sum(int(record["bytes"]) for record in records),
        "files": records,
    }
    manifest_path = args.out / ("inventory.json" if args.inventory_only else "manifest.json")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {manifest_path}: {len(records)} objects, {manifest['totalBytes']:,} bytes")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"download-connectome-data: {error}", file=sys.stderr)
        raise
