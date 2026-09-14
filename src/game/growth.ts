import { getSpecies } from '../data/pokemon';
import { regionalEncounterFrequency } from '../data/regional-encounters';
import type { Monster } from './engine';

export function duplicateMergeValue(monster: Pick<Monster, 'speciesId' | 'level' | 'xp'>) {
  const frequency = regionalEncounterFrequency(monster.speciesId);
  const multiplier = Math.min(4, Math.max(1, Math.sqrt(10 / Math.max(.1, frequency))));
  // Retain a fraction of trained XP; repeatedly merging a merged individual
  // cannot multiply all of its accumulated XP again.
  const xp = Math.max(1, Math.floor(monster.xp * .2 + getSpecies(monster.speciesId).baseExperience * monster.level / 7 * 5 * multiplier));
  return { xp, frequency, multiplier };
}
