import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { OPAQUE_POKEMON_SURFACES } from '../src/data/pokemon-material-overrides';
import { SMOOTH_POKEMON_SPECIES } from '../src/three/pokemon-normals';

const inventory = JSON.parse(await readFile('artifacts/research/model-quality/full-model-quality-audit.json', 'utf8')) as { entries: { id: number; path: string }[] };
const pixelAudit = JSON.parse(await readFile('artifacts/model-appearance/texture-audit.json', 'utf8')) as { results: { id: number; images: unknown[] }[] };
const ids = process.argv[2] === 'smooth-all' ? [...SMOOTH_POKEMON_SPECIES] : process.argv[2] === 'review-all'
  ? [...new Set([...Object.keys(OPAQUE_POKEMON_SURFACES).map(Number), ...pixelAudit.results.filter(row => !row.images.length).map(row => row.id)])].sort((a, b) => a - b)
  : (process.argv[2] ?? '823').split(',').map(Number);
const label = process.argv[3] ?? 'review';
const smoothNormals = process.argv[4] !== 'source-normals';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--mute-audio'] });
try {
  for (const id of ids) {
  const output = `artifacts/model-appearance/${id}/${label}`;
  await mkdir(output, { recursive: true });
  const entry = inventory.entries.find(row => row.id === id);
  if (!entry) throw new Error(`No pinned model for ${id}`);
  const bytes = await readFile(entry.path);
  const page = await browser.newPage({ viewport: { width: 660, height: 660 } });
  await page.route('**/appearance-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.route(`**/models/pokemon/${id}.glb`, route => route.fulfill({ body: bytes, contentType: 'model/gltf-binary' }));
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${process.env.CHOKETMON_TEST_PORT ?? '5188'}/appearance-fixture`);
  const result = await page.evaluate(async ({ id, smoothNormals }) => {
    const path = '/tests/ui/helpers/model-appearance.ts';
    const { inspectAppearance } = await import(/* @vite-ignore */ path);
    return inspectAppearance(`/models/pokemon/${id}.glb`, id, true, smoothNormals);
  }, { id, smoothNormals });
  await page.screenshot({ path: `${output}/render.png` });
  await writeFile(`${output}/report.json`, JSON.stringify({ ...result, errors }, null, 2));
  console.log(JSON.stringify({ id, report: result.report, normalRepair: result.normalRepair, errors, gpuErrors: result.gpuErrors }));
  if (errors.length || result.gpuErrors.length) throw new Error(`Model ${id} failed rendering; see ${output}/report.json`);
  await page.close();
  }
  // Contact sheets are browser layouts of the unchanged captures, not retouched images.
  for (let offset = 0; offset < ids.length; offset += 12) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 960 } });
    const cells = await Promise.all(ids.slice(offset, offset + 12).map(async id => {
      const png = await readFile(`artifacts/model-appearance/${id}/${label}/render.png`);
      return `<figure><img src="data:image/png;base64,${png.toString('base64')}"><figcaption>#${id}</figcaption></figure>`;
    }));
    await page.setContent(`<style>body{margin:0;background:#c2cbd1;display:grid;grid-template-columns:repeat(4,300px);font:18px sans-serif}figure{margin:0;text-align:center}img{width:300px;height:300px;object-fit:contain}figcaption{height:20px}</style>${cells.join('')}`);
    await page.locator('img').evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
    await page.screenshot({ path: `artifacts/model-appearance/${label}-sheet-${offset / 12 + 1}.png` });
    await page.close();
  }
} finally { await browser.close(); }
