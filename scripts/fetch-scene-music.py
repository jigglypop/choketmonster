"""Fetch the user-selected public album tracks, preserving bytes and source receipts."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, unquote, urlparse
from urllib.request import Request, urlopen
import json
import re
import shutil

ALBUM = 'https://downloads.khinsider.com/game-soundtracks/album/pokemon-game-boy-pok-mon-sound-complete-set-play-cd'
TRACKS = {1:'opening',2:'pallet',6:'route1',7:'wild-battle',8:'wild-victory',9:'pewter',10:'center',12:'forest',15:'trainer-battle',16:'trainer-victory',17:'cave',18:'route3',19:'cerulean',20:'gym',21:'route24',23:'vermilion',24:'ship',25:'route11',28:'gym-battle',29:'gym-victory',31:'lavender',32:'tower',33:'celadon',36:'hideout',37:'silph',38:'surf',39:'cinnabar',40:'mansion',41:'evolution',42:'victory-road',43:'champion-battle',44:'hall-of-fame',45:'ending'}
ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'data/local/audio/pokemon-rg'
PUBLIC = ROOT / 'public/audio/pokemon-rg'
SOURCE.mkdir(parents=True, exist_ok=True)
PUBLIC.mkdir(parents=True, exist_ok=True)

class Links(HTMLParser):
    def __init__(self):
        super().__init__(); self.links = []; self.current = None
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'a' and 'href' in attrs: self.current = [attrs['href'], '']
    def handle_data(self, data):
        if self.current is not None: self.current[1] += data
    def handle_endtag(self, tag):
        if tag == 'a' and self.current is not None:
            self.links.append(tuple(self.current)); self.current = None

def page(url, filename):
    target = SOURCE / filename
    if not target.exists():
        with urlopen(Request(url, headers={'User-Agent':'choketmon-source-downloader/1.0'}), timeout=45) as response:
            content = response.read()
        target.write_bytes(content)
    parser = Links(); parser.feed(target.read_text(encoding='utf-8')); return parser.links

album_links = page(ALBUM, 'album.html')
pages = {}
for href, title in album_links:
    match = re.search(r'/1-(\d+)\.', unquote(unquote(href)))
    if match and int(match[1]) in TRACKS:
        number = int(match[1])
        label = title.strip()
        if not label or re.fullmatch(r'[\d.]+(?:\s*(?:KB|MB|GB))?', label): continue
        if number not in pages: pages[number] = (urljoin(ALBUM+'/', href), label)
if set(pages) != set(TRACKS): raise ValueError(f'Missing album entries: {set(TRACKS)-set(pages)}')

def fetch(number):
    cue = TRACKS[number]; detail_url, title = pages[number]
    links = page(detail_url, f'{number:02}.html')
    candidates = [urljoin(detail_url, href) for href, _ in links if urlparse(href).hostname and urlparse(href).hostname.endswith('.vgmtreasurechest.com') and unquote(href).lower().endswith('.mp3')]
    if not candidates: raise ValueError(f'No public MP3 link: {detail_url}')
    url = candidates[0]; target = SOURCE / f'{cue}.mp3'; receipt = SOURCE / f'{cue}.json'
    if target.exists() and receipt.exists():
        record = json.loads(receipt.read_text(encoding='utf-8'))
        if sha256(target.read_bytes()).hexdigest() != record['sha256']: raise ValueError(f'Checksum mismatch: {cue}')
        record['title'] = title
    else:
        partial = target.with_suffix('.mp3.part'); offset = partial.stat().st_size if partial.exists() else 0
        headers = {'User-Agent':'choketmon-source-downloader/1.0', 'Referer': detail_url}
        if offset: headers['Range'] = f'bytes={offset}-'
        with urlopen(Request(url, headers=headers), timeout=60) as response:
            if response.status != 206: offset = 0
            with partial.open('ab' if offset else 'wb') as stream:
                while chunk := response.read(1024*128): stream.write(chunk)
        data = partial.read_bytes()
        if len(data) < 100_000 or not (data.startswith(b'ID3') or data[0] == 255): raise ValueError(f'Not an MP3: {cue}')
        partial.replace(target)
        record = {'cue':cue,'disc':1,'track':number,'title':title,'sourcePage':detail_url,'downloadUrl':url,'bytes':len(data),'sha256':sha256(data).hexdigest(),'url':f'/audio/pokemon-rg/{cue}.mp3'}
        receipt.write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    shutil.copyfile(target, PUBLIC / target.name)
    print(json.dumps({'cue':cue,'bytes':record['bytes'],'sha256':record['sha256']}),flush=True)
    return record

with ThreadPoolExecutor(max_workers=3) as executor: records = list(executor.map(fetch, sorted(TRACKS)))
manifest = {'schema':1,'album':ALBUM,'title':'GB Pokemon Complete Sound CD','sourceSelection':'User-requested source, 2026-09-16','license':'No redistribution license is stated on the source album; no open-license claim is made.','transformation':'None: MP3 bytes preserved; source copies and HTML are retained in data/local/audio/pokemon-rg.','tracks':records}
(PUBLIC/'sources.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'tracks':len(records),'bytes':sum(record['bytes'] for record in records)}))
