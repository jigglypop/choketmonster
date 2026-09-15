import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { getPokemonModelSource } from '../../src/data/pokemon-models';

test('regional loader rigs the actual male-form source URL before cloning', async ({ page }) => {
  const source = getPokemonModelSource(521)!;
  await page.route(source.url, route => route.fulfill({
    contentType: 'model/gltf-binary',
    body: readFileSync(`data/local/pokemon-models-expanded/${source.commit}/521.glb`),
  }));
  await page.goto('/data/connectome.json');
  const result = await page.evaluate(async url => {
    const path = '/src/three/gltf-loader.ts';
    const { createGLTFLoader } = await import(/* @vite-ignore */ path);
    const asset = await createGLTFLoader().loadAsync(url);
    let skins = 0;
    asset.scene.traverse((node: any) => { if (node.isSkinnedMesh) skins++; });
    return { skins, clips: asset.animations.map((clip: any) => clip.name), rig: asset.scene.userData.authoredRig };
  }, source.url);
  expect(result.skins).toBeGreaterThan(0);
  expect(result.clips).toEqual(expect.arrayContaining(['CM_idle', 'CM_walk', 'CM_attack', 'CM_damage']));
  expect(result.rig).toMatchObject({ speciesId: 521, version: 'regional-authored-v2' });
});
