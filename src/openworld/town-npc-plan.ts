import { getSpecies } from '../data/pokemon';
import { dungeonReward } from '../data/dungeon-rewards';
import { TOWN_SHOPS } from '../data/town-shops';
import { ITEM_LABELS } from '../game/engine';
import { getTechnicalMachine } from '../game/technical-machines';
import { POKEMON_TYPE_LABELS } from '../ui/pokemon-presentation';
import type { WorldAtlas } from './atlas';
import { DUNGEON_PLANS } from './dungeons';
import type { KantoGym, KantoLocation } from './kanto';
import { BUILDING_HALF_X, BUILDING_HALF_Z, SIGNBOARD } from './world-details';

/**
 * SD townsfolk from the owner's files: a fire boy in red, a leaf girl in green, a doctor and an officer. The red, doctor
 * and officer files carry 8192 px colour maps that browsers fail to decode side by side, so they load from copies in
 * `web/` whose maps alone are halved (colour 4096, normal and metallic-roughness 2048); mesh, rig and clips are untouched.
 */
const npcModel = (name: 'red' | 'green' | 'docter' | 'police') => name === 'green' ? `/models/trainer/${name}.glb` : `/models/trainer/web/${name}.glb`;

/** Who stands where: beside the Pokémon Center, the mart, the gym, Pallet's houses and lab, or out on the plaza. */
export type TownNpcRole = 'clinic' | 'shop' | 'gym' | 'lab' | 'home' | 'plaza' | 'police';
/** A patrolling figure walks this ring (world centre and radius) instead of standing at (x, z). */
export type TownPatrol = { x: number; z: number; radius: number };
export type TownNpc = { id: string; townId: string; role: TownNpcRole; title: string; x: number; z: number; facing: number; model: string; patrol?: TownPatrol };

/** The doctor keeps the Pokémon Center and the lab; the red boy the mart and gym; the green girl the plaza and home. */
const MODELS: Record<TownNpcRole, readonly string[]> = {
  clinic: [npcModel('docter')], shop: [npcModel('red')], gym: [npcModel('red')], lab: [npcModel('docter')], home: [npcModel('green')], plaza: [npcModel('green')],
  police: [npcModel('police')],
};
const TITLES: Record<TownNpcRole, string> = { clinic: '센터 도우미', shop: '상점 단골', gym: '체육관 안내원', lab: '연구소 조수', home: '이웃 주민', plaza: '소문난 주민', police: '순경' };

function hash(text: string): number {
  let value = 2166136261;
  for (const character of text) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return value >>> 0;
}

/**
 * A few townsfolk per town: one beside each building's door (doors face +z) and one on the plaza. Spots stay on open
 * ground, off the buildings, the signboard and the arrival point, and apart from each other.
 */
