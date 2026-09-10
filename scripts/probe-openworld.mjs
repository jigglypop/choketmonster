import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const projectRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1)));
const temporaryRoot = await mkdtemp(join(tmpdir(), 'choketmon-openworld-'));
const screenshotPath = resolve(projectRoot, 'artifacts/openworld-probe.png');
const viewPath = resolve(projectRoot, 'src/openworld/view.tsx').replaceAll('\\', '/');

await writeFile(join(temporaryRoot, 'index.html'), '<main id="world"></main><script type="module" src="/entry.tsx"></script>', 'utf8');
await writeFile(join(temporaryRoot, 'entry.tsx'), `
  import { mountOpenWorld } from '/@fs/${viewPath}';
  let player = { x: 48, z: 22, heading: 0 };
  let moves = 0;
  const snapshot = () => ({
    player,
    selectedWildId: 'wild-25',
    entities: [
      { id: 'wild-25', speciesId: 25, name: '피카츄', level: 12, hp: 29, maxHp: 35, x: 42, z: 14, action: 'idle' },
      { id: 'wild-6', speciesId: 6, name: '리자몽', level: 38, hp: 92, maxHp: 110, x: 54, z: 11, action: 'attack' },
    ],
    foods: [{ id: 'food-1', x: 46, z: 16 }],
  });
  window.__openworldProbe = { moves: 0 };
  mountOpenWorld(document.querySelector('#world'), {
    getSnapshot: snapshot,
    onPlayerMove(next) { player = next; window.__openworldProbe.moves = ++moves; return true; },
    onSelect() {},
    terrainUrl: '/models/world.glb',
    sampleWorld(x, z) { return { height: Math.sin(x * .05) + Math.cos(z * .04), biome: 'meadow', blocked: false }; },
  });
`, 'utf8');

const server = await createServer({
  root: temporaryRoot,
  publicDir: resolve(projectRoot, 'public'),
  configFile: false,
  logLevel: 'warn',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [projectRoot, temporaryRoot] } },
});

await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === 'string') throw new Error('Open-world probe server did not bind.');
const browser = await chromium.launch({ headless: true });
const errors = [];
let modelLoaded = false;
let terrainLoaded = false;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => {
    if (response.url().endsWith('/models/pokemon/25.glb') && response.ok()) modelLoaded = true;
    if (response.url().endsWith('/models/world.glb') && response.ok()) terrainLoaded = true;
  });
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForSelector('canvas', { timeout: 15_000 });
  await page.waitForTimeout(1_200);
  await page.keyboard.down('w');
  await page.waitForTimeout(250);
  await page.keyboard.up('w');
  await page.screenshot({ path: screenshotPath });
  const result = await page.evaluate(() => ({
    canvas: document.querySelector('canvas')?.getBoundingClientRect().toJSON(),
    moves: window.__openworldProbe.moves,
    webgl: Boolean(document.querySelector('canvas')?.getContext('webgl2')),
  }));
  const screenshot = await stat(screenshotPath);
  if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`);
  if (!result.webgl || !result.canvas || result.canvas.width < 1000 || result.moves < 1) throw new Error(`Invalid rendered view: ${JSON.stringify(result)}`);
  if (!modelLoaded) throw new Error('The lazy Pokemon GLB was not loaded successfully.');
  if (!terrainLoaded) throw new Error('The Gaesup world terrain GLB was not loaded successfully.');
  if (screenshot.size < 20_000) throw new Error(`Rendered screenshot is unexpectedly small (${screenshot.size} bytes).`);
  console.log(JSON.stringify({ ...result, modelLoaded, terrainLoaded, screenshotBytes: screenshot.size }, null, 2));
} finally {
  await browser.close();
  await server.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
