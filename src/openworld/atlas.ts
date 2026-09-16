import type { WorldSample } from './types';
import { JOHTO_ATLAS } from './johto';
import * as hoennMap from './hoenn';
import * as sinnohMap from './sinnoh';
import * as unovaMap from './unova';
import * as kalosMap from './kalos';
import * as alolaMap from './alola';
import * as galarMap from './galar';
import * as hisuiMap from './hisui';
import * as paldeaMap from './paldea';
import { CAVE_SCENES, getCaveScene, type CaveScene } from './caves';
import { WORLD_SCALE, scaleWorldDistance, surfaceSceneId } from './world-space';
import {
  KANTO_CONNECTIONS, KANTO_GATES, KANTO_GYMS, KANTO_LOCATIONS, KANTO_MAP_VERSION, KANTO_START, KANTO_SURFACE_CONNECTIONS,
  distanceToKantoPath, encountersForLocation, evaluateKantoTraversal, kantoGateHalfWidth, kantoTravelPoint, locationAt,
  nearestKantoWalkable, safeKantoArrival, sampleKantoWorld, townBuildingOffsets,
  type KantoGate, type KantoGym, type KantoLocation, type KantoLocationKind, type KantoTraversal,
} from './kanto';

export type WorldRegionId = 'kanto' | 'johto' | 'hoenn' | 'sinnoh' | 'unova' | 'kalos' | 'alola' | 'galar' | 'hisui' | 'paldea';
export type WorldAtlas = {
  id: WorldRegionId; name: string; englishName: string; defaultVersion: string; mapVersion: string; start: { x: number; z: number };
  surfaceSceneId: string; caves: readonly CaveScene[];
  locations: readonly KantoLocation[]; connections: ReadonlyArray<readonly [string, string]>; surfaceConnections: ReadonlyArray<readonly [string, string]>;
  gates: readonly KantoGate[]; gyms: readonly KantoGym[]; palette: { ground: string; water: string; town: string };
  sample(x: number, z: number): WorldSample; locationAt(x: number, z: number): KantoLocation; distanceToPath(x: number, z: number): number;
  evaluateTraversal(from: { x: number; z: number }, to: { x: number; z: number }, badges: number): KantoTraversal;
  safeArrival(id: string, badges?: number): { x: number; z: number } | undefined;
  nearestWalkable(x: number, z: number, badges?: number): { x: number; z: number } | undefined;
  travelPoint(id: string, badges?: number): { x: number; z: number } | undefined;
  buildingOffsets(town: KantoLocation): ReadonlyArray<readonly [number, number]>;
  encounters(id: string, badges: number): number[]; gateHalfWidth(gate: KantoGate): number;
};

type Landmark = readonly [id: string, name: string, x: number, z: number, kind?: KantoLocationKind];
type TerrainZone = { x: number; z: number; radius: number; biome: WorldSample['biome']; lift?: number };
type AtlasPlan = {
  id: Exclude<WorldRegionId, 'kanto'>; name: string; englishName: string; defaultVersion: string;
  palette: WorldAtlas['palette']; landmarks: readonly Landmark[]; species: readonly number[]; zones: readonly TerrainZone[];
};

const location = (entry: Landmark, index: number, species: readonly number[], coordinateScale: number): KantoLocation => {
  const [id, name, x, z, kind = 'town'] = entry, offset = index * 3;
  return { id, name, x: x * coordinateScale, z: z * coordinateScale, kind, minLevel: Math.min(55, 3 + index * 3), maxLevel: Math.min(65, 7 + index * 4),
    encounters: [0, 1, 2, 3].map(step => species[(offset + step) % species.length]), requiredBadges: 0 };
};

