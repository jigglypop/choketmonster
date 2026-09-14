import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import type { FieldPolicy } from '../src/game/field';
import { createGame } from '../src/game/engine';
import { CAVE_SCENES, getCaveScene } from '../src/openworld/caves';
import { OpenWorldSimulation } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;

describe('cave simulation scenes', () => {
  it('enables new-world auto capture while preserving an explicit saved false value', () => {
    const game = createGame(1, 'auto-capture-default'), world = new OpenWorldSimulation(graph, game, 7181, undefined, policy);
    expect(world.autoCapture).toBe(true);
    world.setAutoCapture(false);
    const restored = new OpenWorldSimulation(graph, game, world.seed, world.snapshot(), policy);
    expect(restored.autoCapture).toBe(false);
  });

  it('enters, saves, restores and exits through a real portal', () => {
    const game = createGame(1, 'cave-scene'), world = new OpenWorldSimulation(graph, game, 7182, undefined, policy);
    const cave = getCaveScene('cave:kanto:mt-moon')!, portal = cave.portals[0];
    expect(world.movePlayer({ ...portal.surface, heading: 0 })).toBe(true);
    expect(world.traverseCavePortal()).toBe(true);
    expect(world.sceneId).toBe(cave.sceneId);
    expect(world.locationAt(world.player.x, world.player.z).id).toBe(cave.encounterLocationId);
    expect(world.entities.filter(entity => entity.kind === 'wild')).toHaveLength(15);
    const restored = new OpenWorldSimulation(graph, game, world.seed, world.snapshot(), policy);
    expect(restored.sceneId).toBe(cave.sceneId);
    expect(restored.movePlayer({ ...portal.interior, heading: 0 })).toBe(true);
    expect(restored.traverseCavePortal()).toBe(true);
    expect(restored.sceneId).toBe(portal.surfaceSceneId);
  });

  it('populates, restores and exits every shipped cave at the completed-region gate', () => {
    for (const [index, cave] of CAVE_SCENES.entries()) {
      const game=createGame(cave.regionId==='kanto'?1:152,`all-caves-${cave.id}`);
      if(cave.regionId==='kanto'){game.defeatedGyms=[1,2,3,4,5,6,7,8];game.player.badges=8;}
      else game.campaign!.johtoBadges=[1,2,3,4,5,6,7,8];
      const world=new OpenWorldSimulation(graph,game,7200+index,undefined,policy);
      if(cave.regionId==='johto')world.changeRegion('johto');
      world.sceneId=cave.sceneId;(world as any).resetScenePopulation(cave.portals[0].interiorArrival);
      const wilds=world.entities.filter(entity=>entity.kind==='wild');
      expect(wilds, cave.sceneId).toHaveLength(15);
      expect(wilds.every(entity=>world.locationAt(entity.x,entity.z).id===cave.encounterLocationId&&!world.sampleWorld(entity.x,entity.z).blocked),cave.sceneId).toBe(true);
      const restored=new OpenWorldSimulation(graph,game,world.seed,world.snapshot(),policy);
      expect(restored.sceneId).toBe(cave.sceneId);
      expect(restored.movePlayer({...cave.portals[0].interior,heading:0})).toBe(true);
      expect(restored.traverseCavePortal()).toBe(true);
      expect(restored.sceneId).toBe(cave.portals[0].surfaceSceneId);
    }
  },60_000);
});
