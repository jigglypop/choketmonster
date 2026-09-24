/**
 * Multi-floor dungeon plans. Every floor is its own `cave:<region>:<id>` scene.
 * The floor a dungeon's first entrance opens onto keeps the dungeon id, so saves
 * made inside the older single-chamber caves still resolve to a real floor.
 * Pure data: rendering, simulation and the save validator share it.
 */
export type DungeonKind = 'cave' | 'tower' | 'building' | 'plant' | 'ruins';
export type DungeonStyle = 'rock' | 'ghost' | 'pagoda' | 'bell' | 'charred' | 'lighthouse' | 'mansion' | 'industrial' | 'ruins' | 'stone' | 'sand' | 'warehouse';
export type DungeonSilhouette = 'rounded' | 'oval' | 'long' | 'hall' | 'bend';
export type DungeonFloorPlan = {
  /** Scene id suffix for every floor except the entry floor. */
  key: string;
  label: string;
  /** Height order used for stair direction: 1F = 0, 2F = 1, B1F = -1. */
  level: number;
  /** Source encounter area names. Omitted: the location's whole table. */
  areas?: readonly string[];
  /** Encounter location for this floor when it differs from the dungeon's (Dark Cave's two entrances). */
  locationId?: string;
};
export type DungeonPlan = {
  regionId: string; id: string; name: string;
  /** Stable ASCII text for labels even when localized fonts are unavailable. */
  label: string;
  kind: DungeonKind; style: DungeonStyle; seed: number;
  /** Floor footprint in 2 m tiles. */
  width: number; depth: number;
  silhouette?: DungeonSilhouette;
  /** Surface entrances. With two, the first opens onto the first floor and the second onto the last. */
  surfaceLocations: readonly string[];
  /** Floor each surface entrance opens onto, when a through passage stays on one floor (Mt. Coronet 1F). */
  surfaceFloors?: readonly number[];
  /** Floors in walking order; stairs join neighbours. */
  floors: readonly DungeonFloorPlan[];
  /** Floor the single surface entrance opens onto. */
  entry?: number;
  /** Floor hosting the location's rare supplemental and legendary spawns; defaults to the last floor with wild Pokémon. */
  anchor?: number;
  /** The entry floor keeps the historical single-chamber footprint. */
  legacy?: boolean;
};

const KEY_LEVEL = /^(b)?(\d+)f/;
const ASCII_ROOFS: Record<string, string> = { roof: 'Roof', top: 'Top' };
/** Floor from a key such as `1f`, `b2f` or `roof`; `label` and `level` override the defaults. */
function floor(key: string, areas?: readonly string[], extra: Partial<DungeonFloorPlan> = {}): DungeonFloorPlan {
  const match = KEY_LEVEL.exec(key), number = match ? Number(match[2]) : 0;
  const level = extra.level ?? (match ? (match[1] ? -number : number - 1) : 99);
  const label = extra.label ?? (match ? (match[1] ? `지하 ${number}층` : `${number}층`) : key === 'roof' ? '옥상' : key === 'top' ? '정상' : key);
  return { key, label, level, ...(areas ? { areas } : {}), ...(extra.locationId ? { locationId: extra.locationId } : {}) };
}
/** Floors whose encounter area names match their keys. */
const floors = (...keys: string[]) => keys.map(key => floor(key, [key]));
/** Upper floors of a tower; `wild` lists keys that have encounter tables. */
const tower = (count: number, wild: readonly string[]) => Array.from({ length: count }, (_, index) => {
  const key = `${index + 1}f`; return floor(key, wild.includes(key) ? [key] : []);
});

type Base = Omit<DungeonPlan, 'kind' | 'style' | 'floors'>;
const cave = (base: Base, floorPlans: readonly DungeonFloorPlan[], style: DungeonStyle = 'rock'): DungeonPlan => ({ ...base, kind: 'cave', style, floors: floorPlans });
const room = (kind: Exclude<DungeonKind, 'cave'>, style: DungeonStyle, base: Base, floorPlans: readonly DungeonFloorPlan[]): DungeonPlan => ({ ...base, kind, style, floors: floorPlans });

