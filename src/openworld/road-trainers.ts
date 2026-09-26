import { fieldTrainersAt, type FieldTrainer } from '../data/field-trainers';
import type { WorldAtlas } from './atlas';
import { trailHalfWidth } from './world-details';

/** Road trainers wear the owner's figures, chosen by trainer class. */
const figure = (name: 'teacher' | 'man' | 'mountain' | 'docter' | 'police' | 'nurse' | 'boy' | 'fish') => `/models/trainer/web/${name}.glb`;
/** Matched against the Korean class and the source's class code. */
const FIGURE_BY_CLASS: ReadonlyArray<readonly [RegExp, string]> = [
  [/경찰|순경|경비|OFFICER|POLICE|GUARD/i, figure('police')],
  [/GRUNT|TEAM_|로켓|조무래기|BURGLAR|도둑|JUGGLER|저글러|GAMBLER|GAMER|갬블러|BIKER|폭주족|ROCKER|로커|GUITARIST|기타|MUSIC|뮤지션|CUE_?BALL|빡빡이|ENGINEER|엔지니어|CABBIE|택시|POSTMAN|우편|깡패/i, figure('man')],
  [/간호|NURSE|아가씨|치마|LASS|피크니커|PICNICKER|쌍둥이|TWINS|숙녀|LADY|BEAUTY|미녀|COOLTRAINERF|POKEFANF|무당|MEDIUM|CHANNELER|SKIER|스키어|AROMA|아로마|소녀|TUBER_F|배틀걸|BATTLE_GIRL|CRUSH_GIRL|오컬트|HEX|화가|PAINTER|PARASOL|양산|브리더|BREEDER/i, figure('nurse')],
  [/반바지|YOUNGSTER|곤충|BUG|꼬마|소년|SCHOOL|캠퍼|캠프|CAMPER|TUBER|KID|도련님|RICH_BOY|NINJA/i, figure('boy')],
  [/낚시|FISHER/i, figure('fish')],
  [/등산가|HIKER|선원|뱃사람|SAILOR|탐험|유적|RUIN|조련사|TAMER|BIRD|불놀이꾼|FIREBREATHER|KINDLER|태권|BLACK_?BELT|보더|BOARDER|레인저|RANGER|백팩커|BACKPACKER/i, figure('mountain')],
  [/과학자|SCIENTIST|박사|연구|매니아|마니아|MANIAC|NERD|괴짜|의사|DOCTOR|MEDICAL|메디컬|수집가|COLLECTOR/i, figure('docter')],
  [/선생|TEACHER|신사|GENTLEMAN|엘리트|COOLTRAINER|수행자|SAGE|초능력|PSYCHIC|POKEFAN|애호가|달인|EXPERT/i, figure('teacher')],
];
/** A trainer of no particular class takes the next figure in turn, so neighbours on a road never look alike; a woman wears the nurse. */
const FALLBACK = [figure('boy'), figure('man'), figure('teacher'), figure('mountain'), figure('nurse')];

/** Source class codes the Crystal transcription left in English, in their Korean game names. */
const CLASS_LABELS: Readonly<Record<string, string>> = {
  COOLTRAINERF: '엘리트트레이너', COOLTRAINERM: '엘리트트레이너', GRUNTM: '로켓단 조무래기', GRUNTF: '로켓단 조무래기',
  SWIMMERM: '수영팬티 소년', SWIMMERF: '비키니 아가씨', POKEFANM: '포켓몬 애호가', POKEFANF: '포켓몬 애호가', 'SUPER NERD': '괴짜',
  SKIER: '스키어', GENTLEMAN: '신사', BURGLAR: '도둑', JUGGLER: '저글러',
};
export const trainerClassLabel = (trainerClass: string) => CLASS_LABELS[trainerClass] ?? trainerClass;
/** Source names are in capitals (BENNY); they read as names (Benny). */
export const trainerNameLabel = (name: string) => /^[A-Z0-9 .'-]+$/.test(name) ? name.toLowerCase().replace(/(^|[ .'-])([a-z])/g, (_, gap: string, letter: string) => gap + letter.toUpperCase()) : name;

