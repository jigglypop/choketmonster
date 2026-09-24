import type { KantoGate, KantoGym, KantoLocation } from './kanto';
import { authoredLocation, createAuthoredRegionSampler } from './authored-region';
import { terrainProgressGates } from './progression-gates';
import { WORLD_SCALE } from './world-space';

export const SINNOH_MAP_VERSION = 'sinnoh-authored-v1' as const;
export const SINNOH_START = { x: -72 * WORLD_SCALE, z: 78 * WORLD_SCALE } as const;
const l = (id: string, name: string, x: number, z: number, kind: Parameters<typeof authoredLocation>[5], levels: readonly [number, number], badges = 0) => authoredLocation('sinnoh', id, name, x, z, kind, levels, badges);
/**
 * requiredBadges follows Diamond/Pearl, the order of SINNOH_GYMS: badges held when a place first opens.
 * 1: Route 204 north of Jubilife. 2: Cycling Road needs the Eterna bicycle, which also climbs Route 207 into Mt. Coronet.
 * 3: Route 209 on to Veilstone. 4: Routes 214, 213 and 212 to Pastoria. 5: SecretPotion clears the Route 210 Psyduck;
 * Surf (Fen Badge) crosses Route 218 to Canalave and opens Lake Verity's water. 6: Strength crosses Mt. Coronet to Route 216; boat to Iron Island.
 * 7: Route 222 after the Spear Pillar. 8: Waterfall on Route 223, the League and the legendary lairs.
 */
