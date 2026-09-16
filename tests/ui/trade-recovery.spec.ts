import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import type { Graph } from '../../src/core/brain';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;

for (const failure of ['neural-cache', 'game-application'] as const) {
  test(`a committed trade resumes after a transient ${failure} failure`, async ({ page }) => {
    const user = { id: 'trade-recovery-user', username: 'trade_recovery' };
    const game = createGame(152, `trade-recovery-${failure}`), initial = packSave(game, graph, defaultView());
    const received = createMonster(game, 25, 12);
    game.player.box.push(received); game.player.money += 250;
    game.dex.seen.push(25); game.dex.caught.push(25);
    game.dex.seen.sort((a, b) => a - b); game.dex.caught.sort((a, b) => a - b);
    const completed = { ...packSave(game, graph, defaultView()), tradeEpoch: 1 };
    const graphId = 'trade-recovery-full-circuit';
    const neural = {
      schema: 1, graphId, gameScope: `account:donor:${game.seed}`,
      state: { lastRequestId: 'a'.repeat(64), checkpointId: 'a'.repeat(64), checkpoint: 'fixture-checkpoint', history: [],
        decision: { action: 0, updates: 7, activity: .25, elapsedMs: 1, graphId, nodes: 2, edges: 1 } },
    };
    const trade = { id: 'recovery-trade', status: 'completed', version: 4, expiresAt: '2030-01-01T00:00:00Z', participants: [],
      result: { save: completed, revision: 2, tradeEpoch: 1, incomingNeural: { instanceId: received.instanceId, neural } } };
    // Real DOM, IndexedDB, save adoption and neural-import code; HTTP is a
    // deterministic fixture so this failure scenario needs no live accounts.
    await page.route('**/trade-recovery-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.route('**/api/connectome', route => route.fulfill({ json: { available: true, graphId } }));
    await page.route('**/api/saves/current', route => route.fulfill({ json: { save: initial, revision: 1 } }));
    await page.route('**/api/trades/current', route => route.fulfill({ json: { trade } }));
    await page.routeWebSocket('**/api/trades/live?*', () => {});
    await page.goto('/trade-recovery-fixture');
    await page.evaluate(async ({ user, graph, failure }) => {
      // Let Vite resolve all imports together, including active HMR versions of
      // stateful modules, instead of creating a second bare-URL storage module.
      const helperPath = '/tests/ui/helpers/trade-recovery.ts';
      const { startTradeRecovery } = await import(/* @vite-ignore */ helperPath);
      await startTradeRecovery({ user, graph, failure });
    }, { user, graph, failure });
    const state = () => page.evaluate(() => (window as any).tradeRecovery.state());
    await expect(page.locator('.trade-error')).toContainText('Injected temporary');
    expect((await page.evaluate(() => (window as any).tradeRecovery.stored())).tradeEpoch).toBe(1);
    expect((await state()).money).toBe(3000);
    await page.evaluate(() => (window as any).tradeRecovery.recover());
    await page.locator('[data-retry]').click();
    await expect(page.locator('.trade-dialog')).not.toBeVisible();
    expect(await state()).toMatchObject({ money: 3250, species: [25], applied: 1, closed: 1 });
    expect((await state()).applyAttempts).toBeGreaterThanOrEqual(failure === 'game-application' ? 2 : 1);

    // Reopening an already applied result still shows the lobby and never
    // reapplies the old game or grants the received Pokemon/money twice.
    await page.evaluate(() => (window as any).tradeRecovery.open());
    await expect(page.locator('[data-create]')).toBeVisible();
    expect((await state()).applied).toBe(1);
    await page.locator('.trade-close').click();
    await page.evaluate(() => (window as any).tradeRecovery.save());
    const saved = await page.evaluate(() => (window as any).tradeRecovery.stored());
    expect(saved.tradeEpoch).toBe(1);
    expect(saved.game.player.money).toBe(3250);
    expect(saved.game.player.box.map((monster: { speciesId: number }) => monster.speciesId)).toEqual([25]);
  });
}
