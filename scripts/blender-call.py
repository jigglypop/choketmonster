"""Read a project script and execute it through the local Blender bridge."""
import argparse
import json
import socket
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--script', type=Path)
parser.add_argument('--out', type=Path)
parser.add_argument('--port', type=int, default=9878)
args = parser.parse_args()
payload = {'type': 'execute_code', 'code': args.script.read_text(encoding='utf-8')} if args.script else {'type': 'get_scene_info'}
with socket.create_connection(('127.0.0.1', args.port), timeout=10) as connection:
    connection.settimeout(300)
    connection.sendall((json.dumps(payload) + '\n').encode('utf-8'))
    chunks = bytearray()
    while b'\n' not in chunks:
        block = connection.recv(65536)
        if not block: raise RuntimeError('Blender disconnected before the response')
        chunks.extend(block)
    result = json.loads(bytes(chunks).split(b'\n', 1)[0])
if args.out:
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result, ensure_ascii=True))
if result.get('status') != 'success': raise SystemExit(1)
