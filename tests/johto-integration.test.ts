import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { createGame } from '../src/game/engine';
import { getWorldAtlas } from '../src/openworld/atlas';
import { PLAYABLE_WORLDS } from '../src/openworld/availability';
import { GOLD_ENCOUNTER_LAYOUT, OpenWorldSimulation, regionalEncounters, restoreOpenWorld, serializeOpenWorld } from '../src/openworld/simulation';
import { regionalSourcePools, supplementalEncounterRules } from '../src/data/regional-encounters';
import { regionalWildLevels } from '../src/game/campaign';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;

describe('reconstructed Johto adventure', () => {
  it('changes collection version without changing region, spawns, RNG or any brain', () => {
    const game = createGame(1, 'collection-only'), world = new OpenWorldSimulation(graph, game, 602);
    const before = world.snapshot();
    world.changeVersion('gold');
    expect(world.snapshot()).toEqual(before);
    expect(game.adventureVersion).toBe('gold');
    expect(game.versionCaught?.red).toEqual([1]);
    world.changeRegion('johto');
    const johto = world.snapshot();
    world.changeVersion('silver');
    expect(world.snapshot()).toEqual(johto);
    expect(johto.encounterLayout).toBe(GOLD_ENCOUNTER_LAYOUT);
  });

  it('persists the actual region, town visits, partner brain and fixed local encounters', () => {
    const game = createGame(1, 'johto-persistence'), world = new OpenWorldSimulation(graph, game, 603);
    const partner = world.snapshot().entities.find(entity => entity.kind === 'companion')!;
    world.changeRegion('johto');
    world.setControlMode('manual'); world.setAutoHunt(false);
    const before = world.snapshot(), atlas = getWorldAtlas('johto');
    const wilds = before.entities.filter(entity => entity.kind === 'wild');
    expect(wilds.length).toBeGreaterThan(0);
    expect(wilds.some(entity => atlas.locationAt(entity.x, entity.z).id === 'route-29')).toBe(true);
    for (const entity of wilds) {
      const location = atlas.locationAt(entity.x, entity.z);
      expect(['route-29', 'route-46'], `${entity.id} spawned at ${location.id}`).toContain(location.id);
      expect(entity.level).toBeGreaterThanOrEqual(2);
      expect(entity.level).toBeLessThanOrEqual(5);
    }
    expect(before.entities.find(entity => entity.kind === 'companion')!.brain).toEqual(partner.brain);
    for (const entity of wilds) {
      const location = atlas.locationAt(entity.x, entity.z);
      expect(regionalEncounters(location.id, 0, 'johto')).toContain(entity.speciesId);
      const sample = atlas.sample(entity.x, entity.z);
      const sourceSlots = regionalSourcePools('johto', location.id, world.dayPeriod, sample.biome).flatMap(pool => pool.slots).filter(slot => slot.speciesId === entity.speciesId);
      const balanced=regionalWildLevels(game,'johto',location);
      const supplemental = Number(entity.id.slice(5)) % 20 === 0 && supplementalEncounterRules('johto').some(rule => rule.speciesId === entity.speciesId && rule.locationId === location.id && rule.period === world.dayPeriod && rule.biome === sample.biome && rule.requiredBadges === 0);
      expect((sourceSlots.length>0&&entity.level>=balanced.minLevel&&entity.level<=balanced.maxLevel) || supplemental).toBe(true);
      expect(sample.blocked).toBe(false);
    }
    const restored = restoreOpenWorld(graph, serializeOpenWorld(game, world));
    expect(restored.simulation.snapshot()).toEqual(before);
    expect(before.mapVersion).toBe('johto-v3');
    expect(before.visitedTownsByRegion).toMatchObject({ kanto: ['pallet'], johto: ['new-bark'] });
    expect(game.player.badges).toBe(0);
    expect(world.challengeLocalGym()).toBe(false);
  });

  it('exposes only reconstructed regions and retains the Kanto route 1 layout', () => {
    expect(PLAYABLE_WORLDS.map(world => world.id)).toEqual(['kanto', 'johto']);
    expect(regionalEncounters('route-1', 0, 'kanto')).toEqual(expect.arrayContaining([16, 19]));
    expect(regionalEncounters('route-1', 0, 'kanto')).not.toContain(151);
    expect(regionalEncounters('route-29', 0, 'johto')).not.toContain(250);
    const world = new OpenWorldSimulation(graph, createGame(1, 'unavailable'), 604);
    expect(() => world.changeRegion('hoenn')).toThrow();
  });
});
