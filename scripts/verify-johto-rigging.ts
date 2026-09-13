import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = 'data/local/pokemon-models-expanded/429de1288cea0d43f5b4f56305d2276e94239d65';
const out = 'artifacts/johto-rigging'; mkdirSync(out, { recursive: true });
const ids = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2].split(',').map(Number) : Array.from({ length: 100 }, (_, i) => i + 152);
if (ids.some(id => !Number.isInteger(id) || id < 152 || id > 251)) throw new Error('Expected comma-separated Johto species IDs (152..251)');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.route('**/rig-source/*.glb', async route => {
  const match = new URL(route.request().url()).pathname.match(/\/rig-source\/(\d+)\.glb$/);
  if (!match) { await route.continue(); return; }
  const id = match[1];
  await route.fulfill({ body: readFileSync(`${root}/${id}.glb`), contentType: 'model/gltf-binary' });
});
await page.goto('http://127.0.0.1:5173/data/connectome.json');
const results: unknown[] = [];
try {
  for (const id of ids) {
    try {
      const result = await page.evaluate(async ({ id, exportGlb }) => {
        const path = '/scripts/johto-rig-probe.ts'; const { probeJohtoRig } = await import(/* @vite-ignore */ path);
        return probeJohtoRig(id, exportGlb);
      }, { id, exportGlb: process.argv.includes('--export') });
      writeFileSync(`${out}/${id}.png`, Buffer.from(result.image.split(',')[1], 'base64'));
      if (result.binary) writeFileSync(`${out}/${id}.glb`, Buffer.from(result.binary));
      const record = { ...result, image: undefined, binary: undefined, sourceSha256: createHash('sha256').update(readFileSync(`${root}/${id}.glb`)).digest('hex') };
      results.push(record); console.log(JSON.stringify({ id, passed: result.passed, skin: result.skinnedMeshes, bindError: result.relativeBindError, rigMs: Math.round(result.rigMs) }));
    } catch (error) { results.push({ id, passed: false, error: String(error) }); console.log(JSON.stringify({ id, error: String(error) })); }
    writeFileSync(`${out}/verification.json`, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  }
} finally { await browser.close(); }
if (results.some(record => !(record as { passed: boolean }).passed)) process.exitCode = 1;
