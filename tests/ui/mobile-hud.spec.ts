import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8'));
test.use({ hasTouch: true, launchOptions: { args: ['--mute-audio', '--enable-unsafe-webgpu'] } });
test.setTimeout(120000);

async function loadWorld(page: Page, battle = false) {
  const game = createGame(152, 'mobile-hud');
  const world = new OpenWorldSimulation(graph, game, 35211, undefined, policy);
  world.setAutoHunt(false);
  if (battle) world.startEncounter(world.entities.find(entity => entity.kind === 'wild')!.id);
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: { id: 'mobile-hud', username: 'mobile' } } }));
  await page.route('**/api/saves/current', route => route.fulfill({ json: { save, revision: 1 } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route('**/api/auth/realtime-ticket', route => route.fulfill({ status: 401, json: { message: 'Login required' } }));
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => /\/152\.glb$/.test(route.request().url()) ? route.continue() : route.abort());
  await page.goto('/?renderProbe');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 45000 });
  await expect.poll(() => page.evaluate(() => {
    const probe = (window as any).__renderProbe?.read();
    return probe?.samples.length >= 10 && probe.loadedPokemon.includes(152);
  }), { timeout: 30000 }).toBe(true);
}

test('mobile chat and partner leave the terrain clear and expand one at a time', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await loadWorld(page);
  const chat = page.locator('.social-dock'), partner = page.locator('.world-battle-hud');
  await expect(page.locator('.world-dpad,[data-world-step]')).toHaveCount(0);
  await expect(page.locator('#world-chat-collapse')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#world-chat-form')).toBeHidden();
  await expect(partner).not.toHaveAttribute('open', '');
  mkdirSync('artifacts/mobile-hud', { recursive: true });
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    const terrain = (await page.locator('.adventure').boundingBox())!;
    const a = (await partner.boundingBox())!, b = (await chat.boundingBox())!;
    expect(a.height).toBeLessThanOrEqual(48);
    expect(b.height).toBeLessThanOrEqual(48);
    expect(a.y + a.height).toBeLessThanOrEqual(b.y);
    expect(b.y + b.height).toBeLessThanOrEqual(terrain.y + terrain.height);
    expect(a.y - terrain.y).toBeGreaterThan(terrain.height * .6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/mobile-hud/compact-${viewport.width}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#world-chat-collapse').click();
  await expect(page.locator('#world-chat-form')).toBeVisible();
  await expect(page.locator('#world-chat-input')).toBeVisible();
  await page.screenshot({ path: 'artifacts/mobile-hud/chat-open.png' });
  await partner.locator(':scope > summary').click();
  await expect(page.locator('#world-chat-form')).toBeHidden();
  await expect(page.locator('#world-combatants')).toBeVisible();
  await page.screenshot({ path: 'artifacts/mobile-hud/partner-open.png' });
  await page.locator('#world-chat-collapse').click();
  await expect(partner).not.toHaveAttribute('open', '');
  await expect(page.locator('#world-chat-form')).toBeVisible();
  expect(errors).toEqual([]);
});

for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
  test(`restored battle stays folded and manual actions stay compact at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await loadWorld(page, true);
    const partner = page.locator('.world-battle-hud');
    await expect(partner).not.toHaveAttribute('open', '');
    expect((await partner.boundingBox())!.height).toBeLessThanOrEqual(48);
    await partner.locator(':scope > summary').click();
    await expect(page.locator('#world-moves')).toBeVisible();
    await expect(page.locator('#world-combatants .world-combatant')).toHaveCount(2);
    const bounds = await partner.boundingBox();
    expect(bounds!.height).toBeLessThanOrEqual(viewport.height * .45);
    if (viewport.width > 720) expect(bounds!.width).toBeLessThanOrEqual(322);
    const buttons = await page.locator('[data-world-move]').evaluateAll(nodes => nodes.map(node => {
      const { width, height, bottom } = node.getBoundingClientRect();
      const deck = node.closest('.world-battle-deck')!.getBoundingClientRect();
      return { width, height, inView: bottom <= deck.bottom, font: parseFloat(getComputedStyle(node.querySelector('strong')!).fontSize) };
    }));
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.width).toBeGreaterThanOrEqual(44);
      expect(button.height).toBeGreaterThanOrEqual(44);
      expect(button.height).toBeLessThanOrEqual(60);
      expect(button.font).toBeGreaterThanOrEqual(14);
      expect(button.inView).toBe(true);
    }
    await testInfo.attach('compact-battle', { body: await page.screenshot(), contentType: 'image/png' });
    await partner.locator(':scope > summary').click();
    await expect(partner).not.toHaveAttribute('open', '');
    // A later refresh must respect the user's choice as the battle continues.
    await page.keyboard.press('Digit1');
    await expect(page.locator('#world-battle-state')).not.toContainText('턴 0');
    await expect(partner).not.toHaveAttribute('open', '');
  });
}