function createAtlas(plan: AtlasPlan, coordinateScale: number = WORLD_SCALE): WorldAtlas {
  const distance = (value: number) => value * coordinateScale;
  const landmarks = plan.landmarks.map((entry, index) => location(entry, index, plan.species, coordinateScale));
  const locations: KantoLocation[] = [], connections: Array<readonly [string, string]> = [];
  for (let index = 0; index < landmarks.length; index++) {
    const current = landmarks[index]; locations.push(current);
    if (index === 0) continue;
    const previous = landmarks[index - 1], road: KantoLocation = {
      id: `${plan.id}-road-${index}`, name: `${previous.name}–${current.name} 연결로`, x: (previous.x + current.x) / 2, z: (previous.z + current.z) / 2,
      kind: current.kind === 'sea' || previous.kind === 'sea' ? 'sea' : 'route', minLevel: Math.max(previous.minLevel, 3), maxLevel: current.maxLevel,
      encounters: [...new Set([...previous.encounters.slice(0, 2), ...current.encounters.slice(0, 2)])], requiredBadges: 0,
    };
    locations.push(road); connections.push([previous.id, road.id], [road.id, current.id]);
  }
  const byId = new Map(locations.map(item => [item.id, item]));
  const segments = connections.map(([from, to]) => {
    const a = byId.get(from)!, b = byId.get(to)!, dx = b.x - a.x, dz = b.z - a.z;
    return { x: a.x, z: a.z, dx, dz, lengthSquared: dx * dx + dz * dz || 1 };
  });
  const distanceToPath = (x: number, z: number) => {
    let nearest = Infinity;
    for (const segment of segments) {
      const t = Math.max(0, Math.min(1, ((x - segment.x) * segment.dx + (z - segment.z) * segment.dz) / segment.lengthSquared));
      const dx = x - segment.x - segment.dx * t, dz = z - segment.z - segment.dz * t;
      nearest = Math.min(nearest, dx * dx + dz * dz);
    }
    return Math.sqrt(nearest);
  };
  const nearestLocation = (x: number, z: number) => locations.reduce((best, item) => Math.hypot(item.x - x, item.z - z) < Math.hypot(best.x - x, best.z - z) ? item : best, locations[0]);
  const buildings = (town: KantoLocation) => {
    const candidates: ReadonlyArray<readonly [number, number]> = [[-5,-4], [5,-4], [-5,4], [5,4], [-6,0], [6,0], [0,-6], [0,6]]
      .map(([x, z]) => [distance(x), distance(z)] as const);
    return candidates.filter(([dx, dz]) => distanceToPath(town.x + dx, town.z + dz) > distance(5)).slice(0, 3);
  };
  const sample = (x: number, z: number): WorldSample => {
    const wave = .16 * Math.sin((x / coordinateScale + plan.id.length * 7) * .075) + .14 * Math.cos(z / coordinateScale * .065);
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > 120 * coordinateScale || Math.abs(z) > 120 * coordinateScale) return { height: wave, biome: 'rock', blocked: true };
    const nearest = nearestLocation(x, z), distance = Math.hypot(x - nearest.x, z - nearest.z), path = distanceToPath(x, z);
    const town = locations.find(item => item.kind === 'town' && Math.hypot(x - item.x, z - item.z) < 8 * coordinateScale);
    if (town) {
      const blocked = buildings(town).some(([dx, dz]) => Math.abs(x - town.x - dx) < 1.8 * coordinateScale && Math.abs(z - town.z - dz) < 1.6 * coordinateScale);
      return { height: wave, biome: 'meadow', blocked };
    }
    const playable = path < 3.25 * coordinateScale || distance < (nearest.kind === 'forest' ? 7 : nearest.kind === 'sea' ? 6 : 5.5) * coordinateScale;
    if (playable) {
      const biome = nearest.kind === 'sea' ? 'lake' : nearest.kind === 'forest' ? 'forest' : nearest.kind === 'cave' ? 'rock' : 'meadow';
      return { height: wave + (biome === 'rock' ? .45 : biome === 'lake' ? -.35 : 0), biome, blocked: false };
    }
    const zone = plan.zones.find(item => Math.hypot(x - item.x * coordinateScale, z - item.z * coordinateScale) < item.radius * coordinateScale);
    return { height: wave + (zone?.lift ?? (zone?.biome === 'lake' ? -.45 : .25)), biome: zone?.biome ?? 'forest', blocked: true };
  };
  const safeArrival = (id: string, badges = 0) => {
    const target = byId.get(id); if (!target || !Number.isFinite(badges) || badges < target.requiredBadges) return undefined;
    for (const [x, z] of [[target.x, target.z], [target.x + distance(2), target.z], [target.x, target.z + distance(2)], [target.x - distance(2), target.z], [target.x, target.z - distance(2)]]) if (!sample(x, z).blocked) return { x, z };
    return undefined;
  };
  const nearestWalkable = (x: number, z: number, badges = 0) => {
    if (![x, z, badges].every(Number.isFinite) || badges < 0) return undefined;
    if (!sample(x, z).blocked && nearestLocation(x, z).requiredBadges <= badges) return { x, z };
    for (let radius = distance(.5); radius <= distance(18); radius += distance(.5)) for (let step = 0; step < 32; step++) {
      const angle = step / 32 * Math.PI * 2, candidate = { x: x + Math.cos(angle) * radius, z: z + Math.sin(angle) * radius };
      if (!sample(candidate.x, candidate.z).blocked && nearestLocation(candidate.x, candidate.z).requiredBadges <= badges) return candidate;
    }
    const target = [...locations].sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
    return target ? safeArrival(target.id, badges) : undefined;
  };
  return {
    buildingOffsets: buildings, id: plan.id, name: plan.name, englishName: plan.englishName, defaultVersion: plan.defaultVersion, mapVersion: `${plan.id}-atlas-v${coordinateScale === WORLD_SCALE ? 2 : 1}`,
    surfaceSceneId: surfaceSceneId(plan.id), caves: CAVE_SCENES.filter(scene => scene.regionId === plan.id),
    start: { x: landmarks[0].x, z: landmarks[0].z }, locations, connections, surfaceConnections: connections, gates: [], gyms: [], palette: plan.palette,
    sample, locationAt: nearestLocation, distanceToPath,
    evaluateTraversal: (_from, to, badges) => {
      const destination = nearestLocation(to.x, to.z);
      if (!Number.isFinite(badges) || badges < 0) return { allowed: false, location: destination, reason: '배지 정보가 올바르지 않습니다.' };
      return sample(to.x, to.z).blocked ? { allowed: false, location: destination, reason: '연결된 길과 탐험 지역을 벗어날 수 없습니다.' } : { allowed: true, location: destination };
    },
    safeArrival, nearestWalkable, travelPoint: (id, badges = 0) => byId.get(id)?.kind === 'town' ? safeArrival(id, badges) : undefined,
    encounters: (id, badges) => { const found = byId.get(id); return found && Number.isFinite(badges) && badges >= found.requiredBadges ? [...found.encounters] : []; },
    gateHalfWidth: () => 0,
  };
}