export function planTownNpcs(atlas: WorldAtlas, town: KantoLocation, hasGym: boolean): TownNpc[] {
  const buildings = atlas.buildingOffsets(town), pallet = town.id === 'pallet', placed: TownNpc[] = [];
  const open = (x: number, z: number) => !atlas.sample(town.x + x, town.z + z).blocked
    && buildings.every(([bx, bz]) => Math.abs(x - bx) > BUILDING_HALF_X + .9 || Math.abs(z - bz) > BUILDING_HALF_Z + .9)
    && Math.hypot(x - SIGNBOARD.x, z - SIGNBOARD.z) >= 2.6 && Math.hypot(x, z) >= 2.5
    && placed.every(npc => Math.hypot(npc.x - town.x - x, npc.z - town.z - z) >= 3.5);
  const roles: Array<[TownNpcRole, number | undefined]> = buildings.map((_, index): [TownNpcRole, number] =>
    [pallet ? (index === 2 ? 'lab' : 'home') : index === 0 ? 'clinic' : index === 1 ? 'shop' : 'gym', index]);
  roles.push(['plaza', undefined]);
  for (const [role, index] of roles) {
    if (role === 'gym' && !hasGym) continue;
    if (role === 'home' && index === 1) continue;
    const seed = hash(`${atlas.id}:${town.id}:${role}`), side = seed & 1 ? 1 : -1;
    const candidates: Array<[number, number]> = index !== undefined
      ? (() => { const [bx, bz] = buildings[index]; return [[bx + side * 4.1, bz + 4.4], [bx - side * 4.1, bz + 4.4], [bx + side * 2.3, bz + 5.6], [bx - side * 2.3, bz + 5.6]]; })()
      : Array.from({ length: 12 }, (_, step) => { const angle = (seed % 628) / 100 + step * Math.PI / 6; return [Math.cos(angle) * 5.4, Math.sin(angle) * 5.4]; });
    const spot = candidates.find(([x, z]) => open(x, z));
    if (!spot) continue;
    const [x, z] = spot;
    placed.push({
      id: `${town.id}:${role}`, townId: town.id, role, title: TITLES[role], x: town.x + x, z: town.z + z,
      // Door-side folk look out over the plaza; the plaza one faces the town centre.
      facing: index !== undefined ? 0 : Math.atan2(-x, -z),
      model: MODELS[role][seed % MODELS[role].length],
    });
  }
  // The officer walks a ring round the square, clear of the buildings and the signboard and passing everyone standing by a
  // step; the widest ring that fits is walked, down to a small beat round the arrival point.
  const ring = [7.5, 6.6, 8.3, 5.6, 4.4, 3.4].find(radius => Array.from({ length: 40 }, (_, step) => step / 40 * Math.PI * 2).every(angle => {
    const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
    return !atlas.sample(town.x + x, town.z + z).blocked
      && buildings.every(([bx, bz]) => Math.abs(x - bx) > BUILDING_HALF_X + .6 || Math.abs(z - bz) > BUILDING_HALF_Z + .6)
      && Math.hypot(x - SIGNBOARD.x, z - SIGNBOARD.z) >= 2
      && placed.every(npc => Math.hypot(npc.x - town.x - x, npc.z - town.z - z) >= 1.4);
  }));
  if (ring) {
    const seed = hash(`${atlas.id}:${town.id}:police`), angle = (seed % 628) / 100;
    placed.push({
      id: `${town.id}:police`, townId: town.id, role: 'police', title: TITLES.police,
      x: town.x + Math.cos(angle) * ring, z: town.z + Math.sin(angle) * ring, facing: Math.atan2(-Math.sin(angle), Math.cos(angle)),
      model: MODELS.police[0], patrol: { x: town.x, z: town.z, radius: ring },
    });
  }
  return placed;
}

/** Korean particles follow whether the last syllable ends in a consonant (받침). */
function finalConsonant(word: string): number {
  const last = word.trim().at(-1) ?? '', code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28;
  if (/[0-9]/.test(last)) return '013678'.includes(last) ? 1 : 0;
  return /[lmnr]/i.test(last) ? 1 : 0;
}
export const particle = (word: string, withFinal: string, without: string) => `${word}${finalConsonant(word) ? withFinal : without}`;
const copula = (word: string) => `${word}${finalConsonant(word) ? '이에요' : '예요'}`;

export type NpcTalkContext = {
  regionId: string; regionName: string; town: { id: string; name: string };
  gym?: KantoGym; badges: number;
  outbreak?: { placeName: string; speciesName: string };
  partnerName?: string;
  nearbyDungeon?: { name: string; reward: string };
};

/** The nearest dungeon to a town (by its surface entrances) and what its first clear gives. */
export function nearbyDungeon(atlas: WorldAtlas, town: KantoLocation): NpcTalkContext['nearbyDungeon'] {
  const places = new Map(atlas.locations.map(place => [place.id, place]));
  let best: { name: string; id: string; distance: number } | undefined;
  for (const plan of DUNGEON_PLANS) {
    if (plan.regionId !== atlas.id) continue;
    for (const id of plan.surfaceLocations) {
      const place = places.get(id); if (!place) continue;
      const distance = Math.hypot(place.x - town.x, place.z - town.z);
      if (distance <= 90 && (!best || distance < best.distance)) best = { name: plan.name, id: plan.id, distance };
    }
  }
  if (!best) return undefined;
  const reward = dungeonReward(atlas.id, best.id, 0);
  const prize = reward.machines.map(id => getTechnicalMachine(id)?.name).find(Boolean) ?? (reward.items[0] ? ITEM_LABELS[reward.items[0]] : undefined);
  return { name: best.name, reward: prize ?? '상금' };
}

