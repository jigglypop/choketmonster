import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getWorldAtlas } from '../src/openworld/atlas';

/**
 * Route, forest and cave trainers of Kanto (FireRed) and Hoenn (Emerald), from pinned pret sources fetched into
 * data/local/route-trainer-source: who each map's trainer objects are, their class, name and party.
 */
const root = join('data', 'local', 'route-trainer-source');
const SOURCES = [
  { repo: 'pokefirered', commit: 'c75f352304d529f6ba92d4f74b9cf8b5c3810788', prefix: 'frlg', region: 'kanto' },
  { repo: 'pokeemerald', commit: '5eff78649e7170a877b961ef0b3da13b81a16038', prefix: 'emerald', region: 'hoenn' },
] as const;

/** Map folders to places; routes split in two take the half each trainer stands in. */
const PLACES: Record<string, Array<[RegExp, string]>> = {
  kanto: [
    [/^ViridianForest$/, 'viridian-forest'], [/^MtMoon_/, 'mt-moon'], [/^RockTunnel_/, 'rock-tunnel'], [/^VictoryRoad_/, 'victory-road'],
    [/^PokemonTower_/, 'pokemon-tower'], [/^PokemonMansion_/, 'pokemon-mansion'], [/^SeafoamIslands_/, 'seafoam-islands'], [/^PowerPlant$/, 'power-plant'],
  ],
  hoenn: [
    [/^PetalburgWoods$/, 'petalburg-woods'], [/^GraniteCave_/, 'granite-cave'], [/^RusturfTunnel$/, 'rusturf-tunnel'], [/^FieryPath$/, 'fiery-path'],
    [/^MeteorFalls_/, 'meteor-falls'], [/^VictoryRoad_/, 'hoenn-victory-road'], [/^CaveOfOrigin_/, 'cave-of-origin'], [/^IslandCave$/, 'island-cave'],
  ],
};
const SPLITS: Record<string, { axis: 'x' | 'y'; low: string; high: string }> = {
  'kanto:route-2': { axis: 'y', low: 'route-2-north', high: 'route-2-south' },
  'kanto:route-10': { axis: 'y', low: 'route-10-north', high: 'route-10-south' },
  'kanto:route-20': { axis: 'x', low: 'route-20-west', high: 'route-20-east' },
};
/** Story battles keep to their own scenes. */
const EXCLUDED_CLASSES = /^(RIVAL\w*|LEADER|ELITE_FOUR|CHAMPION|BOSS|\w*_LEADER|\w*_ADMIN|PKMN_PROF|PROFESSOR|PKMN_TRAINER_\d)$/;

/** Korean class names of the Korean releases. */
const CLASS_KO: Record<string, string> = {
  YOUNGSTER: '반바지 꼬마', BUG_CATCHER: '곤충채집소년', LASS: '짧은치마', SAILOR: '뱃사람', CAMPER: '캠프보이', PICNICKER: '피크니커',
  POKEMANIAC: '포켓몬 매니아', SUPER_NERD: '괴짜', HIKER: '등산가', BIKER: '폭주족', BURGLAR: '도둑', ENGINEER: '엔지니어', FISHERMAN: '낚시꾼',
  SWIMMER_M: '수영팬티 소년', SWIMMER_F: '비키니 아가씨', CUE_BALL: '빡빡이', GAMBLER: '갬블러', BEAUTY: '아가씨', PSYCHIC: '초능력자',
  ROCKER: '로커', JUGGLER: '저글러', TAMER: '조련사', BIRD_KEEPER: '새 조련사', BLACK_BELT: '태권왕', SCIENTIST: '과학자', TEAM_ROCKET: '로켓단 조무래기',
  COOLTRAINER: '엘리트트레이너', GENTLEMAN: '신사', CHANNELER: '무당', TWINS: '쌍둥이', COOL_COUPLE: '엘리트 커플', YOUNG_COUPLE: '젊은 부부',
  SIS_AND_BRO: '남매', CRUSH_KIN: '태권 남매', CRUSH_GIRL: '배틀걸', TUBER: '튜브꼬마', TUBER_2: '튜브꼬마', PKMN_BREEDER: '포켓몬 브리더',
  PKMN_RANGER: '포켓몬 레인저', AROMA_LADY: '아로마 아가씨', RUIN_MANIAC: '유적 마니아', PAINTER: '화가', HEX_MANIAC: '오컬트 마니아',
  RICH_BOY: '부잣집 도련님', SCHOOL_KID: '학원소년', GUITARIST: '기타리스트', KINDLER: '불놀이꾼', EXPERT: '달인', SR_AND_JR: '선후배',
  LADY: '숙녀', TUBER_F: '튜브소녀', TUBER_M: '튜브소년', GAMER: '갬블러', PKMN_FAN: '포켓몬 애호가', POKEFAN: '포켓몬 애호가', NINJA_BOY: '닌자 소년', BATTLE_GIRL: '배틀걸', PARASOL_LADY: '양산 아가씨', COLLECTOR: '수집가',
  DRAGON_TAMER: '드래곤 조련사', TRIATHLETE: '트라이애슬론 선수', INTERVIEWER: '인터뷰어', WINSTRATE: '연승가족', TEAM_AQUA: '아쿠아단 조무래기',
  TEAM_MAGMA: '마그마단 조무래기', BUG_MANIAC: '곤충 마니아', SWIMMING_TRIATHLETE: '트라이애슬론 선수', CYCLING_TRIATHLETE: '트라이애슬론 선수',
  RUNNING_TRIATHLETE: '트라이애슬론 선수', PSYCHIC_M: '초능력자', PSYCHIC_F: '초능력자', LADY_2: '숙녀', POKEMON_BREEDER: '포켓몬 브리더',
  POKEMON_RANGER: '포켓몬 레인저', PKMN_RANGER_2: '포켓몬 레인저', HIKER_2: '등산가', OLD_COUPLE_2: '노부부', YOUNG_COUPLE_2: '젊은 부부',
};

