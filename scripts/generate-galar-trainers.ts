import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getWorldAtlas } from '../src/openworld/atlas';

/**
 * Galar's route and Wild Area trainers from Bulbapedia's Sword and Shield location pages, fetched as raw wikitext into
 * data/local/galar-trainer-source (`index.php?title=<page>&action=raw`): class, name, prize and party of each
 * {{Trainerentry}}. Rival and leader battles ({{Party}}) are left to their own scenes.
 */
const root = join('data', 'local', 'galar-trainer-source');
const PAGES: Record<string, string> = {
  'Galar_Route_2': 'galar-route-2', 'Galar_Route_3': 'galar-route-3', 'Galar_Route_4': 'galar-route-4', 'Galar_Route_5': 'galar-route-5',
  'Galar_Route_6': 'galar-route-6', 'Galar_Route_7': 'galar-route-7', 'Galar_Route_8': 'galar-route-8', 'Galar_Route_9': 'galar-route-9',
  'Galar_Route_10': 'galar-route-10', 'Motostoke_Outskirts': 'motostoke-outskirts', 'Bridge_Field': 'bridge-field', 'East_Lake_Axewell': 'east-lake-axewell',
};
/** Korean class names of the Korean release. */
const CLASS_KO: Record<string, string> = {
  Youngster: '반바지 꼬마', Lass: '짧은치마', Fisher: '낚시꾼', Swimmer: '수영팬티 소년', Dancer: '댄서', 'Black Belt': '태권왕', 'Team Yell Grunt': '엘 단 단원',
  'Music Crew': '뮤지션', 'Gym Trainer': '짐트레이너', 'Pokémon Breeder': '포켓몬 브리더', Hiker: '등산가', Worker: '작업원', Madame: '마담', Gentleman: '신사',
  Cyclist: '사이클링', Doctor: '의사', Nurse: '간호사', Backpacker: '백팩커', Cook: '요리사', Artist: '화가', 'Pokémon Ranger': '포켓몬 레인저', Model: '모델',
  'Poké Kid': '포켓몬 키즈', Schoolboy: '학원소년', Schoolgirl: '학원소녀', 'Café Master': '카페 마스터', Postman: '우편배달부', 'Ace Trainer': '엘리트트레이너',
  Camper: '캠프보이', Picnicker: '피크니커', 'Pokémon Collector': '포켓몬 수집가', Rail: '철도원', 'Street Thug': '불량배', 'Office Worker': '회사원',
  Cabbie: '택시운전사', Interviewers: '인터뷰어', 'New Schoolboy': '학원소년', 'Medical Team': '메디컬팀', Musician: '뮤지션', Colleagues: '동료',
  'Police Officer': '경찰관', Waiter: '웨이터', Waitress: '웨이트리스', Psychic: '초능력자', 'Battle Girl': '배틀걸', 'Rich Boy': '부잣집 도련님', Beauty: '아가씨', Clerk: '점원',
};
const FEMALE = /Lass|Swimmer F|Dancer|Madame|Nurse|Model|Schoolgirl|Picnicker|Waitress|Battle Girl|Beauty| F\.png|Grunt F/;

/** Top-level fields of a template call, ignoring the pipes of templates inside it. */
function fields(call: string): string[] {
  const out: string[] = []; let depth = 0, current = '';
  for (let i = 0; i < call.length; i++) {
    if (call.startsWith('{{', i)) { depth++; current += '{{'; i++; continue; }
    if (call.startsWith('}}', i)) { depth--; current += '}}'; i++; continue; }
    if (call[i] === '|' && depth === 0) { out.push(current); current = ''; continue; }
    current += call[i];
  }
  out.push(current);
  return out;
}

const known = new Set(getWorldAtlas('galar').locations.map(place => place.id));
const trainers: unknown[] = [], checksums: Record<string, string> = {}, unnamed = new Set<string>(), seen = new Set<string>(), ids = new Set<string>();
for (const file of readdirSync(root).filter(name => name.endsWith('.wiki')).sort()) {
  const page = file.slice(0, -5), locationId = PAGES[page]; if (!locationId || !known.has(locationId)) continue;
  const text = readFileSync(join(root, file), 'utf8'); checksums[file] = createHash('sha256').update(text).digest('hex');
  for (const match of text.matchAll(/^\{\{Trainerentry\|(.*)\}\}\s*$/gm)) {
    const positional = fields(match[1]).filter(field => !/^\w+=/.test(field));
    const [image, klass, linkedName, prize, count] = positional;
    const name = (linkedName ?? '').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').trim();
    const team: Array<[number, number]> = [];
    for (let k = 0; k < Number(count); k++) {
      const [dex, , , level] = positional.slice(5 + k * 5, 10 + k * 5);
      const id = Number.parseInt(dex, 10); if (id > 0 && Number(level) > 0) team.push([id, Number(level)]);
    }
    if (!klass || !team.length) continue;
    // A named trainer listed again (a neighbouring page, a later visit) stands only where first listed; nameless grunts are numbered.
    if (name && seen.has(`${klass}:${name}`)) continue;
    if (name) seen.add(`${klass}:${name}`);
    const base = `swsh-${locationId}-${`${klass}-${name || 'grunt'}`.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    let id = base; for (let serial = 2; ids.has(id); serial++) id = `${base}-${serial}`;
    ids.add(id);
    const female = FEMALE.test(`${klass} ${image}`);
    const trainerClass = klass === 'Swimmer' && female ? '비키니 아가씨' : CLASS_KO[klass];
    if (!trainerClass) unnamed.add(klass);
    trainers.push({ id, region: 'galar', locationId, name: name || '', trainerClass: trainerClass ?? klass, sourceClass: klass.toUpperCase().replace(/[^A-Z]+/g, '_'),
      ...(female ? { female: true } : {}), team, reward: Number(prize.replace(/[^0-9]/g, '')) || Math.max(...team.map(([, level]) => level)) * 16, sourceMap: `bulbapedia/${page}` });
  }
}
if (unnamed.size) console.warn('classes without a Korean name:', [...unnamed].join(', '));
writeFileSync(join('src', 'data', 'galar-trainers.generated.ts'), `// Generated by scripts/generate-galar-trainers.ts from Bulbapedia's Sword and Shield location pages (CC BY-NC-SA 2.5).
import type { FieldTrainer } from './field-trainers';
export const GALAR_TRAINER_CHECKSUMS: Record<string, string> = ${JSON.stringify(checksums)};
export const GENERATED_GALAR_TRAINERS: FieldTrainer[] = ${JSON.stringify(trainers)};
`);
const byPlace = new Map<string, string[]>();
for (const trainer of trainers as Array<{ locationId: string; trainerClass: string; name: string }>) byPlace.set(trainer.locationId, [...byPlace.get(trainer.locationId) ?? [], `${trainer.trainerClass} ${trainer.name}`]);
console.log(trainers.length, 'trainers'); for (const [place, list] of byPlace) console.log(place, '|', list.join(', '));
