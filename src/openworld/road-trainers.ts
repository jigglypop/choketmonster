import { fieldTrainersAt, type FieldTrainer } from '../data/field-trainers';
import type { WorldAtlas } from './atlas';
import { trailHalfWidth } from './world-details';

/** Road trainers wear the owner's figures, chosen by trainer class. */
const figure = (name: 'teacher' | 'man' | 'mountain' | 'docter' | 'police' | 'nurse' | 'boy') => `/models/trainer/web/${name}.glb`;
const FIGURE_BY_CLASS: ReadonlyArray<readonly [RegExp, string]> = [
  [/경찰|순경|경비|OFFICER|POLICE|GUARD/i, figure('police')],
  [/GRUNT|로켓|BURGLAR|도둑|JUGGLER|저글러|GAMBLER|갬블러|BIKER|폭주족|ROCKER|로커|CUE ?BALL|깡패/i, figure('man')],
  [/간호|NURSE|아가씨|LASS|피크니커|PICNICKER|쌍둥이|TWINS|숙녀|LADY|BEAUTY|미녀|미니스커트|COOLTRAINERF|POKEFANF|무당|MEDIUM|SKIER|스키어|AROMA|아로마/i, figure('nurse')],
  [/반바지|YOUNGSTER|곤충|BUG|꼬마|소년|SCHOOL|캠퍼|CAMPER|TUBER|KID/i, figure('boy')],
  [/등산가|HIKER|낚시|FISHER|선원|SAILOR|탐험|RUIN|새 조련사|BIRD|불놀이꾼|FIREBREATHER|태권왕|BLACK ?BELT|보더|BOARDER/i, figure('mountain')],
  [/과학자|SCIENTIST|박사|연구|매니아|MANIAC|NERD|괴짜|의사|DOCTOR/i, figure('docter')],
  [/선생|TEACHER|신사|GENTLEMAN|엘리트|COOLTRAINER|수행자|SAGE|초능력|PSYCHIC|POKEFAN|애호가/i, figure('teacher')],
];
/** A trainer of no particular class takes the next figure in turn, so neighbours on a road never look alike. */
const FALLBACK = [figure('boy'), figure('nurse'), figure('man'), figure('teacher'), figure('mountain')];

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
 * and facing it, on open ground inside its own place and apart from each other. Trainers of towns, caves and gyms
 * keep to the trainer list, and swimmers keep to the sea.
 */
export function roadTrainers(atlas: WorldAtlas): readonly RoadTrainer[] {
  const cached = plans.get(atlas.id); if (cached) return cached;
  const byId = new Map(atlas.locations.map(place => [place.id, place]));
  const placed: RoadTrainer[] = [];
  for (const place of atlas.locations) {
    if (place.kind !== 'route' && place.kind !== 'forest') continue;
    const trainers = fieldTrainersAt(atlas.id, place.id).filter(trainer => !/SWIMMER|수영|비키니/i.test(trainer.trainerClass));
    const roads = atlas.surfaceConnections.flatMap(([from, to]) => from === place.id ? [to] : to === place.id ? [from] : [])
      .map(id => byId.get(id)).filter((other): other is NonNullable<typeof other> => !!other && other.kind !== 'sea');
    if (!trainers.length || !roads.length) continue;
    trainers.forEach((trainer, index) => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const road = roads[(index + attempt) % roads.length], side = (index + attempt) % 2 ? 1 : -1;
        const along = .16 + .07 * ((Math.floor(index / roads.length) + attempt) % 5);
        const dx = road.x - place.x, dz = road.z - place.z, length = Math.hypot(dx, dz) || 1, ux = dx / length, uz = dz / length;
        const lateral = trailHalfWidth(place.id, road.id) + .9;
        const x = place.x + dx * along - uz * side * lateral, z = place.z + dz * along + ux * side * lateral;
        if (atlas.sample(x, z).blocked || atlas.locationAt(x, z).id !== place.id) continue;
        if (placed.some(other => Math.hypot(other.x - x, other.z - z) < 3.2)) continue;
        const known = FIGURE_BY_CLASS.find(([pattern]) => pattern.test(trainer.trainerClass))?.[1];
        placed.push({ trainer, x, z, facing: Math.atan2(uz * side, -ux * side), model: known ?? FALLBACK[(hash(atlas.id) + placed.length) % FALLBACK.length] });
        break;
      }
    });
  }
  plans.set(atlas.id, placed);
  return placed;
}
