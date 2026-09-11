"""Small, resumable CC0 source package. Powered by Poly Haven.

Sources are immutable; each downloaded byte is checked against the API's MD5,
then a SHA-256 roster is retained for offline normalization and verification.
"""
import hashlib
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/source-world/polyhaven-nature-detail-20260911'
HEADERS = {'User-Agent': 'ChoketmonLocalAssetImport/1.0 (local development)'}


def metadata(endpoint, output):
    if output.exists():
        return json.loads(output.read_text())
    with urllib.request.urlopen(urllib.request.Request('https://api.polyhaven.com/' + endpoint, headers=HEADERS), timeout=45) as response:
        data = json.load(response)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, indent=2) + '\n')
    return data


def download(spec, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        part = path.with_suffix(path.suffix + '.part')
        offset = part.stat().st_size if part.exists() else 0
        headers = dict(HEADERS)
        if offset:
            headers['Range'] = f'bytes={offset}-'
        with urllib.request.urlopen(urllib.request.Request(spec['url'], headers=headers), timeout=60) as response:
            with part.open('ab' if offset and response.status == 206 else 'wb') as stream:
                while chunk := response.read(65536):
                    stream.write(chunk)
        assert part.stat().st_size == spec['size'], f'Incomplete source: {path}'
        assert hashlib.md5(part.read_bytes()).hexdigest() == spec['md5'], f'Source checksum: {path}'
        part.replace(path)
    assert path.stat().st_size == spec['size']
    assert hashlib.md5(path.read_bytes()).hexdigest() == spec['md5']
    return dict(file=str(path.relative_to(SOURCE)).replace('\\', '/'), sourceUrl=spec['url'],
                bytes=path.stat().st_size, sourceMd5=spec['md5'], sha256=hashlib.sha256(path.read_bytes()).hexdigest())


if __name__ == '__main__':
    SOURCE.mkdir(parents=True, exist_ok=True)
    records = []
    for asset in ['rock_moss_set_01', 'fern_02']:
        data = metadata('files/' + asset, SOURCE / asset / 'files.json')
        info = metadata('info/' + asset, SOURCE / asset / 'info.json')
        spec = data['gltf']['1k']['gltf']
        dependencies = {f'{asset}_1k.gltf': spec, **spec['include']}
        assert sum(item['size'] for item in dependencies.values()) < 6_000_000
        files = [download(item, SOURCE / asset / name) for name, item in dependencies.items()]
        records.append(dict(id=asset, sourcePage=f'https://polyhaven.com/a/{asset}', authors=info.get('authors'),
                            license='CC0-1.0', licenseUrl='https://polyhaven.com/license', files=files))
        print(asset, sum(item['bytes'] for item in files), flush=True)
    # A dedicated trail material replaces the rock texture previously used on paths.
    for asset, channels in [('brown_mud_03', ['diff', 'nor_gl', 'rough', 'ao']),
                            ('aerial_grass_rock', ['rough', 'ao']), ('rock_boulder_dry', ['rough', 'ao'])]:
        data = metadata('files/' + asset, SOURCE / asset / 'files.json')
        files = []
        for channel in channels:
            key = {'diff': 'Diffuse', 'rough': 'Rough', 'ao': 'AO'}.get(channel, channel)
            spec = data[key]['1k']['jpg']
            files.append(download(spec, SOURCE / asset / f'{asset}_{channel}_1k.jpg'))
        records.append(dict(id=asset, sourcePage=f'https://polyhaven.com/a/{asset}',
                            license='CC0-1.0', licenseUrl='https://polyhaven.com/license', files=files))
        print(asset, sum(item['bytes'] for item in files), flush=True)
    (SOURCE / 'manifest.json').write_text(json.dumps(dict(version='20260911', assets=records), indent=2) + '\n')
    (SOURCE / 'LICENSE.txt').write_text('Powered by Poly Haven\nCC0 1.0 Universal\nhttps://polyhaven.com/license\nhttps://creativecommons.org/publicdomain/zero/1.0/\n')