const plans: readonly AtlasPlan[] = [
  { id: 'johto', name: '성도', englishName: 'Johto', defaultVersion: 'gold', palette: { ground: '#83a66a', water: '#5b9fc0', town: '#d8aa65' }, species: [152,155,158,161,163,165,167,179,187,194,204,209,216,220,228], zones: [{ x: 55, z: -60, radius: 22, biome: 'lake' }, { x: -20, z: -35, radius: 25, biome: 'forest' }], landmarks: [
    ['new-bark','연두마을',-82,78],['cherrygrove','무궁시티',-64,58],['violet','도라지시티',-46,26],['azalea','고동마을',-64,-5],['goldenrod','금빛시티',-30,-24],['ecruteak','인주시티',3,-42],['bell-tower','방울탑',16,-55,'special'],['olivine','담청시티',-10,2],['cianwood','진청시티',-50,28],['mahogany','황토마을',34,-42],['lake-of-rage','분노의호수',55,-62,'sea'],['blackthorn','검은먹시티',77,-32],
  ] },
  { id: 'hoenn', name: '호연', englishName: 'Hoenn', defaultVersion: 'ruby', palette: { ground: '#79ad70', water: '#3f9bbb', town: '#e09b61' }, species: [252,255,258,261,263,265,270,273,276,280,293,304,309,316,318,320,322,325], zones: [{ x: 10, z: 5, radius: 26, biome: 'rock', lift: .8 }, { x: 55, z: 50, radius: 48, biome: 'lake' }], landmarks: [
    ['littleroot','미로마을',-76,76],['petalburg','등화시티',-68,38],['rustboro','금탄도시',-76,-2],['dewford','무로마을',-42,35,'town'],['slateport','잿빛도시',-8,46],['mauville','보라시티',2,12],['mt-chimney','굴뚝산',-8,-25,'cave'],['lavaridge','용암마을',-30,-18],['fortree','검방울시티',35,-20],['lilycove','해안시티',70,2],
  ] },
  { id: 'sinnoh', name: '신오', englishName: 'Sinnoh', defaultVersion: 'diamond', palette: { ground: '#91a878', water: '#6096bd', town: '#b9a88e' }, species: [387,390,393,396,399,401,403,406,418,425,427,431,434,436,443,449,451,453,455,459], zones: [{ x: 4, z: -10, radius: 30, biome: 'rock', lift: 1.1 }, { x: -60, z: 46, radius: 20, biome: 'lake' }], landmarks: [
    ['twinleaf','떡잎마을',-78,78],['sandgem','잔모래마을',-58,66],['jubilife','축복시티',-52,35],['oreburgh','무쇠시티',-25,28],['mt-coronet','천관산',2,-4,'cave'],['hearthome','연고시티',15,26],['veilstone','장막시티',48,5],['pastoria','들판시티',38,50],['canalave','운하시티',-62,2],['snowpoint','선단시티',18,-76],
  ] },
  { id: 'unova', name: '하나', englishName: 'Unova', defaultVersion: 'black', palette: { ground: '#779968', water: '#4e8bab', town: '#bd9d78' }, species: [495,498,501,504,506,509,511,513,515,519,522,524,527,529,532,535,540,543,546,548,550,551,554,557,559,562,568,570,572,574], zones: [{ x: 5, z: 5, radius: 21, biome: 'lake' }, { x: 58, z: -45, radius: 24, biome: 'rock', lift: .7 }], landmarks: [
    ['nuvema','마름꽃마을',-72,78],['accumula','넝쿨마을',-55,58],['striaton','성신시티',-35,38],['nacrene','칠보시티',-50,8],['castelia','구름시티',-25,-18],['nimbasa','뇌문시티',3,-34],['driftveil','물풍경시티',30,-12],['mistralton','궐수시티',48,-42],['icirrus','설화시티',68,-18],['opelucid','쌍용시티',74,20],
  ] },
  { id: 'kalos', name: '칼로스', englishName: 'Kalos', defaultVersion: 'x', palette: { ground: '#89ad75', water: '#5d9fbd', town: '#d2a679' }, species: [650,653,656,659,661,664,667,669,672,674,676,677,679,682,684,686,688,690,692,694,696,698,701,702,704,707,708,710,712,714], zones: [{ x: -5, z: -8, radius: 22, biome: 'forest' }, { x: -62, z: 5, radius: 25, biome: 'rock', lift: .65 }], landmarks: [
    ['vaniville','조아마을',-78,76],['aquacorde','수미마을',-65,55],['santalune','백단시티',-48,28],['lumiose','미르시티',-8,5],['camphrier','고목내마을',-32,-14],['cyllage','삼채시티',-65,-28],['geosenge','옥유마을',-30,-48],['shalour','사라시티',10,-52],['coumarine','비익시티',48,-25],['anistar','향전시티',72,5],
  ] },
  { id: 'alola', name: '알로라', englishName: 'Alola', defaultVersion: 'sun', palette: { ground: '#91b66d', water: '#36a7c6', town: '#e3b56f' }, species: [722,725,728,731,734,736,739,741,742,744,746,747,749,751,753,755,757,759,761,764,766,769,771,774,775,777,779,780,782], zones: [{ x: -55, z: 45, radius: 24, biome: 'lake' }, { x: 8, z: 5, radius: 24, biome: 'lake' }, { x: 62, z: -35, radius: 25, biome: 'lake' }], landmarks: [
    ['iki-town','릴리마을',-76,65],['hauoli','하우올리시티',-56,45],['heahea','환대시티',-20,22,'town'],['paniola','오하나마을',-4,2],['konikoni','코니코니시티',14,-18],['malie','말리에시티',48,-38],['tapu-village','카푸마을',68,-8],['seafolk','바다민족의마을',52,42,'town'],
  ] },
  { id: 'galar', name: '가라르', englishName: 'Galar', defaultVersion: 'sword', palette: { ground: '#86a76c', water: '#5795b2', town: '#b88772' }, species: [810,813,816,819,821,824,827,829,831,833,835,837,840,843,845,846,848,850,852,854,856,859,868,870,872,874,875,876,877,878], zones: [{ x: 4, z: 5, radius: 28, biome: 'forest' }, { x: 40, z: -48, radius: 25, biome: 'rock', lift: .8 }], landmarks: [
    ['postwick','펄롱마을',-74,80],['wedgehurst','브래시마을',-61,58],['motostoke','엔진시티',-38,25],['turffield','터프마을',-62,-2],['hulbury','바우마을',-25,-16],['hammerlocke','너클시티',5,-34],['stow-on-side','래터럴마을',30,-18],['ballonlea','아라베스크마을',45,-43],['circhester','키르쿠스마을',69,-22],['wyndon','슛시티',75,24],
  ] },
  { id: 'hisui', name: '히스이', englishName: 'Hisui', defaultVersion: 'legends-arceus', palette: { ground: '#8da16b', water: '#5b91a8', town: '#a98c6d' }, species: [722,155,501,399,396,403,418,425,434,449,459,550,570,627,629,704,712], zones: [{ x: 0, z: -5, radius: 30, biome: 'rock', lift: 1 }, { x: 58, z: 18, radius: 25, biome: 'lake' }], landmarks: [
    ['jubilife-village','축복마을',-78,72],['fieldlands-camp','흑요 들판 기지',-53,48],['mirelands-camp','홍련 습지 기지',-24,25],['coastlands-camp','군청 해안 기지',12,38],['highlands-camp','천관산 기슭 기지',20,-2],['icelands-camp','순백 동토 기지',50,-45],['temple-of-sinnoh','신오신전',75,-68,'special'],
  ] },
  { id: 'paldea', name: '팔데아', englishName: 'Paldea', defaultVersion: 'scarlet', palette: { ground: '#9dad65', water: '#4e9bb8', town: '#d89765' }, species: [906,909,912,915,917,919,921,924,926,928,931,932,935,938,940,942,944,946,948,950,951,953,955,957,960,962,963,965,967,969,971,973,974], zones: [{ x: 0, z: 0, radius: 23, biome: 'rock', lift: -.2 }, { x: 65, z: -20, radius: 22, biome: 'lake' }], landmarks: [
    ['cabo-poco','코사라 마을',-76,78],['los-platos','플라토마을',-58,60],['mesagoza','테이블시티',-35,34],['cortondo','세르클마을',-60,5],['artazon','보울마을',-12,8],['levincia','누룩스시티',35,-2],['cascarrafa','카라프시티',10,32],['medali','참푸르마을',28,-35],['montenevera','프리지마을',52,-55],['alfornada','베이크마을',70,20],
  ] },
];

