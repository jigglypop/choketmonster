import { expect, test } from '@playwright/test';
test.setTimeout(100_000);

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

async function visibleWorldHudBoxes(page: import('@playwright/test').Page) {
  return page.locator('.world-explore-toggle, .world-radar, .world-tools, .world-control-mode, .world-objective, .ow-camera-controls, .world-dpad, .world-battle-hud, .world-target, .social-dock').evaluateAll(elements =>
    elements.filter(element => {
      const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
      const closed = element.closest('details:not([open])');
      const hiddenByDetails = closed && !closed.querySelector(':scope > summary')?.contains(element);
      return !hiddenByDetails && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }).map(element => ({ selector: element.id ? `#${element.id}` : `.${element.classList[0]}`, ...element.getBoundingClientRect().toJSON() })),
  );
}

test('original cry decodes and reaches the real audio graph; volume and mute persist', async ({ page }) => {
  await page.routeWebSocket('**', socket => socket.close());
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
  await expect(page.locator('#game-music-panel')).toBeVisible();
  await page.locator('#open-interface-settings').click();
  await page.locator('#audio-music').fill('22'); await page.locator('#audio-effects').fill('41'); await page.locator('#audio-muted').check();
  await page.locator('.settings-done').click(); await page.reload();
  await page.locator('#open-interface-settings').click();
  await expect(page.locator('#audio-music')).toHaveValue('22'); await expect(page.locator('#audio-effects')).toHaveValue('41'); await expect(page.locator('#audio-muted')).toBeChecked();
});

test('first desktop game input starts one visible provider player and explicit pause is respected', async ({ page }) => {
  await page.routeWebSocket('**', socket => socket.close());
  await page.addInitScript(() => {
    const nativeHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')?.get;
    let forcedHidden: boolean | undefined;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => forcedHidden ?? nativeHidden?.call(document) ?? false });
    (window as typeof window & { setAudioTestHidden(value: boolean): void }).setAudioTestHidden = value => { forcedHidden = value; document.dispatchEvent(new Event('visibilitychange')); };
  });
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
  await page.goto('/');
  const panel = page.locator('#game-music-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('iframe')).toBeVisible({ timeout: 25_000 });
  await expect(panel.locator('iframe')).toHaveAttribute('allow', /autoplay/);
  const videoBox = await panel.locator('iframe').boundingBox();
  expect(videoBox?.width).toBeGreaterThanOrEqual(200); expect(videoBox?.height).toBeGreaterThanOrEqual(200);
  await page.locator('[data-starter="152"]').click();
  await expect(panel).toHaveAttribute('data-playback', '1', { timeout: 35_000 });
  await page.locator('[data-tab="team"]').click();
  await expect(panel).toHaveAttribute('data-playback', '1');
  await expect(panel.locator('iframe')).toHaveCount(1);
  await page.getByRole('button', { name: '음악 플레이어 설정' }).click();
  await expect(page.locator('#game-music-details')).toHaveAttribute('open', '');
  await page.locator('#game-music-volume').fill('25');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('choketmon-audio-v1')!).musicVolume)).toBe(.25);
  await page.locator('#game-music-play').click();
  await expect(panel).toHaveAttribute('data-intent', 'stopped');
  await page.locator('[data-tab="map"]').click(); await page.keyboard.press('Space');
  await expect(panel).toHaveAttribute('data-intent', 'stopped');
  await expect(panel).toHaveAttribute('data-playback', '2');
  await page.locator('#game-music-play').click();
  await expect(page.locator('#game-music-panel')).toHaveAttribute('data-playback', '1', { timeout: 35_000 });
  await page.evaluate(() => (window as typeof window & { setAudioTestHidden(value: boolean): void }).setAudioTestHidden(true));
  await expect(panel).toHaveAttribute('data-playback', '2');
  await page.evaluate(() => (window as typeof window & { setAudioTestHidden(value: boolean): void }).setAudioTestHidden(false));
  await expect(panel).toHaveAttribute('data-visibility', 'visible');
  await expect(panel).toHaveAttribute('data-playback', '1', { timeout: 15_000 });
  await page.locator('[data-tab="map"]').click();
  await expect(page.locator('.world-battle-hud')).toBeVisible();
  await page.keyboard.down('KeyW'); await page.waitForTimeout(250); await page.keyboard.up('KeyW');
  await expect(panel).toHaveAttribute('data-playback', '1');
  const desktopPanel = await panel.boundingBox();
  const desktopHud = await visibleWorldHudBoxes(page);
  expect(desktopHud.filter(box => overlaps(desktopPanel!, box)), JSON.stringify(desktopHud)).toEqual([]);
  await page.locator('#game-music-close').click();
  await expect(panel).toBeHidden();
  await expect(panel).toHaveAttribute('data-intent', 'stopped');
  await page.getByRole('button', { name: '음악 플레이어 설정' }).click();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-playback', '1', { timeout: 15_000 });
});

