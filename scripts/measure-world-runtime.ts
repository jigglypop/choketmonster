import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createGame } from '../src/game/engine';
import { defaultView, packSave } from '../src/game/storage';
import { OpenWorldSimulation, movementSpeed } from '../src/openworld/simulation';
import { getCaveScene } from '../src/openworld/caves';

const label = process.argv[2] ?? 'baseline', scene = process.argv[3] ?? 'surface';
const moving = process.env.WORLD_MOVING === '1', mobile = process.env.WORLD_MOBILE === '1';
const baseUrl = process.env.CHOKETMON_BASE_URL ?? `http://127.0.0.1:${process.env.CHOKETMON_TEST_PORT ?? '5173'}`;
const replayClock = process.env.WORLD_REAL_CLOCK !== '1';
const viewport = mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 };
const output = `artifacts/world-speed/${label}-${scene}`;
await mkdir(output, { recursive: true });
const graph = JSON.parse(await readFile('public/data/connectome.json', 'utf8'));
const policy = JSON.parse(await readFile('public/data/openworld-policy.json', 'utf8'));
const game = createGame(scene === 'water' ? 1 : 152, 'world-speed-20260915');
const world = new OpenWorldSimulation(graph, game, 35211, undefined, policy);
world.setControlMode('manual'); world.setAutoHunt(false);
if (scene === 'cave') {
  const portal = getCaveScene('cave:johto:slowpoke-well')!.portals[0];
  Object.assign(world.player, portal.surface);
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
  if (!world.traverseCavePortal()) throw new Error('Cannot enter benchmark cave');
}
const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true, learning: false });
await writeFile(`${output}/fixture.json`, JSON.stringify(save));
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--mute-audio'] });
try {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1, hasTouch: mobile });
  // Isolate the capture from source edits/HMR in the shared development server.
  await page.routeWebSocket('**', socket => socket.close());
  // Replay the same changing morning light in every capture. A fixed noon
  // would conceal rebuilds caused by the gradual day/night transition.
  if (replayClock) await page.addInitScript(() => { Date.now = () => 1_800_000_000_000 + 300_000 + performance.now(); });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: { id: 'world-speed', username: 'benchmark' } } }));
  await page.route('**/api/saves/current', route => route.fulfill({ json: { save, revision: 1 } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route('**/api/auth/realtime-ticket', route => route.fulfill({ status: 401, json: {} }));
  const started = performance.now();
  await page.goto(`${baseUrl}/?renderProbe`);
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 60000 });
  const readyMs = performance.now() - started;
  await expect.poll(() => page.evaluate(() => {
    const value = (window as any).__renderProbe?.read();
    return value?.loadedPokemon.length >= 2 && value.streaming.activeLoads === 0 && value.streaming.queuedLoads === 0;
  }), { timeout: 60000 }).toBe(true);
  const warmupMs = Number(process.env.WORLD_WARMUP_MS ?? 5000);
  await page.waitForTimeout(warmupMs);
  if (moving) {
    await page.locator('.world-explore-toggle').click();
    await page.locator('#world-pause').click();
    await page.locator('.world-explore-toggle').click();
  }
  const before = await page.evaluate(() => (window as any).__renderProbe.read());
  const session = await page.context().newCDPSession(page);
  await session.send('Profiler.enable'); await session.send('Profiler.start');
  await page.evaluate(() => (window as any).__renderProbe.reset());
  const path: unknown[] = [];
  if (moving) for (const key of ['s', 'd', 'w', 'a', 's', 'd', 'w', 'a']) {
    await page.keyboard.down(key);
    try { await page.waitForTimeout(1250); } finally { await page.keyboard.up(key); }
    path.push(await page.evaluate(() => (window as any).__renderProbe.read().streaming.player));
  } else await page.waitForTimeout(10000);
  const counters = await page.evaluate(() => (window as any).__renderProbe.read());
  const { profile } = await session.send('Profiler.stop');
  await writeFile(`${output}/cpu.cpuprofile`, JSON.stringify(profile));
  const durations = counters.samples.map((sample: any) => sample.frameMs).sort((a: number, b: number) => a - b);
  const percent = (p: number) => durations[Math.floor((durations.length - 1) * p)];
  const result = { label, scene, moving, mobile, path, baseUrl, buildMode: process.env.CHOKETMON_BASE_URL ? 'external' : 'vite-development', clock: replayClock ? 'replayed-morning' : 'real', viewport, readyMs, warmupMs,
    sampleCount: durations.length, medianFrameMs: percent(.5), p95FrameMs: percent(.95), p99FrameMs: percent(.99), maxFrameMs: durations.at(-1),
    movementSpeed: movementSpeed(152, 5), errors, ...counters };
  await page.screenshot({ path: `${output}/scene.png` });
  await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ label, scene, readyMs, medianFrameMs: result.medianFrameMs, p95FrameMs: result.p95FrameMs,
    p99FrameMs: result.p99FrameMs, maxFrameMs: result.maxFrameMs, sampleCount: durations.length,
    dpr: counters.dpr, backend: counters.backend, models: counters.loadedPokemon, trainers: counters.trainers.length, errors }));
  expect(errors).toEqual([]);
  if (moving) expect(new Set(path.map(point => JSON.stringify(point))).size).toBeGreaterThan(2);
  if (before.lights) {
    expect(counters.lights.map((light: any) => light.id)).toEqual(before.lights.map((light: any) => light.id));
    expect(counters.lights).toEqual(before.lights);
    expect(counters.background).toEqual(before.background);
    expect(counters.streaming.daylight).toBe(1);
    expect(counters.fog).toBeNull();
    expect(counters.daylightEnvironment).toBe(true);
    expect(counters.shadowsEnabled).toBe(true);
    if (scene !== 'cave') {
      const sun = counters.lights.find((light: any) => light.castsShadow);
      expect(sun.shadowSize).toEqual(mobile ? [256, 256] : [512, 512]);
      expect(sun.shadowAutoUpdate).toBe(false);
      expect(counters.terrainMaterials).toHaveLength(1);
      expect(counters.terrainMaterials[0].effect).toBe('surface:ground');
      expect(counters.terrainMaterials).toEqual(before.terrainMaterials);
    }
    if (scene === 'water') {
      expect(counters.water.some((water: any) => water.lod === 'detailed')).toBe(true);
      expect(counters.water.some((water: any) => water.lod === 'simple')).toBe(true);
    }
  }
} finally { await browser.close(); }
