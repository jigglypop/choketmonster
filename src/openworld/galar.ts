import type { KantoGate, KantoGym, KantoLocation } from './kanto';
import { terrainProgressGates } from './progression-gates';
import { authoredLocation, createAuthoredRegionSampler } from './authored-region';
import { WORLD_SCALE } from './world-space';

/** Own 3D reconstruction from the official Galar map and Wild Area relationship. */
export const GALAR_MAP_VERSION = 'galar-authored-v1' as const;
export const GALAR_MAP_SOURCE = {
  region: 'https://swordshield.pokemon.com/en-us/story/the-galar-region/',
  wildArea: 'https://swordshield.pokemon.com/en-us/gameplay/wild-area/',
  reconstruction: true,
} as const;
export const GALAR_START = { x: -82 * WORLD_SCALE, z: 80 * WORLD_SCALE } as const;
const l = (id:string,name:string,x:number,z:number,kind:Parameters<typeof authoredLocation>[5],levels:readonly[number,number],badges=0) => authoredLocation('galar',id,name,x,z,kind,levels,badges);
export const GALAR_LOCATIONS: readonly KantoLocation[] = [
  l('postwick','펄롱마을',-82,80,'town',[2,5]), l('slumbering-weald','꾸벅졸음숲',-92,65,'forest',[2,6]),
  l('galar-route-1','1번도로',-70,68,'route',[2,6]), l('wedgehurst','브래시마을',-61,59,'town',[3,7]), l('galar-route-2','2번도로',-51,50,'route',[4,9]),
  l('dappled-grove','터검니호 동쪽 숲',-40,39,'forest',[8,15]), l('east-lake-axewell','터검니호 동쪽',-29,31,'sea',[8,16]),
  l('motostoke','엔진시티',-18,24,'town',[10,18]), l('galar-route-3','3번도로',-30,11,'route',[10,19]), l('motostoke-outskirts','엔진시티 변두리',-42,2,'route',[14,23]),
  l('galar-route-4','4번도로',-55,-5,'route',[14,24]), l('turffield','터프마을',-68,-14,'town',[17,25]), l('galar-route-5','5번도로',-52,-25,'route',[18,27],1),
  l('hulbury','바우마을',-34,-31,'town',[20,29],1), l('south-lake-miloch','밀로틱호 남쪽',-14,-18,'sea',[11,20],1), l('bridge-field','다리아래 벌판',2,-15,'route',[20,32],3),
  l('hammerlocke','너클시티',12,-30,'town',[25,36],3), l('galar-route-6','6번도로',27,-18,'route',[28,39],3), l('stow-on-side','래터럴마을',41,-8,'town',[30,41],3),
  l('glimwood-tangle','루미너스메이즈숲',48,-24,'forest',[32,44],4), l('ballonlea','아라베스크마을',58,-35,'town',[34,46],4),
  l('galar-route-7','7번도로',28,-42,'route',[35,48],5), l('galar-route-8','8번도로',42,-55,'route',[38,51],5), l('circhester','키르쿠스마을',61,-59,'town',[40,53],5),
  l('galar-route-9','9번도로',75,-44,'sea',[42,55],6), l('spikemuth','스파이크마을',83,-27,'town',[44,57],6),
  l('galar-route-10','10번도로',72,-5,'route',[46,60],8), l('wyndon','슛시티',78,18,'town',[50,64],8), l('galar-pokemon-league','챔피언컵',88,31,'special',[55,70],8),
  l('energy-plant','에너지플랜트',12,-44,'special',[55,65],8), l('split-decision-ruins','결단의유적',61,-73,'special',[55,65],8),
];
export const GALAR_CONNECTIONS: ReadonlyArray<readonly[string,string]> = [
  ['postwick','slumbering-weald'],['postwick','galar-route-1'],['galar-route-1','wedgehurst'],['wedgehurst','galar-route-2'],['galar-route-2','dappled-grove'],['dappled-grove','east-lake-axewell'],['east-lake-axewell','motostoke'],
  ['motostoke','galar-route-3'],['galar-route-3','motostoke-outskirts'],['motostoke-outskirts','galar-route-4'],['galar-route-4','turffield'],['turffield','galar-route-5'],['galar-route-5','hulbury'],
  ['hulbury','south-lake-miloch'],['south-lake-miloch','bridge-field'],['bridge-field','hammerlocke'],['hammerlocke','galar-route-6'],['galar-route-6','stow-on-side'],['stow-on-side','glimwood-tangle'],['glimwood-tangle','ballonlea'],
  ['hammerlocke','galar-route-7'],['galar-route-7','galar-route-8'],['galar-route-8','circhester'],['circhester','galar-route-9'],['galar-route-9','spikemuth'],['spikemuth','galar-route-10'],['galar-route-10','wyndon'],['wyndon','galar-pokemon-league'],
  ['hammerlocke','energy-plant'],['circhester','split-decision-ruins'],
];
export const GALAR_GYMS: readonly KantoGym[] = [
  {locationId:'turffield',badge:1,badgeName:'풀배지',name:'아킬',speciesId:830,level:20}, {locationId:'hulbury',badge:2,badgeName:'물배지',name:'야청',speciesId:834,level:24},
  {locationId:'motostoke',badge:3,badgeName:'불꽃배지',name:'순무',speciesId:851,level:27}, {locationId:'stow-on-side',badge:4,badgeName:'격투배지',name:'채두',speciesId:68,level:36},
  {locationId:'ballonlea',badge:5,badgeName:'페어리배지',name:'포플러',speciesId:869,level:38}, {locationId:'circhester',badge:6,badgeName:'바위배지',name:'마쿠와',speciesId:839,level:42},
  {locationId:'spikemuth',badge:7,badgeName:'악배지',name:'두송',speciesId:862,level:46}, {locationId:'hammerlocke',badge:8,badgeName:'드래곤배지',name:'금랑',speciesId:884,level:48},
];
const runtime=createAuthoredRegionSampler({id:'galar',locations:GALAR_LOCATIONS,connections:GALAR_CONNECTIONS});
export const GALAR_GATES: readonly KantoGate[] = terrainProgressGates(GALAR_LOCATIONS, GALAR_CONNECTIONS, runtime.locationAt, GALAR_GYMS, '배지');
export const galarLocationAt=runtime.locationAt,distanceToGalarPath=runtime.distanceToPath,sampleGalarWorld=runtime.sample,evaluateGalarTraversal=runtime.evaluate,safeGalarArrival=runtime.safeArrival,nearestGalarWalkable=runtime.nearestWalkable,galarBuildingOffsets=runtime.buildingOffsets;
