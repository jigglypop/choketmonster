import { getSpecies } from '../data/pokemon';
import { johtoGoldEncounterPools } from '../data/johto-gold-encounters';
import { KANTO_LOCATIONS } from '../openworld/kanto';
import { JOHTO_LOCATIONS } from '../openworld/johto';
import type { Monster } from './engine';

// Equal area weighting across the shipped maps: Kanto uses its authored species
// slots; Johto uses Gold daytime slot weights. This is a game rarity index,
// not a claim about the frequency of real player encounters.
const weights = new Map<number, number>();
let areaCount = 0;
for (const location of KANTO_LOCATIONS) {
  if (!location.encounters.length) continue;
  areaCount++;
  for (const id of location.encounters) weights.set(id, (weights.get(id) ?? 0) + 100 / location.encounters.length);
}
for (const location of JOHTO_LOCATIONS) {
  const area = location.id === 'dark-cave-east' ? 'blackthorn-city-entrance' : location.id === 'dark-cave-west' ? 'violet-city-entrance' : undefined;
  const pools = johtoGoldEncounterPools(location.id, location.kind === 'sea' ? 'surf' : 'walk', 'day', area);
  if (!pools.length) continue;
  areaCount++;
  for (const pool of pools) for (const slot of pool.slots)
    weights.set(slot.speciesId, (weights.get(slot.speciesId) ?? 0) + slot.weight / pools.length);
}
export function duplicateMergeValue(monster: Pick<Monster, 'speciesId' | 'level' | 'xp'>) {
  const frequency = (weights.get(monster.speciesId) ?? 0) / Math.max(1, areaCount);
  const multiplier = Math.min(4, Math.max(1, Math.sqrt(10 / Math.max(.1, frequency))));
  // Retain a fraction of trained XP; repeatedly merging a merged individual
  // cannot multiply all of its accumulated XP again.
  const xp = Math.max(1, Math.floor(monster.xp * .2 + getSpecies(monster.speciesId).baseExperience * monster.level / 7 * 5 * multiplier));
  return { xp, frequency, multiplier };
}
