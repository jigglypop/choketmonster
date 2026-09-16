import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGame, type GameState } from '../src/game/engine';
import { PLAYABLE_WORLDS } from '../src/openworld/availability';
import { OpenWorldSimulation } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8'));
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8'));
const badges = [1,2,3,4,5,6,7,8];

function fullyUnlockedGame(region: string): GameState {
  const game=createGame(region==='johto'?152:1,`town-safety-${region}`);
  game.defeatedGyms=[...badges];game.player.badges=8;game.championDefeated=true;
  game.campaign={startRegion:'kanto',johtoBadges:[...badges],johtoLeague:5,kantoLeague:5,redDefeated:false,expansion:{
    hoenn:{badges:[...badges],league:5},sinnoh:{badges:[...badges],league:5},unova:{badges:[...badges],league:5},kalos:{badges:[...badges],league:5},alola:{badges:[...badges],league:5},
    galar:{badges:[...badges],league:5},hisui:{badges:[...badges],league:5},paldea:{badges:[...badges],league:5},
  }};
  game.claimedRegionalStarters=PLAYABLE_WORLDS.map(world=>world.id);
  return game;
}

describe('town safety across playable worlds', () => {
  for (const [index, region] of PLAYABLE_WORLDS.entries()) it(`${region.id} keeps towns safe through spawning, movement, recovery, and route battles`, () => {
    const game=fullyUnlockedGame(region.id),world=new OpenWorldSimulation(graph,game,9341+index,undefined,policy);
    world.changeRegion(region.id);world.setControlMode('manual');
    const wilds=()=>world.entities.filter(entity=>entity.kind==='wild');
    const safe=()=>wilds().every(entity=>!world.isSafeTown(entity.x,entity.z));

    expect(world.regionId).toBe(region.id);expect(world.isSafeTown(world.player.x,world.player.z)).toBe(true);
    expect(safe()).toBe(true);expect(wilds()).toHaveLength(15);
    // startEncounter checks the player's town before resolving the target, so a real outside wild cannot start a battle here.
    expect(world.startEncounter(wilds()[0].id)).toBe(false);
    for(let tick=0;tick<80;tick++){world.step({deltaSeconds:.25,learning:false});expect(safe()).toBe(true);}

    const checkpoint=world.snapshot(),legacyWild=checkpoint.entities.find(entity=>entity.kind==='wild')!;
    Object.assign(legacyWild,{x:world.player.x,z:world.player.z});
    const restored=new OpenWorldSimulation(graph,structuredClone(game),world.seed,checkpoint,policy);
    const restoredWilds=restored.entities.filter(entity=>entity.kind==='wild');
    expect(restoredWilds.every(entity=>!restored.isSafeTown(entity.x,entity.z))).toBe(true);
    expect(restored.rosterStatus().total).toBe(15);
    expect(restored.snapshot().entities.find(entity=>entity.id===legacyWild.id)?.brain).toEqual(legacyWild.brain);

    const route=restored.atlas.locations.find(location=>location.kind==='route'&&!restored.atlas.sample(location.x,location.z).blocked);
    expect(route,`${region.id} needs a walkable route battle anchor`).toBeDefined();
    const target=restoredWilds[0];Object.assign(target,{x:route!.x,z:route!.z});
    expect(restored.locationAt(target.x,target.z).kind).toBe('route');expect(restored.isSafeTown(target.x,target.z)).toBe(false);
    restored.movePlayer({x:target.x,z:target.z,heading:0});
    expect(restored.startEncounter(target.id)).toBe(true);
  });
});
