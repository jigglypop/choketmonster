import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Graph } from '../../src/core/brain';
import type { FieldPolicy } from '../../src/game/field';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;
const model152 = readFileSync('data/local/pokemon-models-expanded/429de1288cea0d43f5b4f56305d2276e94239d65/152.glb');

test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/, route => /\/152\.glb(?:\?|$)/.test(route.request().url())
    ? route.fulfill({ body: model152, contentType: 'model/gltf-binary' }) : route.abort());
});

async function start(page: Page) {
  await page.goto('/');
  await expect(page.locator('[data-starter="152"]')).toBeVisible({ timeout: 30_000 });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await page.locator('#starter-dialog[open]').count()) await page.locator('[data-starter="152"]').click();
    await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await page.waitForTimeout(500);
    if (!await page.locator('#starter-dialog[open]').count()) break;
  }
  await expect(page.locator('#starter-dialog')).not.toHaveAttribute('open', '');
  const game = createGame(152, 'dex-map-ui');
  const world = new OpenWorldSimulation(graph, game, 7251, undefined, policy);
  world.setControlMode('manual'); world.setAutoHunt(false);
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), openWorldPaused: false });
  await page.locator('#import-file').setInputFiles({ name: 'dex-map-ui.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#world-mode-manual')).toHaveAttribute('aria-pressed', 'true');
}

for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`${viewport.name} Pokédex detail navigation and map compass controls`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(viewport);
    await start(page);
    await page.waitForTimeout(500);
    await expect(page.locator('.topbar .brand')).toHaveText('');
    await expect(page.locator('.topbar .brand')).toHaveAccessibleName('초켓몬스터 홈');

    await expect(page.locator('[data-tab="lab"]')).toHaveCount(0);
    await page.locator('[data-tab="dex"]').click();
    await page.waitForTimeout(500);
    expect(errors).toEqual([]);
    const dexState = await page.evaluate(() => ({ active: document.querySelector('[data-tab="dex"]')?.className, screen: document.querySelector('#screen')?.firstElementChild?.className, toast: document.querySelector('#toast')?.textContent }));
    expect(dexState.screen, JSON.stringify(dexState)).toContain('dex-page');
    await expect(page.locator('.dex-pagination')).toContainText('처음');
    await expect(page.locator('.dex-pagination')).toContainText('맨 끝');
    await expect(page.locator('.dex-card').first().locator('p')).toHaveCount(0);
    await expect(page.locator('.dex-card').first()).toContainText('상세 보기');
    await page.locator('.dex-card').first().click();
    const dialog = page.locator('.model-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.dex-detail-nav')).toContainText('처음');
    await expect(dialog.locator('.dex-detail-section').first()).toContainText('출현·입수');
    const title = await dialog.locator('h2').innerText();
    await dialog.locator('[data-dex-detail="next"]').click();
    await expect(dialog.locator('h2')).not.toHaveText(title);
    await dialog.locator('[data-dex-detail="last"]').click();
    await expect(dialog.locator('.dex-detail-nav span')).toHaveText(/(\d+) \/ \1/);
    await dialog.locator('.model-close').click();

    await page.locator('[data-tab="shop"]').click();
    const itemDetail = page.locator('.shop-card .item-detail').first();
    await expect(itemDetail).not.toHaveAttribute('open', '');
    await itemDetail.locator('summary').click();
    await expect(itemDetail).toHaveAttribute('open', '');

    await page.locator('[data-tab="map"]').click();
    const radar = page.locator('.world-radar');
    await expect(radar).toHaveAttribute('data-size', 'medium');
    const medium = await page.locator('#world-minimap').boundingBox();
    await page.locator('#world-minimap-larger').click();
    await expect(radar).toHaveAttribute('data-size', 'large');
    const large = await page.locator('#world-minimap').boundingBox();
    expect(large!.width).toBeGreaterThan(medium!.width);
    await page.locator('#world-minimap-smaller').click();
    await expect(radar).toHaveAttribute('data-size', 'medium');
    await page.locator('#world-map-open').click();
    await expect(page.locator('#world-map-dialog')).toBeVisible();
    await expect(page.locator('#world-map-content svg')).toHaveAttribute('aria-label', /도로·다리·특별 지점/);
    await page.locator('[data-map-orientation="east"]').click();
    await expect(page.locator('[data-map-orientation="east"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#world-minimap-heading')).toHaveText('동');
    const position = await page.locator('#world-position').innerText();
    const [playerX, playerZ] = position.split(',').map(Number);
    const nearestRoute = await page.locator('.world-map-point.traversable.kind-route').evaluateAll((nodes, player) => nodes.map(node => ({ id: (node as SVGGElement).dataset.locationId!, distance: Math.hypot(Number((node as SVGGElement).dataset.mapX) - player.x, Number((node as SVGGElement).dataset.mapZ) - player.z) })).sort((a, b) => a.distance - b.distance)[0], { x: playerX, z: playerZ });
    const walkable = page.locator(`[data-location-id="${nearestRoute.id}"]`);
    await expect(walkable).toBeVisible();
    await walkable.locator('circle').click();
    await expect(page.locator('#world-map-dialog')).not.toBeVisible();
    await expect(page.locator('#toast')).toContainText('길찾기를 시작합니다');
    await expect(page.locator('#world-position')).not.toHaveText(position, { timeout: 10_000 });
  });
}
