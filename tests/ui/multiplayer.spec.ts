import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { openExplorePanel } from './helpers/explore-panel';

test.skip(!process.env.CHOKETMON_LIVE_AUTH, 'Requires the local Rust/PostgreSQL server.');
test.setTimeout(420_000);

type SocketStats = { opens: number; closes: number; reauths: number; welcomes: string[] };

async function newPage(context: BrowserContext): Promise<Page> {
  await context.addInitScript(() => {
    localStorage.setItem('choketmon-audio-v1', JSON.stringify({ musicVolume: .34, effectsVolume: .62, muted: true }));
    const NativeSocket = window.WebSocket;
    const stats: SocketStats = { opens: 0, closes: 0, reauths: 0, welcomes: [] };
    Object.defineProperty(window, '__realtimeSocketStats', { value: stats });
    class TrackedSocket extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        stats.opens++;
        this.addEventListener('close', () => stats.closes++);
        this.addEventListener('message', event => {
          try { const message = JSON.parse(String(event.data)); if (message.type === 'welcome') stats.welcomes.push(message.id); } catch { /* control frames */ }
        });
      }
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (typeof data === 'string') {
          try { if (JSON.parse(data).type === 'reauth') stats.reauths++; } catch { /* non-JSON frames are unused */ }
        }
        super.send(data);
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: TrackedSocket });
  });
  const page = await context.newPage();
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => /\/152\.glb$/.test(route.request().url()) ? route.continue() : route.abort());
  await page.goto('/?renderProbe');
  return page;
}

async function register(page: Page, username: string, password: string, fromChat = false): Promise<void> {
  await (fromChat ? page.locator('#world-chat-login') : page.locator('[data-open-auth]')).click();
  await expect(page.locator('.account-dialog')).toBeVisible();
  await page.locator('.account-dialog input[name="username"]').fill(username);
  await page.locator('.account-dialog input[name="password"]').fill(password);
  await page.locator('.account-dialog button[value="register"]').click();
  await expect(page.locator('.account-dialog')).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('.account-name')).toContainText(username);
}

