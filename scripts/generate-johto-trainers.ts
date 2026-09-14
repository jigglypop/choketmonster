import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join('data', 'local', 'pokecrystal-source');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const classConstants = read('constants/trainer_constants.asm');
const partiesText = read('data/trainers/parties.asm');
const pointers = [...read('data/trainers/party_pointers.asm').matchAll(/^\s*dw (\w+Group)$/gm)].map(match => match[1]);
const pokemonConstants = read('constants/pokemon_constants.asm');
const species = new Map<string, number>();
let speciesId = 0;
for (const line of pokemonConstants.split(/\r?\n/)) {
  const reset = /const_def\s+([0-9A-Fa-fx$]+)/.exec(line); if (reset) speciesId = Number(reset[1].replace('$', '0x'));
  const match = /^\s*const\s+(\w+)/.exec(line); if (match) species.set(match[1], speciesId++);
}

const classOrder = [...classConstants.matchAll(/^\s*trainerclass\s+(\w+)/gm)].map(match => match[1]).slice(1);
const partyByKey = new Map<string, { name: string; team: Array<[number, number]> }>();
for (let classIndex = 0; classIndex < classOrder.length; classIndex++) {
  const klass = classOrder[classIndex], group = pointers[classIndex]; if (!group) continue;
  const start = partiesText.indexOf(`${group}:`);
  const nextGroup = [...partiesText.matchAll(/^\w+Group:\r?$/gm)].find(match => (match.index ?? 0) > start)?.index ?? partiesText.length;
  const chunk = partiesText.slice(start, nextGroup);
  const constantsChunk = classConstants.slice(classConstants.indexOf(`trainerclass ${klass}`), classConstants.indexOf('\n\ttrainerclass ', classConstants.indexOf(`trainerclass ${klass}`) + 1) < 0 ? classConstants.length : classConstants.indexOf('\n\ttrainerclass ', classConstants.indexOf(`trainerclass ${klass}`) + 1));
  const ids = [...constantsChunk.matchAll(/^\s*const\s+(\w+)/gm)].map(match => match[1]);
  const blocks = [...chunk.matchAll(/^\s*db "[^"]+@", TRAINERTYPE_[^\n]*\n([\s\S]*?)^\s*db -1/gm)].map(match => match[0]);
  blocks.forEach((block, index) => {
    const name = /db "([^"]+)@"/.exec(block)?.[1]; if (!name || !ids[index]) return;
    const team: Array<[number, number]> = [];
    for (const match of block.matchAll(/^\s*db\s+(\d+),\s*([A-Z][A-Z0-9_]*)/gm)) {
      const id = species.get(match[2]); if (id) team.push([id, Number(match[1])]);
    }
    if (team.length) partyByKey.set(`${klass}:${ids[index]}`, { name, team });
  });
}

