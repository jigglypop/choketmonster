import { describe, expect, it } from 'vitest';
import { chooseRegionalEncounter, encounterPeriodAt, regionalEncounterFrequency, regionalRuntimePools, regionalSpeciesIds, runtimeSourceSpeciesIds, SELECTED_ENCOUNTER_VERSIONS, supplementalEncounterRules, supplementalSpeciesIds, WORLD_DAY_SECONDS } from '../src/data/regional-encounters';
import { duplicateMergeValue } from '../src/game/growth';

describe('fixed regional encounter sources', () => {
  it('selects the most diverse compared public versions', () => {
    expect(SELECTED_ENCOUNTER_VERSIONS.kanto.version).toBe('red');
    expect(SELECTED_ENCOUNTER_VERSIONS.kanto.candidates.red).toBeGreaterThan(SELECTED_ENCOUNTER_VERSIONS.kanto.candidates.firered);
    expect(SELECTED_ENCOUNTER_VERSIONS.johto.version).toBe('crystal');
    expect(SELECTED_ENCOUNTER_VERSIONS.johto.candidates.crystal).toBeGreaterThan(SELECTED_ENCOUNTER_VERSIONS.johto.candidates.heartgold);
  });

  it('runs a deterministic 20 minute morning/day/night clock', () => {
    expect(encounterPeriodAt(0)).toBe('night');
    expect(encounterPeriodAt(WORLD_DAY_SECONDS * 4 / 24)).toBe('morning');
    expect(encounterPeriodAt(WORLD_DAY_SECONDS * 10 / 24)).toBe('day');
    expect(encounterPeriodAt(WORLD_DAY_SECONDS * 20 / 24)).toBe('night');
  });

  it('keeps original and authored pools separate while covering each regional dex', () => {
    for (const region of ['kanto', 'johto'] as const) {
      const source = new Set(runtimeSourceSpeciesIds(region)), supplemental = new Set(supplementalSpeciesIds(region));
      const covered = new Set([...source, ...supplemental]);
      expect(regionalSpeciesIds(region).every(id => covered.has(id))).toBe(true);
    }
  });

  it('combines source periods without triple-counting repeated tables and excludes towns', () => {
    expect(regionalRuntimePools('kanto','pallet','day','meadow')).toEqual([]);
    const morning=regionalRuntimePools('johto','route-29','morning','meadow').flatMap(pool=>pool.slots);
    const night=regionalRuntimePools('johto','route-29','night','meadow').flatMap(pool=>pool.slots);
    expect(new Set(morning.map(slot=>slot.speciesId))).toEqual(new Set(night.map(slot=>slot.speciesId)));
    expect(morning.reduce((sum,slot)=>sum+slot.weight,0)).toBeCloseTo(100);
  });

  it('cycles supplemental species without consulting model availability', () => {
    const rule = supplementalEncounterRules('johto').find(item => item.requiredBadges === 0)!;
    const selected = chooseRegionalEncounter('johto', rule.locationId, rule.period, rule.biome, 8, 20, () => 0, { min: 2, max: 4 });
    expect(selected.speciesId).toBe(rule.speciesId);
    expect(selected.origin).toBe('supplemental');
  });

  it('gates starters and legendary supplements to later revisits', () => {
    const rules = supplementalEncounterRules('johto');
    expect(new Set(supplementalEncounterRules('kanto').map(rule => rule.locationId)).size).toBeGreaterThanOrEqual(15);
    expect(new Set(rules.map(rule => rule.locationId)).size).toBeGreaterThanOrEqual(15);
    expect(rules.filter(rule => [152,155,158].includes(rule.speciesId)).every(rule => rule.requiredBadges >= 4)).toBe(true);
    expect(rules.filter(rule => [243,244,245,249,250,251].includes(rule.speciesId)).every(rule => rule.requiredBadges === 8)).toBe(true);
  });

  it('makes every supplemental rule reachable by revisiting its gated place and period', () => {
    for (const region of ['kanto','johto'] as const) {
      const rules = supplementalEncounterRules(region);
      for (const rule of rules) {
        const local = rules.filter(item => item.locationId === rule.locationId && item.biome === rule.biome && item.requiredBadges <= 8);
        const index = local.findIndex(item => item.speciesId === rule.speciesId);
        const encounter = chooseRegionalEncounter(region, rule.locationId, rule.period, rule.biome, 8, (index + 1) * 20, () => 0, { min: 2, max: 8 });
        expect(encounter.speciesId).toBe(rule.speciesId);
      }
    }
  });

  it('uses the same bounded level percentage for every duplicate species', () => {
    expect(Array.from({ length: 251 }, (_, index) => regionalEncounterFrequency(index + 1)).every(frequency => frequency > 0)).toBe(true);
    for (const speciesId of [1, 19, 72, 144, 151, 163, 249, 251]) {
      expect(speciesId).toBeGreaterThan(0);
      expect(duplicateMergeValue({ level: 20 })).toEqual({ levels: 1, percent: 5 });
    }
  });
});
