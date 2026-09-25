import type { KantoGym, KantoLocation } from './kanto';
import { terrainProgressGates } from './progression-gates';
import { authoredLocation, createAuthoredRegionSampler } from './authored-region';
import { WORLD_SCALE } from './world-space';

/** Hub-and-expedition reconstruction; trial stages are game balance, not gyms from Legends: Arceus. */
export const HISUI_MAP_VERSION='hisui-authored-v1' as const;
export const HISUI_MAP_SOURCE={story:'https://legends.arceus.pokemon.com/en-us/story/',reconstruction:true} as const;
export const HISUI_START={x:-80*WORLD_SCALE,z:72*WORLD_SCALE} as const;
const l=(id:string,name:string,x:number,z:number,kind:Parameters<typeof authoredLocation>[5],levels:readonly[number,number],badges=0)=>authoredLocation('hisui',id,name,x,z,kind,levels,badges);
export const HISUI_LOCATIONS:readonly KantoLocation[]=[
  l('jubilife-village','축복마을',-80,72,'town',[2,6]),l('aspiration-hill','큰뜻의 언덕',-65,57,'route',[3,8]),l('fieldlands-camp','들판 기지',-52,50,'town',[4,10]),l('deertrack-path','사슴신령 길',-42,36,'forest',[7,14]),l('grandtree-arena','거목의 전장',-29,25,'special',[12,20]),
  l('mirelands-camp','습지 기지',-25,47,'town',[16,25],1),l('crimson-mirelands','홍련 습지',-8,35,'sea',[18,28],1),l('brava-arena','무대의 전장',5,24,'special',[24,32],1),
  l('coastlands-camp','해안 기지',-5,3,'town',[25,34],2),l('cobalt-coastlands','군청 해안',15,8,'sea',[28,38],2),l('molten-arena','용암의 전장',31,16,'special',[32,42],2),
  l('highlands-camp','산기슭 기지',14,-18,'town',[34,44],3),l('coronet-highlands','천관산 기슭',29,-28,'cave',[38,50],3),l('moonview-arena','영월의 전장',45,-21,'special',[43,54],4),
  l('icelands-camp','동토 기지',43,-50,'town',[46,58],5),l('alabaster-icelands','순백 동토',60,-56,'route',[48,60],5),l('icepeak-arena','빙산의 전장',75,-48,'special',[52,64],6),
  l('temple-of-sinnoh','신오신전',84,-72,'special',[58,70],7),
  l('hisui-verity-cavern','진실호수 동굴',-51,26,'cave',[55,65],8),l('hisui-valor-cavern','입지호수 동굴',-25,61,'cave',[55,65],8),l('hisui-acuity-cavern','예지호수 동굴',60,-69,'cave',[60,70],8),
  l('firespit-island','불꽃섬',-13,-8,'cave',[60,70],8),l('hisui-snowpoint-temple','선단신전',43,-64,'special',[60,70],8),l('hisui-turnback-cave','돌아오는동굴',10,-31,'cave',[65,75],8),
];
export const HISUI_CONNECTIONS:ReadonlyArray<readonly[string,string]>=[
  ['jubilife-village','aspiration-hill'],['aspiration-hill','fieldlands-camp'],['fieldlands-camp','deertrack-path'],['deertrack-path','grandtree-arena'],
  ['jubilife-village','mirelands-camp'],['mirelands-camp','crimson-mirelands'],['crimson-mirelands','brava-arena'],['jubilife-village','coastlands-camp'],['coastlands-camp','cobalt-coastlands'],['cobalt-coastlands','molten-arena'],
  ['jubilife-village','highlands-camp'],['highlands-camp','coronet-highlands'],['coronet-highlands','moonview-arena'],['jubilife-village','icelands-camp'],['icelands-camp','alabaster-icelands'],['alabaster-icelands','icepeak-arena'],['moonview-arena','temple-of-sinnoh'],['icepeak-arena','temple-of-sinnoh'],
  ['deertrack-path','hisui-verity-cavern'],['mirelands-camp','hisui-valor-cavern'],['alabaster-icelands','hisui-acuity-cavern'],['coastlands-camp','firespit-island'],['icelands-camp','hisui-snowpoint-temple'],['highlands-camp','hisui-turnback-cave'],
];
export const HISUI_GYMS:readonly KantoGym[]=[
  {locationId:'grandtree-arena',badge:1,badgeName:'들판 조사증',name:'사마자르 진정',speciesId:900,level:18},{locationId:'brava-arena',badge:2,badgeName:'습지 조사증',name:'드레디어 진정',speciesId:549,level:28},
  {locationId:'molten-arena',badge:3,badgeName:'해안 조사증',name:'윈디 진정',speciesId:59,level:36},{locationId:'coronet-highlands',badge:4,badgeName:'산기슭 조사증',name:'천관산 조사',speciesId:904,level:43},
  {locationId:'moonview-arena',badge:5,badgeName:'영월 조사증',name:'붐볼 진정',speciesId:101,level:48},{locationId:'alabaster-icelands',badge:6,badgeName:'동토 조사증',name:'순백 동토 조사',speciesId:903,level:53},
  {locationId:'icepeak-arena',badge:7,badgeName:'빙산 조사증',name:'크레베이스 진정',speciesId:713,level:58},{locationId:'temple-of-sinnoh',badge:8,badgeName:'신오 조사증',name:'신오신전 조사',speciesId:905,level:65},
];
const runtime=createAuthoredRegionSampler({id:'hisui',locations:HISUI_LOCATIONS,connections:HISUI_CONNECTIONS,terrainFeatures:[
  {locationId:'alabaster-icelands',surface:'snow',radius:16,elevation:.6},
  {locationId:'icelands-camp',surface:'snow',radius:9,elevation:.35},
  {locationId:'icepeak-arena',surface:'snow',radius:8,elevation:.5},
  {locationId:'hisui-snowpoint-temple',surface:'snow',radius:7,elevation:.5},
  {locationId:'crimson-mirelands',surface:'marsh',radius:16,elevation:0},
  {locationId:'mirelands-camp',surface:'marsh',radius:9,elevation:0},
]});
export const HISUI_GATES = terrainProgressGates(HISUI_LOCATIONS, HISUI_CONNECTIONS, runtime.locationAt, HISUI_GYMS, '조사증');
export const hisuiLocationAt=runtime.locationAt,distanceToHisuiPath=runtime.distanceToPath,sampleHisuiWorld=runtime.sample,evaluateHisuiTraversal=runtime.evaluate,safeHisuiArrival=runtime.safeArrival,nearestHisuiWalkable=runtime.nearestWalkable,hisuiBuildingOffsets=runtime.buildingOffsets;
