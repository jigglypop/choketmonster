import { describe, expect, it } from 'vitest';
import { DUNGEON_PLANS } from '../src/openworld/dungeons';
import { POKEMON } from '../src/data/pokemon';
import {
  chooseRegionalEncounter, regionalBaseBand, regionalRuntimePools, regionalSpeciesIds, REGIONAL_WORLD_LOCATION_IDS, runtimeSourceSpeciesIds,
  supplementalEncounterRules, supplementalRuleLevels,
} from '../src/data/regional-encounters';
import { chooseExpansionEncounter, expansionRuntimePools, expansionSourceSpeciesIds, expansionSupplementalRules } from '../src/data/expansion-spawns';
import { expansionEncounterPools, type ExpansionRegion } from '../src/data/expansion-encounters';
import { isLegendaryOrMythical, rareSpawnLevels, WILD_FLOOR_TOLERANCE, wildLevelFloor, wildSpeciesForBand } from '../src/data/wild-levels';
import { CAMPAIGN_TRAINERS } from '../src/game/campaign';
import { GYM_TEAMS } from '../src/game/gym-teams';
import { getWorldAtlas } from '../src/openworld/atlas';
import { CAVE_SCENES } from '../src/openworld/caves';

const EXPANSIONS = ['hoenn', 'sinnoh', 'unova', 'kalos', 'alola', 'galar', 'hisui', 'paldea'] as const;
const NATIVE: Record<ExpansionRegion, readonly [number, number]> = { hoenn: [252, 386], sinnoh: [387, 493], unova: [494, 649], kalos: [650, 721], alola: [722, 809], galar: [810, 898], hisui: [899, 905], paldea: [906, 1025] };
const STARTER_LINES = [1, 4, 7, 152, 155, 158, 252, 255, 258, 387, 390, 393, 495, 498, 501, 650, 653, 656, 722, 725, 728, 810, 813, 816, 906, 909, 912];
const stagesOf = (base: number) => { const middle = POKEMON[base - 1].evolutions.map(evolution => evolution.target); return { base, middle, final: middle.flatMap(id => POKEMON[id - 1].evolutions.map(evolution => evolution.target)) }; };
const bandOf = (region: string, locationId: string) => {
  const location = getWorldAtlas(region).locations.find(item => item.id === locationId)!;
  return region === 'kanto' || region === 'johto' ? regionalBaseBand(region, locationId) : { minLevel: location.minLevel, maxLevel: location.maxLevel };
};
const rulesOf = (region: string) => region === 'kanto' || region === 'johto' ? supplementalEncounterRules(region) : expansionSupplementalRules(region as ExpansionRegion);

describe('natural wild level floors', () => {
  it('derives floors from evolution biology', () => {
    expect([wildLevelFloor(1), wildLevelFloor(2), wildLevelFloor(3), wildLevelFloor(5), wildLevelFloor(6)]).toEqual([1, 16, 32, 16, 36]);
    expect(wildLevelFloor(149)).toBe(55); expect(wildLevelFloor(248)).toBe(55);
    // Item, trade and friendship evolutions: ten levels past the previous stage, at least Lv.20.
    expect([wildLevelFloor(26), wildLevelFloor(76), wildLevelFloor(169)]).toEqual([20, 35, 32]);
    // A baby added after its evolution is not a stage (Pichu, Happiny); Togepi is.
    expect([wildLevelFloor(25), wildLevelFloor(113), wildLevelFloor(176)]).toEqual([1, 1, 20]);
    expect(wildSpeciesForBand(80, 15)).toBe(79);
    expect(wildSpeciesForBand(14, 6)).toBe(14);
  });
});

