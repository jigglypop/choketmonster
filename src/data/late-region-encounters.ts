/**
 * Authored runtime encounter anchors for games whose detailed encounter tables
 * are absent from the pinned PokeAPI dataset. These are supplemental game
 * balance data, not extracted cartridge encounter tables.
 */
export const LATE_REGION_ENCOUNTER_SOURCE = {
  origin: 'supplemental',
  reconstruction: true,
  pokeApiRevision: '8fe210b21c9abbe73de93670f3d5a346c80a3625',
  reason: 'The pinned PokeAPI revision contains no Scarlet/Violet encounter rows and no Legends: Arceus version encounter table.',
  geographySources: {
    hisui: 'https://legends.arceus.pokemon.com/en-us/story/',
    paldea: 'https://www.nintendo.com/us/store/products/pokemon-scarlet-114549/',
  },
} as const;

export type LateRegion = 'hisui' | 'paldea';
export type AuthoredEncounterPool = {
  locationId: string; areaId: number; areaName: string; method: 'walk' | 'surf'; period: 'morning' | 'day' | 'night';
  slots: Array<{ speciesId: number; sourcePokemonId: number; minLevel: number; maxLevel: number; weight: number }>;
};

type Anchor = readonly [locationId: string, method: 'walk' | 'surf', minLevel: number, maxLevel: number, species: readonly number[]];
const weights = [35, 25, 20, 12, 8] as const;
function pools(anchors: readonly Anchor[]): AuthoredEncounterPool[] {
  return anchors.flatMap(([locationId, method, minLevel, maxLevel, species], areaId) =>
    (['morning', 'day', 'night'] as const).map(period => ({
      locationId, areaId: -(areaId + 1), areaName: 'authored-supplemental', method, period,
      slots: species.map((speciesId, index) => ({ speciesId, sourcePokemonId: speciesId, minLevel, maxLevel, weight: weights[index] ?? 5 })),
    })),
  );
}

export const LATE_REGION_ENCOUNTER_POOLS: Readonly<Record<LateRegion, readonly AuthoredEncounterPool[]>> = {
  hisui: pools([
    ['aspiration-hill', 'walk', 3, 8, [399, 396, 403, 265, 401]],
    ['deertrack-path', 'walk', 7, 14, [400, 418, 425, 434, 449]],
    ['grandtree-arena', 'walk', 12, 20, [123, 900, 406, 427, 415]],
    ['crimson-mirelands', 'walk', 18, 28, [455, 453, 114, 193, 704]],
    ['brava-arena', 'walk', 24, 32, [548, 549, 111, 315, 46]],
    ['cobalt-coastlands', 'surf', 28, 38, [550, 418, 422, 223, 226]],
    ['molten-arena', 'walk', 32, 42, [58, 59, 77, 126, 900]],
    ['coronet-highlands', 'walk', 38, 50, [627, 704, 712, 459, 443]],
    ['moonview-arena', 'walk', 43, 54, [100, 101, 479, 462, 466]],
    ['alabaster-icelands', 'walk', 48, 60, [712, 713, 459, 460, 215]],
    ['icepeak-arena', 'walk', 52, 64, [713, 461, 478, 221, 899]],
    ['temple-of-sinnoh', 'walk', 58, 70, [901, 902, 903, 904, 905]],
  ]),
  paldea: pools([
    ['south-province-area-one', 'walk', 3, 9, [915, 921, 919, 917, 928]],
    ['south-province-area-two', 'walk', 8, 16, [926, 932, 935, 953, 955]],
    ['west-province-area-one', 'walk', 14, 24, [924, 931, 944, 946, 950]],
    ['east-province-area-one', 'walk', 16, 26, [938, 940, 942, 948, 951]],
    ['east-province-area-two', 'surf', 20, 32, [963, 960, 961, 339, 129]],
    ['west-province-area-two', 'walk', 25, 38, [965, 967, 969, 971, 973]],
    ['tagtree-thicket', 'walk', 28, 42, [944, 945, 946, 947, 948]],
    ['glaseado-mountain', 'walk', 38, 52, [974, 975, 712, 613, 215]],
    ['casseroya-lake', 'surf', 40, 55, [976, 977, 978, 979, 980]],
    ['south-province-area-six', 'walk', 42, 56, [967, 968, 969, 970, 971]],
    ['area-zero', 'walk', 55, 70, [984, 985, 986, 987, 988]],
    ['paldea-pokemon-league', 'walk', 58, 72, [1005, 1006, 1007, 1008, 1009]],
  ]),
};

