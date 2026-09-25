import { GENERATED_FIELD_TRAINERS } from './field-trainers.generated';
import { GENERATED_ROUTE_TRAINERS } from './route-trainers.generated';
import authoredTrainers from './authored-trainers.json' with { type: 'json' };
import type { CampaignRegion } from '../game/campaign';
export type FieldTrainer = {
  id: string; region: CampaignRegion; locationId: string; name: string; trainerClass: string;
  team: readonly (readonly [speciesId: number, level: number])[]; reward: number;
  sourceClass?: string; female?: boolean; sourceMap?: string; sourceX?: number; sourceZ?: number;
  trainerOrigin?: 'source' | 'supplemental' | 'authored';
};

export const FIELD_TRAINER_SOURCE = {
  repository: 'https://github.com/pret/pokecrystal', commit: '7a7881d0d62e0ddbd82dcf10e7116807487ac651', license: 'not-declared',
  partyFile: { path: 'data/trainers/parties.asm', sha256: '934e5a781c64c000c82423ea3bde5ef947549112d4129f5e075a084f343d7eba' },
  note: 'Trainer parties and map placements are factual transcriptions from Pokemon Crystal. The source repository declares no license; review rights before public deployment. Encounter tables use HeartGold separately.',
} as const;

const TRAINER_FREE_PROGRESS_LOCATIONS = ['new-bark','tohjo-falls','mt-silver','route-29','cherrygrove','burned-tower','bell-tower','olivine','whirl-islands','mt-mortar','ice-path','dark-cave-east','dark-cave-west'] as const;
/** Crystal's Johto, then FireRed's Kanto and Emerald's Hoenn routes (scripts/generate-route-trainers.ts). */
const sourceTrainers = [...GENERATED_FIELD_TRAINERS, ...GENERATED_ROUTE_TRAINERS].map(trainer => ({ ...trainer, trainerOrigin: 'source' as const }));
const supplementalTrainers = TRAINER_FREE_PROGRESS_LOCATIONS.map((locationId, index): FieldTrainer => {
  const source = sourceTrainers[index % sourceTrainers.length];
  return { ...source, id: `supplemental-${locationId}-${source.id}`, locationId, trainerOrigin: 'supplemental' };
});
/** Crystal map trainers plus explicitly labeled placements for progression locations whose original map has none. */
const authoredRoster: FieldTrainer[] = authoredTrainers.map(trainer => ({ ...trainer,
  region: trainer.region as CampaignRegion, trainerOrigin: 'authored',
  team: trainer.team.map(([speciesId, level]) => [speciesId, level] as const),
}));
export const FIELD_TRAINERS: readonly FieldTrainer[] = [...sourceTrainers, ...supplementalTrainers, ...authoredRoster];
const FIELD_TRAINER_BY_ID = new Map(FIELD_TRAINERS.map(trainer => [trainer.id, trainer]));

export function availableFieldTrainer(region: string, locationId: string, defeated: readonly string[] = []): FieldTrainer | undefined {
  return fieldTrainersAt(region, locationId).find(trainer => !defeated.includes(trainer.id));
}
export function fieldTrainersAt(region: string, locationId: string): FieldTrainer[] {
  const matches = (trainerLocation: string) => trainerLocation === locationId
    || trainerLocation === 'route-42' && locationId.startsWith('route-42-')
    || trainerLocation === 'dark-cave' && locationId.startsWith('dark-cave-');
  return FIELD_TRAINERS.filter(trainer => trainer.region === region && matches(trainer.locationId))
    .sort((a, b) => Math.max(...a.team.map(([, level]) => level)) - Math.max(...b.team.map(([, level]) => level)));
}
export function getFieldTrainer(id: string): FieldTrainer | undefined { return FIELD_TRAINER_BY_ID.get(id); }
