import { expect, test } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { createGame, createMonster } from '../../src/game/engine';
import { getCampaignGyms } from '../../src/game/campaign';
import { defaultView, packSave } from '../../src/game/storage';
import { OpenWorldSimulation } from '../../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8'));
test.setTimeout(120_000);
for (const [region, starter, label] of [['hoenn',252,'호연'],['sinnoh',387,'신오'],['unova',495,'하나'],['kalos',650,'칼로스'],['alola',722,'알로라']] as const) test(`${region} renders a rigged partner, starts a gym battle and restores it`, async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  // Other work can edit source during this run; keep Vite HMR from replacing this loaded scenario.
  await page.routeWebSocket(url => url.pathname === '/' && url.searchParams.has('token'), () => {});
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/connectome', route => route.fulfill({ json: { available: false } }));
  const game = createGame(152, `expansion-ui-${region}`);
  game.player.badges=8; game.defeatedGyms=[1,2,3,4,5,6,7,8]; game.championDefeated=true;
  const sequence = ['hoenn', 'sinnoh', 'unova', 'kalos', 'alola'];
  Object.assign(game.campaign!, {johtoBadges:[1,2,3,4,5,6,7,8],johtoLeague:5,kantoLeague:5,expansion:
    Object.fromEntries(sequence.slice(0, sequence.indexOf(region)).map(id => [id, { badges: [1,2,3,4,5,6,7,8], league: 5 }]))});
  game.player.team=[createMonster(game,starter,25)]; game.dex.caught=[152,starter]; game.dex.seen=[152,starter];
  const world=new OpenWorldSimulation(graph,game,9451,undefined,policy); world.changeRegion(region); world.setControlMode('manual');
  const gym=getCampaignGyms(game,region)[0], location=world.atlas.safeArrival(gym.locationId)!;
  world.player={...location,heading:0};Object.assign(world.entities.find(entity=>entity.kind==='companion')!,world.player);
  await page.goto('/?renderProbe=1'); await page.locator('[data-starter="1"]').click();
  await page.locator('#import-file').setInputFiles({name:'expansion.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(packSave(game,graph,{...defaultView(),openWorld:world.snapshot(),openWorldPaused:true,learning:false})))});
  await expect(page.locator('#toast')).toContainText('불러왔습니다');
  await expect(page.locator('#ow-host')).toHaveAttribute('data-region',region);
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready','true',{timeout:45_000});
  await expect.poll(()=>page.evaluate(()=>(window as any).__renderProbe?.read().loadedPokemon ?? []),{timeout:45_000}).toContain(starter);
  if (world.atlas.locations.find(item => item.id === gym.locationId)?.kind === 'town') {
    await expect.poll(()=>page.evaluate(()=>(window as any).__renderProbe?.read().townBuildings ?? []),{timeout:45_000})
      .toEqual(expect.arrayContaining([expect.stringContaining(':0:loaded'),expect.stringContaining(':1:loaded'),expect.stringContaining(':2:loaded')]));
  }
  await expect(page.locator('#world-next-guide')).toHaveAttribute('data-status','arrived');
  await page.locator('.world-explore-toggle').click();
  await expect(page.locator('#world-gym')).toContainText(`${label} 배지 0/8`);
  await expect(page.locator('#world-gym-challenge')).toContainText(gym.name);
  await page.locator('#world-gym-challenge').click();
  await expect(page.locator('#world-battle-state')).toContainText('턴 1');
  await page.waitForTimeout(1500); await page.reload();
  await expect(page.locator('#world-battle-state')).toContainText('턴 1',{timeout:45_000});
  await expect(page.locator('#ow-host')).toHaveAttribute('data-region',region);
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready','true',{timeout:45_000});
  await expect.poll(()=>page.evaluate(()=>(window as any).__renderProbe?.read().loadedPokemon ?? []),{timeout:45_000}).toContain(starter);
  if (world.atlas.locations.find(item => item.id === gym.locationId)?.kind === 'town') {
    await expect.poll(()=>page.evaluate(()=>(window as any).__renderProbe?.read().townBuildings ?? []),{timeout:45_000})
      .toEqual(expect.arrayContaining([expect.stringContaining(':0:loaded'),expect.stringContaining(':1:loaded'),expect.stringContaining(':2:loaded')]));
  }
  await page.waitForTimeout(750);
  mkdirSync('artifacts/expansion-runtime',{recursive:true});
  await page.screenshot({path:`artifacts/expansion-runtime/${region}.png`});
  expect(errors).toEqual([]);
});
