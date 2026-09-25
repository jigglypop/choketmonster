import { expect, test, type BrowserContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { assignPreferredTransformation, assignAlolaForm, createGame, createMonster, replaceMonsterMove } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import type { Graph } from '../../src/core/brain';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const base = process.env.CHOKETMON_BASE_URL ?? 'http://127.0.0.1:5173';

async function prepare(context: BrowserContext, index: number) {
  const username = `rankforms_${index}_${Date.now().toString(36)}`;
  const registered = await context.request.post(`${base}/api/auth/register`, { headers: { origin: base }, data: { username, password: `Rank-fixture-${Date.now()}!` } });
  expect(registered.ok(), await registered.text()).toBe(true);
  const user = (await registered.json()).user as { id: string };
  const headers = { origin: base, 'x-choketmon-profile': user.id };
  const game = createGame(4, username);
  game.player.team = [createMonster(game, index ? 26 : 6, 50), createMonster(game, 25, 50)];
  if (index) { assignAlolaForm(game, game.player.team[0].instanceId, true); replaceMonsterMove(game, game.player.team[0].instanceId, 0, 851); }
  if (!index) { game.inventory['mega-stone:charizard-mega-x'] = 1; assignPreferredTransformation(game, game.player.team[0].instanceId, { kind: 'mega', formIdentifier: 'charizard-mega-x' }); }
  if (index) game.player.team[0].heldTool = 'focus-sash';
  game.dex.caught = [...new Set([4, ...game.player.team.map(m => m.speciesId)])].sort((a, b) => a - b);
  game.dex.seen = game.dex.caught.slice();
  const world = new OpenWorldSimulation(graph, game, index + 200);
  world.setControlMode('manual'); world.setAutoHunt(false);
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true });
  const saved = await context.request.put(`${base}/api/saves/current`, { headers, data: { save, revision: 0, requestId: crypto.randomUUID() } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  return { context, page, headers, errors };
}

test('real ranked applies preset Mega and Alola before the first move, then survives reload', async ({ browser }) => {
  test.setTimeout(120_000);
  const a = await browser.newContext(), b = await browser.newContext();
  try {
    const left = await prepare(a, 0), right = await prepare(b, 1);
    for (const trainer of [left, right]) {
      const queued = await trainer.context.request.post(`${base}/api/ranked/queue`, { headers: trainer.headers, data: { league: 'standard' } });
      expect(queued.ok(), await queued.text()).toBe(true);
    }
    for (const trainer of [left, right]) {
      await trainer.page.goto(base);
      await expect(trainer.page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
      await trainer.page.locator('[data-tab="ranked"]').click();
      await expect(trainer.page.locator('.ranked-match')).toBeVisible();
    }
    await expect(right.page.locator('.ranked-fighter.is-self img')).toHaveAttribute('src', /10100/);
    await expect(right.page.locator('.ranked-fighter.is-self h3')).toHaveText('알로라 라이츄');
    await expect(left.page.locator('.battle-transformation-active')).toHaveText('메가진화');
    await expect(left.page.locator('.ranked-fighter.is-self img')).toHaveAttribute('src', /10034/);
    await expect(left.page.locator('.ranked-fighter.is-self h3')).toHaveText('메가리자몽 X');
    await expect(right.page.locator('.battle-transformation-active')).toHaveCount(0);
    const status = async () => (await (await a.request.get(`${base}/api/ranked?league=standard`, { headers: left.headers })).json()).currentMatch;
    let match = await status();
    expect(match.turn).toBe(1);
    expect(match.selfSide.team[0].types).toEqual(['fire', 'dragon']);
    expect(match.opponentSide.team[0].types).toEqual(['electric', 'psychic']);
    // The opponent view carries only the active Pokémon's card, so the move list is read from the owner's side.
    const rightMatch = (await (await right.context.request.get(`${base}/api/ranked?league=standard`, { headers: right.headers })).json()).currentMatch;
    expect(rightMatch.selfSide.team[0].moves.find((move: { id: number }) => move.id === 851).type).toBe('normal');
    await expect(right.page.locator('.ranked-moves button').filter({ hasText: '테라버스트' })).toContainText('노말');
    expect(match.selfSide.megaUsed).toBe(true);
    const repeated = await a.request.post(`${base}/api/ranked/matches/${match.id}/action`, { headers: left.headers, data: { turn: match.turn, transformation: { kind: 'mega', formIdentifier: 'charizard-mega-x' } } });
    expect(repeated.status()).toBe(422);
    await left.page.reload(); await left.page.locator('[data-tab="ranked"]').click();
    await expect(left.page.locator('.battle-transformation-active')).toHaveText('메가진화');
    const index = match.selfSide.team[0].moves.findIndex((move: { power: number }) => move.power === 0);
    const selected = Math.max(0, index);
    await left.page.locator(`[data-ranked-move="${selected}"]`).click();
    await right.page.locator('[data-ranked-move="0"]').click();
    await expect.poll(async () => (await status()).turn).toBe(match.turn + 1);
    match = await status(); expect(match.selfSide.team[0].choiceMove).toBeNull();
    await expect(left.page.locator('.ranked-wait')).toHaveCount(0);
    await expect(left.page.locator(`[data-ranked-move="${selected}"]`)).toBeEnabled();
    await expect(left.page.locator(`[data-ranked-move="${(selected + 1) % match.selfSide.team[0].moves.length}"]`)).toBeEnabled();
    await left.page.screenshot({ path: 'artifacts/ranked-forms-live.png', fullPage: true });
    expect([...left.errors, ...right.errors]).toEqual([]);
    const surrendered = await a.request.post(`${base}/api/ranked/matches/${match.id}/action`, { headers: left.headers, data: { turn: match.turn, surrender: true } });
    expect(surrendered.ok(), await surrendered.text()).toBe(true);
  } finally { await a.close(); await b.close(); }
});
