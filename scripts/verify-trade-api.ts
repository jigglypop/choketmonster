import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGame, createMonster, type GameState } from '../src/game/engine.ts';
import { defaultView, packSave } from '../src/game/storage.ts';
import { FieldSimulation } from '../src/game/field.ts';
import { OpenWorldSimulation } from '../src/openworld/simulation.ts';
import { emptyRewardLedger } from '../src/game/rewards.ts';
import type { Graph } from '../src/core/brain.ts';

class Jar {
  cookie = ''; profile = '';
  capture(response: Response, body: any) {
    const raw = response.headers.get('set-cookie') ?? '';
    const token = /choketmon_session=([^;,]+)/.exec(raw)?.[1];
    if (token) this.cookie = `choketmon_session=${token}`;
    this.profile = body.user?.id ?? this.profile;
  }
}
const base = (process.argv[process.argv.indexOf('--base-url') + 1] || 'http://127.0.0.1:18081').replace(/\/$/, '');
const origin = process.argv[process.argv.indexOf('--origin') + 1] || 'http://127.0.0.1:5173';
async function call(path: string, init: RequestInit = {}, jar?: Jar) {
  const headers = new Headers(init.headers);
  if (jar?.cookie) headers.set('cookie', jar.cookie);
  if (jar?.profile) headers.set('x-choketmon-profile', jar.profile);
  if (init.method && init.method !== 'GET') { headers.set('origin', origin); headers.set('content-type', 'application/json'); }
  const response = await fetch(base + path, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function addBox(game: GameState, species: number) {
  const monster = createMonster(game, species, 12);
  game.player.box.push(monster);
  game.dex.seen = [...new Set([...game.dex.seen, species])].sort((a, b) => a - b);
  game.dex.caught = [...new Set([...game.dex.caught, species])].sort((a, b) => a - b);
  if ((game.versionCaught?.red ?? []).length >= 0) game.versionCaught!.red = [...new Set([...(game.versionCaught!.red ?? []), species])].sort((a, b) => a - b);
  return monster;
}

async function main() {
  const suffix = Date.now().toString(36) + crypto.randomUUID().slice(0, 4);
  const graph = JSON.parse(await readFile(resolve('public/data/connectome.json'), 'utf8')) as Graph;
  const a = new Jar(), b = new Jar(), password = `Trade-test-${suffix}!`;
  for (const [jar, username] of [[a, `tradea_${suffix}`], [b, `tradeb_${suffix}`]] as const) {
    const registered = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: username.slice(0, 32), password }) });
    assert(registered.response.ok, `register failed: ${JSON.stringify(registered.body)}`); jar.capture(registered.response, registered.body);
  }
  const ga = createGame(1, `trade-a-${suffix}`), gb = createGame(152, `trade-b-${suffix}`);
  gb.defeatedFieldTrainers = ['crystal-hiker-daniel'];
  const ma = addBox(ga, 25), mb = addBox(gb, 7); ga.player.money = 5000; gb.player.money = 7000;
  ma.brain = { schema: 1, seed: 3, graph, inputWeights: Array.from({ length: graph.nodes.length }, () => Array(12).fill(0)), readout: Array.from({ length: 5 }, () => Array(12 + graph.nodes.length).fill(0)), activity: Array(graph.nodes.length).fill(0), previous: null, action: 0, rng: 3, updates: 9, sensoryBypass: false };
  const fieldA = new FieldSimulation(graph, 71, [{ id: ma.instanceId, speciesId: ma.speciesId }]).snapshot();
  const fieldB = new FieldSimulation(graph, 72, [{ id: mb.instanceId, speciesId: mb.speciesId }]).snapshot();
  const worldA = new OpenWorldSimulation(graph, ga, 81).snapshot(), worldB = new OpenWorldSimulation(graph, gb, 82).snapshot();
  const companionA = worldA.entities.find(entity => entity.kind === 'companion')!, companionB = worldB.entities.find(entity => entity.kind === 'companion')!;
  worldA.companionMemories = [{ ...structuredClone(companionA), id: `companion:${ma.instanceId}`, speciesId: ma.speciesId }];
  worldB.companionMemories = [{ ...structuredClone(companionB), id: `companion:${mb.instanceId}`, speciesId: mb.speciesId }];
  worldA.rewardLedgers = { [ma.instanceId]: emptyRewardLedger(ma.instanceId) };
  const sa = packSave(ga, graph, { ...defaultView(), rewards: { [ma.instanceId]: 12 }, field: fieldA, openWorld: worldA }), sb = packSave(gb, graph, { ...defaultView(), field: fieldB, openWorld: worldB });
  const put = async (jar: Jar, save: any, revision: number) => call('/api/saves/current', { method: 'PUT', body: JSON.stringify({ save, revision, requestId: crypto.randomUUID() }) }, jar);
  assert(sb.view.openWorld?.mapVersion === 'johto-v3' && sb.view.openWorld.sceneId === 'surface:johto', 'fixture is not a v3 scene save');
  const wrongScene = structuredClone(sb); wrongScene.view.openWorld!.sceneId = 'cave:kanto:mt-moon';
  const outsideWorld = structuredClone(sb); outsideWorld.view.openWorld!.player.x = 240.01;
  const badClock = structuredClone(sb); badClock.view.openWorld!.worldClockSeconds = 1200;
  for (const invalid of [wrongScene, outsideWorld, badClock]) {
    const rejected = await put(b, invalid, 0); assert(rejected.response.status === 422, `invalid v3 save was accepted: ${JSON.stringify(rejected.body)}`);
  }
  const pa = await put(a, sa, 0), pb = await put(b, sb, 0); assert(pa.response.ok && pb.response.ok, 'initial saves failed');
  let entered = await call('/api/trades', { method: 'POST', body: JSON.stringify({ action: 'create' }) }, a);
  assert(entered.response.ok && entered.body.trade.code?.length === 12, 'create failed'); const tradeId = entered.body.trade.id, code = entered.body.trade.code;
  entered = await call('/api/trades', { method: 'POST', body: JSON.stringify({ action: 'join', code }) }, b); assert(entered.response.ok, 'join failed'); let version = entered.body.trade.version;
  let changed = await call(`/api/trades/${tradeId}/offer`, { method: 'POST', body: JSON.stringify({ version, revision: pa.body.revision, monsterId: ma.instanceId, money: 900 }) }, a); assert(changed.response.ok, `creator offer failed ${JSON.stringify(changed.body)}`); version = changed.body.trade.version;
  changed = await call(`/api/trades/${tradeId}/offer`, { method: 'POST', body: JSON.stringify({ version, revision: pb.body.revision, monsterId: mb.instanceId, money: 300 }) }, b); assert(changed.response.ok, 'joiner offer failed'); version = changed.body.trade.version;
  changed = await call(`/api/trades/${tradeId}/confirm`, { method: 'POST', body: JSON.stringify({ version }) }, a); assert(changed.response.ok, 'first confirm failed'); version = changed.body.trade.version;
  const completed = await call(`/api/trades/${tradeId}/confirm`, { method: 'POST', body: JSON.stringify({ version }) }, b);
  assert(completed.response.ok && completed.body.trade.status === 'completed', `completion failed ${JSON.stringify(completed.body)}`);
  const ra = await call(`/api/trades/${tradeId}/result`, {}, a), rb = await call(`/api/trades/${tradeId}/result`, {}, b);
  assert(ra.response.ok && rb.response.ok, 'result recovery failed');
  const ag = ra.body.result.save.game as GameState, bg = rb.body.result.save.game as GameState;
  const receivedA = ag.player.box.find(mon => mon.speciesId === mb.speciesId), receivedB = bg.player.box.find(mon => mon.speciesId === ma.speciesId);
  assert(receivedA && receivedB && receivedA.instanceId !== mb.instanceId && receivedB.instanceId !== ma.instanceId, 'recipient-local IDs not allocated');
  assert(receivedB.brain?.updates === 9, 'complete monster brain was not preserved');
  assert(ag.versionCaught?.[ag.adventureVersion ?? 'red']?.includes(mb.speciesId) && bg.versionCaught?.[bg.adventureVersion ?? 'red']?.includes(ma.speciesId), `received species was not added to the active version collection: ${JSON.stringify([ag.versionCaught, bg.versionCaught])}`);
  assert(ag.player.money === 4400 && bg.player.money === 7600, 'money exchange incorrect');
  assert(rb.body.result.incomingNeural === null && ra.body.result.incomingNeural === null, 'absent neural attachment leaked a receipt');
  assert((rb.body.result.save.view.field.memories as any[]).some(row => row.id === receivedB.instanceId), 'field memory was not remapped');
  assert((rb.body.result.save.view.openWorld.companionMemories as any[]).some(row => row.id === `companion:${receivedB.instanceId}`), 'world companion memory was not remapped');
  assert(ra.body.result.tradeEpoch === 1 && rb.body.result.tradeEpoch === 1, 'trade epoch not incremented');
  const stale = await put(a, sa, ra.body.result.revision);
  assert(stale.response.status === 409, 'pre-trade save resurrected traded state');
  const retry = await call(`/api/trades/${tradeId}/confirm`, { method: 'POST', body: JSON.stringify({ version }) }, b);
  assert(retry.response.ok && retry.body.trade.status === 'completed', 'completed confirm retry not idempotent');
  console.log(JSON.stringify({ passed: true, tradeId, creatorRevision: ra.body.result.revision, joinerRevision: rb.body.result.revision, tradeEpoch: 1 }));
}
await main();
