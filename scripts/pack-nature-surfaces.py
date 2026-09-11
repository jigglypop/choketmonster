"""Pack verified AO/roughness maps and new path textures into a separate package."""
import hashlib
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/source-world/polyhaven-nature-detail-20260911'
OUTPUT = ROOT / 'public/textures/nature-detail'
OUTPUT.mkdir(parents=True, exist_ok=True)
source_manifest = json.loads((SOURCE / 'manifest.json').read_text())
records = []
for asset in ['brown_mud_03', 'aerial_grass_rock', 'rock_boulder_dry']:
    source = next(a for a in source_manifest['assets'] if a['id'] == asset)
    for file in source['files']:
        assert hashlib.sha256((SOURCE / file['file']).read_bytes()).hexdigest() == file['sha256']
    def read(channel):
        return Image.open(SOURCE / asset / f'{asset}_{channel}_1k.jpg')
    rough = read('rough').convert('L').resize((512, 512), Image.Resampling.LANCZOS)
    ao = read('ao').convert('L').resize((512, 512), Image.Resampling.LANCZOS)
    outputs = [('arm', Image.merge('RGB', (ao, rough, Image.new('L', (512, 512), 0))))]
    if asset == 'brown_mud_03':
        outputs.extend([('diff', read('diff').convert('RGB')), ('nor_gl', read('nor_gl').convert('RGB').resize((512, 512), Image.Resampling.LANCZOS))])
    for channel, texture in outputs:
        path = OUTPUT / f'{asset}_{channel}.webp'
        texture.save(path, lossless=channel != 'diff', quality=82, method=6)
        records.append(dict(file=path.name, sha256=hashlib.sha256(path.read_bytes()).hexdigest(), bytes=path.stat().st_size,
                            source=source, channel=channel, colorSpace='sRGB' if channel == 'diff' else 'linear', size=list(texture.size),
                            conversion='WebP; ARM = AO / roughness / zero metalness; data maps 512px lossless, color 1024px quality 82'))
(OUTPUT / 'manifest.json').write_text(json.dumps(dict(version='20260911', assets=records), indent=2) + '\n')
(OUTPUT / 'LICENSE.txt').write_text((SOURCE / 'LICENSE.txt').read_text())
print('Textures:', len(records), 'bytes:', sum(a['bytes'] for a in records))
