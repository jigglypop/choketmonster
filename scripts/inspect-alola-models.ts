import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import manifest from '../src/data/pokemon-alola-models-manifest.json';
import megaManifest from '../src/data/pokemon-mega-models-manifest.json';

const mega = process.argv.includes('--mega');
const selected = process.argv.slice(2).find(arg => !arg.startsWith('--'))?.split(',').map(Number);
const entries = (mega ? megaManifest.entries : manifest.entries).filter(entry => !selected || selected.includes(entry.speciesId));
if (!entries.length || selected?.some(id => !Number.isInteger(id))) throw new Error('Supply comma-separated Alola species IDs');
const output = mega ? 'artifacts/mega-3d' : 'artifacts/alola-3d';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--mute-audio'] });
try {
  const reports = [];
  for (const entry of entries) {
    const cachePath = mega
      ? `data/local/pokemon-models-research/${megaManifest.source.commit}/mega-forms/${entry.sourcePath.replace('models/opt/', '')}`
      : `data/local/alola-models/${manifest.sources.find(source => source.name === entry.source)!.commit}/${entry.sourcePath.split('/').at(-1)}`;
    const bytes = await readFile(cachePath);
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Invalid cached model: ${entry.identifier}`);
    const page = await browser.newPage({ viewport: { width: 660, height: 660 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/alola-appearance-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.route(entry.url, route => route.fulfill({ body: bytes, contentType: 'model/gltf-binary' }));
    await page.goto(`http://127.0.0.1:${process.env.CHOKETMON_TEST_PORT ?? '5173'}/alola-appearance-fixture`);
    const result = await page.evaluate(async entry => {
      const path = '/tests/ui/helpers/model-appearance.ts';
      const { inspectAppearance } = await import(/* @vite-ignore */ path);
      return inspectAppearance(entry.url, entry.speciesId, true, true);
    }, entry);
    await page.screenshot({ path: `${output}/${entry.identifier}.png` });
    const report = { identifier: entry.identifier, sha256: entry.sha256, ...result, errors };
    reports.push(report);
    await writeFile(`${output}/${entry.identifier}.json`, JSON.stringify(report, null, 2));
    if (errors.length || result.gpuErrors.length || result.render.triangles <= 0) throw new Error(`Rendering failed: ${entry.identifier}`);
    console.log(JSON.stringify({ identifier: entry.identifier, triangles: result.render.triangles, pose: result.pose, errors }));
    await page.close();
  }
  await writeFile(`${output}/summary.json`, JSON.stringify(reports.map(({ identifier, sha256, render, errors, gpuErrors, pose }) => ({ identifier, sha256, render, errors, gpuErrors, pose })), null, 2));
  const page = await browser.newPage({ viewport: { width: 1200, height: Math.ceil(entries.length / 4) * 320 } });
  const cells = await Promise.all(entries.map(async entry => `<figure><img src="data:image/png;base64,${(await readFile(`${output}/${entry.identifier}.png`)).toString('base64')}"><figcaption>${entry.identifier}</figcaption></figure>`));
  await page.setContent(`<style>body{margin:0;background:#c2cbd1;display:grid;grid-template-columns:repeat(4,300px);font:16px sans-serif}figure{margin:0;text-align:center}img{width:300px;height:300px;object-fit:contain}figcaption{height:20px}</style>${cells.join('')}`);
  await page.locator('img').evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
  await page.screenshot({ path: `${output}/contact-sheet.png`, fullPage: true });
} finally { await browser.close(); }