const kanto: WorldAtlas = {
  buildingOffsets: townBuildingOffsets, id: 'kanto', name: '관동', englishName: 'Kanto', defaultVersion: 'red', mapVersion: KANTO_MAP_VERSION, start: KANTO_START,
  surfaceSceneId: surfaceSceneId('kanto'), caves: CAVE_SCENES.filter(scene => scene.regionId === 'kanto'),
  locations: KANTO_LOCATIONS, connections: KANTO_CONNECTIONS, surfaceConnections: KANTO_SURFACE_CONNECTIONS, gates: KANTO_GATES, gyms: KANTO_GYMS,
  palette: { ground: '#85a96c', water: '#559abd', town: '#d4aa71' }, sample: sampleKantoWorld, locationAt, distanceToPath: distanceToKantoPath,
  evaluateTraversal: evaluateKantoTraversal, safeArrival: safeKantoArrival, nearestWalkable: nearestKantoWalkable, travelPoint: kantoTravelPoint,
  encounters: encountersForLocation, gateHalfWidth: kantoGateHalfWidth,
};

const johto: WorldAtlas = {
  ...JOHTO_ATLAS,
  surfaceSceneId: surfaceSceneId('johto'),
  caves: CAVE_SCENES.filter(scene => scene.regionId === 'johto'),
};
const legacyJohto = createAtlas(plans.find(plan => plan.id === 'johto')!, 1);
/** Validate old coordinates before migrating them into the reconstructed map. */
export const getLegacyJohtoAtlas = (): WorldAtlas => legacyJohto;
export type LegacyExpansionRegion = 'hoenn' | 'sinnoh' | 'unova';
const legacyExpansionPlans = Object.fromEntries(
  plans.filter((plan): plan is AtlasPlan & { id: LegacyExpansionRegion } => plan.id === 'hoenn' || plan.id === 'sinnoh' || plan.id === 'unova')
    .map(plan => [plan.id, { v1: createAtlas(plan, 1), v2: createAtlas(plan) }]),
) as Record<LegacyExpansionRegion, { v1: WorldAtlas; v2: WorldAtlas }>;

