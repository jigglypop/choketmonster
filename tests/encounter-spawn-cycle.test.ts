import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { chooseExpansionEncounter, expansionEncounterSpecies } from '../src/data/expansion-spawns';
import { getWorldAtlas } from '../src/openworld/atlas';
import { OpenWorldSimulation } from '../src/openworld/simulation';
import { createGame } from '../src/game/engine';

describe('spawn eligibility matches the exact encounter cycle', () => {
  for (const location of ['east-lake-axewell', 'galar-route-9']) it(`${location} only admits its rare-only water habitat on rare turns`, () => {
    for (const period of ['morning', 'day', 'night'] as const) {
      expect(expansionEncounterSpecies('galar', location, 8, period, 'lake').length).toBeGreaterThan(0);
      for (const serial of [1, 19, 21, 39, 41]) expect(expansionEncounterSpecies('galar', location, 8, period, 'lake', serial)).toEqual([]);
      for (const serial of [20, 40]) {
        const selected = chooseExpansionEncounter('galar', location, period, 'lake', 8, serial, () => 0, { min: 2, max: 70 });
        expect(expansionEncounterSpecies('galar', location, 8, period, 'lake', serial)).toContain(selected.speciesId);
        expect(selected.origin).toBe('supplemental');
      }
    }
  });

  it('every eligible expansion habitat has a selectable encounter, independent of the saved clock', () => {
    for (const region of ['hoenn', 'sinnoh', 'unova', 'kalos', 'alola', 'galar', 'hisui', 'paldea'] as const)
      for (const location of getWorldAtlas(region).locations)
        for (const biome of ['meadow', 'forest', 'rock', 'lake'])
          for (const period of ['morning', 'day', 'night'] as const)
            for (const serial of [1, 20, 21]) {
              const pool = expansionEncounterSpecies(region, location.id, 8, period, biome, serial);
              if (!pool.length) continue;
              expect(location.kind).not.toBe('town');
              const selected = chooseExpansionEncounter(region, location.id, period, biome, 8, serial, () => .37, { min: 2, max: 70 });
              expect(pool, `${region}:${location.id}:${biome}:${period}:${serial}`).toContain(selected.speciesId);
            }
  }, 30_000);

  it('streams and respawns a saved morning Galar adventure by the rare-only lake without stopping', () => {
    const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
    const game = createGame(1, 'morning-galar-spawn');
    game.player.badges = 8; game.defeatedGyms = [1,2,3,4,5,6,7,8]; game.championDefeated = true;
    const complete = { badges: [1,2,3,4,5,6,7,8], league: 5 };
    game.campaign = { startRegion: 'kanto', johtoBadges: [], johtoLeague: 0, kantoLeague: 5, redDefeated: false,
      expansion: { hoenn: structuredClone(complete), sinnoh: structuredClone(complete), unova: structuredClone(complete),
        kalos: structuredClone(complete), alola: structuredClone(complete), galar: structuredClone(complete) } };
    const world = new OpenWorldSimulation(graph, game, 88371);
    world.worldClockSeconds = 300; world.changeRegion('galar'); world.claimRegionalStarter(810); world.setControlMode('manual');
    const lake = getWorldAtlas('galar').locations.find(location => location.id === 'east-lake-axewell')!;
    world.player = { x: lake.x, z: lake.z, heading: 0 };
    Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
    for (const serial of [1001, 1019, 1020, 1021, 1039, 1040]) {
      world.spawnSerial = serial;
      world.entities.splice(world.entities.findIndex(entity => entity.kind === 'wild'), 1);
      world.respawnQueue.push({ id: `regression:${serial}`, speciesId: 129, level: 5, biome: 'lake', originX: lake.x, originZ: lake.z, remainingSeconds: 0 });
      expect(() => world.step({ deltaSeconds: .1, learning: false })).not.toThrow();
      expect(world.respawnQueue).toHaveLength(0);
    }
    expect(world.dayPeriod).toBe('morning');
    expect(world.entities.filter(entity => entity.kind === 'wild').every(entity => !world.isSafeTown(entity.x, entity.z))).toBe(true);
    const saved = world.snapshot();
    expect(() => new OpenWorldSimulation(graph, game, world.seed, saved)).not.toThrow();
  });
});
