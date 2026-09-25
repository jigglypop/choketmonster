import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGame, type GameState } from '../src/game/engine';
import { PLAYABLE_WORLDS } from '../src/openworld/availability';
import { OpenWorldSimulation } from '../src/openworld/simulation';
import { isTownPaved } from '../src/openworld/world-details';

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

// Town ground is drawn as a meadow disc around each town centre (8.5 map units in Kanto and Johto, 8 elsewhere) with a
// paved plaza on it, and both reach past the town's own map cell into neighbouring routes and landmarks.
describe('town ground as drawn', () => {
  const discRadius = (region: string) => (region === 'kanto' || region === 'johto' ? 8.5 : 8) * 2;
  for (const [index, region] of PLAYABLE_WORLDS.entries()) it(`${region.id} keeps wild Pokémon off every town's meadow and plaza`, () => {
    const game = fullyUnlockedGame(region.id), world = new OpenWorldSimulation(graph, game, 9361 + index, undefined, policy);
    world.changeRegion(region.id);
    const atlas = world.atlas, towns = atlas.locations.filter(location => location.kind === 'town');
    const onTownGround = (x: number, z: number) => towns.some(town => Math.hypot(x - town.x, z - town.z) < discRadius(region.id) || isTownPaved(x - town.x, z - town.z));
    let beyondOwnCell = 0;
    for (const town of towns) {
      for (let dx = -18; dx <= 18; dx += 1) for (let dz = -18; dz <= 18; dz += 1) {
        const x = town.x + dx, z = town.z + dz;
        if (!onTownGround(x, z) || atlas.sample(x, z).blocked) continue;
        if (atlas.locationAt(x, z).kind !== 'town') beyondOwnCell++;
        expect(world.isSafeTown(x, z), `${region.id}:${town.id} ${dx},${dz}`).toBe(true);
      }
      // Spawning around the town centre, a wild Pokémon never lands on any town's ground.
      world.player = { x: town.x, z: town.z, heading: 0 };
      for (let spawn = 0; spawn < 12; spawn++) {
        const point = (world as any).localSpawnPosition() as { x: number; z: number };
        expect(onTownGround(point.x, point.z), `${region.id}:${town.id} spawn`).toBe(false);
      }
    }
    // The drawn ground does reach into other places' cells, which the nearest-place rule alone left open.
    if (region.id === 'kanto') expect(beyondOwnCell).toBeGreaterThan(0);
    // A wild Pokémon at the edge of town ground can neither step onto it nor be battled from it.
    const edges = towns.flatMap(town => Array.from({ length: 64 }, (_, step) => {
      const angle = step / 64 * Math.PI * 2, reach = discRadius(region.id);
      return [{ x: town.x + Math.cos(angle) * (reach + 1), z: town.z + Math.sin(angle) * (reach + 1) }, { x: town.x + Math.cos(angle) * (reach - .5), z: town.z + Math.sin(angle) * (reach - .5) }];
    })).filter(([outside, inside]) => !onTownGround(outside.x, outside.z) && !atlas.sample(outside.x, outside.z).blocked && !atlas.sample(inside.x, inside.z).blocked
      && atlas.evaluateTraversal(outside, outside, 8).allowed);
    expect(edges.length, `${region.id} has roads out of its towns`).toBeGreaterThan(0);
    const [outside, inside] = edges[0], wild = world.entities.find(entity => entity.kind === 'wild')!;
    Object.assign(wild, outside);
    expect((world as any).pathBlocked(wild, inside.x, inside.z, [])).toBe(true);
    world.player = { ...inside, heading: 0 }; Object.assign(world.entities.find(entity => entity.kind === 'companion')!, inside);
    expect(world.canEngageWild(wild.id)).toBe(false);
    expect(world.startEncounter(wild.id)).toBe(false);
  }, 60_000);
});
