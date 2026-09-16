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
        return probeJohtoRig(speciesId, false, true);
      }, id);
      const posePreviews: Record<string, { path: string; sha256: string }> = {};
      for (const [pose, data] of Object.entries(probe.poseImages as Record<string, string>)) {
        const bytes = Buffer.from(data.split(',')[1], 'base64'), path = `${previewDirectory}/${id}-${pose}.png`;
        writeFileSync(path, bytes); posePreviews[pose] = { path, sha256: createHash('sha256').update(bytes).digest('hex') };
      }
      const preview = Buffer.from(probe.image.split(',')[1], 'base64');
      const previewPath = `${previewDirectory}/${id}.png`;
      writeFileSync(previewPath, preview);
      const row = {
        ...probe, passed: probe.passed && (probe.humanoidArmPose.arms.length === 0 || probe.humanoidArmPose.bothArmsLoweredInMultipleFrames),
        image: undefined, poseImages: undefined,
        source: { path: source.localPath, sha256: source.sha256, skins: source.skins, animations: source.animations, images: source.images },
        preview: { path: previewPath, sha256: createHash('sha256').update(preview).digest('hex') }, posePreviews,
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
  method: 'Load each ignored HOME GLB from its SHA-256-verified local cache through the production regional rig and authored sprite-palette appearance functions. Sample all four authored clips across 13 frames and require finite, non-rigid skinned vertex deformation. When upper arms are present, both must point downward in at least two of three samples in idle and walk. Save bind/idle/walk local PNG previews. Original GLBs and sprites are never modified.',
  scope: { requested: typed.length, passed: typed.length - failed.length, failed: failed.map(row => row.id) },
  results,
};
writeFileSync(`${outputDirectory}/verification.json`, JSON.stringify(receipt, null, 2) + '\n');
writeFileSync(`${outputDirectory}/index.html`, `<!doctype html><meta charset="utf-8"><title>HOME research rig previews</title><style>body{font:14px system-ui;background:#17191d;color:#eee}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}figure{margin:0;padding:8px;background:#242830;border-radius:8px}.poses{display:grid;grid-template-columns:repeat(3,1fr)}img{width:100%;aspect-ratio:1;object-fit:contain;background:#fff}figcaption{display:flex;justify-content:space-between}</style><h1>Research-only authored rig and palette previews</h1><p>Source geometry: ${manifest.source.repository}@${manifest.source.commit}. Appearance: authored palettes derived from pinned PokeAPI sprites. These previews use external-source geometry and do not claim source textures or cleared redistribution rights.</p><main>${typed.map(row => `<figure><div class="poses"><img src="previews/${row.id}-bind.png" alt="#${row.id} bind"><img src="previews/${row.id}-idle.png" alt="#${row.id} idle"><img src="previews/${row.id}-walk.png" alt="#${row.id} walk"></div><figcaption><b>#${row.id}</b><span>${row.passed ? 'rig + pose pass' : 'FAILED'}</span></figcaption></figure>`).join('')}</main>`);
console.log(JSON.stringify(receipt.scope));
if (failed.length) process.exitCode = 1;
