import { expect, test, type Page } from '@playwright/test';
test.setTimeout(100_000);
// Verify the real playback graph without playing fixtures over the user's speakers.
test.use({ headless: true, launchOptions: { args: ['--enable-unsafe-webgpu', '--mute-audio'] } });

/** Generated WAV validation fixture. This is not the original song or a deployable music asset. */
function wavFixture(frequency = 440, seconds = 2): Buffer {
  const sampleRate = 22_050, samples = sampleRate * seconds, dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin(i / sampleRate * frequency * Math.PI * 2) * 5000), 44 + i * 2);
  return buffer;
}

async function chooseFixture(page: Page, name: string, frequency = 440) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /BGM 오디오 파일 선택|BGM 파일/ }).first().click();
  await (await chooser).setFiles({ name, mimeType: 'audio/wav', buffer: wavFixture(frequency) });
  await expect(page.locator('#game-sound-toggle')).toHaveAttribute('data-music', /ready|playing/);
}

async function isolateApp(page: Page) {
  await page.routeWebSocket('**', socket => socket.close());
  await page.route('**/api/auth/me', route => route.fulfill({ status: 200, json: { user: null } }));
  await page.route('**/api/saves/current', route => route.fulfill({ status: 404, json: {} }));
  await page.route('**/api/connectome', route => route.fulfill({ status: 200, json: { available: false } }));
  await page.route('**/api/auth/realtime-ticket', route => route.fulfill({ status: 401, json: { message: 'Login required' } }));
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());
}

async function expectPlaying(page: Page) {
  await expect(page.locator('#game-sound-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('#game-music-audio').evaluate(audio => (audio as HTMLAudioElement).currentTime), { timeout: 10_000 }).toBeGreaterThan(.05);
}

test('original cry decodes and reaches the real audio graph; volume and mute persist', async ({ page }) => {
  await isolateApp(page);
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
        for (const value of this.buffer.getChannelData(0)) scope.cryProbe!.peak = Math.max(scope.cryProbe!.peak, Math.abs(value));
        const pending: AudioNode[] = [this], visited = new Set<AudioNode>();
        while (pending.length) { const node = pending.pop()!; if (node === this.context.destination) scope.cryProbe!.connected = true; if (visited.has(node)) continue; visited.add(node); pending.push(...(edges.get(node) ?? [])); }
        scope.cryProbe!.running = this.context.state === 'running';
      }
      return originalStart.apply(this, args);
    };
  });
  await page.goto('/');
  const fetched = page.waitForResponse(response => response.url().endsWith('/cries/pokemon/latest/152.ogg') && response.ok());
  await page.locator('[data-starter="152"]').click(); await page.keyboard.press('Space'); await page.locator('[data-tab="team"]').click(); await fetched;
  await expect.poll(() => page.evaluate(() => (window as unknown as { cryProbe: { peak: number } }).cryProbe.peak), { timeout: 15_000 }).toBeGreaterThan(.001);
  const decoded = await page.evaluate(() => (window as unknown as { cryProbe: { started: number; duration: number; sampleRate: number; connected: boolean; running: boolean } }).cryProbe);
  expect(decoded.started).toBeGreaterThan(0); expect(decoded.duration).toBeGreaterThan(.05); expect(decoded.sampleRate).toBeGreaterThan(8000); expect(decoded.connected).toBe(true); expect(decoded.running).toBe(true);
  await expect(page.locator('iframe, #game-music-panel')).toHaveCount(0);
  await page.locator('#open-interface-settings').click();
  await page.locator('#audio-music').fill('22'); await page.locator('#audio-effects').fill('41'); await page.locator('#audio-muted').check();
  await page.locator('.settings-done').click(); await page.reload(); await page.locator('#open-interface-settings').click();
  await expect(page.locator('#audio-music')).toHaveValue('22'); await expect(page.locator('#audio-effects')).toHaveValue('41'); await expect(page.locator('#audio-muted')).toBeChecked();
});

