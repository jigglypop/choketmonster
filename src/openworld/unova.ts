import type { KantoGate, KantoGym, KantoLocation } from './kanto';
import { authoredLocation, createAuthoredRegionSampler } from './authored-region';
import { terrainProgressGates } from './progression-gates';
import { WORLD_SCALE } from './world-space';

export const UNOVA_MAP_VERSION = 'unova-authored-v1' as const;
export const UNOVA_START = { x: 0, z: 92 * WORLD_SCALE } as const;
const l = (id:string,name:string,x:number,z:number,kind:Parameters<typeof authoredLocation>[5],levels:readonly [number,number],badges=0)=>authoredLocation('unova',id,name,x,z,kind,levels,badges);
/**
 * requiredBadges follows Black/White: badges held when a place first opens. 1: Route 3 after the Striaton Gym and the Dreamyard.
 * 2: Pinwheel Forest and Skyarrow Bridge after Nacrene. 3: Route 4 to Nimbasa. 4: Driftveil Drawbridge lowers after Elesa.
 * 5: Route 6 and Chargestone Cave after Clay. 6: Twist Mountain after Skyla. 7: Dragonspiral Tower and Routes 8-9 to Opelucid.
 * 8: Route 10's badge gates, the post-game east (Routes 11-15, Lacunosa, Undella) and the legendary lairs.
 * Terrain ownership keeps three places earlier: the Nacrene-Pinwheel-Skyarrow road runs over Route 7 and Celestial Tower,
 * and Route 9's road to Opelucid over Village Bridge, so those open with the road that crosses them.
 */