export type RoadTrainer = { trainer: FieldTrainer; x: number; z: number; facing: number; model: string };

function hash(text: string): number {
  let value = 2166136261;
  for (const character of text) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return value >>> 0;
}

const plans = new Map<string, readonly RoadTrainer[]>();
/**
 * Where each road trainer stands: along the roads leaving its route or forest, alternating sides just off the trail
 * and facing it, on open ground inside its own place and apart from each other. On a sea route, everyone but the
 * swimmers stands on the shore facing the water, nearest the land it is reached from first. Trainers of towns, caves
 * and gyms keep to the trainer list, and swimmers keep to the sea.
 */
export function roadTrainers(atlas: WorldAtlas): readonly RoadTrainer[] {
  const cached = plans.get(atlas.id); if (cached) return cached;
  const byId = new Map(atlas.locations.map(place => [place.id, place]));
  const placed: RoadTrainer[] = [];
  const dress = (trainer: FieldTrainer) => FIGURE_BY_CLASS.find(([pattern]) => pattern.test(`${trainer.trainerClass} ${trainer.sourceClass ?? ''}`))?.[1]
    ?? (trainer.female ? figure('nurse') : FALLBACK[(hash(atlas.id) + placed.length) % FALLBACK.length]);
  for (const place of atlas.locations) {
    if (place.kind !== 'route' && place.kind !== 'forest' && place.kind !== 'sea') continue;
    const trainers = fieldTrainersAt(atlas.id, place.id).filter(trainer => !/SWIMMER|수영|비키니/i.test(trainer.trainerClass));
    const roads = atlas.surfaceConnections.flatMap(([from, to]) => from === place.id ? [to] : to === place.id ? [from] : [])
      .map(id => byId.get(id)).filter((other): other is NonNullable<typeof other> => !!other && other.kind !== 'sea');
    if (!trainers.length || !roads.length) continue;
    if (place.kind === 'sea') {
      const shore: Array<{ x: number; z: number; facing: number; reach: number }> = [];
      for (let dx = -80; dx <= 80; dx += 2) for (let dz = -80; dz <= 80; dz += 2) {
        const x = place.x + dx, z = place.z + dz;
        if (atlas.locationAt(x, z).id !== place.id || atlas.sample(x, z).blocked) continue;
        const water = ([[2, 0], [-2, 0], [0, 2], [0, -2]] as const).filter(([ox, oz]) => atlas.sample(x + ox, z + oz).blocked);
        if (!water.length) continue;
        shore.push({ x, z, facing: Math.atan2(water.reduce((sum, [ox]) => sum + ox, 0), water.reduce((sum, [, oz]) => sum + oz, 0)),
          reach: Math.min(...roads.map(road => Math.hypot(road.x - x, road.z - z))) });
      }
      shore.sort((a, b) => a.reach - b.reach);
      for (const trainer of trainers) {
        const spot = shore.find(item => placed.every(other => Math.hypot(other.x - item.x, other.z - item.z) >= 5));
        if (spot) placed.push({ trainer, x: spot.x, z: spot.z, facing: spot.facing, model: dress(trainer) });
      }
      continue;
    }
    trainers.forEach((trainer, index) => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const road = roads[(index + attempt) % roads.length], side = (index + attempt) % 2 ? 1 : -1;
        const along = .16 + .07 * ((Math.floor(index / roads.length) + attempt) % 5);
        const dx = road.x - place.x, dz = road.z - place.z, length = Math.hypot(dx, dz) || 1, ux = dx / length, uz = dz / length;
        const lateral = trailHalfWidth(place.id, road.id) + .9;
        const x = place.x + dx * along - uz * side * lateral, z = place.z + dz * along + ux * side * lateral;
        if (atlas.sample(x, z).blocked || atlas.locationAt(x, z).id !== place.id) continue;
        if (placed.some(other => Math.hypot(other.x - x, other.z - z) < 3.2)) continue;
        placed.push({ trainer, x, z, facing: Math.atan2(uz * side, -ux * side), model: dress(trainer) });
        break;
      }
    });
  }
  plans.set(atlas.id, placed);
  return placed;
}