async function chooseJohtoAndOpenWorld(page: Page): Promise<void> {
  await expect(page.locator('[data-starter="152"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-starter="152"]').click();
  await expect(page.locator('#starter-dialog')).toBeHidden();
  await openExplorePanel(page);
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
}

async function sendChat(page: Page, text: string): Promise<void> {
  const input = page.locator('#world-chat-input');
  await expect(input).toBeEnabled();
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toHaveValue('');
}

test('registered account usernames identify bidirectional chat and reauthenticate without disconnecting', async ({ browser }, testInfo) => {
  const suffix = `${testInfo.workerIndex}-${Date.now().toString(36)}`;
  const firstName = `chat_a_${suffix}`.slice(0, 32), secondName = `chat_b_${suffix}`.slice(0, 32);
  const password = `Chat-${crypto.randomUUID()}-pass`;
  const firstContext = await browser.newContext(), secondContext = await browser.newContext();
  try {
    const first = await newPage(firstContext);
    await chooseJohtoAndOpenWorld(first);
    await expect(first.locator('#world-realtime-status')).toHaveText('로그인 필요');
    await expect(first.locator('#world-chat-input')).toBeDisabled();
    await expect(first.locator('#world-chat-login')).toBeVisible();
    await expect(first.locator('#world-realtime-name,#world-realtime-rename')).toHaveCount(0);
    await register(first, firstName, password, true);
    await chooseJohtoAndOpenWorld(first);

    const second = await newPage(secondContext);
    await chooseJohtoAndOpenWorld(second);
    await register(second, secondName, password, true);
    await chooseJohtoAndOpenWorld(second);
    await expect(first.locator('#world-realtime-status')).toHaveText('연결됨', { timeout: 30_000 });
    await expect(second.locator('#world-realtime-status')).toHaveText('연결됨', { timeout: 30_000 });
    await expect(first.locator('#world-chat-identity')).toHaveText(firstName);
    await expect(second.locator('#world-chat-identity')).toHaveText(secondName);

    await first.locator('.social-players > summary').click();
    await second.locator('.social-players > summary').click();
    await expect(first.locator('[data-remote-player]').filter({ hasText: secondName })).toBeVisible({ timeout: 20_000 });
    await expect(second.locator('[data-remote-player]').filter({ hasText: firstName })).toBeVisible({ timeout: 20_000 });
    await expect(first.locator('#world-realtime-count')).toContainText('2명');

    const firstText = `성도에서 만나요 ${suffix}`, secondText = `반가워요 ${suffix}`;
    await sendChat(first, firstText);
    await expect(second.locator('#world-chat-log p').filter({ hasText: firstText }).last()).toContainText(firstName, { timeout: 15_000 });
    await sendChat(second, secondText);
    await expect(first.locator('#world-chat-log p').filter({ hasText: secondText }).last()).toContainText(secondName, { timeout: 15_000 });

    mkdirSync('artifacts', { recursive: true });
    await first.screenshot({ path: 'artifacts/multiplayer-auth-chat-desktop.png' });
    const stableBaselines = await Promise.all([first, second].map(page => page.evaluate(() => (window as typeof window & { __realtimeSocketStats: SocketStats }).__realtimeSocketStats).then(stats => structuredClone(stats))));
    await first.waitForTimeout(72_000);
    for (const [index, page] of [first, second].entries()) {
      await expect(page.locator('#world-realtime-status')).toHaveText('연결됨');
      const stats = await page.evaluate(() => (window as typeof window & { __realtimeSocketStats: SocketStats }).__realtimeSocketStats);
      const baseline = stableBaselines[index];
      expect(stats.opens).toBe(baseline.opens); expect(stats.closes).toBe(baseline.closes);
      expect(stats.reauths).toBeGreaterThan(baseline.reauths);
      expect(stats.welcomes).toEqual(baseline.welcomes);
    }

    // Expiring the browser session must keep the account's local adventure
    // active, disable chat, and let the same credentials restore service. The
    // account-panel regression also asserts that this path authenticates before
    // attempting the now-unauthorized server checkpoint.
    await firstContext.clearCookies();
    await expect(first.locator('#world-realtime-status')).toHaveText('다시 로그인', { timeout: 50_000 });
    await expect(first.locator('#world-chat-input')).toBeDisabled();
    await expect(first.locator('#world-chat-login')).toHaveText('다시 로그인');
    await expect(first.locator('.account-name')).toContainText(firstName);
    await first.locator('#world-chat-login').click();
    await first.locator('.account-dialog input[name="username"]').fill(firstName.toUpperCase());
    await first.locator('.account-dialog input[name="password"]').fill(password);
    await first.locator('.account-dialog button[value="login"]').click();
    await expect(first.locator('.account-dialog')).toBeHidden({ timeout: 30_000 });
    await expect(first.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await expect(first.locator('#world-realtime-status')).toHaveText('연결됨', { timeout: 30_000 });
    await sendChat(first, `재로그인 복구 ${suffix}`);
    await expect(second.locator('#world-chat-log p').filter({ hasText: `재로그인 복구 ${suffix}` }).last()).toContainText(firstName, { timeout: 15_000 });
    await second.setViewportSize({ width: 390, height: 844 });
    await second.screenshot({ path: 'artifacts/multiplayer-auth-chat-mobile.png' });
    const recoveredStats = await first.evaluate(() => (window as typeof window & { __realtimeSocketStats: SocketStats }).__realtimeSocketStats);
    const recoveryOpens = recoveredStats.opens - stableBaselines[0].opens, recoveryCloses = recoveredStats.closes - stableBaselines[0].closes;
    expect(recoveryOpens).toBeGreaterThanOrEqual(1); expect(recoveryCloses).toBe(recoveryOpens);
    expect(recoveredStats.opens - recoveredStats.closes).toBe(1);
  } finally {
    await firstContext.close().catch(() => undefined);
    await secondContext.close().catch(() => undefined);
  }
});
