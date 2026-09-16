import speciesIds from '../data/legendary-species.json';

const legendarySpecies = new Set<number>(speciesIds);
/** PokeAPI legendary or mythical flags; shared with the ranked server catalog. */
export const isLegendarySpecies = (id: number) => legendarySpecies.has(id);
export const legendaryClass = (id: number) => isLegendarySpecies(id) ? ' legendary-pokemon' : '';