describe('source tables never spawn below the evolution floor', () => {
  it('Kanto and Johto: every runtime slot, on the surface and on every dungeon floor', () => {
    for (const region of ['kanto', 'johto'] as const) for (const locationId of REGIONAL_WORLD_LOCATION_IDS[region]) {
      const band = regionalBaseBand(region, locationId);
      const contexts = [{ biome: 'rock', shift: 0, areas: undefined as readonly string[] | undefined }, { biome: 'lake', shift: 0, areas: undefined },
        ...CAVE_SCENES.filter(scene => scene.regionId === region && scene.encounterLocationId === locationId && scene.wild).map(scene => ({ biome: 'rock', shift: scene.levelShift, areas: scene.encounterAreas }))];
      for (const { biome, shift, areas } of contexts) {
        const slots = regionalRuntimePools(region, locationId, 'day', biome, areas).flatMap(pool => pool.slots);
        for (const slot of slots) expect(wildLevelFloor(slot.speciesId), `${region}:${locationId}:${slot.speciesId}`).toBeLessThanOrEqual(band.maxLevel + WILD_FLOOR_TOLERANCE);
        const total = slots.reduce((sum, slot) => sum + slot.weight, 0);
        let before = 0;
        for (const slot of slots) {
          const roll = (before + slot.weight / 2) / total; before += slot.weight;
          const encounter = chooseRegionalEncounter(region, locationId, 'day', biome, 8, 1, () => roll, { min: band.minLevel + shift, max: band.maxLevel + shift }, areas ? { areas, supplemental: false } : undefined);
          expect(encounter.speciesId).toBe(slot.speciesId);
          expect(encounter.minLevel, `${region}:${locationId}:${slot.speciesId}`).toBeGreaterThanOrEqual(wildLevelFloor(encounter.speciesId));
          expect(encounter.maxLevel).toBeGreaterThanOrEqual(encounter.minLevel);
        }
      }
    }
  });

  it('keeps an early place in its band: Slowbro in Slowpoke Well spawns as Slowpoke, Kakuna stays at Lv.7', () => {
    const well = regionalRuntimePools('johto', 'slowpoke-well', 'day', 'lake').flatMap(pool => pool.slots.map(slot => slot.speciesId));
    expect(well).toContain(79); expect(well).not.toContain(80);
    const forest = regionalRuntimePools('kanto', 'viridian-forest', 'day', 'forest').flatMap(pool => pool.slots);
    expect(forest.find(slot => slot.speciesId === 14)).toMatchObject({ minLevel: 7, maxLevel: 7 });
    // The Violet side of Dark Cave no longer leaks the Blackthorn side's Graveler and Ursaring at Lv.2-4.
    expect(regionalRuntimePools('johto', 'dark-cave-west', 'day', 'rock').flatMap(pool => pool.slots.map(slot => slot.speciesId)).sort((a, b) => a - b)).toEqual([41, 74, 206, 216]);
    expect(regionalBaseBand('johto', 'mt-silver')).toEqual({ minLevel: 40, maxLevel: 50 });
  });

  it('expansions: each slot keeps its own table range, raised to the floor', () => {
    for (const region of EXPANSIONS) for (const location of getWorldAtlas(region).locations) for (const method of ['walk', 'surf'] as const) {
      for (const slot of expansionRuntimePools(region, location.id, method, 'day').flatMap(pool => pool.slots)) {
        expect(slot.minLevel, `${region}:${location.id}:${slot.speciesId}`).toBeGreaterThanOrEqual(wildLevelFloor(slot.speciesId));
      }
    }
    // Slumbering Weald's Lv.45 depths stay closed while its Lv.2 edge is open, and open with three badges (cap 50).
    const levelsAt = (badges: number) => Array.from({ length: 40 }, (_, index) => chooseExpansionEncounter('galar', 'slumbering-weald', 'day', 'forest', badges, 1, () => (index + .5) / 40, { min: 2, max: 47 }));
    expect(levelsAt(0).every(encounter => encounter.maxLevel <= 20)).toBe(true);
    expect(levelsAt(3).some(encounter => encounter.minLevel >= 45)).toBe(true);
  });
});

