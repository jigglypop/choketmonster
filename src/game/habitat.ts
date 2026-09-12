import type { PokemonSpecies } from './contracts';

/** Gameplay placement only; never overwrites missing habitat in the original data. */
export function gameplayHabitat(species: PokemonSpecies): string {
  if (species.habitat !== 'unknown') return species.habitat;
  if (species.types.includes('water')) return 'waters-edge';
  if (species.types.some(type => type === 'grass' || type === 'bug')) return 'forest';
  if (species.types.some(type => ['rock', 'ground', 'steel', 'ice'].includes(type))) return 'mountain';
  return 'grassland';
}
