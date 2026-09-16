import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Graph } from '../../src/core/brain';
import type { FieldPolicy } from '../../src/game/field';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave, type SaveEnvelope } from '../../src/game/storage';
import { getCaveScene } from '../../src/openworld/caves';
import { OpenWorldSimulation } from '../../src/openworld/simulation';

test.setTimeout(180_000);
test.use({ launchOptions: { args: ['--mute-audio', '--enable-unsafe-webgpu'] } });
const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;

function sceneSaves() {
  const game = createGame(152, 'music-scenes');
  const world = new OpenWorldSimulation(graph, game, 7619, undefined, policy);
  const save = () => structuredClone(packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false }));
  const town = save();
  const cave = getCaveScene('cave:johto:slowpoke-well')!;
  world.player = { ...cave.portals[0].surface, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  expect(world.traverseCavePortal()).toBe(true);
  const underground = save();
  const wild = world.entities.find(entity => entity.kind === 'wild')!;
  world.player = { x: wild.x, z: wild.z, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  expect(world.startEncounter(wild.id)).toBe(true);
  return { town, underground, battle: save() };
}

async function importScene(page: Page, save: SaveEnvelope, cue: string, playing = true) {
  await page.locator('#import-file').setInputFiles({ name: 'music-scene.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  const audio = page.locator('#game-music-audio');
  await expect(audio).toHaveAttribute('data-cue', cue, { timeout: 45_000 });
  if (playing) await expect.poll(() => audio.evaluate(element => {
    const media = element as HTMLAudioElement;
    return !media.paused && media.currentTime > .05 && !media.error;
  }), { timeout: 20_000 }).toBe(true);
  else expect(await audio.evaluate(element => (element as HTMLAudioElement).paused)).toBe(true);
}

test('battle and capture states keep the exploration track and playback position', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**', socket => socket.close());
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
  await page.goto('/');
  await page.locator('[data-starter="152"]').click();
  const saves = sceneSaves();
  await importScene(page, saves.underground, 'cave');
  const cavePosition = await page.locator('#game-music-audio').evaluate(element => (element as HTMLAudioElement).currentTime);
  await page.locator('#import-file').setInputFiles({ name: 'music-scene.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saves.battle)) });
  await expect(page.locator('#game-music-audio')).toHaveAttribute('data-cue', 'cave');
  await page.waitForTimeout(1_000);
  await expect(page.locator('#game-music-audio')).toHaveAttribute('data-cue', 'cave');
  const battlePosition = await page.locator('#game-music-audio').evaluate(element => (element as HTMLAudioElement).currentTime);
  expect(battlePosition).toBeGreaterThan(cavePosition);
  await page.screenshot({ path: testInfo.outputPath('battle-keeps-exploration.png') });
  await page.locator('#import-file').setInputFiles({ name: 'music-scene.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saves.underground)) });
  await expect(page.locator('#game-music-audio')).toHaveAttribute('data-cue', 'cave');
  await expect.poll(() => page.locator('#game-music-audio').evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(battlePosition);
  await page.locator('#import-file').setInputFiles({ name: 'music-scene.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saves.town)) });
  await expect(page.locator('#game-music-audio')).toHaveAttribute('data-cue', 'pallet', { timeout: 5_000 });
  await importScene(page, saves.underground, 'cave');
  await expect.poll(() => page.locator('#game-music-audio').evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(cavePosition);
  await page.locator('#game-sound-toggle').click();
  await importScene(page, saves.town, 'pallet', false);
  await page.reload();
  await expect(page.locator('#game-music-audio')).toHaveAttribute('data-cue', 'pallet');
  await page.locator('[data-tab="team"]').click();
  expect(await page.locator('#game-music-audio').evaluate(element => (element as HTMLAudioElement).paused)).toBe(true);
  await page.locator('#game-sound-toggle').click();
  await expect.poll(() => page.locator('#game-music-audio').evaluate(element => (element as HTMLAudioElement).currentTime), { timeout: 20_000 }).toBeGreaterThan(.05);
  expect(errors).toEqual([]);
});

test('bundled music works when the personal music database cannot be opened', async ({ page }) => {
  await page.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (name, version) {
      if (name === 'choketmon-local-music-v1') throw new DOMException('Storage unavailable', 'SecurityError');
      return open.call(this, name, version);
    };
  });
  await page.routeWebSocket('**', socket => socket.close());
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
  await page.goto('/');
  await page.locator('[data-starter="152"]').click();
  await expect(page.locator('#game-music-audio')).toHaveAttribute('data-cue', 'pallet');
  await expect.poll(() => page.locator('#game-music-audio').evaluate(element => (element as HTMLAudioElement).currentTime), { timeout: 20_000 }).toBeGreaterThan(.05);
});