const LOCATION_RULES: Array<[RegExp, string]> = [
  [/^SproutTower/, 'sprout-tower'], [/^RuinsOfAlph/, 'ruins-of-alph'], [/^UnionCave/, 'union-cave'],
  [/^SlowpokeWell/, 'slowpoke-well'], [/^IlexForest/, 'ilex-forest'], [/^Goldenrod/, 'goldenrod'], [/^NationalPark/, 'national-park'],
  [/^BurnedTower/, 'burned-tower'], [/^(Tin|Bell)Tower/, 'bell-tower'], [/^OlivineLighthouse/, 'lighthouse'], [/^WhirlIsland/, 'whirl-islands'],
  [/^MtMortar/, 'mt-mortar'], [/^LakeOfRage/, 'lake-of-rage'], [/^IcePath/, 'ice-path'], [/^DragonsDen/, 'dragons-den'],
  [/^DarkCaveViolet/, 'dark-cave-west'], [/^DarkCaveBlackthorn/, 'dark-cave-east'], [/^MtSilver/, 'mt-silver'], [/^TohjoFalls/, 'tohjo-falls'],
  [/^Violet/, 'violet'], [/^Azalea/, 'azalea'], [/^Ecruteak/, 'ecruteak'], [/^Cianwood/, 'cianwood'], [/^Mahogany/, 'mahogany'], [/^Blackthorn/, 'blackthorn'],
];
const EXCLUDED = new Set(['FALKNER','WHITNEY','BUGSY','MORTY','PRYCE','JASMINE','CHUCK','CLAIR','RIVAL1','RIVAL2','WILL','BRUNO','KAREN','KOGA','CHAMPION','RED','BLUE']);
const CLASS_KO: Record<string, string> = { YOUNGSTER:'반바지 꼬마', SCHOOLBOY:'학원소년', BIRD_KEEPER:'새 조련사', LASS:'아가씨', BUG_CATCHER:'곤충채집소년', FISHER:'낚시꾼', SWIMMER_M:'수영팬 남자', SWIMMER_F:'수영팬 여자', SAILOR:'선원', HIKER:'등산가', FIREBREATHER:'불놀이꾼', BLACKBELT_T:'태권왕', PSYCHIC_T:'초능력자', PICNICKER:'피크니커', CAMPER:'캠퍼', SAGE:'수행자', MEDIUM:'무당', BOARDER:'보더', POKEFAN_M:'포켓몬 애호가', POKEFAN_F:'포켓몬 애호가', KIMONO_GIRL:'무희', TWINS:'쌍둥이', OFFICER:'경찰관', BEAUTY:'아가씨', POKEMANIAC:'포켓몬 매니아', SCIENTIST:'과학자', TEACHER:'선생님', COOLTRAINER_M:'엘리트 트레이너', COOLTRAINER_F:'엘리트 트레이너' };
const trainers: any[] = [];
const trainerIds = new Set<string>();
for (const filename of readdirSync(join(root, 'maps')).filter(name => name.endsWith('.asm')).sort()) {
  const stem = filename.slice(0, -4); let locationId: string | undefined;
  const route = /^Route(\d+)$/.exec(stem);
  if (route && (Number(route[1]) === 27 || (Number(route[1]) >= 29 && Number(route[1]) <= 46))) locationId = `route-${route[1]}`;
  for (const [pattern, replacement] of LOCATION_RULES) if (!locationId && pattern.test(stem)) locationId = replacement;
  if (!locationId) continue;
  const text = read(`maps/${filename}`), definitions = new Map<string, { klass: string; constant: string }>();
  for (const match of text.matchAll(/^(\w+):\r?\n\s*trainer\s+(\w+),\s*(\w+),/gm)) definitions.set(match[1], { klass: match[2], constant: match[3] });
  for (const match of text.matchAll(/^\s*object_event\s+(\d+),\s*(\d+),[^\n]*OBJECTTYPE_TRAINER,\s*\d+,\s*(\w+)/gm)) {
    const definition = definitions.get(match[3]); if (!definition || EXCLUDED.has(definition.klass)) continue;
    const party = partyByKey.get(`${definition.klass}:${definition.constant}`); if (!party) continue;
    const id = `crystal-${definition.klass.toLowerCase().replaceAll('_','-')}-${definition.constant.toLowerCase().replaceAll('_','-')}`;
    if (trainerIds.has(id)) continue; trainerIds.add(id);
    trainers.push({ id, region:'johto', locationId, name:party.name, trainerClass:CLASS_KO[definition.klass] ?? definition.klass.replaceAll('_',' '), sourceClass:definition.klass, team:party.team, reward:Math.max(...party.team.map(([, level]) => level))*16, sourceMap:`maps/${filename}`, sourceX:Number(match[1]), sourceZ:Number(match[2]) });
  }
}
const sourcePaths = ['constants/trainer_constants.asm','constants/pokemon_constants.asm','data/trainers/parties.asm','data/trainers/party_pointers.asm'];
const checksums = Object.fromEntries(sourcePaths.map(path => [path, createHash('sha256').update(read(path)).digest('hex')]));
writeFileSync(join('src','data','field-trainers.generated.ts'), `// Generated from pinned pret/pokecrystal source.\nimport type { FieldTrainer } from './field-trainers';\nexport const FIELD_TRAINER_CHECKSUMS: Record<string,string> = ${JSON.stringify(checksums)};\nexport const GENERATED_FIELD_TRAINERS: FieldTrainer[] = ${JSON.stringify(trainers)};\n`);
console.log({ trainers: trainers.length, locations: new Set(trainers.map((trainer: any) => trainer.locationId)).size });