/** Resolve the provisional atlas that wrote an expansion save before authored maps shipped. */
export function getLegacyExpansionAtlas(regionId: string, mapVersion: string | undefined): WorldAtlas | undefined {
  if (regionId !== 'hoenn' && regionId !== 'sinnoh' && regionId !== 'unova') return undefined;
  if (mapVersion === `${regionId}-atlas-v1`) return legacyExpansionPlans[regionId].v1;
  if (mapVersion === `${regionId}-atlas-v2`) return legacyExpansionPlans[regionId].v2;
  return undefined;
}

const legacyExpansionLocationIds: Record<LegacyExpansionRegion, Readonly<Record<string, string>>> = {
  hoenn: {
    littleroot: 'littleroot-town', petalburg: 'petalburg-city', rustboro: 'rustboro-city', dewford: 'dewford-town',
    slateport: 'slateport-city', mauville: 'mauville-city', 'mt-chimney': 'fiery-path', lavaridge: 'lavaridge-town',
    fortree: 'fortree-city', lilycove: 'lilycove-city',
  },
  sinnoh: {
    twinleaf: 'twinleaf-town', sandgem: 'sandgem-town', jubilife: 'jubilife-city', oreburgh: 'oreburgh-city',
    'mt-coronet': 'mt-coronet', hearthome: 'hearthome-city', veilstone: 'veilstone-city', pastoria: 'pastoria-city',
    canalave: 'canalave-city', snowpoint: 'snowpoint-city',
  },
  unova: {
    nuvema: 'nuvema-town', accumula: 'accumula-town', striaton: 'striaton-city', nacrene: 'nacrene-city',
    castelia: 'castelia-city', nimbasa: 'nimbasa-city', driftveil: 'driftveil-city', mistralton: 'mistralton-city',
    icirrus: 'icirrus-city', opelucid: 'opelucid-city',
  },
};

