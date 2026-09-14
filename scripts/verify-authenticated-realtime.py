#!/usr/bin/env python3
"""Verify authenticated ticket issuance, trusted names, and scene-isolated chat."""
import argparse
import asyncio
import http.cookiejar
import json
import secrets
import urllib.error
import urllib.request

from websockets.asyncio.client import connect


def account_client(api, origin, username, password):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def post(path, body):
        request = urllib.request.Request(
            f"{api}{path}",
            json.dumps(body).encode(),
            {"content-type": "application/json", "origin": origin},
            method="POST",
        )
        with opener.open(request, timeout=20) as response:
            return json.load(response)

    user = post("/api/auth/register", {"username": username, "password": password})["user"]
    return user, lambda: post("/api/auth/realtime-ticket", {})["ticket"]


async def receive_type(socket, expected, timeout=3):
    async def read():
        async for raw in socket:
            message = json.loads(raw)
            if message.get("type") == expected:
                return message
    return await asyncio.wait_for(read(), timeout)


async def verify(args):
    suffix = secrets.token_hex(5)
    password = f"Realtime-{secrets.token_urlsafe(18)}"
    first, first_ticket = await asyncio.to_thread(account_client, args.api, args.origin, f"rt-a-{suffix}", password)
    second, second_ticket = await asyncio.to_thread(account_client, args.api, args.origin, f"rt-b-{suffix}", password)
    tickets = await asyncio.gather(asyncio.to_thread(first_ticket), asyncio.to_thread(second_ticket))
    sockets = []
    try:
        for ticket in tickets:
            sockets.append(await connect(f"{args.ws}?ticket={ticket}", origin=args.origin, compression=None, proxy=None))
        await sockets[0].send(json.dumps({"type":"join","region":"kanto","sceneId":"surface:kanto","name":"spoofed","speciesId":1,"x":0,"z":0,"heading":0,"activity":"idle"}))
        invalid = await receive_type(sockets[0], "error")
        if invalid.get("code") != "INVALID_MESSAGE":
            raise RuntimeError(f"Spoofed name was not rejected: {invalid}")
        joins = [
            {"type":"join","region":"kanto","sceneId":"surface:kanto","speciesId":1,"x":0,"z":0,"heading":0,"activity":"idle"},
            {"type":"join","region":"kanto","sceneId":"cave:kanto:test-cave","speciesId":4,"x":2,"z":2,"heading":0,"activity":"idle"},
        ]
        await asyncio.gather(*(socket.send(json.dumps(join)) for socket, join in zip(sockets, joins)))
        welcomes = await asyncio.gather(*(receive_type(socket, "welcome") for socket in sockets))
        if [welcome["id"] for welcome in welcomes] != [first["id"], second["id"]]:
            raise RuntimeError("WebSocket identities do not match authenticated accounts")
        if [welcome["sceneId"] for welcome in welcomes] != ["surface:kanto", "cave:kanto:test-cave"]:
            raise RuntimeError("Scene acknowledgements are incorrect")
        await sockets[0].send(json.dumps({"type":"chat","text":"surface-only"}))
        own_chat = await receive_type(sockets[0], "chat")
        if own_chat["message"]["name"] != first["username"]:
            raise RuntimeError("Chat did not use the server-authenticated account username")
        try:
            await receive_type(sockets[1], "chat", .4)
            raise RuntimeError("Chat crossed a scene boundary")
        except asyncio.TimeoutError:
            pass
        reauthenticated = False
        if args.verify_reauth:
            await asyncio.sleep(35)
            refreshed = await asyncio.to_thread(first_ticket)
            await sockets[0].send(json.dumps({"type":"reauth", "ticket":refreshed}))
            await asyncio.sleep(35)
            await sockets[0].send(json.dumps({"type":"ping", "sentAt":12345}))
            pong = await receive_type(sockets[0], "pong")
            reauthenticated = pong.get("sentAt") == 12345
            if not reauthenticated:
                raise RuntimeError("Socket did not remain connected beyond the initial ticket expiry")
        print(json.dumps({"passed": True, "accounts": [first["id"], second["id"]], "trustedName": own_chat["message"]["name"], "sceneIsolation": True, "reauthenticated": reauthenticated}))
    finally:
        await asyncio.gather(*(socket.close() for socket in sockets), return_exceptions=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default="http://127.0.0.1:8080")
    parser.add_argument("--ws", default="ws://127.0.0.1:8080/api/realtime")
    parser.add_argument("--origin", default="http://127.0.0.1:5173")
    parser.add_argument("--verify-reauth", action="store_true")
    asyncio.run(verify(parser.parse_args()))