test('selected WAV fixture plays, toggles explicitly, replaces, and restores from IndexedDB', async ({ page }) => {
  await isolateApp(page);
  await page.goto('/');
  await expect(page.locator('iframe, #game-music-panel')).toHaveCount(0);
  await page.locator('[data-starter="152"]').click();
  await chooseFixture(page, 'generated-bgm-fixture.wav');
  await expectPlaying(page);
  const media = await page.locator('#game-music-audio').evaluate(element => { const audio = element as HTMLAudioElement; return { paused: audio.paused, muted: audio.muted, volume: audio.volume, loop: audio.loop, src: audio.src }; });
  expect(media.paused).toBe(false); expect(media.muted).toBe(false); expect(media.volume).toBeCloseTo(.34); expect(media.loop).toBe(true); expect(media.src).toMatch(/^blob:/);

  await page.locator('#game-sound-toggle').click();
  await expect(page.locator('#game-sound-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('[data-tab="team"]').click(); await page.keyboard.press('Space'); await page.waitForTimeout(250);
  expect(await page.locator('#game-music-audio').evaluate(audio => (audio as HTMLAudioElement).paused)).toBe(true);
  await page.locator('#game-sound-toggle').click(); await expectPlaying(page);

  const oldUrl = await page.locator('#game-music-audio').evaluate(audio => (audio as HTMLAudioElement).src);
  await page.locator('#open-interface-settings').click();
  const chooser = page.waitForEvent('filechooser'); await page.locator('#audio-music-change').click();
  await (await chooser).setFiles({ name: 'replacement-bgm-fixture.wav', mimeType: 'audio/wav', buffer: wavFixture(554) });
  await expect(page.locator('#audio-music-file-status')).toContainText('replacement-bgm-fixture.wav');
  await expect.poll(() => page.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, oldUrl)).toBe(true);
  await page.locator('.settings-done').click(); await page.reload();
  await expect(page.locator('#game-sound-toggle')).toHaveAttribute('aria-label', 'BGM 재생');
  await page.locator('[data-tab="map"]').click(); await expectPlaying(page);
  const stored = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('choketmon-local-music-v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const result = await new Promise<{ name: string; blob: Blob }>((resolve, reject) => { const request = db.transaction('tracks').objectStore('tracks').get('selected'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close(); return { name: result.name, size: result.blob.size };
  });
  expect(stored.name).toBe('replacement-bgm-fixture.wav'); expect(stored.size).toBeGreaterThan(44);
  await page.locator('#open-interface-settings').click(); await page.locator('#audio-music-remove').click();
  await expect(page.locator('#game-sound-toggle')).toHaveAttribute('data-music', 'empty');
  await expect(page.locator('#audio-music-file-status')).toContainText('제거');
});

test('mobile restores a local WAV and starts unmuted from the first world touch without an overlay', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, baseURL: testInfo.project.use.baseURL as string });
  let page = await context.newPage(); await isolateApp(page); await page.goto('/');
  await page.locator('[data-starter="152"]').tap();
  await chooseFixture(page, 'generated-mobile-bgm-fixture.wav', 330);
  await page.close();
  page = await context.newPage(); await isolateApp(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-starter="152"]').tap();
  await expect(page.locator('.world-battle-hud')).toBeVisible();
  await page.locator('#ow-host').tap({ position: { x: 340, y: 430 } });
  await expectPlaying(page);
  await expect(page.locator('#game-sound-toggle')).toHaveAttribute('aria-label', 'BGM 정지');
  const media = await page.locator('#game-music-audio').evaluate(element => { const audio = element as HTMLAudioElement; return { muted: audio.muted, volume: audio.volume, loop: audio.loop }; });
  expect(media.muted).toBe(false); expect(media.volume).toBeCloseTo(.34); expect(media.loop).toBe(true);
  await expect(page.locator('iframe, video, #game-music-panel')).toHaveCount(0);
  await context.close();
});
