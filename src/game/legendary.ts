import speciesIds from '../data/legendary-species.json';

const legendarySpecies = new Set<number>(speciesIds);
/** PokeAPI legendary or mythical flags; shared with the ranked server catalog. */
export const isLegendarySpecies = (id: number) => legendarySpecies.has(id);
/** PokeAPI's mythical flag: Mew, Celebi, Jirachi and the others handed out at events rather than met in the story. */
const mythicalSpecies = new Set<number>([151, 251, 385, 386, 489, 490, 491, 492, 493, 494, 647, 648, 649, 719, 720, 721, 801, 802, 807, 808, 809, 893, 1025]);
export const isMythicalSpecies = (id: number) => mythicalSpecies.has(id);
export const legendaryClass = (id: number) => isMythicalSpecies(id) ? ' legendary-pokemon mythical-pokemon' : isLegendarySpecies(id) ? ' legendary-pokemon' : '';
