import { chromium, expect, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createGame } from '../src/game/engine';
import { defaultView, packSave } from '../src/game/storage';
import { OpenWorldSimulation } from '../src/openworld/simulation';

const name = process.argv[2] ?? 'candidate';
const output = `artifacts/ui-cohesion-shell/${name}`;
await mkdir(output, { recursive: true });
const graph = JSON.parse(await readFile('public/data/connectome.json', 'utf8'));
const policy = JSON.parse(await readFile('public/data/openworld-policy.json', 'utf8'));
const game = createGame(152, 'ui-layout-audit');
const world = new OpenWorldSimulation(graph, game, 43215, undefined, policy);
const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: true });
const browser = await chromium.launch({ args: ['--mute-audio', '--enable-unsafe-webgpu'] });
const errors: string[] = [], results: unknown[] = [];
const page = await browser.newPage();
await page.addInitScript(() => {
  const original = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = callback => original(time => {
    if (!(window as any).__layoutAuditFreeze) callback(time);
  });
});
page.on('pageerror', error => errors.push(error.message));
await page.routeWebSocket('**', socket => socket.close());
await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
// This checks HTML layout. The separate render probe measures actual models.
await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => route.abort());

async function capture(page: Page, state: string) {
  await page.evaluate(() => document.fonts.ready);
  // Font scaling and details toggles deliver ResizeObserver callbacks after
  // the input event. Measure only once the dependent HUD anchors have settled.
  await expect.poll(() => page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.adventure')!.parentElement!;
    const pairs = [['.world-radar', '--world-radar-height'], ['#world-next-guide', '--world-guide-height'], ['.world-battle-hud', '--world-partner-height'], ['.world-explore-toggle', '--world-explore-toggle-height'], ['.social-dock', '--world-chat-height']];
    return pairs.every(([selector, variable]) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      return parseFloat(getComputedStyle(host).getPropertyValue(variable)) === Math.ceil(element.getBoundingClientRect().height);
    }) && parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-header-height')) === Math.ceil(document.querySelector('.topbar')!.getBoundingClientRect().height);
  }), { timeout: 5_000 }).toBe(true);
  const result = await page.evaluate(() => {
    const selectors = ['.topbar .brand', '.topbar nav', '.trainer-summary', '.world-explore-panel', '.world-radar', '.ow-camera-controls', '.world-next-guide', '.world-target', '.world-capture-offer', '.world-battle-hud', '.social-dock', 'dialog[open]'];
    const rectangles = selectors.flatMap(selector => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element || !element.checkVisibility()) return [];
      const r = element.getBoundingClientRect();
      return [{ selector, x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }];
    });
    const overlap: string[] = [];
    if (!document.querySelector('dialog[open]')) for (let i = 0; i < rectangles.length; i++) for (let j = i + 1; j < rectangles.length; j++) {
      const a = rectangles[i], b = rectangles[j];
      if (Math.min(a.right, b.right) - Math.max(a.x, b.x) > 3 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 3) overlap.push(`${a.selector} / ${b.selector}`);
    }
    const outside = rectangles.filter(r => r.x < -1 || r.y < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1).map(r => r.selector);
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
    return { viewport: [innerWidth, innerHeight], scale: getComputedStyle(document.documentElement).getPropertyValue('--ui-font-scale'), overflow: document.documentElement.scrollWidth > innerWidth,
      rectangles, overlap, outside, dialogOverflow: dialog ? dialog.scrollWidth > dialog.clientWidth + 2 : false };
  });
  results.push({ state, ...result });
  await page.screenshot({ path: `${output}/${state}.png`, animations: 'disabled' });
}
try {
  await page.goto('http://127.0.0.1:5173/');
  await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'ui-layout.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
  await page.evaluate(() => { (window as any).__layoutAuditFreeze = true; });
  if (name === 'preferences') {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => document.documentElement.style.setProperty('--ui-font-scale', '1.5'));
      for (const position of ['right', 'left', 'bottom']) {
        await page.evaluate(position => { document.documentElement.dataset.battlePosition = position; }, position);
        await page.locator('.world-battle-hud').evaluate(node => node.setAttribute('open', ''));
        await capture(page, `${viewport.width}x${viewport.height}-1.5-${position}`);
      }
    }
  } else if (name === 'dialogs') {
    const viewports = [{ width: 1440, height: 900 }, { width: 360, height: 640 }, { width: 844, height: 390 }];
    await page.evaluate(() => document.documentElement.style.setProperty('--ui-font-scale', '1.5'));
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      const key = `${viewport.width}x${viewport.height}-1.5`;
      await page.locator('.world-explore-panel').evaluate(node => node.setAttribute('open', ''));
      await page.locator('#world-trainer-open').click();
      await capture(page, `${key}-trainer-dialog`);
      await page.locator('#world-trainer-close').click();
      await page.locator('.world-shop').evaluate(node => node.setAttribute('open', ''));
      await page.locator('#world-box-open').click();
      await expect(page.locator('#world-box-dialog')).toBeVisible();
      await capture(page, `${key}-box-dialog`);
      await page.locator('#world-box-close').click();
    }
    await page.locator('#world-trainer-open').click();
    await page.locator('[data-trainer-battle]:not(:disabled)').first().click();
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.locator('.world-explore-panel').evaluate(node => node.removeAttribute('open'));
      await page.locator('.world-battle-hud').evaluate(node => node.setAttribute('open', ''));
      await capture(page, `${viewport.width}x${viewport.height}-1.5-battle`);
    }
  } else for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 360, height: 640 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    for (const scale of [1, 1.5]) {
      await page.evaluate(scale => document.documentElement.style.setProperty('--ui-font-scale', String(scale)), scale);
      const key = `${viewport.width}x${viewport.height}-${scale}`;
      await page.locator('.world-explore-panel').evaluate(node => node.removeAttribute('open'));
      await page.locator('.world-battle-hud').evaluate(node => node.removeAttribute('open'));
      if (await page.locator('#world-chat-collapse').getAttribute('aria-expanded') === 'true') await page.locator('#world-chat-collapse').click();
      await capture(page, `${key}-closed`);
      await page.locator('.world-explore-toggle').click();
      await capture(page, `${key}-explore`);
      await page.locator('.world-explore-toggle').click();
      await page.locator('.world-battle-hud > summary').click();
      await capture(page, `${key}-partner`);
      await page.locator('.world-battle-hud > summary').click();
      await page.locator('#open-interface-settings').click();
      await capture(page, `${key}-settings`);
      await page.locator('.settings-close').click();
      await page.locator('#world-map-open').click();
      await capture(page, `${key}-map`);
      await page.locator('#world-map-close').click();
    }
  }
} finally {
  const font = await page.evaluate(() => ({ family: getComputedStyle(document.body).fontFamily,
    loaded: document.fonts.check('14px "Choket Sans"', '포켓몬'), requests: performance.getEntriesByType('resource').filter(entry => /\.woff2/.test(entry.name)).map(entry => ({ url: entry.name, bytes: (entry as PerformanceResourceTiming).decodedBodySize })) }));
  await writeFile(`${output}/report.json`, JSON.stringify({ errors, font, results }, null, 2));
  const issues = results.filter((r: any) => r.overflow || r.overlap.length || r.outside.length || r.dialogOverflow);
  console.log(JSON.stringify({ errors, checked: results.length, issues }, null, 2));
  if (issues.length || errors.length) process.exitCode = 1;
  await browser.close();
}
