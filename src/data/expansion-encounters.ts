import {
  EXPANSION_ENCOUNTER_POOLS, EXPANSION_ENCOUNTER_SOURCE,
  type ExpansionEncounterPool, type ExpansionRegion,
} from './expansion-encounters.generated';

export { EXPANSION_ENCOUNTER_SOURCE };
export type { ExpansionEncounterPool, ExpansionRegion };

export function expansionEncounterPools(
  region: ExpansionRegion,
  locationId: string,
  method?: 'walk' | 'surf',
  period?: 'morning' | 'day' | 'night',
): readonly ExpansionEncounterPool[] {
  return EXPANSION_ENCOUNTER_POOLS[region].filter(pool => pool.locationId === locationId
    && (!method || pool.method === method) && (!period || pool.period === period));
}

export function expansionSourceSpecies(region: ExpansionRegion, locationId: string, method: 'walk' | 'surf'): readonly number[] {
  return [...new Set(expansionEncounterPools(region, locationId, method).flatMap(pool => pool.slots.map(slot => slot.speciesId)))].sort((a, b) => a - b);
}
