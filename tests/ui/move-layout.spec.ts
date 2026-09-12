import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { ConnectomeController } from '../../src/game/connectome';
import { createGame, createMonster, type GameState, type Monster } from '../../src/game/engine';
import { getMoveLayout } from '../../src/game/move-layout';
import { defaultView, packSave, unpackSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import type { Graph } from '../../src/core/brain';
import type { FieldPolicy } from '../../src/game/field';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;
const slots = [
  { moveId: 45, pp: 17 }, // Growl: status
  { moveId: 33, pp: 11 }, // Tackle: attack
  { moveId: 73, pp: 8 }, // Leech Seed: status
  { moveId: 22, pp: 6 }, // Vine Whip: attack
];

test.setTimeout(150_000);

function fixture() {
  const game = createGame(1, 'move-layout-ui');
  const lead = createMonster(game, 1, 30);
  const boxed = createMonster(game, 1, 30);
  lead.moves = structuredClone(slots);
  boxed.moves = structuredClone(slots);
  game.player.team = [lead];
  game.player.box = [boxed];
  const controller = new ConnectomeController(graph);
  controller.ensure(lead);
  controller.ensure(boxed);
  return { game, lead, boxed };
}

async function bootstrap(page: Page) {
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
  await page.goto('/');
  await expect(page.locator('#starter-dialog [data-starter="1"]')).toBeVisible();
  await page.locator('#starter-dialog [data-starter="1"]').click();
}

async function importSave(page: Page, save: unknown) {
  const status = page.getByRole('status');
  await expect(status).toBeHidden();
  await page.locator('#import-file').setInputFiles({
    name: 'move-layout.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)),
  });
  await expect(status).toBeVisible();
  await expect(status).toContainText('불러왔습니다');
}

async function exportSave(page: Page) {
  await page.locator('[data-tab="lab"]').click();
  const pending = page.waitForEvent('download');
  await page.locator('#export-save').click();
  const download = await pending;
  return JSON.parse(await readFile((await download.path())!, 'utf8')) as { game: GameState };
}

const displayedMoveIds = (page: Page, root = '#team-detail') => page.locator(`${root} .move-layout-entry`).evaluateAll(entries =>
  entries.map(entry => Number((entry as HTMLElement).dataset.layoutMove)));
const brainState = (brain: Monster['brain']) => JSON.parse(JSON.stringify(brain, (key, value) => key === 'graph' ? undefined : value));

test('team and box layout edits persist without changing engine slots, PP, brain, or another individual', async ({ page }) => {
  const { game, lead, boxed } = fixture();
  const originalMoves = structuredClone(lead.moves);
  const originalBrain = structuredClone(lead.brain);
  expect(lead.moveOrder).toBeUndefined();
  expect(getMoveLayout(lead).map(entry => [entry.moveId, entry.sourceIndex])).toEqual([[33, 1], [22, 3], [45, 0], [73, 2]]);

  const world = new OpenWorldSimulation(graph, game, 7361, undefined, policy);
  world.setControlMode('manual');
  world.setAutoHunt(false);
  await bootstrap(page);
  await importSave(page, packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true }));

  await expect(page.locator('#world-edit-moves')).toBeEnabled();
  await page.locator('#world-edit-moves').click();
  await expect(page.locator('[data-tab="team"]')).toHaveClass(/active/);
  await expect.poll(() => displayedMoveIds(page)).toEqual([33, 22, 45, 73]);
  const boundary = page.locator('[data-reorder-from="1"][data-reorder-to="2"]');
  await expect(boundary).toBeDisabled();

  await page.locator('[data-reorder-from="0"][data-reorder-to="1"]').click();
  await expect(page.getByRole('status')).toHaveText('기술 배치를 저장했습니다.');
  await expect.poll(() => displayedMoveIds(page)).toEqual([22, 33, 45, 73]);
  await expect(page.locator('[data-reorder-from="1"][data-reorder-to="0"]')).toBeFocused();

  const local = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('choketmon-151', 2);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const value = await new Promise<{ game: GameState }>((resolve, reject) => {
      const request = db.transaction('saves', 'readonly').objectStore('saves').get('current');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    db.close(); return value;
  });
  expect(local.game.player.team[0].moveOrder).toEqual([22, 33, 45, 73]);
  expect(local.game.player.team[0].moves).toEqual(originalMoves);
  expect(brainState(local.game.player.team[0].brain)).toEqual(brainState(originalBrain));
  expect(local.game.player.box[0].moveOrder).toBeUndefined();

  await page.locator(`.box-monster[data-monster="${boxed.instanceId}"]`).click();
  await expect.poll(() => displayedMoveIds(page)).toEqual([33, 22, 45, 73]);
  await page.locator(`.team-monster[data-monster="${lead.instanceId}"]`).click();

  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.locator('#team-detail .move-layout-entry').evaluateAll(entries => entries.map(entry => {
    const rect = entry.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth };
  }));
  expect(overflow.every(({ left, right, viewport }) => left >= 0 && right <= viewport + 1)).toBe(true);
  await mkdir('artifacts/move-layout', { recursive: true });
  await page.screenshot({ path: 'artifacts/move-layout/mobile-team-layout.png', fullPage: true });

  const exported = await exportSave(page);
  expect(exported.game.player.team[0].moveOrder).toEqual([22, 33, 45, 73]);
  await page.reload();
  await page.locator('[data-tab="team"]').click();
  await expect.poll(() => displayedMoveIds(page)).toEqual([22, 33, 45, 73]);
  await importSave(page, exported);
  await page.locator('[data-tab="team"]').click();
  await expect.poll(() => displayedMoveIds(page)).toEqual([22, 33, 45, 73]);
});

