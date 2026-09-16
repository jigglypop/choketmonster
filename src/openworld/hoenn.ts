import type { KantoGate, KantoGym, KantoLocation } from './kanto';
import { authoredLocation, createAuthoredRegionSampler } from './authored-region';
import { WORLD_SCALE } from './world-space';

export const HOENN_MAP_VERSION = 'hoenn-authored-v1' as const;
export const HOENN_START = { x: -52 * WORLD_SCALE, z: 78 * WORLD_SCALE } as const;
const l = (id: string, name: string, x: number, z: number, kind: Parameters<typeof authoredLocation>[5], levels: readonly [number, number], badges = 0) => authoredLocation('hoenn', id, name, x, z, kind, levels, badges);

// Relative placement follows the Hoenn route graph. Geometry and collision are authored here;
// no map mesh or texture is copied from the reference games.
export const HOENN_LOCATIONS: readonly KantoLocation[] = [
  l('littleroot-town', '미로마을', -52, 78, 'town', [2, 4]), l('hoenn-route-101', '101번도로', -52, 65, 'route', [2, 4]),
  l('oldale-town', '고도마을', -52, 53, 'town', [3, 5]), l('hoenn-route-102', '102번도로', -68, 53, 'route', [3, 5]),
  l('petalburg-city', '등화도시', -84, 53, 'town', [4, 8]), l('hoenn-route-104', '104번도로', -84, 34, 'route', [4, 8]),
  l('hoenn-route-105', '105번수로', -101, 45, 'sea', [5, 10]), l('hoenn-route-106', '106번수로', -105, 61, 'sea', [6, 12]),
  l('dewford-town', '무로마을', -94, 72, 'town', [7, 14]), l('granite-cave', '바위동굴', -105, 76, 'cave', [8, 15]),
  l('hoenn-route-107', '107번수로', -74, 78, 'sea', [8, 16]), l('hoenn-route-108', '108번수로', -48, 82, 'sea', [9, 18]), l('hoenn-route-109', '109번수로', -10, 67, 'sea', [10, 20]),
  l('petalburg-woods', '등화숲', -82, 23, 'forest', [5, 9]), l('rustboro-city', '금탄도시', -74, 8, 'town', [7, 12]),
  l('hoenn-route-116', '116번도로', -53, 8, 'route', [7, 12]), l('rusturf-tunnel', '금잔터널', -34, 8, 'cave', [8, 13]),
  l('verdanturf-town', '잔디마을', -15, 8, 'town', [10, 16]), l('hoenn-route-117', '117번도로', 4, 8, 'route', [12, 18]),
  l('mauville-city', '보라시티', 24, 8, 'town', [14, 22]), l('hoenn-route-110', '110번도로', 24, 29, 'route', [12, 18]),
  l('slateport-city', '잿빛도시', 24, 48, 'town', [14, 22]), l('hoenn-route-103', '103번도로', -30, 48, 'route', [3, 6]),
  l('hoenn-route-111', '111번도로', 24, -12, 'route', [15, 24]), l('hoenn-route-112', '112번도로', 7, -24, 'route', [16, 25]),
  l('fiery-path', '불꽃샛길', 3, -36, 'cave', [16, 26]), l('lavaridge-town', '용암마을', -8, -28, 'town', [18, 28]),
  l('hoenn-route-113', '113번도로', 10, -52, 'route', [18, 28]), l('fallarbor-town', '단풍마을', -12, -58, 'town', [20, 30]),
  l('hoenn-route-114', '114번도로', -36, -46, 'route', [20, 31]), l('meteor-falls', '유성폭포', -58, -38, 'cave', [20, 33]),
  l('hoenn-route-115', '115번도로', -70, -18, 'route', [21, 34]), l('hoenn-route-118', '118번도로', 43, 8, 'route', [22, 34]),
  l('hoenn-route-119', '119번도로', 49, -13, 'forest', [23, 35]), l('fortree-city', '검방울시티', 49, -34, 'town', [24, 36]),
  l('hoenn-route-120', '120번도로', 65, -24, 'route', [25, 38]), l('hoenn-route-121', '121번도로', 80, -10, 'route', [26, 39]),
  l('lilycove-city', '해안시티', 92, -5, 'town', [28, 42]), l('hoenn-route-124', '124번수로', 91, 20, 'sea', [30, 44]),
  l('mossdeep-city', '이끼시티', 82, 36, 'town', [32, 45]), l('hoenn-route-126', '126번수로', 64, 48, 'sea', [32, 46]),
  l('sootopolis-city', '루네시티', 61, 35, 'town', [34, 48]), l('hoenn-route-127', '127번수로', 82, 54, 'sea', [34, 48]),
  l('hoenn-route-128', '128번수로', 91, 68, 'sea', [35, 50]), l('hoenn-victory-road', '챔피언로드', 100, 77, 'cave', [40, 55], 8),
  l('ever-grande-city', '그랜드시티', 108, 86, 'town', [45, 60], 8), l('hoenn-route-129', '129번수로', 70, 74, 'sea', [34, 50]),
  l('hoenn-route-130', '130번수로', 47, 74, 'sea', [34, 50]), l('hoenn-route-131', '131번수로', 24, 74, 'sea', [34, 50]),
  l('pacifidlog-town', '황금마을', 2, 74, 'town', [34, 50]), l('hoenn-route-132', '132번수로', -17, 74, 'sea', [34, 50]),
  l('hoenn-route-133', '133번수로', -35, 70, 'sea', [34, 50]), l('hoenn-route-134', '134번수로', -52, 62, 'sea', [34, 50]),
];