/** Map a provisional landmark id to the corresponding authored-map id. */
export function migrateLegacyExpansionLocationId(regionId: string, locationId: string): string {
  if (regionId !== 'hoenn' && regionId !== 'sinnoh' && regionId !== 'unova') return locationId;
  return legacyExpansionLocationIds[regionId][locationId] ?? locationId;
}
const expandedAtlas = (base: WorldAtlas, data: {
  mapVersion: string; start: WorldAtlas['start']; locations: WorldAtlas['locations']; connections: WorldAtlas['connections'];
  gates: WorldAtlas['gates']; gyms: WorldAtlas['gyms']; sample: WorldAtlas['sample']; locationAt: WorldAtlas['locationAt'];
  distanceToPath: WorldAtlas['distanceToPath']; evaluateTraversal: WorldAtlas['evaluateTraversal']; safeArrival: WorldAtlas['safeArrival'];
  buildingOffsets: WorldAtlas['buildingOffsets'];
}): WorldAtlas => ({
  ...base, ...data, surfaceConnections: data.connections,
  defaultVersion: base.id === 'hoenn' ? 'emerald' : base.id === 'sinnoh' ? 'platinum' : base.id === 'unova' ? 'black' : base.id === 'kalos' ? 'x' : base.id === 'alola' ? 'ultra-moon' : base.defaultVersion,
  buildingOffsets: data.buildingOffsets,
  gateHalfWidth: () => scaleWorldDistance(3),
  nearestWalkable: (x, z, badges = 0) => {
    if (data.evaluateTraversal({ x, z }, { x, z }, badges).allowed) return { x, z };
    for (const location of [...data.locations].sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))) {
      const point = data.safeArrival(location.id, badges); if (point) return point;
    }
    return undefined;
  },
  travelPoint: (id, badges = 0) => data.locations.find(location => location.id === id)?.kind === 'town' ? data.safeArrival(id, badges) : undefined,
  encounters: (id, badges) => { const location = data.locations.find(item => item.id === id); return location && location.requiredBadges <= badges ? [...location.encounters] : []; },
});
const expansionMaps = {
  hoenn: { mapVersion: hoennMap.HOENN_MAP_VERSION, start: hoennMap.HOENN_START, locations: hoennMap.HOENN_LOCATIONS, connections: hoennMap.HOENN_CONNECTIONS, gates: hoennMap.HOENN_GATES, gyms: hoennMap.HOENN_GYMS, sample: hoennMap.sampleHoennWorld, locationAt: hoennMap.hoennLocationAt, distanceToPath: hoennMap.distanceToHoennPath, evaluateTraversal: hoennMap.evaluateHoennTraversal, safeArrival: hoennMap.safeHoennArrival, buildingOffsets: hoennMap.hoennBuildingOffsets },
  sinnoh: { mapVersion: sinnohMap.SINNOH_MAP_VERSION, start: sinnohMap.SINNOH_START, locations: sinnohMap.SINNOH_LOCATIONS, connections: sinnohMap.SINNOH_CONNECTIONS, gates: sinnohMap.SINNOH_GATES, gyms: sinnohMap.SINNOH_GYMS, sample: sinnohMap.sampleSinnohWorld, locationAt: sinnohMap.sinnohLocationAt, distanceToPath: sinnohMap.distanceToSinnohPath, evaluateTraversal: sinnohMap.evaluateSinnohTraversal, safeArrival: sinnohMap.safeSinnohArrival, buildingOffsets: sinnohMap.sinnohBuildingOffsets },
  unova: { mapVersion: unovaMap.UNOVA_MAP_VERSION, start: unovaMap.UNOVA_START, locations: unovaMap.UNOVA_LOCATIONS, connections: unovaMap.UNOVA_CONNECTIONS, gates: unovaMap.UNOVA_GATES, gyms: unovaMap.UNOVA_GYMS, sample: unovaMap.sampleUnovaWorld, locationAt: unovaMap.unovaLocationAt, distanceToPath: unovaMap.distanceToUnovaPath, evaluateTraversal: unovaMap.evaluateUnovaTraversal, safeArrival: unovaMap.safeUnovaArrival, buildingOffsets: unovaMap.unovaBuildingOffsets },
  kalos: { mapVersion: kalosMap.KALOS_MAP_VERSION, start: kalosMap.KALOS_START, locations: kalosMap.KALOS_LOCATIONS, connections: kalosMap.KALOS_CONNECTIONS, gates: kalosMap.KALOS_GATES, gyms: kalosMap.KALOS_GYMS, sample: kalosMap.sampleKalosWorld, locationAt: kalosMap.kalosLocationAt, distanceToPath: kalosMap.distanceToKalosPath, evaluateTraversal: kalosMap.evaluateKalosTraversal, safeArrival: kalosMap.safeKalosArrival, buildingOffsets: kalosMap.kalosBuildingOffsets },
  alola: { mapVersion: alolaMap.ALOLA_MAP_VERSION, start: alolaMap.ALOLA_START, locations: alolaMap.ALOLA_LOCATIONS, connections: alolaMap.ALOLA_CONNECTIONS, gates: alolaMap.ALOLA_GATES, gyms: alolaMap.ALOLA_GYMS, sample: alolaMap.sampleAlolaWorld, locationAt: alolaMap.alolaLocationAt, distanceToPath: alolaMap.distanceToAlolaPath, evaluateTraversal: alolaMap.evaluateAlolaTraversal, safeArrival: alolaMap.safeAlolaArrival, buildingOffsets: alolaMap.alolaBuildingOffsets },
  galar: { mapVersion: galarMap.GALAR_MAP_VERSION, start: galarMap.GALAR_START, locations: galarMap.GALAR_LOCATIONS, connections: galarMap.GALAR_CONNECTIONS, gates: galarMap.GALAR_GATES, gyms: galarMap.GALAR_GYMS, sample: galarMap.sampleGalarWorld, locationAt: galarMap.galarLocationAt, distanceToPath: galarMap.distanceToGalarPath, evaluateTraversal: galarMap.evaluateGalarTraversal, safeArrival: galarMap.safeGalarArrival, buildingOffsets: galarMap.galarBuildingOffsets },
  hisui: { mapVersion: hisuiMap.HISUI_MAP_VERSION, start: hisuiMap.HISUI_START, locations: hisuiMap.HISUI_LOCATIONS, connections: hisuiMap.HISUI_CONNECTIONS, gates: hisuiMap.HISUI_GATES, gyms: hisuiMap.HISUI_GYMS, sample: hisuiMap.sampleHisuiWorld, locationAt: hisuiMap.hisuiLocationAt, distanceToPath: hisuiMap.distanceToHisuiPath, evaluateTraversal: hisuiMap.evaluateHisuiTraversal, safeArrival: hisuiMap.safeHisuiArrival, buildingOffsets: hisuiMap.hisuiBuildingOffsets },
  paldea: { mapVersion: paldeaMap.PALDEA_MAP_VERSION, start: paldeaMap.PALDEA_START, locations: paldeaMap.PALDEA_LOCATIONS, connections: paldeaMap.PALDEA_CONNECTIONS, gates: paldeaMap.PALDEA_GATES, gyms: paldeaMap.PALDEA_GYMS, sample: paldeaMap.samplePaldeaWorld, locationAt: paldeaMap.paldeaLocationAt, distanceToPath: paldeaMap.distanceToPaldeaPath, evaluateTraversal: paldeaMap.evaluatePaldeaTraversal, safeArrival: paldeaMap.safePaldeaArrival, buildingOffsets: paldeaMap.paldeaBuildingOffsets },
};
export const WORLDS: readonly WorldAtlas[] = [kanto, johto, ...plans.filter(plan => plan.id !== 'johto').map(plan => {
  const base = createAtlas(plan);
  return plan.id === 'hoenn' || plan.id === 'sinnoh' || plan.id === 'unova' || plan.id === 'kalos' || plan.id === 'alola' || plan.id === 'galar' || plan.id === 'hisui' || plan.id === 'paldea' ? expandedAtlas(base, expansionMaps[plan.id]) : base;
})];
const worldsById = new Map(WORLDS.map(world => [world.id, world]));
export function getWorldAtlas(id: string): WorldAtlas {
  const world = worldsById.get(id as WorldRegionId); if (!world) throw new RangeError(`Unknown world region: ${id}`); return world;
}

