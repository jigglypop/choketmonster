import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

type BrowserNode = { position: { toArray(): number[] }; quaternion: { toArray(): number[] }; scale: { toArray(): number[] } };
type BrowserActor = { model: { traverse(fn: (node: BrowserNode) => void): void } };

const baseUrl = process.env.CHOKETMON_BASE_URL ?? 'http://127.0.0.1:5173';
const output = process.argv[2] ?? 'artifacts/interface-refresh/model-tests/animation-playback.json';
const manifest = JSON.parse(readFileSync('src/data/pokemon-models-manifest.json', 'utf8')) as { source: { commit: string } };
const modelRoot = join('data/local/pokemon-models-expanded', manifest.source.commit);
const cases = [
  { id: 152, support: 'rigged-static', expectTransformChange: false },
  { id: 160, support: 'rigged-animated', expectTransformChange: true },
  { id: 796, support: 'transform-animated', expectTransformChange: true },
] as const;

const browser = await chromium.launch({ headless: true });
const results: Array<Record<string, unknown>> = [];
try {
  for (const item of cases) {
    const page = await browser.newPage({ viewport: { width: 700, height: 600 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(`**/regular/${item.id}.glb`, async route => route.fulfill({
      status: 200,
      contentType: 'model/gltf-binary',
      body: readFileSync(join(modelRoot, `${item.id}.glb`)),
    }));
    await page.goto(baseUrl);
    await page.evaluate(async id => {
      const modulePath = '/src/three/scene.ts';
      const { getPokemonScene } = await import(/* @vite-ignore */ modulePath);
      const host = document.createElement('div');
      Object.assign(host.style, { width: '600px', height: '500px', position: 'fixed', inset: '0', zIndex: '9999' });
      document.body.append(host);
      const scene = getPokemonScene();
      scene.showSpecimen(host, id);
      scene.controls.autoRotate = false;
      scene.controls.enabled = false;
      (window as unknown as { __motionScene: unknown }).__motionScene = scene;
    }, item.id);
    await page.waitForFunction(id => {
      const canvas = document.querySelector('#pokemon-canvas');
      return canvas?.getAttribute('data-species') === String(id) && canvas?.getAttribute('data-ready') === 'true';
    }, item.id, { timeout: 60_000 });
    await page.waitForTimeout(1_500);
    const before = await page.evaluate(() => {
      const scene = (window as unknown as { __motionScene: { actors: Map<string, unknown> } }).__motionScene;
      const actor = [...scene.actors.values()][0] as BrowserActor;
      const transforms: number[][] = [];
      actor.model.traverse(node => transforms.push([...node.position.toArray(), ...node.quaternion.toArray(), ...node.scale.toArray()]));
      return { transforms, mixerTime: Number(document.querySelector('#pokemon-canvas')?.getAttribute('data-animation-time')) };
    });
    await page.waitForTimeout(550);
    const after = await page.evaluate(() => {
      const scene = (window as unknown as { __motionScene: { actors: Map<string, unknown> } }).__motionScene;
      const actor = [...scene.actors.values()][0] as BrowserActor;
      const transforms: number[][] = [];
      actor.model.traverse(node => transforms.push([...node.position.toArray(), ...node.quaternion.toArray(), ...node.scale.toArray()]));
      return { transforms, mixerTime: Number(document.querySelector('#pokemon-canvas')?.getAttribute('data-animation-time')) };
    });
    let changedNodes = 0, maxComponentDelta = 0;
    for (let node = 0; node < Math.min(before.transforms.length, after.transforms.length); node++) {
      let changed = false;
      for (let component = 0; component < before.transforms[node].length; component++) {
        const delta = Math.abs(before.transforms[node][component] - after.transforms[node][component]);
        if (delta > 1e-7) changed = true;
        maxComponentDelta = Math.max(maxComponentDelta, delta);
      }
      if (changed) changedNodes++;
    }
    const observed = changedNodes > 0;
    results.push({
      ...item,
      originalGlbSha256: createHash('sha256').update(readFileSync(join(modelRoot, `${item.id}.glb`))).digest('hex'),
      nodes: before.transforms.length,
      changedNodes,
      maxComponentDelta,
      mixerAdvanceSeconds: after.mixerTime - before.mixerTime,
      observedTransformChange: observed,
      passed: observed === item.expectTransformChange && errors.length === 0,
      pageErrors: errors,
    });
    await page.close();
  }
} finally {
  await browser.close();
}

const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  method: 'Pinned original GLBs routed into the real Vite renderer; camera motion disabled; AnimationMixer-driven node transforms compared 550ms apart.',
  baseUrl,
  results,
  passed: results.length === cases.length && results.every(result => result.passed),
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
