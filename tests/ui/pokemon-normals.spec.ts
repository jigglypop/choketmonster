import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.setTimeout(90_000);
test.use({ launchOptions: { args: ['--enable-unsafe-webgpu', '--mute-audio'] } });
const inventory = JSON.parse(readFileSync('artifacts/research/model-quality/full-model-quality-audit.json', 'utf8')) as { entries: { id: number; path: string }[] };

for (const id of [399, 393, 525]) test(`${id} repairs only reviewed normals, keeping topology, skinning, maps and draw calls`, async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/normal-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.route(`**/models/pokemon/${id}.glb`, route => route.fulfill({ body: readFileSync(inventory.entries.find(row => row.id === id)!.path), contentType: 'model/gltf-binary' }));
  await page.goto('/normal-fixture');
  const inspect = (smoothNormals: boolean) => page.evaluate(async ({ id, smoothNormals }) => {
    const helper = '/tests/ui/helpers/model-appearance.ts';
    const { inspectAppearance } = await import(/* @vite-ignore */ helper);
    return inspectAppearance(`/models/pokemon/${id}.glb`, id, true, smoothNormals);
  }, { id, smoothNormals });
  const before = await inspect(false);
  await page.screenshot({ path: testInfo.outputPath('before.png') });
  const after = await inspect(true);
  await page.screenshot({ path: testInfo.outputPath('after.png') });
  expect(after.geometryContract).toEqual(before.geometryContract);
  expect(after.motionContract).toBe(before.motionContract);
  expect(after.rows).toEqual(before.rows);
  expect(after.surfaces).toEqual(before.surfaces);
  expect(after.render).toEqual(before.render);
  expect(after.render.calls).toBeGreaterThan(0);
  expect(after.render.triangles).toBeGreaterThan(100);
  expect(after.gpuErrors).toEqual([]); expect(before.gpuErrors).toEqual([]); expect(errors).toEqual([]);
  if (id === 525) expect(after.normalRepair).toBeUndefined();
  else {
    expect(after.normalRepair.vertices).toBeGreaterThan(1000);
    expect(after.normalRepair.eyeVertices).toBeGreaterThan(0);
    expect(after.normalRepair.topologyChanged).toBe(false);
    if (id === 399) expect(after.eyeSeams[0].normalDot.min).toBeGreaterThan(.999);
  }
});
