import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { availableMonsterMoveIds, createGame, createMonster, reorderMonsterMoves, replaceMonsterMove, type GameState } from '../src/game/engine.ts';
import { defaultView, packSave } from '../src/game/storage.ts';
import type { Graph } from '../src/core/brain.ts';

type Check = { name: string; passed: boolean; detail: string; status?: number; elapsedMs: number };
type Report = {
  schema: 1; suite: 'choketmon-rust-api'; baseUrl: string; startedAt: string; elapsedMs: number;
  testAccounts: string[]; brainStepRequested: boolean; passed: boolean; checks: Check[];
  fixture: { slot: string; graphId: string; creatureId: string; saveFormat: string; saveVersion: number };
};

class CookieJar {
  private values = new Map<string, string>();
  profileId?: string;
  capture(response: Response): string[] {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const rows = headers.getSetCookie?.() ?? (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')!] : []);
    for (const row of rows) {
      const match = /^\s*([^=;,\s]+)=([^;,]*)/.exec(row); if (!match) continue;
      if (/max-age=0/i.test(row) || /expires=Thu, 01 Jan 1970/i.test(row)) this.values.delete(match[1]);
      else this.values.set(match[1], match[2]);
    }
    return rows;
  }
  header() { return [...this.values].map(([name, value]) => `${name}=${value}`).join('; '); }
}

const argvValue = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const baseUrl = (argvValue('--base-url') ?? process.env.BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const output = resolve(argvValue('--out') ?? 'artifacts/rust-api-verification.json');
const brainStepRequested = process.argv.includes('--brain');
const origin = argvValue('--origin') ?? process.env.APP_ORIGIN ?? (new URL(baseUrl).port === '8080' ? 'http://127.0.0.1:5173' : new URL(baseUrl).origin);
const suffix = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 5)}`.toLowerCase();
const usernames = [`apitest_${suffix}`, `apitest2_${suffix}`].map(value => value.slice(0, 32));
const password = `Api-test-${suffix}!`;
const checks: Check[] = [];

async function request(path: string, init: RequestInit = {}, jar?: CookieJar) {
  const headers = new Headers(init.headers);
  if (jar?.header()) headers.set('cookie', jar.header());
  if (jar?.profileId && !headers.has('x-choketmon-profile')) headers.set('x-choketmon-profile', jar.profileId);
  if (init.method && init.method !== 'GET' && init.method !== 'HEAD' && !headers.has('origin')) headers.set('origin', origin);
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  return { response, elapsedMs: Math.round(performance.now() - started) };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json().catch(() => ({})) as Record<string, unknown>;
}

function record(name: string, passed: boolean, detail: string, elapsedMs: number, status?: number) {
  checks.push({ name, passed, detail, status, elapsedMs });
}

async function main() {
  const started = Date.now(), startedAt = new Date(started).toISOString();
  const graph = JSON.parse(await readFile(resolve('public/data/connectome.json'), 'utf8')) as Graph;
  const game = createGame(1, `rust-api-${suffix}`);
  const starter = game.player.team[0], customized = createMonster(game, 54, 39);
  game.player.team = [customized]; game.player.box = [starter];
  game.dex.seen = [...new Set([...game.dex.seen, customized.speciesId])].sort((a, b) => a - b);
  game.dex.caught = [...new Set([...game.dex.caught, customized.speciesId])].sort((a, b) => a - b);
  game.versionCaught!.red = [...new Set([...(game.versionCaught!.red ?? []), customized.speciesId])].sort((a, b) => a - b);
  customized.moves[1].pp -= 2;
  const replacementMoveId = availableMonsterMoveIds(customized).find(moveId => !customized.moves.some(slot => slot.moveId === moveId));
  if (replacementMoveId === undefined) throw new Error('PP reserve fixture requires an unequipped legal move');
  replaceMonsterMove(game, customized.instanceId, 1, replacementMoveId);
  reorderMonsterMoves(game, customized.instanceId, 1, 3);
  const moveOrder = structuredClone(customized.moveOrder!);
  const movePpReserve = structuredClone(customized.movePpReserve!);
  customized.evolutionProgress!.friendship = 190;
  customized.evolutionProgress!.beauty = 80;
  customized.evolutionProgress!.steps = 1234;
  customized.evolutionProgress!.moveUses[String(customized.moves[0].moveId)] = 20;
  game.inventory['metal-coat'] = 2; game.inventory['evolution-catalyst'] = 3;
  game.evolutionContext = { period: 'night', regionId: 'kanto', locationId: 'pallet', raining: false, multiplayer: false };
  const expectedGrowth = structuredClone(customized.evolutionProgress);
  const save = packSave(game, graph, defaultView());
  const storedMonster = (envelope: Record<string, unknown>) => (envelope.save as { game?: GameState } | undefined)?.game?.player.team.find(monster => monster.instanceId === customized.instanceId);
  const hasMoveOrder = (envelope: Record<string, unknown>) => JSON.stringify(storedMonster(envelope)?.moveOrder) === JSON.stringify(moveOrder);
  const hasMovePpReserve = (envelope: Record<string, unknown>) => JSON.stringify(storedMonster(envelope)?.movePpReserve) === JSON.stringify(movePpReserve);
  const hasEvolution = (envelope: Record<string, unknown>) => {
    const stored = (envelope.save as { game?: GameState } | undefined)?.game;
    return isDeepStrictEqual(storedMonster(envelope)?.evolutionProgress, expectedGrowth)
      && stored?.inventory['metal-coat'] === 2 && stored?.inventory['evolution-catalyst'] === 3
      && isDeepStrictEqual(stored.evolutionContext, game.evolutionContext);
  };
  const creatureId = customized.instanceId, slot = `api-check-${suffix}`;
  const first = new CookieJar(), second = new CookieJar();

  try {
    let call = await request('/api/auth/me');
    record('unauthenticated me returns guest', call.response.status === 200 && (await json(call.response)).user === null, 'GET /api/auth/me reports no user', call.elapsedMs, call.response.status);

    call = await request('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: usernames[0], password }) });
    const registrationCookies = first.capture(call.response), registered = await json(call.response);
    first.profileId = (registered.user as { id?: string } | undefined)?.id;
    record('register first account', [200, 201].includes(call.response.status) && (registered.user as { username?: string } | undefined)?.username === usernames[0], 'unique test account created', call.elapsedMs, call.response.status);
    record('session cookie is HttpOnly', registrationCookies.some(value => /;\s*httponly(?:;|$)/i.test(value)), 'Set-Cookie contains HttpOnly', call.elapsedMs, call.response.status);
    record('session cookie has SameSite', registrationCookies.some(value => /;\s*samesite=(lax|strict)(?:;|$)/i.test(value)), 'Set-Cookie contains SameSite=Lax or Strict', call.elapsedMs, call.response.status);

    call = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: usernames[0], password: `${password}-wrong` }) });
    record('wrong password rejected', call.response.status === 401, 'invalid credentials return 401', call.elapsedMs, call.response.status);

    call = await request('/api/auth/me', {}, first); const me = await json(call.response);
    record('authenticated me returns account', call.response.status === 200 && (me.user as { username?: string } | undefined)?.username === usernames[0], 'session cookie resolves to first account', call.elapsedMs, call.response.status);

    call = await request(`/api/saves/${encodeURIComponent(slot)}`, {}, first);
    record('new slot is absent', call.response.status === 404, 'first account starts without the test slot', call.elapsedMs, call.response.status);

    const requestId = crypto.randomUUID(), initialBody = JSON.stringify({ save, revision: 0, requestId });
    call = await request(`/api/saves/${encodeURIComponent(slot)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: initialBody }, first);
    const initialPut = await json(call.response), revision = Number(initialPut.revision);
    record('create game save', call.response.status === 200 && Number.isSafeInteger(revision) && revision > 0, 'PUT stores a packSave fixture and returns a revision', call.elapsedMs, call.response.status);

    call = await request(`/api/saves/${encodeURIComponent(slot)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: initialBody }, first);
    const retry = await json(call.response);
    record('idempotent save retry', call.response.status === 200 && Number(retry.revision) === revision, 'same requestId returns the original revision', call.elapsedMs, call.response.status);

    const reusedId = structuredClone(save); reusedId.savedAt = new Date(Date.now() + 500).toISOString();
    call = await request(`/api/saves/${encodeURIComponent(slot)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ save: reusedId, revision: 0, requestId }) }, first);
    record('reused request ID with another body conflicts', call.response.status === 409, 'same requestId with a different payload returns 409', call.elapsedMs, call.response.status);

    const changed = structuredClone(save); changed.savedAt = new Date(Date.now() + 1_000).toISOString();
    call = await request(`/api/saves/${encodeURIComponent(slot)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ save: changed, revision: 0, requestId: crypto.randomUUID() }) }, first);
    record('competing save conflicts', call.response.status === 409, 'stale expected revision returns 409', call.elapsedMs, call.response.status);

    call = await request(`/api/saves/${encodeURIComponent(slot)}`, {}, first); const stored = await json(call.response);
    record('saved game restores', call.response.status === 200 && Number(stored.revision) === revision && (stored.save as { format?: string } | undefined)?.format === 'choketmon', 'GET returns the same game envelope and revision', call.elapsedMs, call.response.status);
    record('move layout survives server save', call.response.status === 200 && hasMoveOrder(stored), 'GET preserves the individual move-order preference', call.elapsedMs, call.response.status);
    record('evolution growth and tools survive server save', call.response.status === 200 && hasEvolution(stored), 'GET preserves growth counters, context and evolution inventory', call.elapsedMs, call.response.status);
    record('unequipped move PP survives server save', call.response.status === 200 && hasMovePpReserve(stored), 'GET preserves spent PP for the replaced move without refreshing it', call.elapsedMs, call.response.status);

    call = await request('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: usernames[1], password }) });
    second.capture(call.response); const secondRegistered = await json(call.response);
    second.profileId = (secondRegistered.user as { id?: string } | undefined)?.id;
    record('register second account', [200, 201].includes(call.response.status) && (secondRegistered.user as { username?: string } | undefined)?.username === usernames[1], 'second isolated test account created', call.elapsedMs, call.response.status);
    call = await request(`/api/saves/${encodeURIComponent(slot)}`, {}, second);
    record('other account cannot see save', call.response.status === 404, 'same slot name is absent for the second account', call.elapsedMs, call.response.status);

    const originalSession = first.header();
    call = await request('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, first); first.capture(call.response);
    record('logout accepted', call.response.status === 204, 'POST /api/auth/logout returns 204', call.elapsedMs, call.response.status);
    const revoked = new CookieJar(); Object.defineProperty(revoked, 'header', { value: () => originalSession });
    call = await request('/api/auth/me', {}, revoked);
    record('logout revokes session', call.response.status === 200 && (await json(call.response)).user === null, 'the pre-logout cookie no longer authenticates', call.elapsedMs, call.response.status);

    const restored = new CookieJar();
    call = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: usernames[0], password }) }); restored.capture(call.response);
    const relogged = await json(call.response); restored.profileId = (relogged.user as { id?: string } | undefined)?.id;
    record('relogin succeeds', call.response.status === 200, 'first account can create a fresh session', call.elapsedMs, call.response.status);
    call = await request(`/api/saves/${encodeURIComponent(slot)}`, {}, restored); const restoredSave = await json(call.response);
    record('relogin restores save', call.response.status === 200 && Number(restoredSave.revision) === revision, 'saved revision remains attached to the account', call.elapsedMs, call.response.status);
    record('relogin restores evolution growth and tools', call.response.status === 200 && hasEvolution(restoredSave), 'growth counters and inventory survive a fresh session', call.elapsedMs, call.response.status);
    record('relogin restores move layout', call.response.status === 200 && hasMoveOrder(restoredSave), 'move-order preference remains attached to the individual after logout and login', call.elapsedMs, call.response.status);
    record('relogin restores unequipped move PP', call.response.status === 200 && hasMovePpReserve(restoredSave), 'spent PP for the replaced move remains attached to the individual after logout and login', call.elapsedMs, call.response.status);

    call = await request(`/api/saves/cross-origin-${suffix}`, { method: 'PUT', headers: { origin: 'https://attacker.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ save, revision: 0, requestId: crypto.randomUUID() }) }, restored);
    record('cross-origin mutation rejected', call.response.status === 403, 'authenticated cross-origin PUT returns 403', call.elapsedMs, call.response.status);
    call = await request(`/api/saves/non-json-${suffix}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: '{}' }, restored);
    record('non-JSON mutation rejected', call.response.status === 415, 'authenticated text/plain PUT returns 415', call.elapsedMs, call.response.status);
    call = await request(`/api/saves/profile-swap-${suffix}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-choketmon-profile': first.profileId! }, body: JSON.stringify({ save, revision: 0, requestId: crypto.randomUUID() }) }, second);
    record('cross-tab profile swap rejected', call.response.status === 403, 'a tab holding profile A data cannot write after the shared cookie changes to session B', call.elapsedMs, call.response.status);
    const missingOriginStarted = performance.now();
    const missingOrigin = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: restored.header() }, body: '{}', redirect: 'manual' });
    record('missing Origin mutation rejected', missingOrigin.status === 403, 'authenticated POST without Origin returns 403', Math.round(performance.now() - missingOriginStarted), missingOrigin.status);

    const edited = structuredClone(save) as typeof save & { game: { player: { team: Array<{ stats: { attack: number } }> } } };
    edited.game.player.team[0].stats.attack += 999;
    call = await request(`/api/saves/edited-${suffix}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ save: edited, revision: 0, requestId: crypto.randomUUID() }) }, restored);
    record('edited Pokemon rejected', call.response.status === 422, 'server recalculates Pokemon stats instead of trusting the client', call.elapsedMs, call.response.status);

    const receiptSlot = `receipt-${suffix}`, firstReceiptId = crypto.randomUUID();
    call = await request(`/api/saves/${receiptSlot}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ save, revision: 0, requestId: firstReceiptId }) }, restored);
    const receiptOne = await json(call.response);
    const nextSave = structuredClone(save); nextSave.savedAt = new Date(Date.now() + 2_000).toISOString();
    call = await request(`/api/saves/${receiptSlot}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ save: nextSave, revision: Number(receiptOne.revision), requestId: crypto.randomUUID() }) }, restored);
    const alteredOldRequest = structuredClone(save); alteredOldRequest.savedAt = new Date(Date.now() + 3_000).toISOString();
    call = await request(`/api/saves/${receiptSlot}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ save: alteredOldRequest, revision: 0, requestId: firstReceiptId }) }, restored);
    record('old request receipt cannot be reused', call.response.status === 409, 'request IDs remain bound after a newer save', call.elapsedMs, call.response.status);

    for (const [name, path, init] of [
      ['unauthenticated save read rejected', `/api/saves/${slot}`, {}],
      ['unauthenticated save write rejected', `/api/saves/${slot}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ save, revision: 0, requestId: crypto.randomUUID() }) }],
      ['unauthenticated brain step rejected', `/api/brains/${encodeURIComponent(creatureId)}/step`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), inputs: Array(12).fill(0), available: Array(5).fill(true), reward: null, learning: false, terminal: false }) }],
    ] as const) {
      call = await request(path, init); record(name, call.response.status === 401, `${init.method ?? 'GET'} returns 401 without a session`, call.elapsedMs, call.response.status);
    }

    if (brainStepRequested) {
      const brainBody = JSON.stringify({ requestId: crypto.randomUUID(), inputs: [1, .8, .7, 0, .1, .02, 0, 0, 1, .7, .5, .2], available: [true, true, true, true, true], reward: null, learning: false, terminal: false });
      call = await request(`/api/brains/${encodeURIComponent(creatureId)}/step`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: brainBody }, restored); const firstBrainStatus = call.response.status, firstBrain = await json(call.response);
      record('database-backed brain step retired', firstBrainStatus === 410 && firstBrain.code === 'LOCAL_CHECKPOINT_REQUIRED', 'legacy endpoint cannot write a neural state on every turn', call.elapsedMs, firstBrainStatus);
    }
  } catch (error) {
    record('suite execution', false, error instanceof Error ? error.message : String(error), Date.now() - started);
  }

  const report: Report = {
    schema: 1, suite: 'choketmon-rust-api', baseUrl, startedAt, elapsedMs: Date.now() - started,
    testAccounts: usernames, brainStepRequested, passed: checks.every(check => check.passed), checks,
    fixture: { slot, graphId: graph.id, creatureId, saveFormat: save.format, saveVersion: save.version },
  };
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.passed ? 'PASS' : 'FAIL'} ${checks.filter(check => check.passed).length}/${checks.length} checks; report: ${output}`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
