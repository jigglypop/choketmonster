export type PokemonType = 'normal' | 'fire' | 'water' | 'electric' | 'grass' | 'ice' | 'fighting' | 'poison' | 'ground' | 'flying' | 'psychic' | 'bug' | 'rock' | 'ghost' | 'dragon' | 'dark' | 'steel' | 'fairy';
export type BaseStats = { hp: number; attack: number; defense: number; specialAttack: number; specialDefense: number; speed: number };
export type Evolution = { target: number; method: 'level' | 'stone' | 'trade' | 'special'; level?: number; item?: string; requirement?: string };
export type PokemonSpecies = {
  id: number; name: string; englishName: string; types: PokemonType[];
  baseStats: BaseStats; catchRate: number; baseExperience: number; growthRate: string; heightMeters?: number;
  frontSprite: string; backSprite: string; evolutions: Evolution[];
  moves: { level: number; moveId: number }[]; machineMoves: number[]; habitat: string;
};
export type PokemonMove = {
  id: number; name: string; englishName: string; type: PokemonType;
  power: number; accuracy: number; pp: number; damageClass: 'physical' | 'special' | 'status';
  priority: number; ailment?: string; effectChance?: number;
  statChanges?: { stat: string; change: number }[];
  healing?: number; drain?: number; metaCategory?: number; effectId?: number;
  targetId?: number; ailmentChance?: number; statChance?: number;
  minHits?: number; maxHits?: number;
};
