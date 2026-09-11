"""Download small CC0 Poly Haven sources; preserve originals and checksum receipts."""
import hashlib
import json
import urllib.request
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/source-world/polyhaven-terrain-20260911'
OUTPUT = ROOT / 'public/textures/terrain'
SOURCE.mkdir(parents=True, exist_ok=True)
OUTPUT.mkdir(parents=True, exist_ok=True)
records = []
for asset in ['aerial_grass_rock', 'rock_boulder_dry']:
    for channel in ['diff', 'nor_gl']:
        filename = f'{asset}_{channel}_1k.jpg'
        url = f'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/{asset}/{filename}'
        raw = SOURCE / filename
        receipt = SOURCE / f'{filename}.json'
        if raw.exists() and receipt.exists():
            previous = json.loads(receipt.read_text())
            assert hashlib.sha256(raw.read_bytes()).hexdigest() == previous['sourceSha256']
            server_sha1 = previous['serverSha1']
        else:
            partial = raw.with_suffix('.part')
            request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(request, timeout=60) as response:
                server_sha1 = response.headers.get('x-bz-content-sha1')
                with partial.open('wb') as out:
                    while chunk := response.read(65536): out.write(chunk)
            if server_sha1:
                assert hashlib.sha1(partial.read_bytes()).hexdigest() == server_sha1
            partial.replace(raw)
        output = OUTPUT / f'{asset}_{channel}.webp'
        with Image.open(raw) as source:
            assert source.size == (1024, 1024)
            texture = source.convert('RGB')
            if channel == 'nor_gl':
                texture = texture.resize((512, 512), Image.Resampling.LANCZOS)
                texture.save(output, lossless=True, method=6)
            else: texture.save(output, quality=78, method=6)
        record = dict(asset=asset, channel=channel, license='CC0-1.0',
            sourcePage=f'https://polyhaven.com/a/{asset}', licenseUrl='https://polyhaven.com/license',
            sourceUrl=url, sourceSha256=hashlib.sha256(raw.read_bytes()).hexdigest(), serverSha1=server_sha1,
            sourceBytes=raw.stat().st_size, file=output.name, bytes=output.stat().st_size,
            sha256=hashlib.sha256(output.read_bytes()).hexdigest(), size=list(texture.size),
            colorSpace='sRGB' if channel == 'diff' else 'linear',
            conversion='WebP quality 78' if channel == 'diff' else '512px Lanczos, lossless WebP; normalize sampled normals in shader')
        receipt.write_text(json.dumps(record, indent=2)+'\n')
        records.append(record)
        print(output.name, record['bytes'], flush=True)
(OUTPUT / 'manifest.json').write_text(json.dumps(dict(version='20260911', assets=records), indent=2)+'\n')
(OUTPUT / 'LICENSE.txt').write_text('Poly Haven: CC0 1.0 Universal\nhttps://polyhaven.com/license\nhttps://creativecommons.org/publicdomain/zero/1.0/\nAerial Grass Rock: Rob Tuytel\nRock Boulder Dry: Dimitrios Savva and Rico Cilliers\n')