export const HOENN_CONNECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['littleroot-town','hoenn-route-101'],['hoenn-route-101','oldale-town'],['oldale-town','hoenn-route-102'],['hoenn-route-102','petalburg-city'],['oldale-town','hoenn-route-103'],['hoenn-route-103','hoenn-route-110'],
  ['petalburg-city','hoenn-route-104'],['hoenn-route-104','petalburg-woods'],['petalburg-woods','rustboro-city'],['rustboro-city','hoenn-route-116'],['hoenn-route-116','rusturf-tunnel'],['rusturf-tunnel','verdanturf-town'],['verdanturf-town','hoenn-route-117'],['hoenn-route-117','mauville-city'],
  ['hoenn-route-104','hoenn-route-105'],['hoenn-route-105','hoenn-route-106'],['hoenn-route-106','dewford-town'],['dewford-town','granite-cave'],['dewford-town','hoenn-route-107'],['hoenn-route-107','hoenn-route-108'],['hoenn-route-108','hoenn-route-109'],['hoenn-route-109','slateport-city'],
  ['mauville-city','hoenn-route-110'],['hoenn-route-110','slateport-city'],['mauville-city','hoenn-route-111'],['hoenn-route-111','hoenn-route-112'],['hoenn-route-112','fiery-path'],['fiery-path','lavaridge-town'],['hoenn-route-111','hoenn-route-113'],['hoenn-route-113','fallarbor-town'],['fallarbor-town','hoenn-route-114'],['hoenn-route-114','meteor-falls'],['meteor-falls','hoenn-route-115'],['hoenn-route-115','rustboro-city'],
  ['mauville-city','hoenn-route-118'],['hoenn-route-118','hoenn-route-119'],['hoenn-route-119','fortree-city'],['fortree-city','hoenn-route-120'],['hoenn-route-120','hoenn-route-121'],['hoenn-route-121','lilycove-city'],['lilycove-city','hoenn-route-124'],['hoenn-route-124','mossdeep-city'],['mossdeep-city','hoenn-route-126'],['hoenn-route-126','sootopolis-city'],['mossdeep-city','hoenn-route-127'],['hoenn-route-127','hoenn-route-128'],['hoenn-route-128','hoenn-victory-road'],['hoenn-victory-road','ever-grande-city'],
  ['hoenn-route-128','hoenn-route-129'],['hoenn-route-129','hoenn-route-130'],['hoenn-route-130','hoenn-route-131'],['hoenn-route-131','pacifidlog-town'],['pacifidlog-town','hoenn-route-132'],['hoenn-route-132','hoenn-route-133'],['hoenn-route-133','hoenn-route-134'],['hoenn-route-134','slateport-city'],
];
export const HOENN_SURFACE_CONNECTIONS = HOENN_CONNECTIONS;
export const HOENN_GATES: readonly KantoGate[] = [];
export const HOENN_GYMS: readonly KantoGym[] = [
  {locationId:'rustboro-city',badge:1,badgeName:'스톤배지',name:'원규',speciesId:299,level:15},
  {locationId:'dewford-town',badge:2,badgeName:'너클배지',name:'철구',speciesId:297,level:18},
  {locationId:'mauville-city',badge:3,badgeName:'다이나모배지',name:'암페어',speciesId:82,level:23},
  {locationId:'lavaridge-town',badge:4,badgeName:'히트배지',name:'민지',speciesId:324,level:29},
  {locationId:'petalburg-city',badge:5,badgeName:'밸런스배지',name:'종길',speciesId:289,level:31},
  {locationId:'fortree-city',badge:6,badgeName:'페더배지',name:'은송',speciesId:334,level:33},
  {locationId:'mossdeep-city',badge:7,badgeName:'마인드배지',name:'풍&란',speciesId:338,level:42},
  {locationId:'sootopolis-city',badge:8,badgeName:'레인배지',name:'아단',speciesId:230,level:46},
];
const runtime = createAuthoredRegionSampler({ id: 'hoenn', locations: HOENN_LOCATIONS, connections: HOENN_CONNECTIONS,
  terrainFeatures: [{ locationId: 'hoenn-route-111', surface: 'desert', radius: 11, elevation: .42 }] });
export const hoennLocationAt = runtime.locationAt, distanceToHoennPath = runtime.distanceToPath, sampleHoennWorld = runtime.sample, evaluateHoennTraversal = runtime.evaluate, safeHoennArrival = runtime.safeArrival, nearestHoennWalkable=runtime.nearestWalkable, hoennBuildingOffsets=runtime.buildingOffsets;