test('mobile touch starts the soundtrack without covering bottom navigation', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, baseURL: testInfo.project.use.baseURL as string });
  const page = await context.newPage();
  await page.routeWebSocket('**', socket => socket.close());
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
  let releaseApi = () => {};
  const apiGate = new Promise<void>(resolve => { releaseApi = resolve; });
  await page.route('https://www.youtube.com/iframe_api', async route => { await apiGate; await route.continue(); });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const panel = page.locator('#game-music-panel');
  await page.locator('[data-starter="152"]').tap();
  await expect(page.locator('.world-battle-hud')).toBeVisible();
  releaseApi();
  await expect(panel.locator('iframe')).toBeVisible({ timeout: 25_000 });
  await expect(panel.locator('iframe')).toHaveAttribute('allow', /autoplay/);
  await page.locator('#ow-host').tap({ position: { x: 350, y: 430 } });
  await expect(panel).toHaveAttribute('data-playback', '1', { timeout: 35_000 });
  await expect(panel).toHaveAttribute('data-muted', 'false');
  await expect(panel).toHaveAttribute('data-provider-muted', 'false');
  const boxes = await page.evaluate(() => ({
    panel: document.querySelector('#game-music-panel')!.getBoundingClientRect().toJSON(),
    nav: document.querySelector('.topbar nav')!.getBoundingClientRect().toJSON(),
    iframeCount: document.querySelectorAll('#game-music-panel iframe').length,
    statusFont: Number.parseFloat(getComputedStyle(document.querySelector('#game-music-status')!).fontSize),
    closeHeight: document.querySelector('#game-music-close')!.getBoundingClientRect().height,
  }));
  expect(boxes.panel.width).toBeGreaterThanOrEqual(200); expect(boxes.panel.height).toBeGreaterThanOrEqual(200);
  expect(boxes.panel.right).toBeLessThanOrEqual(390); expect(boxes.panel.bottom).toBeLessThanOrEqual(boxes.nav.top);
  expect(boxes.iframeCount).toBe(1);
  expect(boxes.statusFont).toBeGreaterThanOrEqual(12); expect(boxes.closeHeight).toBeGreaterThanOrEqual(40);
  const mobileHud = await visibleWorldHudBoxes(page);
  expect(mobileHud.filter(box => overlaps(boxes.panel, box)), JSON.stringify(mobileHud)).toEqual([]);
  await page.locator('.world-explore-toggle').tap();
  await expect(page.locator('.world-explore-panel')).toHaveAttribute('open', '');
  const openPanelBox = await panel.boundingBox();
  const openHud = await visibleWorldHudBoxes(page);
  expect(openHud.filter(box => overlaps(openPanelBox!, box)), JSON.stringify(openHud)).toEqual([]);
  await page.locator('#world-pause').tap();
  await expect(panel).toHaveAttribute('data-playback', '1');
  await context.close();
});