export const SINNOH_LOCATIONS: readonly KantoLocation[] = [
  l('twinleaf-town','떡잎마을',-72,78,'town',[2,4]), l('sinnoh-route-201','201번도로',-62,66,'route',[2,5]), l('lake-verity','진실호수',-82,61,'sea',[3,6],5),
  l('sandgem-town','잔모래마을',-48,66,'town',[3,6]), l('sinnoh-route-202','202번도로',-48,49,'route',[3,7]), l('jubilife-city','축복시티',-48,32,'town',[5,10]),
  l('sinnoh-route-203','203번도로',-29,32,'route',[5,10]), l('oreburgh-gate','무쇠게이트',-15,32,'cave',[6,11]), l('oreburgh-city','무쇠시티',0,32,'town',[7,13]),
  l('sinnoh-route-207','207번도로',0,15,'route',[8,15],2), l('mt-coronet','천관산',15,0,'cave',[12,38],2), l('sinnoh-route-208','208번도로',0,-12,'route',[12,20],2),
  l('hearthome-city','연고시티',-18,-12,'town',[16,25],2), l('sinnoh-route-209','209번도로',-3,-28,'route',[16,25],3), l('solaceon-town','신수마을',11,-38,'town',[18,28],3),
  l('sinnoh-route-210','210번도로',11,-55,'route',[20,31],3), l('celestic-town','봉신마을',-8,-64,'town',[22,34],5), l('sinnoh-route-211','211번도로',12,-64,'route',[22,35],5),
  l('eterna-city','영원시티',-45,-34,'town',[14,23],1), l('eterna-forest','영원의숲',-58,-21,'forest',[10,19],1), l('sinnoh-route-205','205번도로',-48,-7,'route',[9,18],1),
  l('floaroma-town','꽃향기마을',-61,5,'town',[8,16],1), l('sinnoh-route-204','204번도로',-54,18,'route',[6,13],1), l('sinnoh-route-206','206번도로',-31,-20,'route',[12,22],2),
  l('sinnoh-route-212','212번도로',-18,8,'route',[18,30],4), l('pastoria-city','들판시티',-5,18,'town',[22,34],4), l('sinnoh-route-213','213번도로',14,28,'route',[23,35],4),
  l('sinnoh-route-214','214번도로',31,10,'route',[24,36],4), l('veilstone-city','장막시티',31,-12,'town',[24,37],3), l('sinnoh-route-215','215번도로',15,-25,'route',[24,37],3),
  l('sinnoh-route-216','216번도로',31,-45,'route',[28,42],6), l('sinnoh-route-217','217번도로',42,-63,'route',[30,45],6), l('snowpoint-city','선단시티',56,-72,'town',[32,48],6),
  l('lake-acuity','예지호수',70,-66,'sea',[34,50],6), l('sinnoh-route-222','222번도로',58,12,'route',[32,46],7), l('sunyshore-city','물가시티',76,12,'town',[35,50],7),
  l('sinnoh-sea-route-223','223번수로',87,-6,'sea',[38,54],8), l('sinnoh-victory-road','챔피언로드',91,-27,'cave',[42,58],8), l('sinnoh-pokemon-league','포켓몬리그',91,-45,'special',[50,65],8),
  l('sinnoh-route-218','218번도로',-68,32,'route',[18,30],5), l('canalave-city','운하시티',-88,32,'town',[26,40],5), l('iron-island','강철섬',-100,8,'cave',[30,45],6),
  // Legendary lairs open after the eighth badge.
  l('spear-pillar','창기둥',20.5,6,'special',[60,70],8), l('turnback-cave','돌아오는동굴',39,18,'cave',[45,60],8), l('stark-mountain','하드마운틴',64,1,'cave',[55,65],8),
  l('snowpoint-temple','선단신전',56,-83,'special',[45,60],8), l('verity-cavern','진실호수 동굴',-63,55,'cave',[45,55],8), l('acuity-cavern','예지호수 동굴',40,-74,'cave',[45,55],8),
  l('valor-cavern','입지호수 동굴',21,37,'cave',[45,55],8),
];
export const SINNOH_CONNECTIONS: ReadonlyArray<readonly [string,string]> = [
  ['twinleaf-town','sinnoh-route-201'],['sinnoh-route-201','lake-verity'],['sinnoh-route-201','sandgem-town'],['sandgem-town','sinnoh-route-202'],['sinnoh-route-202','jubilife-city'],['jubilife-city','sinnoh-route-203'],['sinnoh-route-203','oreburgh-gate'],['oreburgh-gate','oreburgh-city'],['oreburgh-city','sinnoh-route-207'],['sinnoh-route-207','mt-coronet'],['mt-coronet','sinnoh-route-208'],['sinnoh-route-208','hearthome-city'],
  ['jubilife-city','sinnoh-route-204'],['sinnoh-route-204','floaroma-town'],['floaroma-town','sinnoh-route-205'],['sinnoh-route-205','eterna-forest'],['eterna-forest','eterna-city'],['eterna-city','sinnoh-route-206'],['sinnoh-route-206','sinnoh-route-207'],
  ['hearthome-city','sinnoh-route-209'],['sinnoh-route-209','solaceon-town'],['solaceon-town','sinnoh-route-210'],['sinnoh-route-210','celestic-town'],['celestic-town','sinnoh-route-211'],['sinnoh-route-211','mt-coronet'],
  ['hearthome-city','sinnoh-route-212'],['sinnoh-route-212','pastoria-city'],['pastoria-city','sinnoh-route-213'],['sinnoh-route-213','sinnoh-route-214'],['sinnoh-route-214','veilstone-city'],['veilstone-city','sinnoh-route-215'],['sinnoh-route-215','solaceon-town'],
  ['mt-coronet','sinnoh-route-216'],['sinnoh-route-216','sinnoh-route-217'],['sinnoh-route-217','snowpoint-city'],['snowpoint-city','lake-acuity'],['veilstone-city','sinnoh-route-222'],['sinnoh-route-222','sunyshore-city'],['sunyshore-city','sinnoh-sea-route-223'],['sinnoh-sea-route-223','sinnoh-victory-road'],['sinnoh-victory-road','sinnoh-pokemon-league'],
  ['jubilife-city','sinnoh-route-218'],['sinnoh-route-218','canalave-city'],['canalave-city','iron-island'],
  ['mt-coronet','spear-pillar'],['sinnoh-route-214','turnback-cave'],['sinnoh-route-222','stark-mountain'],['snowpoint-city','snowpoint-temple'],
  ['sinnoh-route-201','verity-cavern'],['sinnoh-route-217','acuity-cavern'],['sinnoh-route-213','valor-cavern'],
];
export const SINNOH_SURFACE_CONNECTIONS = SINNOH_CONNECTIONS;
export const SINNOH_GYMS: readonly KantoGym[] = [
  {locationId:'oreburgh-city',badge:1,badgeName:'콜배지',name:'강석',speciesId:408,level:14},
  {locationId:'eterna-city',badge:2,badgeName:'포리스트배지',name:'유채',speciesId:407,level:22},
  {locationId:'hearthome-city',badge:3,badgeName:'레릭배지',name:'멜리사',speciesId:429,level:26},
  {locationId:'veilstone-city',badge:4,badgeName:'코블배지',name:'자두',speciesId:448,level:32},
  {locationId:'pastoria-city',badge:5,badgeName:'펜배지',name:'맥실러',speciesId:419,level:37},
  {locationId:'canalave-city',badge:6,badgeName:'마인배지',name:'동관',speciesId:411,level:41},
  {locationId:'snowpoint-city',badge:7,badgeName:'글레이셔배지',name:'무청',speciesId:478,level:44},
  {locationId:'sunyshore-city',badge:8,badgeName:'비컨배지',name:'전진',speciesId:466,level:50},
];
const runtime = createAuthoredRegionSampler({ id:'sinnoh', locations:SINNOH_LOCATIONS, connections:SINNOH_CONNECTIONS, terrainFeatures: [
  { locationId: 'mt-coronet', surface: 'mountain', radius: 14, elevation: .9 },
  { locationId: 'sinnoh-route-216', surface: 'snow', radius: 10, elevation: .75 },
  { locationId: 'sinnoh-route-217', surface: 'snow', radius: 12, elevation: 1.15 },
] });
export const SINNOH_GATES: readonly KantoGate[] = terrainProgressGates(SINNOH_LOCATIONS, SINNOH_CONNECTIONS, runtime.locationAt, SINNOH_GYMS, '배지');
export const sinnohLocationAt=runtime.locationAt, distanceToSinnohPath=runtime.distanceToPath, sampleSinnohWorld=runtime.sample, evaluateSinnohTraversal=runtime.evaluate, safeSinnohArrival=runtime.safeArrival,nearestSinnohWalkable=runtime.nearestWalkable,sinnohBuildingOffsets=runtime.buildingOffsets;
