import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Graph } from '../../src/core/brain';
import type { FieldPolicy } from '../../src/game/field';
import { createGame } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { isPlayableWorldRegion } from '../../src/openworld/availability';
import { OpenWorldSimulation } from '../../src/openworld/simulation';

const graph=JSON.parse(readFileSync('public/data/connectome.json','utf8')) as Graph;
const policy=JSON.parse(readFileSync('public/data/openworld-policy.json','utf8')) as FieldPolicy;

test.beforeEach(async({page})=>{
  await page.route('**/api/auth/me',route=>route.fulfill({json:{user:null}}));
  await page.route('**/api/connectome',route=>route.fulfill({json:{available:false}}));
  await page.route(/\.(?:glb|gltf)(?:\?.*)?$/,route=>route.abort());
});

async function importRegion(page:Page,region:'galar'|'hisui'|'paldea'){
  await page.goto('/'); await expect(page.locator('[data-starter="152"]')).toBeVisible({timeout:30_000}); await page.locator('[data-starter="152"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready','true',{timeout:30_000});
  const game=createGame(152,`runtime-${region}`); game.defeatedGyms=[1,2,3,4,5,6,7,8];game.player.badges=8;game.championDefeated=true;
  game.campaign={startRegion:'kanto',johtoBadges:[],johtoLeague:0,kantoLeague:5,redDefeated:false,expansion:{
    hoenn:{badges:[1,2,3,4,5,6,7,8],league:5},sinnoh:{badges:[1,2,3,4,5,6,7,8],league:5},unova:{badges:[1,2,3,4,5,6,7,8],league:5},kalos:{badges:[1,2,3,4,5,6,7,8],league:5},alola:{badges:[1,2,3,4,5,6,7,8],league:5},
    ...(region==='hisui'||region==='paldea'?{galar:{badges:[1,2,3,4,5,6,7,8],league:5}}:{}),...(region==='paldea'?{hisui:{badges:[1,2,3,4,5,6,7,8],league:5}}:{}),
  }};
  const world=new OpenWorldSimulation(graph,game,8600+['galar','hisui','paldea'].indexOf(region),undefined,policy);world.changeRegion(region);world.setControlMode('manual');world.setAutoHunt(false);
  const save=packSave(game,graph,{...defaultView(),openWorld:world.snapshot(),openWorldPaused:false});
  await page.locator('#import-file').setInputFiles({name:`${region}.json`,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(save))});
  await expect(page.locator('#ow-host')).toHaveAttribute('data-region',region);
}

for(const region of ['galar','hisui','paldea'] as const)test(`${region} browser traversal and save recovery`,async({page})=>{
  test.skip(!isPlayableWorldRegion(region),`${region} remains behind the verified runtime asset gate`);test.setTimeout(90_000);
  await importRegion(page,region);await page.locator('[data-tab="map"]').click();await page.locator('#world-map-open').click();await expect(page.locator('#world-map-dialog')).toBeVisible();
  const before=await page.locator('#world-position').innerText();const [x,z]=before.split(',').map(Number);
  const target=await page.locator('.world-map-point.traversable.kind-route,.world-map-point.traversable.kind-forest,.world-map-point.traversable.kind-sea').evaluateAll((nodes,player)=>nodes.map(node=>({id:(node as SVGGElement).dataset.locationId!,distance:Math.hypot(Number((node as SVGGElement).dataset.mapX)-player.x,Number((node as SVGGElement).dataset.mapZ)-player.z)})).sort((a,b)=>a.distance-b.distance)[0],{x,z});
  await page.locator(`[data-location-id="${target.id}"] circle`).click();await expect(page.locator('#world-position')).not.toHaveText(before,{timeout:15_000});
  await page.locator('#save-now').click();await expect(page.getByRole('status')).toContainText('저장했습니다');await page.reload();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-region',region,{timeout:30_000});await expect(page.locator('#world-position')).not.toHaveText(before);
});