export const DUNGEON_PLANS: readonly DungeonPlan[] = [
  // Kanto. FireRed floors; the PokeAPI calls Rock Tunnel's 1F/B1F "b1f"/"b2f".
  cave({ regionId: 'kanto', id: 'mt-moon', name: '달맞이산 동굴', label: 'Mt. Moon', seed: 11, width: 23, depth: 17, silhouette: 'rounded', surfaceLocations: ['route-3', 'route-4'], legacy: true }, floors('1f', 'b1f', 'b2f')),
  cave({ regionId: 'kanto', id: 'diglett-cave', name: '디그다의 굴', label: "Diglett's Cave", seed: 23, width: 29, depth: 11, silhouette: 'long', surfaceLocations: ['diglett-cave-east', 'diglett-cave-west'], legacy: true }, [floor('1f')]),
  cave({ regionId: 'kanto', id: 'rock-tunnel', name: '돌산터널', label: 'Rock Tunnel', seed: 37, width: 21, depth: 21, silhouette: 'bend', surfaceLocations: ['route-10-south', 'route-10-north'], legacy: true }, [floor('1f', ['b1f']), floor('b1f', ['b2f'])]),
  cave({ regionId: 'kanto', id: 'seafoam-islands', name: '쌍둥이섬 동굴', label: 'Seafoam Islands', seed: 41, width: 25, depth: 19, silhouette: 'oval', surfaceLocations: ['route-20-east', 'route-20-west'], legacy: true }, floors('1f', 'b1f', 'b2f', 'b3f', 'b4f')),
  cave({ regionId: 'kanto', id: 'victory-road', name: '챔피언로드', label: 'Victory Road', seed: 53, width: 27, depth: 21, silhouette: 'hall', surfaceLocations: ['route-23', 'indigo-plateau'], legacy: true, anchor: 1 }, floors('1f', '2f', '3f')),
  cave({ regionId: 'kanto', id: 'cerulean-cave', name: '블루시티 동굴', label: 'Cerulean Cave', seed: 67, width: 21, depth: 19, silhouette: 'rounded', surfaceLocations: ['cerulean-cave'], legacy: true, entry: 1 }, floors('2f', '1f', 'b1f')),
  room('plant', 'industrial', { regionId: 'kanto', id: 'power-plant', name: '무인발전소 내부', label: 'Power Plant', seed: 71, width: 29, depth: 19, surfaceLocations: ['power-plant'] }, [floor('1f')]),
  room('tower', 'ghost', { regionId: 'kanto', id: 'pokemon-tower', name: '포켓몬타워', label: 'Pokemon Tower', seed: 79, width: 16, depth: 13, surfaceLocations: ['pokemon-tower'] }, tower(7, ['3f', '4f', '5f', '6f', '7f'])),
  room('building', 'mansion', { regionId: 'kanto', id: 'pokemon-mansion', name: '포켓몬저택', label: 'Pokemon Mansion', seed: 89, width: 21, depth: 15, surfaceLocations: ['pokemon-mansion'], entry: 2 }, floors('3f', '2f', '1f', 'b1f')),
  // Johto. HeartGold floors; Slowpoke Well's B1F/B2F are "1f"/"b1f" in the PokeAPI.
  cave({ regionId: 'johto', id: 'tohjo-falls', name: '동성폭포 동굴', label: 'Tohjo Falls', seed: 83, width: 23, depth: 17, silhouette: 'oval', surfaceLocations: ['route-27', 'mt-silver'], legacy: true }, [floor('1f')]),
  cave({ regionId: 'johto', id: 'union-cave', name: '연결동굴', label: 'Union Cave', seed: 97, width: 25, depth: 19, silhouette: 'bend', surfaceLocations: ['route-32', 'route-33'], legacy: true }, floors('1f', 'b1f', 'b2f')),
  cave({ regionId: 'johto', id: 'slowpoke-well', name: '야돈의 우물', label: 'Slowpoke Well', seed: 101, width: 17, depth: 17, silhouette: 'rounded', surfaceLocations: ['slowpoke-well'], legacy: true }, [floor('b1f', ['1f']), floor('b2f', ['b1f'])]),
  cave({ regionId: 'johto', id: 'whirl-islands', name: '소용돌이섬 동굴', label: 'Whirl Islands', seed: 113, width: 27, depth: 23, silhouette: 'hall', surfaceLocations: ['route-40', 'route-41'], legacy: true }, floors('1f', 'b1f', 'b2f', 'b3f')),
  cave({ regionId: 'johto', id: 'mt-mortar', name: '절구산', label: 'Mt. Mortar', seed: 127, width: 29, depth: 17, silhouette: 'long', surfaceLocations: ['route-42-west', 'route-42-east'], legacy: true }, [
    floor('1f', ['1f'], { label: '1층 바깥' }), floor('1f-inside', ['lower-cave'], { label: '1층 안쪽', level: .5 }), floor('2f', ['upper-cave'], { label: '2층 안쪽' }), floor('b1f', ['b1f']),
  ]),
  cave({ regionId: 'johto', id: 'ice-path', name: '얼음샛길', label: 'Ice Path', seed: 139, width: 23, depth: 23, silhouette: 'oval', surfaceLocations: ['route-44', 'blackthorn'], legacy: true }, floors('1f', 'b1f', 'b2f', 'b3f')),
  // Crystal lists Dragon's Den as one surf table, shared by both floors.
  cave({ regionId: 'johto', id: 'dragons-den', name: '용의 굴', label: "Dragon's Den", seed: 149, width: 19, depth: 21, silhouette: 'rounded', surfaceLocations: ['dragons-den'], legacy: true }, [floor('1f'), floor('b1f')]),
  cave({ regionId: 'johto', id: 'dark-cave', name: '어둠의 동굴', label: 'Dark Cave', seed: 163, width: 31, depth: 15, silhouette: 'bend', surfaceLocations: ['dark-cave-east', 'dark-cave-west'], legacy: true }, [
    floor('blackthorn', ['blackthorn-city-entrance'], { label: '검은먹시티 입구', level: 0, locationId: 'dark-cave-east' }),
    floor('violet', ['violet-city-entrance'], { label: '도라지시티 입구', level: -1, locationId: 'dark-cave-west' }),
  ]),
  cave({ regionId: 'johto', id: 'mt-silver', name: '은빛산 동굴', label: 'Mt. Silver', seed: 179, width: 27, depth: 25, silhouette: 'hall', surfaceLocations: ['mt-silver'], legacy: true }, floors('1f', '2f', 'top')),
  room('tower', 'pagoda', { regionId: 'johto', id: 'sprout-tower', name: '모다피의 탑', label: 'Sprout Tower', seed: 191, width: 14, depth: 14, surfaceLocations: ['sprout-tower'] }, tower(3, ['2f', '3f'])),
  room('tower', 'charred', { regionId: 'johto', id: 'burned-tower', name: '불탄탑', label: 'Burned Tower', seed: 197, width: 18, depth: 15, surfaceLocations: ['burned-tower'] }, floors('1f', 'b1f')),
  // Ho-Oh rests on the roof in the original, which has no wild table; its rare slot is on 9F.
  room('tower', 'bell', { regionId: 'johto', id: 'bell-tower', name: '방울탑', label: 'Bell Tower', seed: 211, width: 14, depth: 14, surfaceLocations: ['bell-tower'], anchor: 8 },
    [...tower(9, ['2f', '3f', '4f', '5f', '6f', '7f', '8f', '9f']), floor('roof', [])]),
  room('tower', 'lighthouse', { regionId: 'johto', id: 'lighthouse', name: '빛남의 등대', label: 'Olivine Lighthouse', seed: 223, width: 11, depth: 11, surfaceLocations: ['lighthouse'] }, tower(6, [])),
  room('ruins', 'ruins', { regionId: 'johto', id: 'ruins-of-alph', name: '알프의 유적', label: 'Ruins of Alph', seed: 229, width: 13, depth: 10, surfaceLocations: ['ruins-of-alph'] },
    [floor('1f', ['interior-a', 'interior-b', 'interior-c', 'interior-d'])]),
  // Later regions: floors where the PokeAPI keeps per-floor areas, otherwise one floor with the whole table.
  cave({ regionId: 'hoenn', id: 'granite-cave', name: '바위동굴', label: 'Granite Cave', seed: 307, width: 21, depth: 17, silhouette: 'bend', surfaceLocations: ['granite-cave'] },
    [floor('1f', ['1f', '1fsmall-room']), floor('b1f', ['b1f']), floor('b2f', ['b2f'])]),
  cave({ regionId: 'hoenn', id: 'rusturf-tunnel', name: '금잔터널', label: 'Rusturf Tunnel', seed: 311, width: 25, depth: 11, silhouette: 'long', surfaceLocations: ['hoenn-route-116', 'verdanturf-town'] }, [floor('1f')]),
  cave({ regionId: 'hoenn', id: 'fiery-path', name: '불꽃샛길', label: 'Fiery Path', seed: 317, width: 23, depth: 13, silhouette: 'long', surfaceLocations: ['hoenn-route-112', 'lavaridge-town'] }, [floor('1f')]),
  cave({ regionId: 'hoenn', id: 'meteor-falls', name: '유성폭포', label: 'Meteor Falls', seed: 331, width: 23, depth: 19, silhouette: 'oval', surfaceLocations: ['hoenn-route-114', 'hoenn-route-115'] },
    [floor('1f', ['', 'back', 'backsmall-room']), floor('b1f', ['b1f'])]),
  cave({ regionId: 'hoenn', id: 'hoenn-victory-road', name: '챔피언로드', label: 'Victory Road', seed: 337, width: 25, depth: 21, silhouette: 'hall', surfaceLocations: ['hoenn-route-128', 'ever-grande-city'] }, floors('1f', 'b1f', 'b2f')),
  cave({ regionId: 'sinnoh', id: 'oreburgh-gate', name: '무쇠게이트', label: 'Oreburgh Gate', seed: 347, width: 21, depth: 13, silhouette: 'long', surfaceLocations: ['sinnoh-route-203', 'oreburgh-city'] }, floors('1f', 'b1f')),
  // The Route 207-208 passage crosses 1F; the mountain's other floors branch off it.
  cave({ regionId: 'sinnoh', id: 'mt-coronet', name: '천관산', label: 'Mt. Coronet', seed: 349, width: 27, depth: 21, silhouette: 'hall', surfaceLocations: ['sinnoh-route-207', 'sinnoh-route-208'], surfaceFloors: [1, 1] }, [
    floor('b1f', ['b1f']), floor('1f', ['1f-route-207', '1f-route-211', '1f-route-216', '1f-from-exterior']), floor('2f', ['2f']), floor('3f', ['3f']),
    floor('4f', ['4f', '4f-small-room']), floor('5f', ['5f']), floor('6f', ['6f']), floor('top', ['exterior-snowfall', 'exterior-blizzard']),
  ]),
  cave({ regionId: 'sinnoh', id: 'sinnoh-victory-road', name: '챔피언로드', label: 'Victory Road', seed: 353, width: 25, depth: 21, silhouette: 'hall', surfaceLocations: ['sinnoh-sea-route-223', 'sinnoh-pokemon-league'] },
    [floor('1f', ['1f', 'inside', 'inside-exit']), floor('2f', ['2f']), floor('b1f', ['b1f', 'inside-b1f'])]),
  cave({ regionId: 'sinnoh', id: 'iron-island', name: '강철섬', label: 'Iron Island', seed: 359, width: 21, depth: 17, silhouette: 'rounded', surfaceLocations: ['iron-island'] },
    [floor('1f', ['1f']), floor('b1f', ['b1f-left', 'b1f-right']), floor('b2f', ['b2f-left', 'b2f-right']), floor('b3f', ['b3f'])]),
  room('ruins', 'stone', { regionId: 'unova', id: 'dreamyard', name: '꿈터', label: 'Dreamyard', seed: 367, width: 17, depth: 13, surfaceLocations: ['dreamyard'] }, [floor('1f')]),
  cave({ regionId: 'unova', id: 'wellspring-cave', name: '지하수맥굴', label: 'Wellspring Cave', seed: 373, width: 19, depth: 15, silhouette: 'rounded', surfaceLocations: ['wellspring-cave'] }, [floor('1f'), floor('b1f')]),
  room('ruins', 'sand', { regionId: 'unova', id: 'relic-castle', name: '고대의성', label: 'Relic Castle', seed: 379, width: 18, depth: 15, surfaceLocations: ['relic-castle'] },
    [floor('1f', ['a']), floor('b1f', ['b']), floor('b2f', ['c']), floor('b3f', ['d'])]),
  room('building', 'warehouse', { regionId: 'unova', id: 'cold-storage', name: '냉동컨테이너', label: 'Cold Storage', seed: 383, width: 19, depth: 13, surfaceLocations: ['cold-storage'] }, [floor('1f')]),
  cave({ regionId: 'unova', id: 'chargestone-cave', name: '전기돌동굴', label: 'Chargestone Cave', seed: 389, width: 23, depth: 19, silhouette: 'bend', surfaceLocations: ['unova-route-6', 'mistralton-city'] }, floors('1f', 'b1f', 'b2f')),
  room('tower', 'ghost', { regionId: 'unova', id: 'celestial-tower', name: '타워오브해븐', label: 'Celestial Tower', seed: 397, width: 14, depth: 14, surfaceLocations: ['celestial-tower'] }, tower(5, ['2f', '3f', '4f', '5f'])),
  cave({ regionId: 'unova', id: 'twist-mountain', name: '태엽산', label: 'Twist Mountain', seed: 401, width: 25, depth: 19, silhouette: 'hall', surfaceLocations: ['unova-route-7', 'icirrus-city'] }, [floor('1f')]),
  room('tower', 'stone', { regionId: 'unova', id: 'dragonspiral-tower', name: '용나선탑', label: 'Dragonspiral Tower', seed: 409, width: 15, depth: 15, surfaceLocations: ['dragonspiral-tower'] }, floors('1f', '2f')),
  cave({ regionId: 'unova', id: 'unova-victory-road', name: '챔피언로드', label: 'Victory Road', seed: 419, width: 27, depth: 21, silhouette: 'oval', surfaceLocations: ['unova-route-10', 'unova-pokemon-league'] }, [floor('1f')]),
  cave({ regionId: 'kalos', id: 'glittering-cave', name: '반짝임의동굴', label: 'Glittering Cave', seed: 421, width: 21, depth: 15, silhouette: 'bend', surfaceLocations: ['kalos-route-8', 'kalos-route-10'] }, [floor('1f')]),
  // Kalos areas carry no floor names; their table order follows the floors.
  cave({ regionId: 'kalos', id: 'reflection-cave', name: '비춤의동굴', label: 'Reflection Cave', seed: 431, width: 21, depth: 17, silhouette: 'oval', surfaceLocations: ['geosenge-town', 'shalour-city'] },
    [floor('1f', ['unknown-area-305']), floor('b1f', ['unknown-area-306']), floor('b2f', ['unknown-area-307']), floor('b3f', ['unknown-area-308'])]),
  cave({ regionId: 'kalos', id: 'frost-cavern', name: '프로스트케이브', label: 'Frost Cavern', seed: 437, width: 21, depth: 17, silhouette: 'rounded', surfaceLocations: ['dendemille-town', 'kalos-route-18'] },
    [floor('1f', ['unknown-area-313', 'unknown-area-314']), floor('2f', ['unknown-area-315']), floor('3f', ['unknown-area-316', 'unknown-area-317'])]),
  cave({ regionId: 'kalos', id: 'kalos-victory-road', name: '챔피언로드', label: 'Victory Road', seed: 439, width: 27, depth: 21, silhouette: 'hall', surfaceLocations: ['kalos-route-21', 'kalos-pokemon-league'] }, [floor('1f')]),
  cave({ regionId: 'alola', id: 'verdant-cavern', name: '우거진동굴', label: 'Verdant Cavern', seed: 443, width: 19, depth: 15, silhouette: 'rounded', surfaceLocations: ['alola-route-2', 'alola-route-3'] }, [floor('1f')]),
  cave({ regionId: 'alola', id: 'wela-volcano-park', name: '벨라화산공원', label: 'Wela Volcano Park', seed: 449, width: 21, depth: 17, silhouette: 'oval', surfaceLocations: ['lush-jungle', 'konikoni-city'] }, [floor('1f')]),
  cave({ regionId: 'alola', id: 'mount-hokulani', name: '호쿠라니큰산', label: 'Mount Hokulani', seed: 457, width: 23, depth: 17, silhouette: 'bend', surfaceLocations: ['alola-route-10', 'blush-mountain'] }, [floor('1f')]),
  cave({ regionId: 'alola', id: 'blush-mountain', name: '화끈산', label: 'Blush Mountain', seed: 461, width: 21, depth: 15, silhouette: 'long', surfaceLocations: ['mount-hokulani', 'tapu-village'] }, [floor('1f')]),
  cave({ regionId: 'alola', id: 'vast-poni-canyon', name: '포니대협곡', label: 'Vast Poni Canyon', seed: 463, width: 25, depth: 17, silhouette: 'long', surfaceLocations: ['ancient-poni-path', 'mount-lanakila'] }, [floor('1f')]),
  cave({ regionId: 'alola', id: 'mount-lanakila', name: '라나키라마운틴', label: 'Mount Lanakila', seed: 467, width: 23, depth: 19, silhouette: 'hall', surfaceLocations: ['vast-poni-canyon', 'alola-pokemon-league'] }, [floor('1f')]),
  cave({ regionId: 'hisui', id: 'coronet-highlands', name: '천관산 기슭', label: 'Coronet Highlands', seed: 479, width: 25, depth: 19, silhouette: 'bend', surfaceLocations: ['highlands-camp', 'moonview-arena'] }, [floor('1f')]),
  cave({ regionId: 'paldea', id: 'glaseado-mountain', name: '나페산', label: 'Glaseado Mountain', seed: 487, width: 25, depth: 19, silhouette: 'oval', surfaceLocations: ['montenevera', 'casseroya-lake'] }, [floor('1f')]),
  cave({ regionId: 'paldea', id: 'south-province-area-six', name: '남부 에리어 6', label: 'South Province Area Six', seed: 491, width: 23, depth: 17, silhouette: 'rounded', surfaceLocations: ['mesagoza', 'alfornada'] }, [floor('1f')]),
  room('ruins', 'stone', { regionId: 'paldea', id: 'area-zero', name: '에리어 제로', label: 'Area Zero', seed: 499, width: 19, depth: 15, surfaceLocations: ['area-zero'] }, [floor('1f')]),
];

