import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket(url => url.pathname === '/' && url.searchParams.has('token'), () => {});
});

function invisibleBodyCopy(source: Buffer): Buffer {
  // A valid, decoded GLB whose geometry exists but whose entire body is invisible.
  // Keep the real mesh, skin, clips and BIN chunk; modify only this response copy.
  const jsonLength = source.readUInt32LE(12);
  const json = JSON.parse(source.subarray(20, 20 + jsonLength).toString('utf8'));
  for (const material of json.materials) {
    material.alphaMode = 'BLEND';
    material.pbrMetallicRoughness ??= {};
    const color = material.pbrMetallicRoughness.baseColorFactor ?? [1, 1, 1, 1];
    material.pbrMetallicRoughness.baseColorFactor = [...color.slice(0, 3), 0];
  }
  const encoded = Buffer.from(JSON.stringify(json)), padded = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 0x20);
  encoded.copy(padded);
  const header = Buffer.from(source.subarray(0, 20)), rest = source.subarray(20 + jsonLength);
  header.writeUInt32LE(20 + padded.length + rest.length, 8); header.writeUInt32LE(padded.length, 12);
  return Buffer.concat([header, padded, rest]);
}

test('a failed visible Pokemon model is stopped instead of moving as an empty placeholder', async ({ page }) => {
  test.setTimeout(90_000);
  let unavailable = true;
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route('**/models/opt/regular/152.glb', route => unavailable ? route.abort('failed') : route.continue());
  await page.goto('/?renderProbe=1');
  await page.locator('[data-starter="1"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-renderer-ready', 'true', { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().modelStatuses ?? []), { timeout: 30_000 }).toContain('3D 불러오기 실패');
  const readCompanion = () => page.evaluate(() => (window as any).__renderProbe.read().creatures.find((item: any) => item.id.startsWith('companion:'))?.position);
  const before = await readCompanion();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'false');
  await expect(page.locator('.ow-creature-label[data-creature-id^="companion:"]')).toHaveCount(0);
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(1_200);
  await page.keyboard.up('ArrowUp');
  const after = await readCompanion();
  expect(before).toBeDefined();
  expect(after).toEqual(before);
  unavailable = false;
  await page.locator('#world-model-retry').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().loadedPokemon ?? [])).toContain(152);
  await expect.poll(() => page.evaluate(() => (window as any).__renderProbe.read().creatures.find((item: any) => item.id.startsWith('companion:'))?.modelDrawCalls ?? 0)).toBeGreaterThan(0);
  await expect(page.locator('#world-recovery')).toBeHidden();
});

test('slow model loading does not mark the world ready or move an invisible partner', async ({ page }) => {
  test.setTimeout(90_000);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route('**/models/opt/regular/152.glb', async route => { await gate; await route.continue(); });
  await page.goto('/?renderProbe=1');
  await page.locator('[data-starter="1"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-renderer-ready', 'true', { timeout: 30_000 });
  const before = await page.locator('#world-position').innerText();
  await page.keyboard.down('ArrowUp'); await page.waitForTimeout(1_000); await page.keyboard.up('ArrowUp');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'false');
  await expect(page.locator('#world-position')).toHaveText(before);
  await expect(page.locator('.ow-creature-label[data-creature-id^="companion:"]')).toHaveCount(0);
  release();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().loadedPokemon ?? [])).toContain(152);
  await expect.poll(() => page.evaluate(() => (window as any).__renderProbe.read().creatures.every((item: any) => !item.hasNameplate || item.drawnModelMeshes > 0))).toBe(true);
  await page.screenshot({ path: test.info().outputPath('loaded-body-and-nameplate.png') });
});

test('a decoded GLB with an invisible body is rejected and can recover with the actual model', async ({ page }) => {
  test.setTimeout(120_000);
  let broken = true;
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route('**/models/opt/regular/152.glb', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: broken ? invisibleBodyCopy(await response.body()) : await response.body() });
  });
  await page.goto('/?renderProbe=1');
  await page.locator('[data-starter="1"]').click();
  await expect(page.locator('#world-model-retry')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'false');
  await expect(page.locator('.ow-creature-label[data-creature-id^="companion:"]')).toHaveCount(0);
  const before = await page.locator('#world-position').innerText();
  await page.keyboard.down('ArrowUp'); await page.waitForTimeout(800); await page.keyboard.up('ArrowUp');
  await expect(page.locator('#world-position')).toHaveText(before);
  broken = false;
  await page.locator('#world-model-retry').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__renderProbe.read().creatures.find((item: any) => item.id.startsWith('companion:'))?.modelDrawCalls ?? 0)).toBeGreaterThan(0);
});

test('cached models are actually drawn after tab reentry and mobile resizing', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.goto('/?renderProbe=1');
  await page.locator('[data-starter="1"]').click();
  for (let pass = 0; pass < 3; pass++) {
    await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
    const read = () => page.evaluate(() => (window as any).__renderProbe.read());
    await expect.poll(async () => (await read()).creatures.find((item: any) => item.id.startsWith('companion:'))?.modelDrawCalls ?? 0).toBeGreaterThan(0);
    const before = (await read()).creatures.find((item: any) => item.id.startsWith('companion:')).modelDrawCalls;
    await page.keyboard.down('ArrowUp'); await page.waitForTimeout(500); await page.keyboard.up('ArrowUp');
    await expect.poll(async () => (await read()).creatures.find((item: any) => item.id.startsWith('companion:'))?.modelDrawCalls ?? 0).toBeGreaterThan(before);
    expect((await read()).creatures.every((item: any) => !item.hasNameplate || item.drawnModelMeshes > 0)).toBe(true);
    await test.info().attach(`draw-state-${pass}.json`, { body: JSON.stringify(await read()), contentType: 'application/json' });
    if (pass < 2) {
      await page.locator('[data-tab="dex"]').click();
      await page.setViewportSize(pass === 0 ? { width: 390, height: 844 } : { width: 1440, height: 1100 });
      await page.locator('[data-tab="map"]').click();
    }
  }
  await page.screenshot({ path: test.info().outputPath('cached-body-after-reentry.png') });
  expect(errors).toEqual([]);
});

test('GPU context loss stops the world and restarts its renderer without losing progress', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.goto('/?renderProbe=1&renderer=webgl');
  await page.locator('[data-starter="1"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await page.locator('#ow-host canvas').evaluate(canvas => {
    const gl = (canvas as HTMLCanvasElement).getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('The real WebGL context-loss extension is required for this regression');
    extension.loseContext();
  });
  await expect(page.locator('[data-world-renderer-retry]')).toBeVisible();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'false');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-renderer-ready', 'false');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-paused', 'true');
  const before = await page.locator('#world-position').innerText();
  await expect(page.locator('.ow-creature-label')).toHaveCount(0);
  await page.keyboard.down('ArrowUp'); await page.waitForTimeout(800); await page.keyboard.up('ArrowUp');
  await expect(page.locator('#world-position')).toHaveText(before);
  await page.locator('[data-world-renderer-retry]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await expect(page.locator('#world-position')).toHaveText(before);
  await expect.poll(() => page.evaluate(() => (window as any).__renderProbe?.read().creatures.find((item: any) => item.id.startsWith('companion:'))?.modelDrawCalls ?? 0)).toBeGreaterThan(0);
  await expect(page.locator('[data-world-renderer-retry]')).toHaveCount(0);
  await page.locator('#world-resume').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-paused', 'false');
  await page.screenshot({ path: test.info().outputPath('gpu-recovered.png') });
});
