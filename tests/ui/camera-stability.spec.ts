import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { getCaveScene } from '../../src/openworld/caves';
import { OpenWorldSimulation } from '../../src/openworld/simulation';
import { openExplorePanel } from './helpers/explore-panel';

test.use({ launchOptions: { args: ['--mute-audio', '--enable-unsafe-webgpu'] } });
const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8'));
const angleDifference = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) * 180 / Math.PI;
async function pose(page: Page) {
  return page.evaluate(() => {
    const state = (window as unknown as { __renderProbe: { read(): { camera: number[]; cameraTarget: number[] } } }).__renderProbe.read();
    return { yaw: Math.atan2(state.camera[0] - state.cameraTarget[0], state.camera[2] - state.cameraTarget[2]), target: state.cameraTarget };
  });
}
async function load(page: Page) {
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  const game = createGame(152, 'camera-stability'), world = new OpenWorldSimulation(graph, game, 77283, undefined, policy);
  const cave = getCaveScene('cave:johto:slowpoke-well')!;
  world.movePlayer({ ...cave.portals[0].surface, heading: 0 });
  expect(world.traverseCavePortal()).toBe(true);
  expect(world.movePlayer({ x: 0, z: 0, heading: 0 })).toBe(true);
  world.setControlMode('manual');
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false });
  await page.goto('/?renderProbe=1');
  await page.locator('[data-starter="1"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'camera.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-scene', cave.sceneId);
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await page.waitForFunction(() => !!(window as any).__renderProbe?.read().cameraTarget);
}

test('desktop orbit stays gentle, settles quickly, and preserves heading while walking at close zoom', async ({ page }, info) => {
  test.setTimeout(90_000);
  await load(page);
  const canvas = (await page.locator('#ow-host canvas').boundingBox())!;
  const x = canvas.x + canvas.width * .6, y = canvas.y + canvas.height * .45;
  const before = await pose(page);
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 180, y, { steps: 12 }); await page.mouse.up();
  await page.waitForTimeout(400);
  const released = await pose(page);
  await page.waitForTimeout(500);
  const settled = await pose(page), rotation = angleDifference(settled.yaw, before.yaw);
  expect(rotation).toBeGreaterThan(3); expect(rotation).toBeLessThan(35);
  expect(angleDifference(settled.yaw, released.yaw)).toBeLessThan(1.5);
  await page.mouse.wheel(0, -2000); await page.waitForTimeout(500);
  await openExplorePanel(page); await page.locator('#world-pause').click();
  const start = await pose(page), headings: number[] = [];
  await page.keyboard.down('KeyW');
  try { for (let index = 0; index < 12; index++) { await page.waitForTimeout(100); headings.push((await pose(page)).yaw); } }
  finally { await page.keyboard.up('KeyW'); }
  await page.locator('#world-pause').click();
  const end = await pose(page);
  expect(Math.hypot(end.target[0] - start.target[0], end.target[2] - start.target[2])).toBeGreaterThan(1);
  const drift = Math.max(...headings.map(yaw => angleDifference(yaw, start.yaw)));
  expect(drift).toBeLessThan(1.5);
  await info.attach('camera-measurement', { body: JSON.stringify({ rotation, coast: angleDifference(settled.yaw, released.yaw), drift }), contentType: 'application/json' });
});

test('mobile finger swipe rotates gently without continued spinning after release', async ({ browser, baseURL }, info) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await load(page);
    const before = await pose(page), cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 105, y: 450 }] });
    for (let index = 1; index <= 12; index++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 105 + index * 12, y: 450 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(400); const released = await pose(page);
    await page.waitForTimeout(500); const settled = await pose(page), rotation = angleDifference(settled.yaw, before.yaw);
    expect(rotation).toBeGreaterThan(3); expect(rotation).toBeLessThan(30);
    expect(angleDifference(settled.yaw, released.yaw)).toBeLessThan(1.5);
    await info.attach('camera-measurement', { body: JSON.stringify({ rotation, coast: angleDifference(settled.yaw, released.yaw) }), contentType: 'application/json' });
  } finally { await context.close(); }
});