test('classic battle uses the saved presentation order and disables editing', async ({ page }) => {
  const { game, lead } = fixture();
  lead.moveOrder = [22, 33, 73, 45];
  const enemy = createMonster(game, 4, 30);
  game.battle = {
    kind: 'wild', regionId: game.regionId,
    player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 },
    turn: 1, canRun: true,
  };
  await bootstrap(page);
  await importSave(page, packSave(game, graph, defaultView()));

  await expect(page.locator('[data-battle-move]')).toHaveCount(4);
  await expect(page.locator('[data-battle-move]').evaluateAll(buttons => buttons.map(button => Number((button as HTMLElement).dataset.battleMove)))).resolves.toEqual([3, 1, 2, 0]);
  await expect(page.locator('.battle-page')).toBeVisible();
});

test('world slots expose display and source indexes, and Digit1 spends only the first displayed move PP', async ({ page }) => {
  const { game, lead } = fixture();
  lead.moveOrder = [22, 33, 73, 45];
  const world = new OpenWorldSimulation(graph, game, 9917, undefined, policy);
  world.setControlMode('manual');
  world.setAutoHunt(false);
  expect(world.startEncounter(world.entities.find(entity => entity.kind === 'wild')!.id)).toBe(true);
  game.battle!.enemy.team = [createMonster(game, 208, 100)];
  game.battle!.enemy.activeIndex = 0;
  game.battle!.enemy.team[0].status = 'sleep';
  game.battle!.enemy.team[0].statusTurns = 3;
  await bootstrap(page);
  await importSave(page, packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: false }));

  const buttons = page.locator('[data-world-slot]');
  await expect(buttons).toHaveCount(4);
  await expect.poll(() => buttons.evaluateAll(items => items.map(item => ({
    slot: Number((item as HTMLElement).dataset.worldSlot),
    source: Number((item as HTMLElement).dataset.worldMove),
    moveId: Number((item as HTMLElement).dataset.worldMoveId),
  })))).toEqual([
    { slot: 0, source: 3, moveId: 22 },
    { slot: 1, source: 1, moveId: 33 },
    { slot: 2, source: 2, moveId: 73 },
    { slot: 3, source: 0, moveId: 45 },
  ]);
  await expect(page.locator('#world-edit-moves')).toBeDisabled();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });

  const before = structuredClone(lead.moves);
  await page.locator('#world-pause').focus();
  await expect(page.locator('#world-pause')).toBeFocused();
  await page.keyboard.press('Digit1');
  await expect(page.locator('[data-world-slot="0"]')).toContainText('PP 5/');
  await page.locator('#world-pause').click();
  const saved = await exportSave(page);
  const after = saved.game.player.team[0].moves;
  expect(after[3].pp).toBe(before[3].pp - 1);
  expect(after.filter((_slot, index) => index !== 3)).toEqual(before.filter((_slot, index) => index !== 3));
});

