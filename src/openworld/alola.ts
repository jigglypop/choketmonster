import type { KantoGate, KantoGym, KantoLocation } from './kanto';
import { authoredLocation, createAuthoredRegionSampler } from './authored-region';
import { WORLD_SCALE } from './world-space';

export const ALOLA_MAP_VERSION='alola-authored-v1' as const;
export const ALOLA_START={x:-82*WORLD_SCALE,z:72*WORLD_SCALE} as const;
const l=(id:string,name:string,x:number,z:number,kind:Parameters<typeof authoredLocation>[5],levels:readonly[number,number],badges=0)=>authoredLocation('alola',id,name,x,z,kind,levels,badges);
export const ALOLA_LOCATIONS:readonly KantoLocation[]=[
 l('iki-town','릴리마을',-82,72,'town',[2,5]),l('alola-route-1','1번도로',-70,60,'route',[2,6]),l('hauoli-city','하우올리시티',-58,48,'town',[4,9]),l('alola-route-2','2번도로',-48,34,'route',[5,11]),l('verdant-cavern','우거진동굴',-40,22,'cave',[7,14]),
 l('alola-route-3','3번도로',-25,24,'route',[8,16]),l('melemele-meadow','멜레멜레화원',-15,14,'forest',[9,18]),l('heahea-city','환대시티',-8,34,'town',[11,21]),l('alola-route-4','4번도로',6,25,'route',[12,23]),l('paniola-town','오하나마을',12,19,'town',[13,24]),l('paniola-ranch','오하나목장',17,14,'route',[14,25]),
 l('alola-route-5','5번도로',28,5,'route',[15,27]),l('brooklet-hill','잔잔한물가언덕',38,15,'sea',[17,29]),l('lush-jungle','셰이드정글',38,-3,'forest',[19,31]),l('wela-volcano-park','벨라화산공원',25,-15,'cave',[20,33]),l('konikoni-city','코니코니시티',10,-22,'town',[22,35]),
 l('alola-route-8','8번도로',-3,-13,'route',[23,37]),l('malie-city','말리에시티',-20,-28,'town',[25,39]),l('malie-garden','말리에정원',-32,-18,'forest',[26,41]),l('alola-route-10','10번도로',-42,-32,'route',[28,43]),l('mount-hokulani','호쿠라니큰산',-52,-45,'cave',[30,45]),
 l('blush-mountain','화끈산',-30,-52,'cave',[31,47]),l('tapu-village','카푸마을',-8,-48,'town',[33,49]),l('alola-route-14','14번도로',7,-54,'sea',[34,51]),l('alola-route-15','15번수로',22,-47,'sea',[35,52]),l('alola-route-17','17번도로',38,-42,'route',[37,54]),
 l('seafolk-village','바다민족의마을',45,-37,'town',[38,55]),l('poni-wilds','포니들판',53,-28,'route',[39,56]),l('ancient-poni-path','포니옛길',64,-15,'route',[40,58]),l('vast-poni-canyon','포니대협곡',76,-3,'cave',[43,61],7),l('mount-lanakila','라나키라마운틴',82,18,'cave',[47,64],8),l('alola-pokemon-league','알로라리그',91,34,'special',[52,68],8),
];
export const ALOLA_CONNECTIONS:ReadonlyArray<readonly[string,string]>=ALOLA_LOCATIONS.slice(1).map((item,index)=>[ALOLA_LOCATIONS[index].id,item.id] as const);
export const ALOLA_GATES:readonly KantoGate[]=[];
export const ALOLA_GYMS:readonly KantoGym[]=[
 {locationId:'verdant-cavern',badge:1,badgeName:'일리마의인증',name:'일리마',speciesId:735,level:12},{locationId:'brooklet-hill',badge:2,badgeName:'수련의인증',name:'수련',speciesId:746,level:22},
 {locationId:'wela-volcano-park',badge:3,badgeName:'키아웨의인증',name:'키아웨',speciesId:758,level:27},{locationId:'lush-jungle',badge:4,badgeName:'마오의인증',name:'마오',speciesId:754,level:29},
 {locationId:'mount-hokulani',badge:5,badgeName:'마마네의인증',name:'마마네',speciesId:777,level:36},{locationId:'tapu-village',badge:6,badgeName:'아세로라의인증',name:'아세로라',speciesId:778,level:40},
 {locationId:'poni-wilds',badge:7,badgeName:'포니의인증',name:'하푸우',speciesId:750,level:47},{locationId:'vast-poni-canyon',badge:8,badgeName:'섬순례완주',name:'대협곡시련',speciesId:784,level:55},
];
const runtime=createAuthoredRegionSampler({id:'alola',locations:ALOLA_LOCATIONS,connections:ALOLA_CONNECTIONS});
export const alolaLocationAt=runtime.locationAt,distanceToAlolaPath=runtime.distanceToPath,sampleAlolaWorld=runtime.sample,evaluateAlolaTraversal=runtime.evaluate,safeAlolaArrival=runtime.safeArrival,nearestAlolaWalkable=runtime.nearestWalkable,alolaBuildingOffsets=runtime.buildingOffsets;
