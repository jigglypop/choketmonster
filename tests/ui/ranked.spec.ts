import { expect, test } from '@playwright/test';

const self = { userId: 'ranked-self', username: '나트레이너', activeIndex: 0, team: [{
  instanceId: 'mine', speciesId: 152, nickname: '치코리타', level: 50, hp: 120, maxHp: 120,
  types: ['grass'], status: null, moves: [{ id: 33, name: '몸통박치기', type: 'normal', power: 40, accuracy: 100, damageClass: 'physical' }],
}] };
const opponent = { userId: 'ranked-rival', username: '상대트레이너', activeIndex: 0, team: [{
  instanceId: 'rival', speciesId: 155, nickname: '브케인', level: 50, hp: 105, maxHp: 105,
  types: ['fire'], status: null, moves: [{ id: 52, name: '불꽃세례', type: 'fire', power: 40, accuracy: 100, damageClass: 'special' }],
}] };
const leaderboard = [
  { rank: 1, userId: 'ranked-rival', username: '상대트레이너', rating: 1640, wins: 20, losses: 4, tier: 'master' },
  { rank: 8, userId: 'ranked-self', username: '나트레이너', rating: 1210, wins: 8, losses: 6, tier: 'silver' },
];
const lobby = (league: 'standard' | 'open') => ({ league, rules: { level: 50, teamSize: 6, legendaryAllowed: league === 'open', turnSeconds: 90 }, leaderboard,
  me: { rating: 1210, wins: 8, losses: 6, tier: 'silver', queued: false }, currentMatch: null });
const match = { id: 'match-1', league: 'standard', status: 'active', turn: 1, deadlineAt: new Date(Date.now() + 90_000).toISOString(), selfSide: self,
  opponentSide: opponent, events: ['랭크전이 시작되었습니다.'], awaitingOpponent: false, winnerId: null, resultReason: null, ratingChange: 0 };

test('shows two ranked ladders, tier borders, matchmaking, and a server-authoritative turn', async ({ page }) => {
  test.setTimeout(90_000);
  const calls: Array<{ path: string; body?: unknown; profile?: string }> = [];
  let current: typeof match | null = null;
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: { id: 'ranked-self', username: '나트레이너' } } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  await page.route('**/api/saves/current', async route => route.request().method() === 'GET'
    ? route.fulfill({ status: 404, json: {} }) : route.fulfill({ json: { revision: 1 } }));
  await page.route('**/api/ranked**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    calls.push({ path, body: route.request().postDataJSON(), profile: route.request().headers()['x-choketmon-profile'] });
    if (path.endsWith('/queue')) { current = { ...match }; return route.fulfill({ json: { ...lobby('standard'), currentMatch: current } }); }
    if (path.includes('/matches/')) { current = { ...match, awaitingOpponent: true }; return route.fulfill({ json: { match: current } }); }
    return route.fulfill({ json: { ...lobby(url.searchParams.get('league') === 'open' ? 'open' : 'standard'), currentMatch: current } });
  });

  await page.goto('/');
  await page.locator('[data-starter="152"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await page.locator('[data-tab="ranked"]').click();
  await expect(page.locator('.ranked-page h1')).toHaveText('트레이너 랭크전');
  await expect(page.locator('.rank-tier-master').filter({ hasText: '상대트레이너' })).toBeVisible();
  await expect(page.locator('.rank-tier-silver').filter({ hasText: '나트레이너' }).first()).toBeVisible();

  await page.locator('[data-ranked-league="open"]').click();
  await expect(page.locator('.ranked-lobby')).toContainText('보유한 모든 포켓몬을 사용할 수 있습니다');
  await page.locator('[data-ranked-league="standard"]').click();
  await page.locator('[data-ranked-queue]').click();
  await expect(page.locator('.ranked-match')).toBeVisible();
  await expect(page.locator('.ranked-versus')).toContainText('나트레이너');
  await expect(page.locator('.ranked-versus')).toContainText('상대트레이너');
  await expect(page.locator('[data-ranked-league="open"]')).toBeDisabled();
  await page.locator('[data-ranked-move="0"]').click();
  await expect(page.locator('.ranked-wait')).toContainText('상대 선택을 기다립니다');
  expect(calls.some(call => call.path.endsWith('/queue') && (call.body as any)?.league === 'standard' && call.profile === 'ranked-self')).toBe(true);
  expect(calls.some(call => call.path.includes('/matches/match-1/action') && (call.body as any)?.moveIndex === 0)).toBe(true);
  current = { ...match, status: 'completed', ratingChange: 20 };
  await expect(page.locator('.ranked-result')).toBeVisible({ timeout: 10_000 });
  await page.locator('[data-ranked-refresh]').click();
  await expect(page.locator('.ranked-lobby')).toBeVisible();
  await expect(page.locator('[data-ranked-queue]')).toBeEnabled();
});
