import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import type { FieldPolicy } from '../src/game/field';
import { createGame } from '../src/game/engine';
import { getCaveScene } from '../src/openworld/caves';
import { findWorldPath } from '../src/openworld/navigation';
import { OpenWorldSimulation } from '../src/openworld/simulation';
import { surfaceSceneId } from '../src/openworld/world-space';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;
const place = (world: OpenWorldSimulation, id: string) => world.atlas.locations.find(location => location.id === id)!;
const stand = (world: OpenWorldSimulation, point: { x: number; z: number }) => {
  world.player = { x: point.x, z: point.z, heading: 0 };
  Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
};

describe('reachable wild Pokémon, lairs and gated routes', () => {
  it('spawns wild Pokémon only on ground the badges open and the roads reach', () => {
    const world = new OpenWorldSimulation(graph, createGame(1, 'reach-spawns'), 9401, undefined, policy);
    // Hoenn's Route 105 needs the first badge; Route 104 beside it is open from the start.
    world.regionId = 'hoenn'; world.sceneId = surfaceSceneId('hoenn');
    const route104 = place(world, 'hoenn-route-104');
    stand(world, world.atlas.nearestWalkable(route104.x, route104.z, 0)!);
    for (let spawn = 0; spawn < 300; spawn++) {
      const point = (world as any).localSpawnPosition() as { x: number; z: number };
      expect(world.atlas.locationAt(point.x, point.z).requiredBadges).toBe(0);
    }
    // In Kanto nothing appears past Pewter's gate before the Boulder Badge, though Route 3 itself needs no badge.
    world.regionId = 'kanto'; world.sceneId = surfaceSceneId('kanto');
    const pewter = place(world, 'pewter');
    stand(world, { x: pewter.x + 14, z: pewter.z });
    for (let spawn = 0; spawn < 300; spawn++) {
      const point = (world as any).localSpawnPosition() as { x: number; z: number };
      expect(['route-3', 'mt-moon', 'route-4']).not.toContain(world.atlas.locationAt(point.x, point.z).id);
    }
  });

  it('chases neither a wild Pokémon it could never reach nor one whose model failed', () => {
    const world = new OpenWorldSimulation(graph, createGame(1, 'reach-targets'), 9402, undefined, policy);
    world.regionId = 'hoenn'; world.sceneId = surfaceSceneId('hoenn');
    const atlas = world.atlas, route104 = place(world, 'hoenn-route-104'), route105 = place(world, 'hoenn-route-105');
    // A spot on Route 105's water and one on Route 104 a little farther from the partner.
    let locked: { x: number; z: number } | undefined;
    for (let t = 0; t <= 1 && !locked; t += .01) {
      const point = { x: route104.x + (route105.x - route104.x) * t, z: route104.z + (route105.z - route104.z) * t };
      if (!atlas.sample(point.x, point.z).blocked && atlas.locationAt(point.x, point.z).id === 'hoenn-route-105') locked = point;
    }
    expect(locked).toBeDefined();
    const partner = { x: locked!.x + (route104.x - locked!.x) * .15, z: locked!.z + (route104.z - locked!.z) * .15 };
    expect(atlas.evaluateTraversal(partner, partner, 0).allowed).toBe(true);
    stand(world, partner);
    const [closed, failed, open, ...rest] = world.entities.filter(entity => entity.kind === 'wild');
    for (const other of rest) Object.assign(other, { x: route104.x + 200, z: route104.z });
    Object.assign(closed, locked);
    Object.assign(failed, { x: partner.x + (route104.x - partner.x) * .1, z: partner.z + (route104.z - partner.z) * .1 });
    Object.assign(open, { x: partner.x + (route104.x - partner.x) * .5, z: partner.z + (route104.z - partner.z) * .5 });
    world.setModelStatus(failed.id, 'failed');
    expect(Math.hypot(closed.x - partner.x, closed.z - partner.z)).toBeLessThan(Math.hypot(open.x - partner.x, open.z - partner.z));
    expect((world as any).nearestWildToCompanion()?.id).toBe(open.id);
    // A wild Pokémon left on locked ground by an older save is moved to open ground, keeping its identity.
    (world as any).relocateTownWilds();
    expect(atlas.locationAt(closed.x, closed.z).requiredBadges).toBe(0);
    expect(world.entities.some(entity => entity.id === closed.id)).toBe(true);
  });

  it('brings a lair\'s legendaries out one at a time, always at the altar', () => {
    const lair = getCaveScene('cave:kanto:cerulean-cave-b1f')!;
    expect(lair.legendary).toEqual([150, 151]);
    const game = createGame(1, 'lair-one-at-a-time');
    game.player.badges = 8; game.defeatedGyms = [1, 2, 3, 4, 5, 6, 7, 8];
    const world = new OpenWorldSimulation(graph, game, 9403, undefined, policy), doorway = lair.portals[0] ?? lair.stairs[0];
    world.sceneId = lair.sceneId; (world as any).resetScenePopulation(doorway.interiorArrival);
    const legends = () => world.entities.filter(entity => entity.kind === 'wild' && lair.legendary!.includes(entity.speciesId));
    expect(legends().map(entity => entity.speciesId)).toEqual([150]);
    expect(Math.hypot(legends()[0].x - lair.altar!.x, legends()[0].z - lair.altar!.z)).toBeLessThan(1e-6);
    for (let spawn = 0; spawn < 12; spawn++) (world as any).spawnWild();
    expect(legends().map(entity => entity.speciesId)).toEqual([150]);
    // Mewtwo caught: Mew waits at the altar next, and Mewtwo never comes back.
    game.dex.caught.push(150);
    (world as any).resetScenePopulation(doorway.interiorArrival);
    expect(legends().map(entity => entity.speciesId)).toEqual([151]);
    expect(Math.hypot(legends()[0].x - lair.altar!.x, legends()[0].z - lair.altar!.z)).toBeLessThan(1e-6);
  });

  it('routes walks around closed gates and names the gate when there is no way through', () => {
    const game = createGame(1, 'gated-routes'), world = new OpenWorldSimulation(graph, game, 9404, undefined, policy);
    const pewter = place(world, 'pewter'), route3 = place(world, 'route-3'), viridian = place(world, 'viridian');
    stand(world, { x: pewter.x + 6, z: pewter.z + 2 });
    const destination = world.atlas.nearestWalkable(route3.x, route3.z, 0)!;
    expect(world.routeBlock(destination)).toContain('회색배지');
    expect(world.routeBlock(world.atlas.nearestWalkable(viridian.x, viridian.z, 0)!)).toBeUndefined();
    const step = (from: { x: number; z: number }, to: { x: number; z: number }) => world.canStep(from, to);
    // Terrain alone runs straight through the closed gate; the gate rule finds no way.
    expect(findWorldPath(world.player, destination, (x, z) => world.sampleWorld(x, z)).length).toBeGreaterThan(0);
    expect(findWorldPath(world.player, destination, (x, z) => world.sampleWorld(x, z), undefined, step)).toEqual([]);
    game.player.badges = 1; game.defeatedGyms = [1];
    expect(world.routeBlock(destination)).toBeUndefined();
    expect(findWorldPath(world.player, destination, (x, z) => world.sampleWorld(x, z), undefined, step).length).toBeGreaterThan(0);
  });
});