describe('rare supplemental spawns follow biology, not Pokédex order', () => {
  const regions = ['kanto', 'johto', ...EXPANSIONS] as const;

  it('only covers species the original tables never spawn, and every dex species stays obtainable', () => {
    for (const region of ['kanto', 'johto'] as const) {
      const source = new Set(runtimeSourceSpeciesIds(region)), rules = supplementalEncounterRules(region), rare = new Set(rules.map(rule => rule.speciesId));
      expect(rules.every(rule => !source.has(rule.speciesId))).toBe(true);
      // Legendary and mythical species wait in lairs instead of rare slots.
      const lairs = new Set(DUNGEON_PLANS.flatMap(plan => plan.legendary ?? []));
      expect(regionalSpeciesIds(region).filter(id => !source.has(id) && !rare.has(id) && !lairs.has(id))).toEqual([]);
      expect(rules.length).toBeLessThan(regionalSpeciesIds(region).length);
    }
    for (const region of EXPANSIONS) {
      const source = new Set(expansionSourceSpeciesIds(region)), rare = new Set(expansionSupplementalRules(region).map(rule => rule.speciesId));
      const [first, last] = NATIVE[region];
      const lairs = new Set(DUNGEON_PLANS.flatMap(plan => plan.legendary ?? []));
      for (let id = first; id <= last; id++) expect(source.has(id) || rare.has(id) || lairs.has(id), `${region}:${id}`).toBe(true);
      expect([...rare].every(id => !source.has(id))).toBe(true);
    }
  });

  it('never spawns a rare below its evolution floor and keeps starter lines, pseudo-legendaries and legendaries late', () => {
    for (const region of regions) for (const rule of rulesOf(region)) {
      const band = bandOf(region, rule.locationId), bounds = { min: band.minLevel, max: band.maxLevel };
      const levels = region === 'kanto' || region === 'johto' ? supplementalRuleLevels(rule, bounds) : rareSpawnLevels(rule.minLevel, bounds);
      expect(levels.minLevel, `${region}:${rule.speciesId}`).toBeGreaterThanOrEqual(wildLevelFloor(rule.speciesId));
      if (isLegendaryOrMythical(rule.speciesId)) { expect(rule.requiredBadges, `${region}:${rule.speciesId}`).toBe(8); expect(levels.minLevel).toBeGreaterThanOrEqual(50); }
      if ([149, 248, 373, 376, 445, 635, 706, 784, 887, 998].includes(rule.speciesId)) expect(rule.requiredBadges, `${region}:${rule.speciesId}`).toBe(8);
    }
    for (const base of STARTER_LINES) {
      const { middle, final } = stagesOf(base);
      for (const region of regions) for (const rule of rulesOf(region)) {
        if (rule.speciesId === base) expect(rule.requiredBadges, `${region}:${base}`).toBeGreaterThanOrEqual(4);
        if (middle.includes(rule.speciesId)) expect(rule.requiredBadges, `${region}:${rule.speciesId}`).toBeGreaterThanOrEqual(5);
        if (final.includes(rule.speciesId)) expect(rule.requiredBadges, `${region}:${rule.speciesId}`).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('never meets an evolved starter on the first routes (Charizard on Route 1 regression)', () => {
    const evolvedStarters = new Set(STARTER_LINES.flatMap(base => { const { middle, final } = stagesOf(base); return [...middle, ...final]; }));
    for (const [region, locationId, biome] of [['kanto', 'route-1', 'meadow'], ['kanto', 'viridian-forest', 'forest'], ['johto', 'route-29', 'meadow']] as const) {
      const band = regionalBaseBand(region, locationId);
      for (let serial = 1; serial <= 2000; serial++) for (const badges of [0, 1, 2, 3]) {
        const encounter = chooseRegionalEncounter(region, locationId, 'day', biome, badges, serial, () => (serial % 97) / 97, { min: band.minLevel, max: band.maxLevel });
        expect(evolvedStarters.has(encounter.speciesId), `${region}:${locationId}:${serial}`).toBe(false);
        expect(encounter.minLevel).toBeGreaterThanOrEqual(wildLevelFloor(encounter.speciesId));
      }
    }
  });

  it('keeps the Kanto and Johto legendaries in their lairs, never in rare slots', () => {
    const lair = (region: 'kanto' | 'johto', speciesId: number) => DUNGEON_PLANS.find(plan => plan.regionId === region && plan.legendary?.includes(speciesId))?.id;
    expect([144, 145, 146, 150, 151].map(id => lair('kanto', id))).toEqual(['seafoam-islands', 'power-plant', 'victory-road', 'cerulean-cave', 'cerulean-cave']);
    expect([243, 244, 245, 249, 250, 251].map(id => lair('johto', id))).toEqual(['burned-tower', 'burned-tower', 'burned-tower', 'whirl-islands', 'bell-tower', 'ilex-shrine']);
    for (const region of ['kanto', 'johto'] as const) expect(supplementalEncounterRules(region).filter(rule => [144, 145, 146, 150, 151, 243, 244, 245, 249, 250, 251].includes(rule.speciesId))).toEqual([]);
  });
});

describe('the 3D world can host the tables counted as source', () => {
  it('has water on every sea place with a surf table and land on every other place with a walk table', () => {
    for (const region of ['kanto', 'johto', ...EXPANSIONS] as const) {
      const atlas = getWorldAtlas(region);
      for (const location of atlas.locations.filter(item => item.kind !== 'town')) {
        const sea = location.kind === 'sea';
        const counted = region === 'kanto' || region === 'johto'
          ? (REGIONAL_WORLD_LOCATION_IDS[region] as readonly string[]).includes(location.id) && regionalRuntimePools(region, location.id, 'day', sea ? 'lake' : 'rock').length > 0
          : expansionEncounterPools(region, location.id, sea ? 'surf' : 'walk').length > 0;
        if (!counted) continue;
        let found = false;
        for (let radius = 0; radius <= 45 && !found; radius += 1) for (let step = 0; step < 48 && !found; step++) {
          const x = location.x + Math.cos(step / 48 * Math.PI * 2) * radius, z = location.z + Math.sin(step / 48 * Math.PI * 2) * radius, sample = atlas.sample(x, z);
          found = !sample.blocked && atlas.locationAt(x, z).id === location.id && (sample.biome === 'lake') === sea;
        }
        expect(found, `${region}:${location.id}`).toBe(true);
      }
    }
  });
});

describe('league levels follow the gym curve where the region can be the first one', () => {
  it('Kanto uses its Red/Blue League levels after the Lv.50 eighth gym', () => {
    const kanto = CAMPAIGN_TRAINERS.filter(trainer => trainer.region === 'kanto');
    const ace = Math.max(...GYM_TEAMS.kanto[8].map(([, level]) => level));
    expect(Math.min(...kanto.flatMap(trainer => trainer.team.map(([, level]) => level)))).toBeLessThanOrEqual(ace + 5);
    expect(Math.max(...kanto.flatMap(trainer => trainer.team.map(([, level]) => level)))).toBe(65);
  });
});
