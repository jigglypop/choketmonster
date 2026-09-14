import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

test.setTimeout(120_000);

async function prepareGame(context: BrowserContext, name: string): Promise<Page> {
  const page = await context.newPage();
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => /\/(?:152|155)\.glb$/.test(route.request().url()) ? route.continue() : route.abort());
  await page.goto('/?renderProbe');
  await expect(page.locator('[data-starter="152"]')).toBeVisible({ timeout: 30_000 });
  const model152 = page.waitForResponse(response => response.url().endsWith('/152.glb') && response.ok(), { timeout: 30_000 });
  await page.locator('[data-starter="152"]').click();
  await page.locator('#world-mode-manual').click();
  await page.locator('#world-auto-hunt').uncheck();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await model152;
  await page.locator('.world-multiplayer summary').click();
  await page.locator('#world-realtime-name').fill(name);
  await page.locator('#world-realtime-rename').click();
  await expect(page.locator('#world-realtime-status')).toHaveText('실시간 연결됨', { timeout: 30_000 });
  return page;
}

async function joinRawBrowser(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const scope = window as typeof window & { testSocket?: WebSocket; testMessages?: unknown[] };
    scope.testMessages = [];
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/realtime`);
    scope.testSocket = socket;
    socket.onerror = () => reject(new Error('raw browser WebSocket failed'));
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data)); scope.testMessages!.push(message);
      if (message.type === 'welcome') resolve();
    };
    socket.onopen = () => socket.send(JSON.stringify({ type: 'join', region: 'johto', name: '채팅트레이너', speciesId: 155, x: 64, z: 71, heading: 1, activity: 'idle' }));
  }));
}

test('two local browsers share movement and Korean chat, then rejoin the room', async ({ browser }, testInfo) => {
  const suffix = `${testInfo.workerIndex}-${Date.now()}`;
  const outgoing = `성도에서 만나요 ${suffix}`, incoming = `반가워요 ${suffix}`;
  const gameContext = await browser.newContext(), rawContext = await browser.newContext();
  try {
    const game = await prepareGame(gameContext, '이동트레이너');
    const peer = await rawContext.newPage(); await peer.goto('/'); await expect(peer.locator('[data-starter="152"]')).toBeVisible();
    const remoteModel = game.waitForResponse(response => response.url().endsWith('/155.glb') && response.ok(), { timeout: 30_000 });
    await joinRawBrowser(peer);
    const remote = game.locator('[data-remote-player]').filter({ hasText: '채팅트레이너' });
    await expect(remote).toBeVisible({ timeout: 20_000 });
    await remoteModel;
    await expect.poll(() => game.evaluate(() => (window as unknown as { __renderProbe: { read(): { creatures: { id: string }[] } } }).__renderProbe.read().creatures.some(creature => creature.id.startsWith('remote:')))).toBe(true);
    await expect(game.locator('#world-realtime-count')).toContainText('2명');
    await peer.evaluate(() => (window as typeof window & { testSocket: WebSocket }).testSocket.send(JSON.stringify({ type: 'join', region: 'kanto', name: '채팅트레이너', speciesId: 155, x: 64, z: 71, heading: 1, activity: 'idle' })));
    await expect(remote).toHaveCount(0, { timeout: 15_000 });
    await peer.evaluate(() => (window as typeof window & { testSocket: WebSocket }).testSocket.send(JSON.stringify({ type: 'join', region: 'johto', name: '채팅트레이너', speciesId: 155, x: 64, z: 71, heading: 1, activity: 'idle' })));
    await expect(game.locator('[data-remote-player]').filter({ hasText: '채팅트레이너' })).toBeVisible({ timeout: 15_000 });

    await peer.evaluate(() => (window as typeof window & { testSocket: WebSocket }).testSocket.send(JSON.stringify({ type: 'state', seq: 1, speciesId: 155, x: 67, z: 71, heading: 1, activity: 'moving' })));
    await expect.poll(async () => Number(await remote.getAttribute('data-x')), { timeout: 15_000 }).toBe(67);

    const firstX = await peer.evaluate(() => {
      const scope = window as typeof window & { testMessages: Array<{ players?: Array<{ name: string; x: number }> }> };
      return scope.testMessages.flatMap(message => message.players ?? []).find(player => player.name === '이동트레이너')?.x;
    });
    await game.keyboard.down('ArrowRight'); await game.waitForTimeout(500); await game.keyboard.up('ArrowRight');
    await peer.waitForFunction(previous => {
      const scope = window as typeof window & { testMessages: Array<{ type: string; players?: Array<{ name: string; x: number }> }> };
      return scope.testMessages.filter(message => message.type === 'patch').flatMap(message => message.players ?? []).some(player => player.name === '이동트레이너' && player.x !== previous);
    }, firstX, { timeout: 15_000 });

    await peer.evaluate(() => { (window as typeof window & { testMessages: unknown[] }).testMessages = []; });
    const input = game.locator('#world-chat-input'); await input.focus();
    await input.evaluate((node, text) => {
      node.dispatchEvent(new CompositionEvent('compositionstart', { data: String(text) }));
      (node as HTMLInputElement).value = String(text);
      node.dispatchEvent(new InputEvent('input', { data: String(text), inputType: 'insertCompositionText', bubbles: true, isComposing: true }));
    }, outgoing);
    await game.keyboard.press('Enter'); await peer.waitForTimeout(250);
    expect(await peer.evaluate(() => JSON.stringify((window as typeof window & { testMessages: unknown[] }).testMessages))).not.toContain(outgoing);
    await input.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { data: (node as HTMLInputElement).value })));
    await game.keyboard.press('Enter');
    await peer.waitForFunction(text => JSON.stringify((window as typeof window & { testMessages: unknown[] }).testMessages).includes(text), outgoing);
    await peer.evaluate(text => (window as typeof window & { testSocket: WebSocket }).testSocket.send(JSON.stringify({ type: 'chat', text })), incoming);
    const chatLog = game.locator('#world-chat-log');
    await expect(chatLog.locator('p').last()).toContainText(incoming, { timeout: 15_000 });
    await expect.poll(() => chatLog.evaluate(node => Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 2)).toBe(true);

    await peer.evaluate(() => (window as typeof window & { testSocket: WebSocket }).testSocket.close());
    await expect(remote).toHaveCount(0, { timeout: 15_000 });
    await joinRawBrowser(peer);
    await expect(game.locator('[data-remote-player]').filter({ hasText: '채팅트레이너' })).toBeVisible({ timeout: 15_000 });
    mkdirSync('artifacts', { recursive: true }); await game.setViewportSize({ width: 390, height: 844 });
    await game.screenshot({ path: 'artifacts/multiplayer-chat-mobile.png' });
  } finally {
    await gameContext.close().catch(() => undefined); await rawContext.close().catch(() => undefined);
  }
});
