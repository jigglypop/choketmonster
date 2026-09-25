import { POKEDEXES } from '../data/pokemon-versions';

/**
 * The game's regions in Pokédex order, each with the regional Pokédex of the version its
 * encounters come from (Red, Crystal, Emerald, Platinum, Black, X, Ultra Moon, Sword,
 * Legends: Arceus, Scarlet). Kalos splits its Pokédex into three books.
 */
export const DEX_REGIONS = [
  { id: 'kanto', name: '관동', pokedexes: ['kanto'] },
  { id: 'johto', name: '성도', pokedexes: ['original-johto'] },
  { id: 'hoenn', name: '호연', pokedexes: ['hoenn'] },
  { id: 'sinnoh', name: '신오', pokedexes: ['extended-sinnoh'] },
  { id: 'unova', name: '하나', pokedexes: ['original-unova'] },
  { id: 'kalos', name: '칼로스', pokedexes: ['kalos-central', 'kalos-coastal', 'kalos-mountain'] },
  { id: 'alola', name: '알로라', pokedexes: ['updated-alola'] },
  { id: 'galar', name: '가라르', pokedexes: ['galar'] },
  { id: 'hisui', name: '히스이', pokedexes: ['hisui'] },
  { id: 'paldea', name: '팔데아', pokedexes: ['paldea'] },
] as const;
export type DexRegionId = typeof DEX_REGIONS[number]['id'];

const cache = new Map<DexRegionId, readonly number[]>();
/** Species of a region's Pokédex in its own order; a species listed in two Kalos books appears once. */
export function regionalDexSpeciesIds(region: DexRegionId): readonly number[] {
  const cached = cache.get(region); if (cached) return cached;
  const books = DEX_REGIONS.find(item => item.id === region)!.pokedexes;
  const ids: number[] = [], seen = new Set<number>();
  for (const book of books) {
    const dex = POKEDEXES.find(item => item.id === book);
    if (!dex) throw new Error(`Missing regional Pokédex: ${book}`);
    for (const entry of [...dex.entries].sort((a, b) => a.number - b.number)) {
      if (!seen.has(entry.speciesId)) { seen.add(entry.speciesId); ids.push(entry.speciesId); }
    }
  }
  const result = Object.freeze(ids);
  cache.set(region, result); return result;
}
