import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { build } from 'vite';
import { createFieldRuntime } from '../src/three/field-runtime.ts';

const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
const packageJson = JSON.parse(await readFile(new URL('../node_modules/gaesup-world/package.json', import.meta.url), 'utf8'));
const ticks = [];
const adapter = createFieldRuntime(step => ticks.push(step), 200);

await adapter.start();
await sleep(470);
adapter.pause();
const pausedAt = ticks.length;
await sleep(260);
if (ticks.length !== pausedAt || pausedAt < 2) throw new Error(`Fixed-step pause probe failed at ${ticks.length} ticks.`);
adapter.stepOnce();
if (ticks.length !== pausedAt + 1) throw new Error('Manual registered-system step failed.');
adapter.resume();
await sleep(240);
await adapter.dispose();
if (ticks.length <= pausedAt + 1) throw new Error('Fixed-step resume probe did not execute the registered system.');

const outputDirectory = await mkdtemp(join(tmpdir(), 'choketmon-gaesup-browser-'));
try {
  await build({
    configFile: false,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      emptyOutDir: true,
      lib: { entry: resolve('src/three/field-runtime.ts'), formats: ['es'], fileName: 'field-runtime-browser' },
      outDir: outputDirectory,
      sourcemap: false,
    },
  });
  const bundle = await readFile(join(outputDirectory, 'field-runtime-browser.js'), 'utf8');
  if (!bundle.includes('choketmon.field-connectome-step')) throw new Error('Browser bundle omitted the registered Gaesup system.');
  await writeFile(join(outputDirectory, 'index.html'), `<!doctype html><script type="module">
    import { createFieldRuntime } from './field-runtime-browser.js';
    window.__gaesupProbe = { ticks: [], done: false };
    const runtime = createFieldRuntime(step => window.__gaesupProbe.ticks.push(step), 200);
    await runtime.start();
    setTimeout(async () => {
      runtime.pause();
      runtime.stepOnce();
      await runtime.dispose();
      window.__gaesupProbe.done = true;
    }, 430);
  </script>`, 'utf8');

  const server = createServer(async (request, response) => {
    const filename = request.url === '/field-runtime-browser.js' ? 'field-runtime-browser.js' : 'index.html';
    response.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : 'text/html');
    response.end(await readFile(join(outputDirectory, filename)));
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Browser probe server did not bind a TCP port.');
  const browser = await chromium.launch({ headless: true });
  let browserResult;
  try {
    const page = await browser.newPage();
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    try {
      await page.waitForFunction(() => window.__gaesupProbe?.done === true, undefined, { timeout: 10_000 });
    } catch (error) {
      throw new Error(`Browser runtime did not finish: ${browserErrors.join(' | ') || error.message}`);
    }
    browserResult = await page.evaluate(() => window.__gaesupProbe);
  } finally {
    await browser.close();
    await new Promise(resolvePromise => server.close(resolvePromise));
  }
  if (browserResult.ticks.length < 3) throw new Error(`Browser runtime produced only ${browserResult.ticks.length} steps.`);
  console.log(JSON.stringify({
    package: `gaesup-world@${packageJson.version}`,
    pluginStatus: adapter.runtime.plugins.status('choketmon.field-simulation'),
    ticks: ticks.length,
    sequence: ticks,
    browserBundleBytes: Buffer.byteLength(bundle),
    browserTicks: browserResult.ticks.length,
  }, null, 2));
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