function shopLines(context: NpcTalkContext): string[] {
  const shops = TOWN_SHOPS[context.regionId]?.[context.town.id] ?? [];
  const lines = shops.flatMap(shop => {
    const goods = [...Object.keys(shop.machines ?? {}).map(id => getTechnicalMachine(Number(id))?.name), ...(shop.items ?? []).map(item => ITEM_LABELS[item])]
      .filter((name): name is string => Boolean(name)).slice(0, 2);
    return goods.length ? [`${shop.name}에서는 ${particle(goods.join(', '), '을', '를')} 팔아요. 다른 마을엔 없대요!`] : [];
  });
  return lines.length ? lines : [`상점에서 ${particle(ITEM_LABELS.potion, '이랑', '랑')} ${particle(ITEM_LABELS['super-potion'], '을', '를')} 살 수 있어요.`, '진화의 돌 같은 건 큰 도시 가게에 가야 있어요.'];
}

function gymLines(context: NpcTalkContext): string[] {
  const gym = context.gym; if (!gym) return [];
  if (context.badges >= gym.badge) return [`${particle(gym.badgeName, '을', '를')} 받았군요! 관장 ${gym.name}도 인정한 트레이너네요.`, '다음 체육관도 응원할게요!'];
  const ace = getSpecies(gym.speciesId), types = ace.types.map(type => POKEMON_TYPE_LABELS[type] ?? type).join('·');
  return [`이 마을 관장은 ${gym.name}! 에이스는 Lv.${gym.level} ${copula(ace.name)}.`, `${types} 타입이니 상성을 잘 따져 봐요.`, `${particle(gym.badgeName, '을', '를')} 따면 막혀 있던 길이 열려요.`];
}

/** What a townsperson says, in order; the bubble walks through these one by one. */
export function npcLines(role: TownNpcRole, context: NpcTalkContext): string[] {
  const partner = context.partnerName;
  switch (role) {
    case 'clinic': return [
      `${context.town.name}에 온 걸 환영해요!`,
      '포켓몬이 지치면 캠프 회복으로 바로 쉬게 해 줄 수 있어요.',
      ...(partner ? [`${particle(partner, '이', '가')} 기운이 넘쳐 보여요!`] : []),
    ];
    case 'shop': return shopLines(context);
    case 'gym': return gymLines(context);
    case 'lab': return ['박사님은 포켓몬 도감을 완성하는 게 꿈이래요.', '풀숲에서 만난 포켓몬은 도감에 바로 기록돼요.'];
    case 'home': return [`${context.regionName} 여행은 여기 ${context.town.name}에서 시작돼요!`, '멀리 가도 가끔은 돌아와서 쉬어 가요.'];
    case 'police': return [
      `${context.town.name} 순찰은 저한테 맡겨요!`,
      ...(context.outbreak ? [`${context.outbreak.placeName}에서 ${particle(context.outbreak.speciesName, '이', '가')} 잔뜩 나왔다는 신고가 들어왔어요.`] : []),
      '배지가 모자라면 막혀 있는 길도 있으니 체육관부터 들러 봐요.',
      ...(partner ? [`${particle(partner, '과', '와')} 함께라니 든든하네요.`] : []),
    ];
    case 'plaza': return [
      ...(context.outbreak ? [`오늘 ${context.outbreak.placeName}에 ${particle(context.outbreak.speciesName, '이', '가')} 잔뜩 나타났대요! 대량발생이에요.`] : []),
      ...(context.nearbyDungeon ? [`${particle(context.nearbyDungeon.name, '을', '를')} 처음 끝까지 돌파하면 ${particle(context.nearbyDungeon.reward, '을', '를')} 준대요.`] : []),
      ...(partner ? [`${particle(partner, '과', '와')} 함께라면 어디든 갈 수 있겠어요!`] : []),
      `${context.regionName} 지방에 온 걸 환영해요!`,
    ];
  }
}
