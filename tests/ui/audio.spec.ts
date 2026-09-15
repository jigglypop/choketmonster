import { expect, test } from '@playwright/test';
test.setTimeout(100_000);

test('original cry decodes and reaches the real audio graph; volume and mute persist', async ({ page }) => {
  await page.addInitScript(() => {
    const scope = window as typeof window & { cryProbe?: { started: number; peak: number; duration: number; sampleRate: number; connected: boolean; running: boolean } };
    scope.cryProbe = { started: 0, peak: 0, duration: 0, sampleRate: 0, connected: false, running: false };
    const edges = new WeakMap<AudioNode, Set<AudioNode>>(), originalConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (this: AudioNode, ...args: Parameters<AudioNode['connect']>) {
      if (args[0] instanceof AudioNode) { const targets = edges.get(this) ?? new Set<AudioNode>(); targets.add(args[0]); edges.set(this, targets); }
      return (originalConnect as (...input: unknown[]) => unknown).apply(this, args);
    } as AudioNode['connect'];
    const originalStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...args: Parameters<AudioBufferSourceNode['start']>) {
      if (this.buffer) {
        scope.cryProbe!.started++; scope.cryProbe!.duration = this.buffer.duration; scope.cryProbe!.sampleRate = this.buffer.sampleRate;
        // Observe the decoded original buffer and the real output graph. Main-thread
        // polling can miss a short cry while the renderer compiles its shaders.
        for (const value of this.buffer.getChannelData(0)) scope.cryProbe!.peak = Math.max(scope.cryProbe!.peak, Math.abs(value));
        const pending: AudioNode[] = [this], visited = new Set<AudioNode>();
        while (pending.length) { const node = pending.pop()!; if (node === this.context.destination) scope.cryProbe!.connected = true; if (visited.has(node)) continue; visited.add(node); pending.push(...(edges.get(node) ?? [])); }
        scope.cryProbe!.running = this.context.state === 'running';
      }
      return originalStart.apply(this, args);
    };
  });
  // Geometry has its own runtime scenario; keep audio timing independent of model loading.
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
  await page.goto('/');
  const fetched = page.waitForResponse(response => response.url().endsWith('/cries/pokemon/latest/152.ogg') && response.ok());
  await page.locator('[data-starter="152"]').click();
  await page.keyboard.press('Space');
  await page.locator('[data-tab="team"]').click();
  await fetched;
  await expect.poll(() => page.evaluate(() => (window as unknown as { cryProbe: { peak: number } }).cryProbe.peak), { timeout: 15_000 }).toBeGreaterThan(.001);
  const decoded = await page.evaluate(() => (window as unknown as { cryProbe: { started: number; duration: number; sampleRate: number; connected: boolean; running: boolean } }).cryProbe);
  expect(decoded.started).toBeGreaterThan(0); expect(decoded.duration).toBeGreaterThan(.05); expect(decoded.sampleRate).toBeGreaterThan(8000);
  expect(decoded.connected).toBe(true); expect(decoded.running).toBe(true);
  await expect(page.locator('#game-music-panel')).toBeHidden();
  await page.locator('#open-interface-settings').click();
  await page.locator('#audio-music').fill('22'); await page.locator('#audio-effects').fill('41'); await page.locator('#audio-muted').check();
  await page.locator('.settings-done').click(); await page.reload();
  await page.locator('#open-interface-settings').click();
  await expect(page.locator('#audio-music')).toHaveValue('22'); await expect(page.locator('#audio-effects')).toHaveValue('41'); await expect(page.locator('#audio-muted')).toBeChecked();
});

test('visible original soundtrack player streams from the provider and accepts volume controls', async ({ page }) => {
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
  await page.goto('/');
  await page.locator('[data-starter="152"]').click();
  await page.keyboard.press('Space');
  await page.locator('[data-tab="team"]').click();
  await expect(page.locator('#game-music-panel')).toBeHidden();
  await page.getByRole('button', { name: '음악 재생과 음량' }).click();
  await expect(page.locator('#game-music-panel')).toBeVisible();
  await expect(page.locator('#game-music-panel iframe')).toBeVisible({ timeout: 25_000 });
  await page.locator('#game-music-play').click();
  await expect(page.locator('#game-music-panel')).toHaveAttribute('data-playback', '1', { timeout: 35_000 });
  await page.locator('#game-music-volume').fill('25');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('choketmon-audio-v1')!).musicVolume)).toBe(.25);
  await page.locator('#game-music-close').click(); await expect(page.locator('#game-music-panel')).toBeHidden();
});
