import type { KantoGate, KantoGym, KantoLocation } from './kanto';
import { authoredLocation, createAuthoredRegionSampler } from './authored-region';
import { WORLD_SCALE } from './world-space';

export const KALOS_MAP_VERSION='kalos-authored-v1' as const;
export const KALOS_START={x:-78*WORLD_SCALE,z:78*WORLD_SCALE} as const;
const l=(id:string,name:string,x:number,z:number,kind:Parameters<typeof authoredLocation>[5],levels:readonly[number,number],badges=0)=>authoredLocation('kalos',id,name,x,z,kind,levels,badges);
export const KALOS_LOCATIONS:readonly KantoLocation[]=[
  l('vaniville-town','조아마을',-78,78,'town',[2,4]),l('kalos-route-2','2번도로',-68,65,'route',[2,5]),l('santalune-forest','백단숲',-60,52,'forest',[3,7]),l('santalune-city','백단시티',-52,40,'town',[5,10]),
  l('kalos-route-3','3번도로',-40,34,'route',[5,11]),l('kalos-route-5','5번도로',-22,23,'route',[8,15]),l('lumiose-city','미르시티',-5,18,'town',[10,18]),l('kalos-route-7','7번도로',-25,4,'route',[12,20]),
  l('cyllage-city','삼채시티',-48,-10,'town',[14,23]),l('kalos-route-8','8번도로',-58,-25,'route',[15,25]),l('glittering-cave','반짝임의동굴',-65,-39,'cave',[17,27]),l('kalos-route-10','10번도로',-40,-35,'route',[18,29]),
  l('geosenge-town','옥유마을',-22,-38,'town',[20,31]),l('reflection-cave','비춤의동굴',-3,-40,'cave',[22,34]),l('shalour-city','사라시티',12,-34,'town',[23,36]),l('kalos-route-12','12번도로',28,-25,'route',[24,38]),
  l('coumarine-city','비익시티',43,-17,'town',[26,40]),l('kalos-route-14','14번도로',34,1,'route',[27,42]),l('laverre-city','후늬시티',25,17,'town',[29,44]),l('kalos-route-15','15번도로',43,28,'forest',[30,46]),
  l('dendemille-town','버들비마을',58,18,'town',[31,47]),l('frost-cavern','프로스트케이브',67,3,'cave',[32,49]),l('kalos-route-18','18번도로',65,36,'route',[34,51]),l('anistar-city','향전시티',78,38,'town',[35,52]),
  l('kalos-route-19','19번도로',64,56,'route',[37,54]),l('snowbelle-city','이설시티',48,67,'town',[39,56]),l('kalos-route-21','21번도로',65,76,'route',[42,59],8),l('kalos-victory-road','챔피언로드',82,72,'cave',[46,63],8),l('kalos-pokemon-league','칼로스리그',96,70,'special',[52,68],8),
];
export const KALOS_CONNECTIONS:ReadonlyArray<readonly[string,string]>=KALOS_LOCATIONS.slice(1).map((item,index)=>[KALOS_LOCATIONS[index].id,item.id] as const);
export const KALOS_GATES:readonly KantoGate[]=[];
export const KALOS_GYMS:readonly KantoGym[]=[
  {locationId:'santalune-city',badge:1,badgeName:'버그배지',name:'비올라',speciesId:666,level:12},{locationId:'cyllage-city',badge:2,badgeName:'월배지',name:'자크로',speciesId:699,level:25},
  {locationId:'shalour-city',badge:3,badgeName:'파이트배지',name:'코르니',speciesId:701,level:32},{locationId:'coumarine-city',badge:4,badgeName:'플랜트배지',name:'후쿠지',speciesId:673,level:34},
  {locationId:'lumiose-city',badge:5,badgeName:'볼티지배지',name:'시트론',speciesId:695,level:37},{locationId:'laverre-city',badge:6,badgeName:'페어리배지',name:'마슈',speciesId:700,level:42},
  {locationId:'anistar-city',badge:7,badgeName:'사이킥배지',name:'고지카',speciesId:678,level:48},{locationId:'snowbelle-city',badge:8,badgeName:'아이스버그배지',name:'우르프',speciesId:713,level:59},
];
const runtime=createAuthoredRegionSampler({id:'kalos',locations:KALOS_LOCATIONS,connections:KALOS_CONNECTIONS});
export const kalosLocationAt=runtime.locationAt,distanceToKalosPath=runtime.distanceToPath,sampleKalosWorld=runtime.sample,evaluateKalosTraversal=runtime.evaluate,safeKalosArrival=runtime.safeArrival,nearestKalosWalkable=runtime.nearestWalkable,kalosBuildingOffsets=runtime.buildingOffsets;
