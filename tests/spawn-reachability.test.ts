import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { supplementalEncounterRules, WORLD_DAY_SECONDS } from '../src/data/regional-encounters';
import { createGame } from '../src/game/engine';
import type { FieldPolicy } from '../src/game/field';
import { getWorldAtlas } from '../src/openworld/atlas';
import { CAVE_SCENES } from '../src/openworld/caves';
import { OpenWorldSimulation } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;
const phaseSeconds = { morning: WORLD_DAY_SECONDS * 6 / 24, day: WORLD_DAY_SECONDS * 12 / 24, night: WORLD_DAY_SECONDS * 22 / 24 };

function unlockedWorld(region: 'kanto'|'johto') {
  const game=createGame(region==='kanto'?1:152,`reach-${region}`);
  if(region==='kanto'){game.defeatedGyms=[1,2,3,4,5,6,7,8];game.player.badges=8;}
  else game.campaign!.johtoBadges=[1,2,3,4,5,6,7,8];
  return new OpenWorldSimulation(graph,game,region==='kanto'?7701:7702,undefined,policy);
}

function walkablePoint(world:OpenWorldSimulation,locationId:string,biome:string){
  const cave=CAVE_SCENES.find(scene=>scene.regionId===world.regionId&&scene.encounterLocationId===locationId);
  if(cave){
    world.sceneId=cave.sceneId;
    for(let z=-cave.depth/2;z<=cave.depth/2;z+=.5)for(let x=-cave.width/2;x<=cave.width/2;x+=.5)if(!world.sampleWorld(x,z).blocked)return{x,z};
  }else{
    world.sceneId=`surface:${world.regionId}`;const atlas=getWorldAtlas(world.regionId),location=atlas.locations.find(item=>item.id===locationId)!;
    for(let radius=0;radius<=45;radius+=.5)for(let step=0;step<72;step++){
      const angle=step/72*Math.PI*2,point={x:location.x+Math.cos(angle)*radius,z:location.z+Math.sin(angle)*radius};
      if(!world.sampleWorld(point.x,point.z).blocked&&world.sampleWorld(point.x,point.z).biome===biome&&world.locationAt(point.x,point.z).id===locationId)return point;
    }
  }
  throw new Error(`No actual ${biome} spawn coordinate for ${world.regionId}:${locationId}`);
}

describe('actual open-world supplemental reachability',()=>{
  for(const region of ['kanto','johto'] as const) it(`spawns every ${region} dex species through a real walkable spawn coordinate`,()=>{
    const world=unlockedWorld(region),rules=supplementalEncounterRules(region),points=new Map<string,{x:number;z:number}>(),spawned=new Set<number>();
    for(const rule of rules){
      world.sceneId=CAVE_SCENES.find(scene=>scene.regionId===region&&scene.encounterLocationId===rule.locationId)?.sceneId??`surface:${region}`;
      const key=`${rule.locationId}:${rule.biome}`,point=points.get(key)??walkablePoint(world,rule.locationId,rule.biome);points.set(key,point);
      world.worldClockSeconds=phaseSeconds[rule.period];
      const local=rules.filter(item=>item.locationId===rule.locationId&&item.period===rule.period&&item.biome===rule.biome&&item.requiredBadges<=8);
      const index=local.findIndex(item=>item.speciesId===rule.speciesId);
      (world as any).spawnSerial=(index+1)*20;
      const entity=(world as any).spawnWildAt(point);spawned.add(entity.speciesId);
      world.entities.splice(world.entities.indexOf(entity),1);(world as any).brains.delete(entity.id);
    }
    expect([...spawned].sort((a,b)=>a-b)).toEqual(rules.map(rule=>rule.speciesId));
  },30_000);
});
