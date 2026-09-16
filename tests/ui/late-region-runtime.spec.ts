import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import type { Graph } from '../../src/core/brain';
import type { FieldPolicy } from '../../src/game/field';
import { createGame, createMonster } from '../../src/game/engine';
import { defaultView, packSave } from '../../src/game/storage';
import { isPlayableWorldRegion } from '../../src/openworld/availability';
import { OpenWorldSimulation } from '../../src/openworld/simulation';

const graph=JSON.parse(readFileSync('public/data/connectome.json','utf8')) as Graph;
const policy=JSON.parse(readFileSync('public/data/openworld-policy.json','utf8')) as FieldPolicy;
const cases=[['galar',850,'HOME'],['hisui',899,'primary'],['paldea',936,'HOME']] as const;
const badges=[1,2,3,4,5,6,7,8];

test.use({launchOptions:{args:['--mute-audio','--enable-unsafe-webgpu']}});
test.setTimeout(180_000);

async function preparePage(page:Page,errors:string[]){
  page.on('pageerror',error=>errors.push(`page: ${error.message}`));
  page.on('console',message=>{if(message.type()==='error'&&/THREE|shader|WebGPU|WGSL|GPUValidation/i.test(message.text()))errors.push(`webgpu: ${message.text()}`);});
  page.on('requestfailed',request=>{if(/\.(?:glb|gltf)(?:\?|$)/i.test(request.url()))errors.push(`model request: ${request.url()} · ${request.failure()?.errorText??'failed'}`);});
  // Other agents can edit source during this long render check. Do not let Vite HMR replace the loaded fixture.
  await page.routeWebSocket(url=>url.pathname==='/'&&url.searchParams.has('token'),()=>{});
  await page.route('**/api/auth/me',route=>route.fulfill({json:{user:null}}));
  await page.route('**/api/connectome',route=>route.fulfill({json:{available:false}}));
}

async function importRegion(page:Page,region:'galar'|'hisui'|'paldea',partner:number){
  await page.goto('/?renderProbe=1');await expect(page.locator(`[data-starter="152"]`)).toBeVisible({timeout:30_000});await page.locator('[data-starter="152"]').click();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready','true',{timeout:45_000});
  const game=createGame(152,`runtime-${region}`);game.defeatedGyms=[...badges];game.player.badges=8;game.championDefeated=true;
  game.campaign={startRegion:'johto',johtoBadges:[...badges],johtoLeague:5,kantoLeague:5,redDefeated:false,expansion:{
    hoenn:{badges:[...badges],league:5},sinnoh:{badges:[...badges],league:5},unova:{badges:[...badges],league:5},kalos:{badges:[...badges],league:5},alola:{badges:[...badges],league:5},
    ...(region==='hisui'||region==='paldea'?{galar:{badges:[...badges],league:5}}:{}),...(region==='paldea'?{hisui:{badges:[...badges],league:5}}:{}),
  }};
  const regionalPartner=createMonster(game,partner,20);regionalPartner.originRegion=region;game.player.team=[regionalPartner];
  game.claimedRegionalStarters=[...new Set([...(game.claimedRegionalStarters??[]),region])];game.dex.caught=[152,partner].sort((a,b)=>a-b);game.dex.seen=[...game.dex.caught];
  const world=new OpenWorldSimulation(graph,game,8600+cases.findIndex(item=>item[0]===region),undefined,policy);world.changeRegion(region);world.setControlMode('manual');world.setAutoHunt(false);
  game.versionCaught??={};game.versionCaught[game.adventureVersion!]=[partner];
  const save=packSave(game,graph,{...defaultView(),openWorld:world.snapshot(),openWorldPaused:true,learning:false});
  await page.locator('#import-file').setInputFiles({name:`${region}.json`,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(save))});
  await expect(page.locator('#toast')).toContainText('불러왔습니다');await expect(page.locator('#ow-host')).toHaveAttribute('data-region',region);await expect(page.locator('#ow-host')).toHaveAttribute('data-ready','true',{timeout:45_000});
}

async function expectExactModel(page:Page,partner:number){
  await expect.poll(()=>page.evaluate(()=>(window as any).__renderProbe?.read().loadedPokemon??[]),{timeout:60_000,message:`expected exact regional partner model ${partner}`}).toContain(partner);
}

async function expectNoRuntimeErrors(page:Page,errors:string[]){
  await expect(page.locator('#ow-host')).toHaveAttribute('data-ready','true');
  expect(errors,'page, WebGPU, or model-request errors').toEqual([]);
}

for(const [region,partner,source] of cases)test(`${region} loads exact ${source} partner, walks by map, and restores the model`,async({page},testInfo:TestInfo)=>{
  test.skip(!isPlayableWorldRegion(region),`${region} remains behind the verified runtime asset gate`);
  const errors:string[]=[];await preparePage(page,errors);await importRegion(page,region,partner);await expectExactModel(page,partner);await expectNoRuntimeErrors(page,errors);
  mkdirSync('artifacts/late-region-runtime',{recursive:true});await page.screenshot({path:`artifacts/late-region-runtime/${region}-loaded-${partner}.png`,fullPage:true});

  await page.locator('[data-tab="map"]').click();await page.locator('.world-explore-toggle').click();await page.locator('#world-pause').click();await page.locator('#world-map-open').click();await expect(page.locator('#world-map-dialog')).toBeVisible();
  const before=await page.locator('#world-position').innerText(),[x,z]=before.split(',').map(Number);
  const target=await page.locator('.world-map-point.traversable.kind-route,.world-map-point.traversable.kind-forest,.world-map-point.traversable.kind-sea').evaluateAll((nodes,player)=>nodes.map(node=>({id:(node as SVGGElement).dataset.locationId!,distance:Math.hypot(Number((node as SVGGElement).dataset.mapX)-player.x,Number((node as SVGGElement).dataset.mapZ)-player.z)})).filter(item=>item.distance>5).sort((a,b)=>a.distance-b.distance)[0],{x,z});
  expect(target).toBeDefined();const marker=page.locator(`[data-location-id="${target.id}"]`);await marker.focus();await marker.press('Enter');await expect(page.locator('#world-map-dialog')).not.toBeVisible();await expect(page.locator('#world-position')).not.toHaveText(before,{timeout:20_000});

  await page.locator('#world-pause').click();await expect(page.locator('#ow-host')).toHaveAttribute('data-paused','true');
  const moved=await page.locator('#world-position').innerText();await page.locator('#save-now').click();await expect(page.getByRole('status')).toContainText('저장했습니다');await page.reload();
  await expect(page.locator('#ow-host')).toHaveAttribute('data-region',region,{timeout:45_000});await expect(page.locator('#ow-host')).toHaveAttribute('data-ready','true',{timeout:45_000});await expect(page.locator('#world-position')).toHaveText(moved,{timeout:45_000});
  await expectExactModel(page,partner);await expectNoRuntimeErrors(page,errors);await testInfo.attach(`${region}-${partner}-restored`,{body:await page.screenshot(),contentType:'image/png'});
});
