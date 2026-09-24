import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { assignAlolaForm, createGame, createMonster, type Monster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import type { Graph } from '../../src/core/brain';
import { getSpecies } from '../../src/data/pokemon';
import { openExplorePanel } from './helpers/explore-panel';

test.setTimeout(240_000);
const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const base = process.env.CHOKETMON_BASE_URL ?? 'http://127.0.0.1:5186';

async function prepare(context: BrowserContext, index: number) {
  await context.addInitScript(() => { localStorage.setItem('choketmon-audio-v1', JSON.stringify({ musicVolume: .34, effectsVolume: .62, muted: true })); });
  const username = `tradeui_${index}_${Date.now().toString(36)}`;
  const registered = await context.request.post(`${base}/api/auth/register`, { headers: { origin: base }, data: { username, password: `Trade-fixture-${Date.now()}!` } });
  expect(registered.ok(), await registered.text()).toBe(true);
  const user = (await registered.json()).user as { id: string; username: string };
  const game = createGame(index ? 155 : 152, `${username}-different-seed`), boxed = createMonster(game, index ? 7 : 19, 12);
  game.autoMergeDuplicates = true;
  if (!index) {
    // Keep the established UI label while exercising an actual transferable
    // Alola form and held-tool payload through both account saves.
    boxed.nickname = getSpecies(25).name;
    game.player.box.push(boxed); assignAlolaForm(game, boxed.instanceId, true); game.player.box.pop();
    boxed.heldTool = 'focus-sash';
  }
  game.player.box.push(boxed); game.dex.seen.push(boxed.speciesId); game.dex.caught.push(boxed.speciesId); game.dex.seen.sort((a,b)=>a-b); game.dex.caught.sort((a,b)=>a-b);
  const world = new OpenWorldSimulation(graph, game, 100 + index); world.setControlMode('manual'); world.setAutoHunt(false);
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true });
  const saved = await context.request.put(`${base}/api/saves/current`, { headers: { origin: base, 'x-choketmon-profile': user.id }, data: { save, revision: 0, requestId: crypto.randomUUID() } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const page = await context.newPage();
  await page.goto(base);
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  // Trade lives in the exploration settings, beside the pause button.
  await openExplorePanel(page); await expect(page.locator('#world-trade-open')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-paused', 'true');
  return { page, user, game, boxed };
}

async function brainStep(page: Page, self: Monster, foe: Monster, turn: number) {
  return page.evaluate(async ({ self, foe, turn }) => {
    const brainModule = '/src/game/server-brain.ts', controllerModule = '/src/game/connectome.ts';
    const brain = await import(brainModule), { ConnectomeController } = await import(controllerModule);
    const graph = await (await fetch('/data/connectome.json')).json();
    const controller = new ConnectomeController(graph);
    const result = await brain.chooseServerBrain(controller, self, foe, turn, .2, true, 'transfer-exact-episode');
    return { action: result.action, updates: result.updates, activity: result.activity };
  }, { self, foe, turn });
}

test('two authenticated trainers trade colliding IDs and money, preserve a full brain, then trade again', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  try {
    const left = await prepare(a, 0), right = await prepare(b, 1);
    expect(left.boxed.instanceId).toBe(right.boxed.instanceId);
    const initialDecision = await brainStep(left.page, left.boxed, left.game.player.team[0], 1);
    expect(initialDecision.updates).toBeGreaterThanOrEqual(0);
    const materialized = left.page.waitForResponse(response => response.url().endsWith('/api/local-brains/checkpoint') && response.ok());
    const sockets: string[] = [];
    for (const page of [left.page, right.page]) page.on('websocket', socket => { if (socket.url().includes('/api/trades/live')) sockets.push(socket.url()); });
    await left.page.locator('#world-trade-open').click();
    await left.page.locator('[data-create]').click();
    await expect(left.page.locator('[data-code]')).toHaveText(/^[A-Za-z0-9]{12}$/);
    const code = await left.page.locator('[data-code]').innerText();
    await right.page.locator('#world-trade-open').click();
    await right.page.locator('[data-join] input').fill(code); await right.page.locator('[data-join] button').click();
    await expect(left.page.locator('[data-other]')).toContainText(right.user.username, { timeout: 15_000 });
    await left.page.locator('.trade-offer select').selectOption(left.boxed.instanceId);
    const offered = left.page.waitForResponse(response => response.url().endsWith('/offer') && response.request().method() === 'POST', { timeout: 60_000 });
    await left.page.locator('.trade-offer input').fill('150'); await left.page.locator('.trade-offer button').click();
    await materialized;
    const offerResponse = await offered; expect(offerResponse.ok(), await offerResponse.text()).toBe(true);
    await expect(left.page.locator('[data-own]')).toContainText('피카츄');
    await expect(right.page.locator('[data-other]')).toContainText('피카츄', { timeout: 15_000 });
    await right.page.locator('.trade-offer select').selectOption(right.boxed.instanceId);
    await right.page.locator('.trade-offer input').fill('400'); await right.page.locator('.trade-offer button').click();
    await expect(left.page.locator('[data-other]')).toContainText('꼬부기', { timeout: 15_000 });
    await left.page.locator('[data-confirm]').click();
    await expect(right.page.locator('[data-other]')).toContainText('확인 완료', { timeout: 15_000 });
    await right.page.locator('[data-confirm]').click();
    await expect(left.page.locator('.trade-dialog')).not.toBeVisible({ timeout: 30_000 });
    await expect(right.page.locator('.trade-dialog')).not.toBeVisible({ timeout: 30_000 });
    expect(sockets).toHaveLength(2);
    const getSave = async (context: BrowserContext, id: string) => (await context.request.get(`${base}/api/saves/current`, { headers: { 'x-choketmon-profile': id } })).json();
    const ls = await getSave(a, left.user.id), rs = await getSave(b, right.user.id);
    expect(ls.save.game.player.money).toBe(3250); expect(rs.save.game.player.money).toBe(2750);
    expect(ls.save.game.autoMergeDuplicates).toBe(true); expect(rs.save.game.autoMergeDuplicates).toBe(true);
    expect(ls.save.game.player.box.map((m: Monster)=>m.speciesId)).toEqual([7]);
    const received = rs.save.game.player.box[0] as Monster;
    expect(received.speciesId).toBe(19); expect(received.instanceId).not.toBe(left.boxed.instanceId);
    expect(received.regionalForm).toBe('rattata-alola'); expect(received.heldTool).toBe('focus-sash');
    // Identical sensory inputs continue the exact source circuit despite a new game and ID.
    const expected = await brainStep(left.page, left.boxed, left.game.player.team[0], 2);
    const actual = await brainStep(right.page, received, left.game.player.team[0], 2);
    expect(actual).toEqual(expected);
    await right.page.reload(); await openExplorePanel(right.page); await expect(right.page.locator('#world-trade-open')).toBeVisible({ timeout: 30_000 });
    await right.page.locator('#world-trade-open').click();
    await expect(right.page.locator('[data-create]')).toBeVisible({ timeout: 20_000 });
    await right.page.locator('[data-create]').click();
    await right.page.locator('[data-cancel]').click();
    await expect(right.page.locator('.trade-dialog')).not.toBeVisible();
    await right.page.locator('#world-trade-open').click(); await expect(right.page.locator('[data-create]')).toBeVisible();
    await right.page.locator('.trade-close').click();
  } finally { await a.close(); await b.close(); }
});