test('a legacy status-only set recovers one legal attack with a backup and uses it in automatic battle', async ({ page }) => {
  const game = createGame(1, 'attack-recovery-ui');
  const lead = createMonster(game, 54, 39);
  lead.moves = [487, 244, 133, 472].map(moveId => ({ moveId, pp: 3 }));
  game.player.team = [lead];
  const controller = new ConnectomeController(graph);
  controller.ensure(lead);
  const originalMoves = structuredClone(lead.moves);
  const originalBrain = brainState(lead.brain);

  await bootstrap(page);
  await importSave(page, packSave(game, graph, defaultView()));
  await page.locator('[data-tab="team"]').click();
  await expect.poll(() => displayedMoveIds(page)).toEqual([487, 244, 133, 472]);
  await expect(page.locator('#recover-attack')).toBeVisible();
  await page.locator('#recover-attack').selectOption('401');
  await page.locator('#recover-attack-move').click();
  await expect(page.getByRole('status')).toHaveText('공격 기술을 배치했습니다.');
  await expect.poll(() => displayedMoveIds(page)).toEqual([401, 244, 133, 472]);
  await expect(page.locator('#recover-attack-move')).toHaveCount(0);

  const backup = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('choketmon-151', 2);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const store = db.transaction('saves', 'readonly').objectStore('saves');
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = store.getAllKeys(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const key = keys.find(value => String(value).startsWith('backup-before-attack-recovery-'))!;
    const value = await new Promise<any>((resolve, reject) => {
      const request = store.get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    db.close(); return { key: String(key), value };
  });
  expect(backup.key).toMatch(/^backup-before-attack-recovery-\d+$/);
  expect(backup.value.game.player.team[0].moves).toEqual(originalMoves);

  const recovered = await exportSave(page);
  expect(recovered.game.player.team[0].moves.map(slot => slot.moveId)).toEqual([401, 244, 133, 472]);
  expect(brainState(recovered.game.player.team[0].brain)).toEqual(originalBrain);
  await page.reload();
  await page.locator('[data-tab="team"]').click();
  await expect.poll(() => displayedMoveIds(page)).toEqual([401, 244, 133, 472]);

  const restored = unpackSave(recovered, graph).game;
  const battleWorld = new OpenWorldSimulation(graph, restored, 7013, undefined, policy);
  battleWorld.setControlMode('auto');
  battleWorld.setAutoHunt(false);
  expect(battleWorld.startEncounter(battleWorld.entities.find(entity => entity.kind === 'wild')!.id)).toBe(true);
  battleWorld.game.battle!.enemy.team = [createMonster(battleWorld.game, 208, 100)];
  const enemy = battleWorld.game.battle!.enemy.team[0];
  enemy.status = 'sleep'; enemy.statusTurns = 3;
  const enemyHp = enemy.hp;
  await importSave(page, packSave(battleWorld.game, graph, { ...defaultView(), openWorld: battleWorld.snapshot(), openWorldPaused: false }));
  await expect(page.locator('#world-mode-auto')).toHaveAttribute('aria-pressed', 'true');
  const enemyMeter = page.getByRole('meter', { name: '강철톤 HP' });
  await expect(page.locator('[data-world-move-id="401"]')).not.toContainText('PP 15/15', { timeout: 15_000 });
  await expect(page.locator('#world-feed')).toContainText(/아쿠아테일! [1-9]\d* 피해/, { timeout: 20_000 });
  await expect.poll(async () => Number(await enemyMeter.getAttribute('aria-valuenow')), { timeout: 20_000 }).toBeLessThan(enemyHp);
  await page.locator('#world-pause').click();
  const battled = await exportSave(page);
  expect(battled.game.player.team[0].moves.find(slot => slot.moveId === 401)!.pp).toBeLessThan(15);
  expect(battled.game.logs.some(log => /아쿠아테일! [1-9]\d* 피해/.test(log))).toBe(true);
  expect(battled.game.battle!.enemy.team[0].hp).toBeLessThan(enemyHp);
});
