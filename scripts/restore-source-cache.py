"""Restore immutable test inputs without regenerating data or publishing the cached PNGs."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
tasks = []
for manifest_path, folder, entries_key, path_key in [
    ('src/data/source-manifest.json', 'src/data/.cache/pokeapi', 'csvFiles', 'file'),
    ('public/pokemon/manifest.json', 'public/pokemon', 'files', 'path'),
]:
    manifest = json.loads((ROOT / manifest_path).read_text(encoding='utf-8'))
    for entry in manifest[entries_key]:
        directory = (ROOT / folder).resolve()
        target = (directory / entry[path_key]).resolve()
        if directory not in target.parents:
            raise ValueError('Source-cache path escaped its directory')
        if not entry['url'].startswith('https://raw.githubusercontent.com/PokeAPI/') or manifest['resolvedCommit'] not in entry['url']:
            raise ValueError('Source URL must be pinned to the manifest commit')
        tasks.append((target, entry))

def restore(task):
    target, entry = task
    if target.exists():
        data = target.read_bytes()
    else:
        for attempt in range(4):
            try:
                with urlopen(Request(entry['url'], headers={'User-Agent': 'choketmon-source-verifier'}), timeout=45) as response:
                    data = response.read()
                break
            except Exception:
                if attempt == 3: raise
                time.sleep(2 ** attempt)
    if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
        raise ValueError(f'Source checksum mismatch: {target.relative_to(ROOT)}')
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + '.part')
        temporary.write_bytes(data)
        temporary.replace(target)
    return len(data)

with ThreadPoolExecutor(max_workers=8) as pool:
    sizes = list(pool.map(restore, tasks))
print(json.dumps({'verifiedSourceFiles': len(sizes), 'bytes': sum(sizes), 'immutableManifestChecksums': True}))
