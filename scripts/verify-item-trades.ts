import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Graph } from '../src/core/brain.ts';
import { createGame, type GameState } from '../src/game/engine.ts';
import { defaultView, packSave } from '../src/game/storage.ts';

class Jar {
  cookie = '';
  profile = '';
  capture(response: Response, body: any) {
    const token = /choketmon_session=([^;,]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
    if (token) this.cookie = `choketmon_session=${token}`;
    this.profile = body.user?.id ?? this.profile;
  }
}

const argument = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const base = argument('--base-url', 'http://127.0.0.1:18081').replace(/\/$/, '');
const origin = argument('--origin', 'http://127.0.0.1:5173');

async function call(path: string, init: RequestInit = {}, jar?: Jar) {
  const headers = new Headers(init.headers);
  if (jar?.cookie) headers.set('cookie', jar.cookie);
  if (jar?.profile) headers.set('x-choketmon-profile', jar.profile);
  if (init.method && init.method !== 'GET') {
    headers.set('origin', origin);
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(base + path, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const suffix = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`;
  const graph = JSON.parse(await readFile(resolve('public/data/connectome.json'), 'utf8')) as Graph;
  const creator = new Jar();
  const joiner = new Jar();
  const password = `Item-trade-${suffix}!`;
  for (const [jar, username] of [[creator, `itema_${suffix}`], [joiner, `itemb_${suffix}`]] as const) {
    const registered = await call('/api/auth/register', {
      method: 'POST', body: JSON.stringify({ username: username.slice(0, 32), password }),
    });
    assert(registered.response.ok, `register failed: ${JSON.stringify(registered.body)}`);
    jar.capture(registered.response, registered.body);
  }

  const left = createGame(1, `item-left-${suffix}`);
  const right = createGame(152, `item-right-${suffix}`);
  left.player.money = 5_000;
  right.player.money = 7_000;
  left.inventory.leftovers = 3;
  left.inventory['focus-sash'] = 1;
  (right.inventory as Record<string, number>)['mega-stone:gengar-mega'] = 2;
  const save = async (jar: Jar, game: GameState) => call('/api/saves/current', {
    method: 'PUT',
    body: JSON.stringify({ save: packSave(game, graph, defaultView()), revision: 0, requestId: crypto.randomUUID() }),
  }, jar);
  const [savedLeft, savedRight] = await Promise.all([save(creator, left), save(joiner, right)]);
  assert(savedLeft.response.ok && savedRight.response.ok, `initial saves failed: ${JSON.stringify([savedLeft.body, savedRight.body])}`);

  let entered = await call('/api/trades', { method: 'POST', body: JSON.stringify({ action: 'create' }) }, creator);
  assert(entered.response.ok, `create failed: ${JSON.stringify(entered.body)}`);
  const tradeId = entered.body.trade.id as string;
  entered = await call('/api/trades', {
    method: 'POST', body: JSON.stringify({ action: 'join', code: entered.body.trade.code }),
  }, joiner);
  assert(entered.response.ok, `join failed: ${JSON.stringify(entered.body)}`);
  let version = entered.body.trade.version as number;

  const rejected = await call(`/api/trades/${tradeId}/offer`, {
    method: 'POST',
    body: JSON.stringify({ version, revision: savedLeft.body.revision, monsterId: null, money: 0, items: [{ itemId: 'poke-ball', quantity: 1 }] }),
  }, creator);
  assert(rejected.response.status === 422, `non-field item accepted: ${JSON.stringify(rejected.body)}`);

  let changed = await call(`/api/trades/${tradeId}/offer`, {
    method: 'POST',
    body: JSON.stringify({ version, revision: savedLeft.body.revision, monsterId: null, money: 0, items: [{ itemId: 'leftovers', quantity: 2 }] }),
  }, creator);
  assert(changed.response.ok, `creator offer failed: ${JSON.stringify(changed.body)}`);
  version = changed.body.trade.version;
  changed = await call(`/api/trades/${tradeId}/offer`, {
    method: 'POST',
    body: JSON.stringify({ version, revision: savedRight.body.revision, monsterId: null, money: 600, items: [{ itemId: 'mega-stone:gengar-mega', quantity: 1 }] }),
  }, joiner);
  assert(changed.response.ok, `joiner offer failed: ${JSON.stringify(changed.body)}`);
  version = changed.body.trade.version;
  const offers = Object.fromEntries(changed.body.trade.participants.map((participant: any) => [participant.side, participant.offer]));
  assert(offers.creator.items[0].itemId === 'leftovers' && offers.joiner.items[0].quantity === 1, 'item offers are not visible to both participants');

  changed = await call(`/api/trades/${tradeId}/confirm`, { method: 'POST', body: JSON.stringify({ version }) }, creator);
  assert(changed.response.ok, `first confirm failed: ${JSON.stringify(changed.body)}`);
  version = changed.body.trade.version;
  const completed = await call(`/api/trades/${tradeId}/confirm`, { method: 'POST', body: JSON.stringify({ version }) }, joiner);
  assert(completed.response.ok && completed.body.trade.status === 'completed', `completion failed: ${JSON.stringify(completed.body)}`);
  const [leftResult, rightResult] = await Promise.all([
    call(`/api/trades/${tradeId}/result`, {}, creator), call(`/api/trades/${tradeId}/result`, {}, joiner),
  ]);
  const leftGame = leftResult.body.result.save.game as GameState;
  const rightGame = rightResult.body.result.save.game as GameState;
  const leftInventory = leftGame.inventory as Record<string, number>;
  const rightInventory = rightGame.inventory as Record<string, number>;
  assert(leftInventory.leftovers === 1 && leftInventory['mega-stone:gengar-mega'] === 1, 'creator item result is incorrect');
  assert(rightInventory.leftovers === 2 && rightInventory['mega-stone:gengar-mega'] === 1, 'joiner item result is incorrect');
  assert(leftGame.player.money === 5_600 && rightGame.player.money === 6_400, 'purchase money result is incorrect');
  const retry = await call(`/api/trades/${tradeId}/confirm`, { method: 'POST', body: JSON.stringify({ version }) }, joiner);
  assert(retry.response.ok && retry.body.trade.status === 'completed', 'double confirmation was not idempotent');
  console.log(JSON.stringify({ passed: true, tradeId, stocks: { creator: leftGame.inventory.leftovers, joiner: rightGame.inventory.leftovers } }));
}

await main();
