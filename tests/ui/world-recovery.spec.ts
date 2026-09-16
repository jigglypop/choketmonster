import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Graph } from '../../src/core/brain';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';

test('a failed server turn remains intact and resumes from the visible recovery button', async ({ page }) => {
  test.setTimeout(120_000);
  await page.routeWebSocket(url => url.pathname === '/' && url.searchParams.has('token'), () => {});
  const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
  const game = createGame(1, 'server-recovery-ui'), world = new OpenWorldSimulation(graph, game, 918);
  const wild = world.entities.find(entity => entity.kind === 'wild')!;
  const companion = world.entities.find(entity => entity.kind === 'companion')!;
  Object.assign(companion, { x: wild.x, z: wild.z }); world.syncPlayerToCompanion();
  expect(world.startEncounter(wild.id)).toBe(true);
  const save = packSave(game, graph, { ...defaultView(), openWorld: world.snapshot(), learning: false });
  let offline = true;
  const batches: string[][] = [];
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: true, graphId: 'recovery-fixture', nodes: 166700, edges: 25582938 } }));
  await page.route('**/api/local-brains/step-batch', route => {
    const body = route.request().postDataJSON(); batches.push(body.steps.map((step: any) => step.requestId));
    return offline ? route.fulfill({ status: 503, json: { message: '회로 서버 일시 중단' } })
      : route.fulfill({ json: { decisions: body.steps.map((step: any) => ({ creatureId: step.creatureId, requestId: step.requestId,
        decision: { action: step.available.findIndex(Boolean), updates: 0, activity: .2, elapsedMs: 10, graphId: 'recovery-fixture', nodes: 166700, edges: 25582938 },
      })) } });
  });
  await page.goto('/'); await page.locator('[data-starter="152"]').click();
  await page.locator('#import-file').setInputFiles({ name: 'recovery.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#world-recovery-message')).toContainText('회로 서버 일시 중단', { timeout: 60_000 });
  await expect(page.locator('#ow-host')).toHaveAttribute('data-paused', 'true');
  await expect(page.locator('#world-resume')).toBeVisible();
  await page.locator('#world-resume').click();
  await expect(page.locator('#world-resume')).toBeEnabled();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-paused', 'true');
  offline = false;
  await page.locator('#world-resume').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-paused', 'false', { timeout: 20_000 });
  await expect(page.locator('#world-recovery')).toBeHidden();
  expect(batches.length).toBeGreaterThanOrEqual(3);
  expect(batches[1]).toEqual(batches[0]); expect(batches[2]).toEqual(batches[0]);
  await expect(page.locator('#world-battle-state')).toContainText('턴 2', { timeout: 10_000 });
});
