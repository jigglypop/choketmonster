#!/usr/bin/env python3
"""Build the title logo font: official BM DoHyeon (Google Fonts "Do Hyeon", OFL) cut down to the title's glyphs."""

from __future__ import annotations

import hashlib
import tempfile
import urllib.request
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
SOURCE_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/dohyeon/DoHyeon-Regular.ttf"
SOURCE_SHA256 = "35644be7f28e0a68a447b1f7af351dcde5674b870f24f7b5f43e26d00b4ab653"
OUTPUT = ROOT / "public/fonts/ChoketTitle.woff2"
TITLE = "초켓몬스터"


def main() -> None:
    with tempfile.TemporaryDirectory() as folder:
        source = Path(folder) / "DoHyeon-Regular.ttf"
        urllib.request.urlretrieve(SOURCE_URL, source)
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        if SOURCE_SHA256 and digest != SOURCE_SHA256:
            raise SystemExit(f"Unexpected Do Hyeon source: {digest}")
        font = TTFont(source)
        options = subset.Options()
        options.flavor = "woff2"
        options.layout_features = ["*"]
        options.name_IDs = ["*"]
        options.notdef_outline = True
        subsetter = subset.Subsetter(options)
        subsetter.populate(text=TITLE)
        subsetter.subset(font)
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        font.flavor = "woff2"
        font.save(OUTPUT)
        print(f"{OUTPUT.relative_to(ROOT)} {OUTPUT.stat().st_size} bytes from {digest}")


if __name__ == "__main__":
    main()