type Trainer = { id: string; region: string; locationId: string; name: string; trainerClass: string; sourceClass: string; female?: true; team: Array<[number, number]>; reward: number; sourceMap: string; sourceX: number; sourceZ: number };
const trainers: Trainer[] = [];
const checksums: Record<string, string> = {};
const unnamedClasses = new Set<string>();

for (const source of SOURCES) {
  const base = join(root, source.repo);
  const read = (path: string) => { const text = readFileSync(join(base, path), 'utf8'); checksums[`${source.repo}/${path}`] = createHash('sha256').update(text).digest('hex'); return text; };
  // National dex numbers by species constant: the first enum of pokedex.h counts from NATIONAL_DEX_NONE.
  const dex = new Map<string, number>();
  const nationalEnum = /enum\s*\{([\s\S]*?)\}/.exec(read('include/constants/pokedex.h'))![1];
  [...nationalEnum.matchAll(/NATIONAL_DEX_(\w+)/g)].forEach((match, index) => dex.set(match[1], index));
  const parties = new Map<string, Array<[number, number]>>();
  for (const match of read('src/data/trainer_parties.h').matchAll(/(sParty_\w+)\[\]\s*=\s*\{([\s\S]*?)\n\};/g)) {
    const team: Array<[number, number]> = [];
    for (const member of match[2].matchAll(/\{([^{}]*)\}/g)) {
      const level = /\.lvl\s*=\s*(\d+)/.exec(member[1])?.[1], species = /\.species\s*=\s*SPECIES_(\w+)/.exec(member[1])?.[1];
      const id = species && dex.get(species); if (level && id) team.push([id, Number(level)]);
    }
    parties.set(match[1], team);
  }
  const roster = new Map<string, { klass: string; name: string; female: boolean; team: Array<[number, number]> }>();
  for (const match of read('src/data/trainers.h').matchAll(/\[(TRAINER_\w+)\]\s*=\s*\{([\s\S]*?)\n\s*\},/g)) {
    const klass = /\.trainerClass\s*=\s*TRAINER_CLASS_(\w+)/.exec(match[2])?.[1], name = /\.trainerName\s*=\s*_\("([^"]*)"\)/.exec(match[2])?.[1];
    const party = /\.party\s*=\s*\w+\((sParty_\w+)\)/.exec(match[2])?.[1];
    const team = party ? parties.get(party) : undefined;
    if (klass && name && team?.length) roster.set(match[1], { klass, name, female: /F_TRAINER_FEMALE/.test(match[2]), team });
  }
  const atlas = getWorldAtlas(source.region), known = new Set(atlas.locations.map(place => place.id));
  const seen = new Set<string>();
  // Each trainer object's script opens with the battle that names its trainer; FireRed keeps them all in one file.
  const battles = (text: string, into: Map<string, string>) => {
    for (const block of text.split(/^(?=\w+::)/m)) {
      const label = /^(\w+)::/.exec(block)?.[1], battle = /trainerbattle_\w+\s+(TRAINER_\w+)/.exec(block)?.[1];
      if (label && battle) into.set(label, battle);
    }
    return into;
  };
  const shared = existsSync(join(base, 'data', 'scripts', 'trainers.inc')) ? battles(read('data/scripts/trainers.inc'), new Map()) : new Map<string, string>();
  const found: Array<Trainer & { axis?: { x: number; y: number }; split?: string }> = [];
  for (const folder of readdirSync(join(base, 'data', 'maps')).sort()) {
    if (!existsSync(join(base, 'data', 'maps', folder, 'scripts.inc')) || !existsSync(join(base, 'data', 'maps', folder, 'map.json'))) continue;
    const route = /^Route(\d+)$/.exec(folder);
    const place = route ? (source.region === 'hoenn' ? `hoenn-route-${route[1]}` : `route-${route[1]}`) : PLACES[source.region].find(([pattern]) => pattern.test(folder))?.[1];
    if (!place) continue;
    const split = SPLITS[`${source.region}:${place}`];
    if (!known.has(place) && !split) continue;
    const scripts = read(`data/maps/${folder}/scripts.inc`), map = JSON.parse(read(`data/maps/${folder}/map.json`));
    const battleByScript = battles(scripts, new Map(shared));
    for (const object of map.object_events ?? []) {
      if (!object.trainer_type || object.trainer_type === 'TRAINER_TYPE_NONE') continue;
      const constant = battleByScript.get(object.script), entry = constant && roster.get(constant);
      if (!constant || !entry || EXCLUDED_CLASSES.test(entry.klass) || seen.has(constant)) continue;
      seen.add(constant);
      const trainerClass = CLASS_KO[entry.klass]; if (!trainerClass) unnamedClasses.add(`${source.repo}:${entry.klass}`);
      found.push({
        id: `${source.prefix}-${constant.slice('TRAINER_'.length).toLowerCase().replaceAll('_', '-')}`, region: source.region, locationId: place,
        name: entry.name, trainerClass: trainerClass ?? entry.klass.replaceAll('_', ' '), sourceClass: entry.klass, ...(entry.female ? { female: true as const } : {}), team: entry.team,
        reward: Math.max(...entry.team.map(([, level]) => level)) * 16, sourceMap: `${source.repo}/data/maps/${folder}`, sourceX: object.x, sourceZ: object.y,
        split: split ? `${source.region}:${place}` : undefined,
      });
    }
  }
  // Split routes: the half of the map each trainer stands in (north/west first).
  for (const [key, split] of Object.entries(SPLITS)) {
    const members = found.filter(trainer => trainer.split === key); if (!members.length) continue;
    const values = members.map(trainer => split.axis === 'x' ? trainer.sourceX : trainer.sourceZ).sort((a, b) => a - b);
    const middle = (values[0] + values[values.length - 1]) / 2;
    for (const trainer of members) trainer.locationId = (split.axis === 'x' ? trainer.sourceX : trainer.sourceZ) <= middle ? split.low : split.high;
  }
  trainers.push(...found.filter(trainer => known.has(trainer.locationId)).map(({ split: _split, axis: _axis, ...trainer }) => trainer));
}

if (unnamedClasses.size) console.warn('classes without a Korean name:', [...unnamedClasses].join(', '));
const provenance = SOURCES.map(source => ({ repository: `https://github.com/pret/${source.repo}`, commit: source.commit, region: source.region }));
writeFileSync(join('src', 'data', 'route-trainers.generated.ts'), `// Generated by scripts/generate-route-trainers.ts from pinned pret/pokefirered and pret/pokeemerald sources.
import type { FieldTrainer } from './field-trainers';
export const ROUTE_TRAINER_SOURCES = ${JSON.stringify(provenance)} as const;
export const ROUTE_TRAINER_CHECKSUMS: Record<string, string> = ${JSON.stringify(checksums)};
export const GENERATED_ROUTE_TRAINERS: FieldTrainer[] =${JSON.stringify(trainers)};
`);
const byPlace = new Map<string, number>();
for (const trainer of trainers) byPlace.set(`${trainer.region}:${trainer.locationId}`, (byPlace.get(`${trainer.region}:${trainer.locationId}`) ?? 0) + 1);
console.log(trainers.length, 'trainers'); console.log([...byPlace].map(([place, count]) => `${place} ${count}`).join(' | '));