/** Floor the first surface entrance opens onto. */
export const dungeonEntryFloor = (plan: DungeonPlan): number => plan.surfaceFloors?.[0] ?? plan.entry ?? 0;
export const dungeonFloorSceneLocalId = (plan: DungeonPlan, index: number): string =>
  index === dungeonEntryFloor(plan) ? plan.id : `${plan.id}-${plan.floors[index].key}`;
export const dungeonFloorAsciiLabel = (key: string): string => ASCII_ROOFS[key] ?? key.toUpperCase();

const planByScene = new Map<string, { plan: DungeonPlan; index: number }>();
for (const plan of DUNGEON_PLANS) plan.floors.forEach((_, index) => planByScene.set(`cave:${plan.regionId}:${dungeonFloorSceneLocalId(plan, index)}`, { plan, index }));

/** The plan and floor behind a dungeon scene id, without building any geometry. */
export const dungeonPlanForScene = (sceneId: string | undefined) => sceneId ? planByScene.get(sceneId) : undefined;

/** Every allowed dungeon scene id suffix by region; mirrored in `src/data/dungeon-scenes.json` for the save server. */
export function dungeonSceneIdsByRegion(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const plan of DUNGEON_PLANS) (result[plan.regionId] ??= []).push(...plan.floors.map((_, index) => dungeonFloorSceneLocalId(plan, index)));
  for (const ids of Object.values(result)) ids.sort();
  return result;
}
