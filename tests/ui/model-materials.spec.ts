import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('real Corviknight GLB retains textures and metal armor without transparent body pieces', async ({ page }, testInfo) => {
  const bytes = await readFile('data/local/pokemon-models-expanded/429de1288cea0d43f5b4f56305d2276e94239d65/823.glb');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/appearance-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.route('**/models/pokemon/823.glb', route => route.fulfill({ body: bytes, contentType: 'model/gltf-binary' }));
  await page.goto('/appearance-fixture');
  const result = await page.evaluate(async () => {
    const path = '/tests/ui/helpers/model-appearance.ts';
    const { inspectAppearance } = await import(/* @vite-ignore */ path);
    return inspectAppearance('/models/pokemon/823.glb', 823);
  });
  expect(result.report.transparencyAdjusted).toBe(3);
  expect(result.surfaces).toEqual(expect.arrayContaining([
    { name: 'BodyA', transparent: false, textured: true, metalness: 1 },
    { name: 'BodyBEnv', transparent: false, textured: true, metalness: 1 },
    { name: 'Eye', transparent: false, textured: true, metalness: 0 },
  ]));
  expect(result.gpuErrors).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('corviknight.png') });
});