/** Resolve the isolated coordinate space used by movement, collision, peers, and encounters. */
export function getWorldScene(regionId: string, sceneId: string): WorldAtlas | CaveScene {
  const world = getWorldAtlas(regionId);
  if (sceneId === world.surfaceSceneId) return world;
  const cave = getCaveScene(sceneId);
  if (!cave || cave.regionId !== world.id) throw new RangeError(`Unknown scene for ${regionId}: ${sceneId}`);
  return cave;
}

const versionRegions: Record<string, WorldRegionId> = {
  red:'kanto',blue:'kanto',yellow:'kanto',firered:'kanto',leafgreen:'kanto','lets-go-pikachu':'kanto','lets-go-eevee':'kanto','red-japan':'kanto','green-japan':'kanto','blue-japan':'kanto',champions:'kanto',
  gold:'johto',silver:'johto',crystal:'johto',heartgold:'johto',soulsilver:'johto',
  ruby:'hoenn',sapphire:'hoenn',emerald:'hoenn','omega-ruby':'hoenn','alpha-sapphire':'hoenn',colosseum:'hoenn',xd:'hoenn',
  diamond:'sinnoh',pearl:'sinnoh',platinum:'sinnoh','brilliant-diamond':'sinnoh','shining-pearl':'sinnoh',
  black:'unova',white:'unova','black-2':'unova','white-2':'unova',
  x:'kalos',y:'kalos','legends-za':'kalos','mega-dimension':'kalos',
  sun:'alola',moon:'alola','ultra-sun':'alola','ultra-moon':'alola',
  sword:'galar',shield:'galar','the-isle-of-armor-sword':'galar','the-isle-of-armor-shield':'galar','the-crown-tundra-sword':'galar','the-crown-tundra-shield':'galar',
  'legends-arceus':'hisui',
  scarlet:'paldea',violet:'paldea','the-teal-mask-scarlet':'paldea','the-teal-mask-violet':'paldea','the-indigo-disk-scarlet':'paldea','the-indigo-disk-violet':'paldea',
};
export function regionForVersion(version: string): WorldRegionId {
  const region = versionRegions[version]; if (!region) throw new RangeError(`Unknown Pokemon version: ${version}`); return region;
}
