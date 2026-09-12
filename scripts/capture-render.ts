import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createGame } from '../src/game/engine';
import { defaultView, packSave } from '../src/game/storage';
import { OpenWorldSimulation } from '../src/openworld/simulation';
const name = process.argv[2] ?? 'candidate';
const town = process.argv[3] ?? 'pallet';
const output = 'artifacts/render-upgrade';
await mkdir(output, { recursive: true });
const graph = JSON.parse(await readFile('public/data/connectome.json', 'utf8'));
const policy = JSON.parse(await readFile('public/data/openworld-policy.json', 'utf8'));
const game = createGame(1, 'render-comparison-20260911');
const world = new OpenWorldSimulation(graph, game, 35211, undefined, policy);
world.setControlMode('manual'); world.setAutoHunt(false);
if (town !== 'pallet') { world.visitedTownIds.push(town); if (!world.teleportToTown(town)) throw new Error(`Cannot place scene at ${town}`); }
const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true });
const browser = await chromium.launch({ headless: process.env.CHOKETMON_HEADED !== '1' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors: string[] = [], failed: string[] = [];
  page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
  page.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); console.error(m.text()); } });
  page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
  await page.goto(`http://127.0.0.1:${process.env.CHOKETMON_TEST_PORT ?? '5173'}/?renderProbe`);
  await page.locator('[data-starter="1"]').click();
  await page.waitForFunction(() => document.querySelector('#ow-host')?.getAttribute('data-ready') === 'true', undefined, { timeout: 60000 });
  await page.locator('#import-file').setInputFiles({ name: 'render-scene.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.getByRole('status')).toContainText('불러왔습니다', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#ow-host')?.getAttribute('data-ready') === 'true', undefined, { timeout: 60000 });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-paused', 'true');
  await expect(page.locator('#world-mode-manual')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(15000);
  await page.evaluate(() => (window as any).__renderProbe.reset());
  await page.waitForFunction(() => (window as any).__renderProbe.read().samples.length >= 120, undefined, { timeout: 60000 });
  const counters = await page.evaluate(() => (window as any).__renderProbe.read());
  const median = (key: string) => { const a = counters.samples.map((x: any) => x[key]).sort((a: number, b: number) => a - b); return a[Math.floor(a.length / 2)]; };
  const result = { scene: `${town}-fixed-seed-paused`, viewport: [1440, 1000], ...counters,
    median: { frameMs: median('frameMs'), calls: median('calls'), triangles: median('triangles') }, errors, failed };
  await writeFile(`${output}/${name}.json`, JSON.stringify(result, null, 2));
  await page.screenshot({ path: `${output}/${name}.png` });
  console.log(JSON.stringify({ name, ...result.median, textures: counters.textures, errors, failed }));
} finally { await browser.close(); }