export const UNOVA_LOCATIONS: readonly KantoLocation[] = [
  l('nuvema-town','마름꽃마을',0,92,'town',[2,5]),l('unova-route-1','1번도로',0,77,'route',[2,6]),l('accumula-town','넝쿨마을',0,63,'town',[3,7]),
  l('unova-route-2','2번도로',-12,50,'route',[4,9]),l('striaton-city','성신시티',-24,38,'town',[6,12]),l('dreamyard','꿈터',-37,38,'special',[7,14]),
  l('unova-route-3','3번도로',-12,24,'route',[7,14],1),l('wellspring-cave','지하수맥굴',-27,17,'cave',[8,16],1),l('nacrene-city','칠보시티',0,10,'town',[10,18],1),
  l('pinwheel-forest','바람개비숲',9,-5,'forest',[12,21],2),l('skyarrow-bridge','스카이애로브리지',20,-18,'route',[14,23],2),l('castelia-city','구름시티',32,-25,'town',[15,25],2),
  l('unova-route-4','4번도로',32,-42,'route',[16,27],3),l('desert-resort','리조트데저트',48,-45,'special',[18,30],3),l('relic-castle','고대의성',58,-51,'cave',[20,32],3),
  l('nimbasa-city','뇌문시티',32,-58,'town',[20,32],3),l('unova-route-5','5번도로',15,-58,'route',[21,34],3),l('driftveil-drawbridge','물풍경도개교',2,-58,'route',[22,35],4),
  l('driftveil-city','물풍경시티',-12,-58,'town',[23,36],4),l('cold-storage','냉동컨테이너',-22,-45,'special',[23,37],4),l('unova-route-6','6번도로',-12,-39,'route',[24,38],5),
  l('chargestone-cave','전기돌동굴',-12,-20,'cave',[26,40],5),l('mistralton-city','궐수시티',-12,-2,'town',[28,42],5),l('unova-route-7','7번도로',2,-2,'route',[29,44],2),
  l('celestial-tower','타워오브해븐',9,-14,'special',[30,45],2),l('twist-mountain','태엽산',18,-2,'cave',[31,46],6),l('icirrus-city','설화시티',34,-2,'town',[32,48],6),
  l('dragonspiral-tower','용나선탑',43,-15,'special',[34,50],7),l('unova-route-8','8번도로',48,9,'route',[33,49],7),l('moor-of-icirrus','설화의습지초원',58,3,'forest',[34,50],7),
  l('unova-route-9','9번도로',48,25,'route',[35,52],7),l('opelucid-city','쌍용시티',48,40,'town',[36,54],7),l('unova-route-10','10번도로',62,52,'route',[38,56],8),
  l('unova-victory-road','챔피언로드',75,63,'cave',[42,60],8),l('unova-pokemon-league','포켓몬리그',88,72,'special',[50,65],8),
  l('unova-route-16','16번도로',49,-58,'route',[22,36],3),l('lostlorn-forest','미혹의숲',64,-51,'forest',[24,39],3),l('unova-route-15','15번도로',76,-37,'route',[30,46],8),
  l('unova-route-14','14번도로',76,-19,'route',[31,47],8),l('undella-town','물결마을',76,-1,'town',[32,48],8),l('unova-route-13','13번도로',76,17,'route',[33,50],8),
  l('lacunosa-town','보배마을',66,26,'town',[34,51],8),l('unova-route-12','12번도로',58,32,'route',[34,52],8),l('village-bridge','빌리지브리지',48,28,'route',[35,53],7),
  l('unova-route-11','11번도로',40,34,'route',[35,53],8),
  // Legendary lairs open after the eighth badge.
  l('giant-chasm','자이언트홀',87,20,'cave',[50,60],8),l('abundant-shrine','풍요의사당',87,-19,'special',[45,55],8),l('mistralton-cave','궐수동굴',-23,-5,'cave',[45,55],8),
];
export const UNOVA_CONNECTIONS: ReadonlyArray<readonly [string,string]> = [
 ['nuvema-town','unova-route-1'],['unova-route-1','accumula-town'],['accumula-town','unova-route-2'],['unova-route-2','striaton-city'],['striaton-city','dreamyard'],['striaton-city','unova-route-3'],['unova-route-3','wellspring-cave'],['unova-route-3','nacrene-city'],['nacrene-city','pinwheel-forest'],['pinwheel-forest','skyarrow-bridge'],['skyarrow-bridge','castelia-city'],['castelia-city','unova-route-4'],['unova-route-4','desert-resort'],['desert-resort','relic-castle'],['unova-route-4','nimbasa-city'],
 ['nimbasa-city','unova-route-5'],['unova-route-5','driftveil-drawbridge'],['driftveil-drawbridge','driftveil-city'],['driftveil-city','cold-storage'],['driftveil-city','unova-route-6'],['unova-route-6','chargestone-cave'],['chargestone-cave','mistralton-city'],['mistralton-city','unova-route-7'],['unova-route-7','celestial-tower'],['unova-route-7','twist-mountain'],['twist-mountain','icirrus-city'],['icirrus-city','dragonspiral-tower'],['icirrus-city','unova-route-8'],['unova-route-8','moor-of-icirrus'],['unova-route-8','unova-route-9'],['unova-route-9','opelucid-city'],['opelucid-city','unova-route-10'],['unova-route-10','unova-victory-road'],['unova-victory-road','unova-pokemon-league'],
 ['nimbasa-city','unova-route-16'],['unova-route-16','lostlorn-forest'],['lostlorn-forest','unova-route-15'],['unova-route-15','unova-route-14'],['unova-route-14','undella-town'],['undella-town','unova-route-13'],['unova-route-13','lacunosa-town'],['lacunosa-town','unova-route-12'],['unova-route-12','village-bridge'],['village-bridge','unova-route-11'],['unova-route-11','opelucid-city'],
 // Places whose ground already overlaps: each opens with the road that crosses it (see UNOVA_LOCATIONS).
 ['pinwheel-forest','unova-route-7'],['unova-route-9','village-bridge'],
 ['unova-route-13','giant-chasm'],['unova-route-14','abundant-shrine'],['mistralton-city','mistralton-cave'],
];
export const UNOVA_SURFACE_CONNECTIONS=UNOVA_CONNECTIONS; export const UNOVA_GYMS:readonly KantoGym[]=[
 {locationId:'striaton-city',badge:1,badgeName:'트라이배지',name:'덴트',speciesId:511,level:14},
 {locationId:'nacrene-city',badge:2,badgeName:'베이직배지',name:'알로에',speciesId:505,level:20},
 {locationId:'castelia-city',badge:3,badgeName:'비틀배지',name:'아티',speciesId:542,level:23},
 {locationId:'nimbasa-city',badge:4,badgeName:'볼트배지',name:'카밀레',speciesId:523,level:27},
 {locationId:'driftveil-city',badge:5,badgeName:'퀘이크배지',name:'야콘',speciesId:530,level:31},
 {locationId:'mistralton-city',badge:6,badgeName:'제트배지',name:'풍란',speciesId:581,level:35},
 {locationId:'icirrus-city',badge:7,badgeName:'아이시클배지',name:'담죽',speciesId:614,level:39},
 {locationId:'opelucid-city',badge:8,badgeName:'레전드배지',name:'아이리스',speciesId:612,level:43},
];
const runtime=createAuthoredRegionSampler({id:'unova',locations:UNOVA_LOCATIONS,connections:UNOVA_CONNECTIONS});
export const UNOVA_GATES:readonly KantoGate[]=terrainProgressGates(UNOVA_LOCATIONS,UNOVA_CONNECTIONS,runtime.locationAt,UNOVA_GYMS,'배지');
export const unovaLocationAt=runtime.locationAt,distanceToUnovaPath=runtime.distanceToPath,sampleUnovaWorld=runtime.sample,evaluateUnovaTraversal=runtime.evaluate,safeUnovaArrival=runtime.safeArrival,nearestUnovaWalkable=runtime.nearestWalkable,unovaBuildingOffsets=runtime.buildingOffsets;
