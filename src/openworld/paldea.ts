import type { KantoGate, KantoGym, KantoLocation } from './kanto';
import { authoredLocation, createAuthoredRegionSampler } from './authored-region';
import { WORLD_SCALE } from './world-space';

/** Own connected 3D reconstruction of Paldea's open-world city and biome graph. */
export const PALDEA_MAP_VERSION='paldea-authored-v1' as const;
export const PALDEA_MAP_SOURCE={overview:'https://www.nintendo.com/us/store/products/pokemon-scarlet-114549/',mapNotes:'https://www.pokemon.com/us/news/adventure-from-kanto-to-paldea-with-the-pokemon-center-s-region-map-posters',reconstruction:true} as const;
export const PALDEA_START={x:-82*WORLD_SCALE,z:79*WORLD_SCALE} as const;
const l=(id:string,name:string,x:number,z:number,kind:Parameters<typeof authoredLocation>[5],levels:readonly[number,number],badges=0)=>authoredLocation('paldea',id,name,x,z,kind,levels,badges);
export const PALDEA_LOCATIONS:readonly KantoLocation[]=[
  l('cabo-poco','코사라 마을',-82,79,'town',[2,5]),l('south-province-area-one','남부 에리어 1',-70,65,'route',[3,9]),l('los-platos','플라토마을',-58,55,'town',[5,11]),l('mesagoza','테이블시티',-43,40,'town',[8,16]),
  l('south-province-area-two','남부 에리어 2',-58,27,'route',[8,16]),l('cortondo','세르클마을',-72,17,'town',[12,20]),l('west-province-area-one','서부 에리어 1',-52,3,'route',[14,24]),l('cascarrafa','카라프시티',-31,-5,'town',[18,28]),
  l('west-province-area-two','서부 에리어 2',-13,-22,'route',[25,38],2),l('medali','참푸르마을',3,-32,'town',[30,42],3),l('casseroya-lake','오야호수',-9,-52,'sea',[40,55],5),
  l('east-province-area-one','동부 에리어 1',-20,29,'route',[16,26]),l('artazon','보울마을',-4,19,'town',[17,27]),l('east-province-area-two','동부 에리어 2',14,9,'sea',[20,32],1),l('levincia','누룩스시티',31,2,'town',[24,35],2),
  l('tagtree-thicket','나페산 숲',35,-18,'forest',[28,42],3),l('montenevera','프리지마을',50,-38,'town',[38,52],5),l('glaseado-mountain','나페산',62,-54,'cave',[38,52],5),
  l('south-province-area-six','남부 에리어 6',7,30,'cave',[42,56],5),l('alfornada','베이크마을',25,43,'town',[44,57],6),l('paldea-pokemon-league','팔데아 포켓몬리그',-28,53,'special',[52,68],8),
  l('area-zero','에리어 제로',56,27,'special',[55,70],8),
];
export const PALDEA_CONNECTIONS:ReadonlyArray<readonly[string,string]>=[
  ['cabo-poco','south-province-area-one'],['south-province-area-one','los-platos'],['los-platos','mesagoza'],
  ['mesagoza','south-province-area-two'],['south-province-area-two','cortondo'],['cortondo','west-province-area-one'],['west-province-area-one','cascarrafa'],['cascarrafa','west-province-area-two'],['west-province-area-two','medali'],['medali','casseroya-lake'],
  ['mesagoza','east-province-area-one'],['east-province-area-one','artazon'],['artazon','east-province-area-two'],['east-province-area-two','levincia'],['levincia','tagtree-thicket'],['tagtree-thicket','montenevera'],['montenevera','glaseado-mountain'],['casseroya-lake','glaseado-mountain'],
  ['mesagoza','south-province-area-six'],['south-province-area-six','alfornada'],['mesagoza','paldea-pokemon-league'],['glaseado-mountain','area-zero'],['alfornada','area-zero'],
];
export const PALDEA_GATES:readonly KantoGate[]=[];
export const PALDEA_GYMS:readonly KantoGym[]=[
  {locationId:'cortondo',badge:1,badgeName:'버그배지',name:'단풍',speciesId:919,level:15},{locationId:'artazon',badge:2,badgeName:'그래스배지',name:'콜사',speciesId:185,level:18},
  {locationId:'levincia',badge:3,badgeName:'일렉트릭배지',name:'모야모',speciesId:429,level:24},{locationId:'cascarrafa',badge:4,badgeName:'워터배지',name:'곤포',speciesId:976,level:30},
  {locationId:'medali',badge:5,badgeName:'노말배지',name:'청목',speciesId:398,level:36},{locationId:'montenevera',badge:6,badgeName:'고스트배지',name:'라임',speciesId:849,level:42},
  {locationId:'alfornada',badge:7,badgeName:'사이킥배지',name:'리파',speciesId:956,level:48},{locationId:'glaseado-mountain',badge:8,badgeName:'아이스배지',name:'그루샤',speciesId:975,level:52},
];
const runtime=createAuthoredRegionSampler({id:'paldea',locations:PALDEA_LOCATIONS,connections:PALDEA_CONNECTIONS});
export const paldeaLocationAt=runtime.locationAt,distanceToPaldeaPath=runtime.distanceToPath,samplePaldeaWorld=runtime.sample,evaluatePaldeaTraversal=runtime.evaluate,safePaldeaArrival=runtime.safeArrival,nearestPaldeaWalkable=runtime.nearestWalkable,paldeaBuildingOffsets=runtime.buildingOffsets;
