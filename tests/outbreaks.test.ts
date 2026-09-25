import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import type { FieldPolicy } from '../src/game/field';
import { createGame } from '../src/game/engine';
import { isLegendarySpecies, isMythicalSpecies, legendaryClass } from '../src/game/legendary';
import { dailyOutbreak, outbreakDay } from '../src/data/outbreaks';
import { getWorldAtlas } from '../src/openworld/atlas';
import { OpenWorldSimulation } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const policy = JSON.parse(readFileSync('public/data/openworld-policy.json', 'utf8')) as FieldPolicy;

describe('mass outbreaks', () => {
  it("keeps Johto to Gold and Silver's radio swarms and gives other regions a route of the day", () => {
    const johto = getWorldAtlas('johto'), kanto = getWorldAtlas('kanto'), any = () => true;
    const swarms = new Set(Array.from({ length: 40 }, (_, day) => JSON.stringify(dailyOutbreak('johto', johto.locations, day, any))));
    expect([...swarms].map(item => JSON.parse(item)).every(item => ['route-35', 'route-38', 'mt-mortar', 'dark-cave-west'].includes(item.locationId))).toBe(true);
    expect(swarms.size).toBeGreaterThan(1);
    for (let day = 0; day < 20; day++) {
      const outbreak = dailyOutbreak('kanto', kanto.locations, day, id => !isLegendarySpecies(id))!;
      const place = kanto.locations.find(location => location.id === outbreak.locationId)!;
      expect(['route', 'forest']).toContain(place.kind);
      expect(place.encounters).toContain(outbreak.speciesId);
      expect(dailyOutbreak('kanto', kanto.locations, day, id => !isLegendarySpecies(id))).toEqual(outbreak);
    }
    expect(outbreakDay(86_400_000 * 3 + 5)).toBe(3);
  });

  it('fills the outbreak place with its species once the clock follows the real day', () => {
    const game = createGame(1, 'outbreak-spawns');
    game.player.badges = 8; game.defeatedGyms = [1, 2, 3, 4, 5, 6, 7, 8];
    const world = new OpenWorldSimulation(graph, game, 8801, undefined, policy);
    expect(world.outbreak).toBeUndefined();
    world.synchronizeWorldClock(86_400_000 * 20_000);
    const outbreak = world.outbreak!, place = world.atlas.locations.find(location => location.id === outbreak.locationId)!;
    const spawns = Array.from({ length: 200 }, () => (world as any).encounterAt({ x: place.x, z: place.z }).speciesId as number);
    expect(spawns.filter(id => id === outbreak.speciesId).length).toBeGreaterThan(60);
  });
});

describe('mythical Pokémon', () => {
  it('frame mythical Pokémon apart from the legendary ones', () => {
    expect(isMythicalSpecies(151) && isLegendarySpecies(151)).toBe(true);
    expect(isMythicalSpecies(150)).toBe(false);
    expect(legendaryClass(151)).toContain('mythical-pokemon');
    expect(legendaryClass(150)).toBe(' legendary-pokemon');
    expect(legendaryClass(25)).toBe('');
  });
});
