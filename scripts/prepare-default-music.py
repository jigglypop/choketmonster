"""Fetch the alternate CC0 game loop and encode its playback copy as AAC/MP4.

Run: uv run --with imageio-ffmpeg python scripts/prepare-default-music.py
The original is retained in data/local; only the MP4 and provenance ship.
This does not replace the user-supplied default bgm.mp3 or its provenance.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.request
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'https://opengameart.org/sites/default/files/othercenter.ogg'
PAGE = 'https://opengameart.org/content/other-center'
source_dir = ROOT / 'data/local/audio/other-center'
output_dir = ROOT / 'public/audio'
source_dir.mkdir(parents=True, exist_ok=True)
output_dir.mkdir(parents=True, exist_ok=True)
source = source_dir / 'othercenter.ogg'
if not source.exists():
    partial = source.with_suffix('.ogg.part')
    with urllib.request.urlopen(SOURCE, timeout=60) as response, partial.open('wb') as target:
        while block := response.read(128 * 1024):
            target.write(block)
    if partial.read_bytes()[:4] != b'OggS':
        raise ValueError('Source is not an Ogg file')
    partial.rename(source)
page_copy = source_dir / 'source-page.html'
if not page_copy.exists():
    with urllib.request.urlopen(PAGE, timeout=60) as response:
        page_copy.write_bytes(response.read())
output = output_dir / 'other-center.mp4'
subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error', '-y',
    '-i', str(source), '-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', str(output)], check=True)
receipt = {
    'title': 'Other Center', 'author': 'Chris Murphy (zesona)', 'sourcePage': PAGE, 'sourceUrl': SOURCE,
    'license': 'CC0-1.0', 'licenseUrl': 'https://creativecommons.org/publicdomain/zero/1.0/',
    'scope': 'Author-composed loop for a Pokemon parody game; not a recording of the Pokemon soundtrack.',
    'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
    'sourcePageSha256': hashlib.sha256(page_copy.read_bytes()).hexdigest(),
    'runtimeUrl': '/audio/other-center.mp4', 'runtimeSha256': hashlib.sha256(output.read_bytes()).hexdigest(),
    'runtimeBytes': output.stat().st_size, 'conversion': 'AAC 128 kbit/s in MP4, original tempo and pitch, no video',
}
(output_dir / 'other-center-sources.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(receipt, ensure_ascii=False))
