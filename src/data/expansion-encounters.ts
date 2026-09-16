import {
  EXPANSION_ENCOUNTER_POOLS, EXPANSION_ENCOUNTER_SOURCE,
  type ExpansionEncounterPool, type ExpansionRegion as GeneratedExpansionRegion,
} from './expansion-encounters.generated';
import { LATE_REGION_ENCOUNTER_POOLS, LATE_REGION_ENCOUNTER_SOURCE } from './late-region-encounters';

export { EXPANSION_ENCOUNTER_SOURCE, LATE_REGION_ENCOUNTER_SOURCE };
export type { ExpansionEncounterPool };
export type ExpansionRegion = GeneratedExpansionRegion | 'hisui';

const RUNTIME_LOCATION_ALIASES: Partial<Record<ExpansionRegion, Record<string,string>>> = {
  kalos:Object.fromEntries(Array.from({length:9},(_,index)=>[`kalos-road-${index+1}`,`kalos-route-${[2,3,5,7,8,10,12,14,18][index]}`])),
  alola:Object.fromEntries(Array.from({length:7},(_,index)=>[`alola-road-${index+1}`,`alola-route-${index+1}`])),
  galar:Object.fromEntries(Array.from({length:9},(_,index)=>[`galar-road-${index+1}`,`galar-route-${index+1}`])),
};

export function expansionEncounterPools(
  region: ExpansionRegion,
  locationId: string,
  method?: 'walk' | 'surf',
  period?: 'morning' | 'day' | 'night',
): readonly ExpansionEncounterPool[] {
  const sourceLocationId=RUNTIME_LOCATION_ALIASES[region]?.[locationId]??locationId;
  const generated = region === 'hisui' ? [] : EXPANSION_ENCOUNTER_POOLS[region];
  const supplemental = region === 'hisui' || region === 'paldea' ? LATE_REGION_ENCOUNTER_POOLS[region] : [];
  return [...generated, ...supplemental].filter(pool => pool.locationId === sourceLocationId
    && (!method || pool.method === method) && (!period || pool.period === period));
}

export function expansionEncounterPoolOrigin(pool: ExpansionEncounterPool): 'source' | 'supplemental' {
  return pool.areaId < 0 && pool.areaName === 'authored-supplemental' ? 'supplemental' : 'source';
}

export function expansionSourceSpecies(region: ExpansionRegion, locationId: string, method: 'walk' | 'surf'): readonly number[] {
  return [...new Set(expansionEncounterPools(region, locationId, method).flatMap(pool => pool.slots.map(slot => slot.speciesId)))].sort((a, b) => a - b);
}
