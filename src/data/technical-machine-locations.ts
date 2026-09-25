/**
 * Where each technical machine (by move id) is found in the version a region's encounters come from: Red/Blue,
 * Crystal, Emerald, Platinum, Black, X, Ultra Moon, Sword (Technical Records drop from Wild Area raids) and Scarlet.
 * Towns and sites stand for their shops, gyms, gifts and game corners; the machine turns up on the roads nearest to
 * them. Legends: Arceus has no machines, so Hisui has none. Sources: serebii.net TM/HM and TR lists per game.
 */
export const TECHNICAL_MACHINE_LOCATIONS: Readonly<Record<string, Readonly<Record<number, readonly string[]>>>> = {
  kanto: {
    14: ['saffron'], 34: ['vermilion'], 85: ['vermilion'], 87: ['power-plant'], 58: ['celadon'], 59: ['pokemon-mansion'],
    89: ['saffron'], 94: ['saffron'], 157: ['celadon'], 126: ['cinnabar'], 57: ['safari-zone'],
  },
  johto: {
    126: ['goldenrod'], 87: ['goldenrod'], 59: ['goldenrod'], 94: ['goldenrod'], 53: ['goldenrod'], 85: ['goldenrod'], 58: ['goldenrod'],
    247: ['ecruteak'], 188: ['route-43'], 89: ['tohjo-falls'], 57: ['ecruteak'], 127: ['ice-path'],
  },
  hoenn: {
    337: ['meteor-falls'], 347: ['mossdeep-city'], 58: ['mauville-city', 'hoenn-route-108'], 59: ['lilycove-city'], 202: ['hoenn-route-118'],
    85: ['mauville-city'], 87: ['lilycove-city'], 89: ['cave-of-origin'], 94: ['mauville-city', 'hoenn-victory-road'], 247: ['hoenn-route-121'],
    280: ['sootopolis-city'], 188: ['dewford-town'], 126: ['lilycove-city'], 263: ['petalburg-city'], 53: ['mauville-city'],
    57: ['petalburg-city'], 127: ['sootopolis-city'],
  },
  sinnoh: {
    53: ['sinnoh-route-205', 'veilstone-city'], 126: ['lake-verity', 'veilstone-city'], 57: ['celestic-town'], 127: ['sunyshore-city'],
    202: ['sinnoh-route-209'], 85: ['sinnoh-route-205', 'veilstone-city'], 87: ['veilstone-city', 'valor-cavern'], 58: ['sinnoh-route-216', 'veilstone-city'],
    59: ['veilstone-city', 'lake-acuity'], 419: ['snowpoint-city'], 280: ['oreburgh-gate'], 411: ['veilstone-city'], 188: ['veilstone-city'],
    398: ['sinnoh-route-212'], 89: ['sinnoh-route-206'], 444: ['sinnoh-victory-road'], 157: ['mt-coronet'], 247: ['sinnoh-route-210'],
    421: ['hearthome-city'], 337: ['mt-coronet'], 406: ['sinnoh-victory-road'], 399: ['sinnoh-victory-road'], 430: ['canalave-city'],
    94: ['veilstone-city'], 14: ['veilstone-city'],
  },
  unova: {
    53: ['abundant-shrine'], 126: ['icirrus-city'], 488: ['unova-route-16'], 57: ['twist-mountain'], 503: ['cold-storage'], 412: ['unova-route-12'],
    87: ['icirrus-city'], 528: ['unova-victory-road'], 58: ['giant-chasm'], 59: ['icirrus-city'], 280: ['icirrus-city'], 411: ['wellspring-cave'],
    188: ['unova-route-8'], 398: ['unova-route-6'], 89: ['relic-castle'], 94: ['unova-route-13'], 473: ['giant-chasm'], 347: ['relic-castle'],
    404: ['unova-route-7'], 444: ['unova-victory-road'], 157: ['mistralton-cave'], 247: ['relic-castle'], 421: ['celestial-tower'],
    337: ['unova-victory-road'], 430: ['twist-mountain'], 14: ['dreamyard'], 263: ['unova-route-8'], 512: ['mistralton-city'],
  },
  kalos: {
    53: ['anistar-city'], 126: ['anistar-city'], 488: ['lumiose-city'], 57: ['shalour-city'], 503: ['kalos-route-18'], 127: ['kalos-route-19'],
    412: ['snowbelle-city'], 85: ['lumiose-city'], 87: ['anistar-city'], 58: ['snowbelle-city'], 59: ['anistar-city'], 280: ['terminus-cave'],
    411: ['anistar-city'], 188: ['kalos-route-19'], 398: ['shalour-city'], 89: ['santalune-city'], 512: ['coumarine-city'], 94: ['snowbelle-city'],
    473: ['kalos-victory-road'], 347: ['anistar-city'], 404: ['kalos-route-12'], 444: ['frost-cavern'], 157: ['kalos-route-18'],
    247: ['terminus-cave'], 421: ['glittering-cave'], 337: ['kalos-victory-road'], 399: ['dendemille-town'], 605: ['laverre-city'],
    14: ['lumiose-city'], 263: ['dendemille-town'],
  },
  alola: {
    263: ['malie-city'], 14: ['poni-wilds'], 53: ['vast-poni-canyon'], 126: ['seafolk-village'], 488: ['alola-route-8'], 57: ['poni-wilds'],
    503: ['ancient-poni-path'], 127: ['poni-wilds'], 412: ['alola-route-8'], 85: ['poni-wilds'], 87: ['seafolk-village'], 528: ['vast-poni-canyon'],
    58: ['mount-lanakila'], 59: ['seafolk-village'], 280: ['verdant-cavern'], 411: ['seafolk-village'], 188: ['alola-route-17'],
    398: ['mount-lanakila'], 89: ['poni-wilds'], 512: ['alola-route-15'], 473: ['altar-of-the-moone'], 347: ['seafolk-village'],
    404: ['alola-route-17'], 444: ['seafolk-village'], 157: ['alola-route-17'], 247: ['alola-route-14'], 421: ['malie-city'],
    337: ['vast-poni-canyon'], 399: ['poni-wilds'], 430: ['seafolk-village'], 605: ['vast-poni-canyon'],
  },
  galar: {
    280: ['galar-route-8'], 157: ['galar-route-9'], 403: ['bridge-field'], 421: ['bridge-field'], 419: ['galar-route-9'], 512: ['ballonlea'],
    // Technical Records: Max Raid drops across the Wild Area.
    ...Object.fromEntries([34, 14, 53, 126, 57, 56, 503, 412, 402, 85, 87, 528, 58, 59, 370, 411, 396, 188, 398, 89, 414, 413, 94, 473, 428,
      347, 404, 405, 444, 408, 247, 337, 406, 399, 242, 430, 442, 605, 583, 127]
      .map(move => [move, ['dappled-grove', 'east-lake-axewell', 'south-lake-miloch', 'bridge-field']])),
  },
  hisui: {},
  paldea: {
    34: ['west-province-area-one'], 263: ['medali'], 14: ['casseroya-lake', 'west-province-area-one'], 53: ['levincia'], 126: ['west-province-area-one'],
    488: ['area-zero', 'west-province-area-one'], 57: ['levincia'], 56: ['cascarrafa'], 503: ['cascarrafa'], 127: ['casseroya-lake'],
    412: ['west-province-area-one'], 202: ['area-zero', 'casseroya-lake', 'east-province-area-one'], 402: ['east-province-area-one'], 85: ['levincia'],
    87: ['mesagoza'], 528: ['levincia', 'south-province-area-two'], 58: ['glaseado-mountain'], 59: ['glaseado-mountain'], 419: ['tagtree-thicket'],
    370: ['glaseado-mountain'], 280: ['west-province-area-one', 'casseroya-lake'], 411: ['alfornada'], 396: ['glaseado-mountain'], 188: ['cascarrafa'],
    398: ['glaseado-mountain'], 89: ['south-province-area-six'], 414: ['glaseado-mountain'], 413: ['east-province-area-two'],
    403: ['east-province-area-one', 'south-province-area-one'], 512: ['casseroya-lake', 'west-province-area-one'], 94: ['alfornada'],
    473: ['cascarrafa', 'casseroya-lake', 'glaseado-mountain'], 428: ['west-province-area-two'], 404: ['glaseado-mountain', 'east-province-area-one', 'south-province-area-six'],
    405: ['east-province-area-one'], 444: ['casseroya-lake'], 157: ['east-province-area-two'], 408: ['area-zero', 'glaseado-mountain'],
    247: ['area-zero', 'montenevera'], 421: ['west-province-area-one'], 337: ['area-zero', 'casseroya-lake', 'east-province-area-one'],
    406: ['glaseado-mountain'], 399: ['glaseado-mountain'], 242: ['east-province-area-two'], 430: ['area-zero', 'east-province-area-two'],
    442: ['casseroya-lake', 'levincia', 'west-province-area-one'], 605: ['area-zero'], 583: ['glaseado-mountain'],
  },
};
