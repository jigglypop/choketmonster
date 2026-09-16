import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

type ResearchManifest = {
  source: { repository: string; commit: string };
  rights: { status: string; evidence: string };
  selection: { requestedSpeciesIds: number[] };
  result: { inspections: Array<{ id: number; localPath: string; sha256: string; skins: number; animations: number; images: number }> };
};

const manifest = JSON.parse(readFileSync('src/data/pokemon-home-research-manifest.json', 'utf8')) as ResearchManifest;
const byId = new Map(manifest.result.inspections.map(row => [row.id, row]));
const outputDirectory = 'artifacts/research/home-model-rigging';
const previewDirectory = `${outputDirectory}/previews`;
mkdirSync(previewDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.route('**/rig-source/*.glb', async route => {
  const id = Number(new URL(route.request().url()).pathname.match(/\/rig-source\/(\d+)\.glb$/)?.[1]);
  const row = byId.get(id);
  if (!row) { await route.abort('failed'); return; }
  await route.fulfill({ body: readFileSync(row.localPath), contentType: 'model/gltf-binary' });
});
await page.goto('http://127.0.0.1:5173/data/connectome.json');

const results: unknown[] = [];
try {
  for (const id of manifest.selection.requestedSpeciesIds) {
    const source = byId.get(id);
    if (!source) throw new Error(`${id}: research inspection is missing`);
    try {
      const probe = await page.evaluate(async speciesId => {
        const probePath = '/scripts/johto-rig-probe.ts';
        const { probeJohtoRig } = await import(/* @vite-ignore */ probePath);
        return probeJohtoRig(speciesId, false);
      }, id);
      const preview = Buffer.from(probe.image.split(',')[1], 'base64');
      const previewPath = `${previewDirectory}/${id}.png`;
      writeFileSync(previewPath, preview);
      const row = {
        ...probe,
        image: undefined,
        source: { path: source.localPath, sha256: source.sha256, skins: source.skins, animations: source.animations, images: source.images },
        preview: { path: previewPath, sha256: createHash('sha256').update(preview).digest('hex') },
        sourceClassification: 'research-only-original-geometry-with-source-skin',
        motionClassification: 'locally-authored-fallback-not-source-animation',
        visualReview: 'requires-human-inspection',
      };
      results.push(row);
      console.log(JSON.stringify({ id, passed: probe.passed, clips: probe.clipNames, skinnedMeshes: probe.skinnedMeshes }));
    } catch (error) {
      results.push({ id, passed: false, error: String(error), source, visualReview: 'not-reached' });
      console.log(JSON.stringify({ id, passed: false, error: String(error) }));
    }
  }
} finally {
  await browser.close();
}

const typed = results as Array<{ id: number; passed: boolean; preview?: { path: string } }>;
const failed = typed.filter(row => !row.passed);
const receipt = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  source: manifest.source,
  rights: manifest.rights,
  method: 'Load each ignored HOME GLB from its SHA-256-verified local cache through the production regional rig function. Sample all four explicitly authored clips across 13 frames and require finite, non-rigid skinned vertex deformation. Save a local PNG preview for human review. Original GLBs are never modified.',
  scope: { requested: typed.length, passed: typed.length - failed.length, failed: failed.map(row => row.id) },
  results,
};
writeFileSync(`${outputDirectory}/verification.json`, JSON.stringify(receipt, null, 2) + '\n');
writeFileSync(`${outputDirectory}/index.html`, `<!doctype html><meta charset="utf-8"><title>HOME research rig previews</title><style>body{font:14px system-ui;background:#17191d;color:#eee}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}figure{margin:0;padding:8px;background:#242830;border-radius:8px}img{width:100%;aspect-ratio:1;object-fit:contain;background:#fff}figcaption{display:flex;justify-content:space-between}</style><h1>Research-only authored rig previews</h1><p>Source: ${manifest.source.repository}@${manifest.source.commit}. These are local review artifacts and are not cleared for redistribution.</p><main>${typed.map(row => `<figure><img src="previews/${row.id}.png" alt="National Dex ${row.id}"><figcaption><b>#${row.id}</b><span>${row.passed ? 'deformation pass' : 'FAILED'}</span></figcaption></figure>`).join('')}</main>`);
console.log(JSON.stringify(receipt.scope));
if (failed.length) process.exitCode = 1;
