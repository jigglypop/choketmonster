#!/usr/bin/env python3
"""Bounded real WebSocket load/latency check; public endpoints never receive chat.

uv run --with websockets==17.0.1 scripts/verify-realtime.py --clients 32 --seconds 5
"""
import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import secrets
import time
from urllib.parse import urlencode, urlparse
import uuid

from websockets.asyncio.client import connect


async def verify(args):
    peers, readers, latencies, errors = [], [], [], []
    metrics = {'receivedBytes': 0, 'patches': 0, 'playerUpdates': 0, 'maxPlayersPerPatch': 0}
    measuring = False
    local = urlparse(args.url).hostname in {'localhost', '127.0.0.1', '::1'}
    if not local and (args.clients > 2 or args.seconds > 5 or args.chat):
        raise ValueError('Public verification is limited to two clients, five seconds, and no chat.')
    secret = os.environ.get(args.ticket_secret_env, '').encode()
    if len(secret) < 32:
        raise ValueError(f'{args.ticket_secret_env} must contain the same 32+ byte secret as the realtime server.')

    def ticket(index):
        claims = json.dumps({'sub': str(uuid.uuid4()), 'username': f'net-check-{index}',
            'exp': int(time.time()) + 60, 'nonce': secrets.token_hex(16)}, separators=(',', ':')).encode()
        body = base64.urlsafe_b64encode(claims).decode().rstrip('=')
        signature = base64.urlsafe_b64encode(hmac.new(secret, body.encode(), hashlib.sha256).digest()).decode().rstrip('=')
        return f'{body}.{signature}'

    async def read_peer(peer):
        async for raw in peer['ws']:
            message = json.loads(raw)
            if message['type'] == 'error':
                errors.append(message)
            if message['type'] == 'welcome':
                peer['id'] = message['id']
                peer['ready'].set()
            elif message['type'] == 'pong':
                latencies.append((time.perf_counter() * 1000) - message['sentAt'])
            elif message['type'] == 'chat' and message['message']['text'] == 'local socket verification':
                peer['chat'].set()
            elif message['type'] in {'patch', 'snapshot'}:
                if message['region'] != 'johto':
                    errors.append({'code': 'ROOM_LEAK'})
                if measuring and message['type'] == 'patch':
                    count = len(message['players'])
                    metrics['patches'] += 1
                    metrics['playerUpdates'] += count
                    metrics['maxPlayersPerPatch'] = max(metrics['maxPlayersPerPatch'], count)
            if measuring:
                metrics['receivedBytes'] += len(raw.encode('utf8'))

    try:
        for index in range(args.clients):
            separator = '&' if '?' in args.url else '?'
            ws = await connect(f'{args.url}{separator}{urlencode({"ticket": ticket(index)})}', origin=args.origin, compression=None, proxy=None, open_timeout=15, close_timeout=3)
            peer = {'ws': ws, 'ready': asyncio.Event(), 'chat': asyncio.Event()}
            peers.append(peer)
            readers.append(asyncio.create_task(read_peer(peer)))
            await ws.send(json.dumps({'type': 'join', 'region': 'johto', 'sceneId': 'surface:johto',
                'speciesId': 152, 'x': -92 + index * .05, 'z': 90, 'heading': 0, 'activity': 'idle'}))
            await asyncio.wait_for(peer['ready'].wait(), 10)
        # Drain join updates before measuring movement deltas.
        await asyncio.sleep(.25)
        if args.chat:
            await peers[0]['ws'].send(json.dumps({'type': 'chat', 'text': 'local socket verification'}))
            await asyncio.wait_for(asyncio.gather(*(peer['chat'].wait() for peer in peers)), 5)
        measuring = True
        started = time.perf_counter()
        ticks = max(1, round(args.seconds * 10))
        for tick in range(ticks):
            for index, peer in enumerate(peers[:args.moving]):
                await peer['ws'].send(json.dumps({'type': 'state', 'seq': tick + 1,
                    'speciesId': 152, 'x': round(-92 + index * .05 + tick * .02, 2),
                    'z': 90, 'heading': 1, 'activity': 'moving'}))
            if tick % 10 == 0:
                for peer in peers:
                    await peer['ws'].send(json.dumps({'type': 'ping', 'sentAt': time.perf_counter() * 1000}))
            await asyncio.sleep(max(0, started + (tick + 1) / 10 - time.perf_counter()))
        await asyncio.sleep(.3)
        elapsed = time.perf_counter() - started
        if errors or not metrics['patches'] or len(latencies) < args.clients:
            raise RuntimeError(f'Incomplete socket run: errors={errors}, pings={len(latencies)}, patches={metrics["patches"]}')
        if metrics['maxPlayersPerPatch'] > args.moving:
            raise RuntimeError('Unchanged peers were retransmitted during the measured movement window.')
        ordered = sorted(latencies)
        percentile = lambda p: round(ordered[min(len(ordered) - 1, math.ceil(len(ordered) * p) - 1)], 2)
        report = {'schema': 1, 'url': args.url, 'clients': args.clients, 'movingClients': args.moving,
            'seconds': round(elapsed, 2), 'chatVerified': args.chat, 'rttSamples': len(latencies),
            'rttMs': {'p50': percentile(.5), 'p95': percentile(.95), 'max': round(max(latencies), 2)},
            'aggregateReceivedBytesPerSecond': round(metrics['receivedBytes'] / elapsed), **metrics,
            'scope': 'Real socket protocol and bounded server load; not browser FPS or a concurrent-user SLA.'}
        path = Path(args.out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
        print(json.dumps(report))
    finally:
        await asyncio.gather(*(peer['ws'].close() for peer in peers), return_exceptions=True)
        for reader in readers:
            reader.cancel()
        await asyncio.gather(*readers, return_exceptions=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='ws://127.0.0.1:8080/api/realtime')
    parser.add_argument('--origin', default='http://127.0.0.1:5186')
    parser.add_argument('--clients', type=int, choices=range(2, 65), default=8)
    parser.add_argument('--moving', type=int, default=1)
    parser.add_argument('--seconds', type=float, default=5)
    parser.add_argument('--chat', action='store_true')
    parser.add_argument('--out', default='artifacts/realtime-sockets.json')
    parser.add_argument('--ticket-secret-env', default='REALTIME_TICKET_SECRET')
    parsed = parser.parse_args()
    if not 1 <= parsed.moving <= parsed.clients or not 1 <= parsed.seconds <= 30:
        parser.error('Use 1..clients moving peers and a 1..30 second run.')
    asyncio.run(verify(parsed))
