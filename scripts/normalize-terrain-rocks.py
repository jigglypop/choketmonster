"""Admit three more models from the previously verified Kenney Nature Kit 2.1."""
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('normalize_world', ROOT / 'scripts/normalize-world-assets.py')
normalizer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(normalizer)
normalizer.OUTPUT = ROOT / 'public/models/openworld/rocks'
normalizer.OUTPUT.mkdir(parents=True, exist_ok=True)
archive = ROOT / 'assets/source-world/kenney-nature-kit-2.1/kenney_nature-kit.zip'
archive_sha = hashlib.sha256(archive.read_bytes()).hexdigest()
assert archive_sha == 'fa7974a0d342bfe63c38664ba9f8ec1a4aab8ea25f099bdc56870e33588c4d9d'
assets = []
for name, source, height in [('rock-tall', 'rock_tallC.glb', 2.8), ('rock-ridge', 'rock_tallG.glb', 2.0), ('cliff', 'cliff_rock.glb', 3.2)]:
    normalizer.clean_scene()
    objects, metadata = normalizer.import_normalized(name, source, height)
    path = normalizer.export_asset(name, objects)
    validation = normalizer.validate_export(path)
    assets.append(dict(id=name, file=path.name, bytes=path.stat().st_size,
        sha256=normalizer.sha256(path), **metadata, validation=validation))
manifest = dict(version='20260911', license='CC0-1.0', sourcePage='https://kenney.nl/assets/nature-kit',
    archiveSha256=archive_sha, sourceVersion='2.1',
    sourceUrl='https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip',
    conversion='Bottom center origin, Y-up meters, baked transforms, nonmetallic woodland palette; original meshes preserved', assets=assets)
(normalizer.OUTPUT / 'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
(normalizer.OUTPUT / 'LICENSE.txt').write_text('Kenney Nature Kit 2.1, CC0 1.0 Universal\nhttps://kenney.nl/assets/nature-kit\nhttps://creativecommons.org/publicdomain/zero/1.0/\n')
print(json.dumps(manifest, indent=2))
