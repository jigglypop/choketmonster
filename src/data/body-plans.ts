import { pokemonBodyShape, type PokemonBodyShape } from './pokemon-body-shapes';

/**
 * How a body travels over the ground. It picks the skeleton authored for a static model and the gait of every
 * authored walk: bipeds and quadrupeds step, many-legged bodies step in alternating tripods, serpents wave,
 * fish swim, flyers flap, and floaters (balls, blobs, arm- or tentacle-only bodies, groups) drift and bob.
 */
export type BodyPlan = 'biped' | 'quadruped' | 'multileg' | 'serpent' | 'fish' | 'flyer' | 'floater';

const FROM_SHAPE: Record<PokemonBodyShape, BodyPlan> = {
  humanoid: 'biped', upright: 'biped', legs: 'biped', quadruped: 'quadruped', armor: 'multileg', squiggle: 'serpent', fish: 'fish',
  wings: 'flyer', 'bug-wings': 'flyer', ball: 'floater', blob: 'floater', arms: 'floater', heads: 'floater', tentacles: 'floater',
};

/** Models whose 3D pose differs from their Pokédex icon. */
const POSE_OVERRIDES: Readonly<Record<number, BodyPlan>> = {
  161: 'biped', // Sentret stands up on its tail.
  614: 'biped', 758: 'biped', 827: 'biped', // Beartic, Salazzle and Nickit stand upright with their arms held out.
  356: 'floater', 385: 'floater', 491: 'floater', 518: 'floater', // Dusclops, Jirachi, Darkrai and Musharna hover.
  480: 'floater', 481: 'floater', 482: 'floater', // The lake guardians hover.
  965: 'floater', 966: 'floater', // Varoom and Revavroom roll on their engine bodies.
};
/** Forms that move unlike their species: Alolan Raichu rides its tail. */
const FORM_OVERRIDES: Readonly<Record<string, BodyPlan>> = { 'raichu-alola': 'floater' };

export function pokemonBodyPlan(speciesId: number, formIdentifier?: string): BodyPlan {
  const override = (formIdentifier && FORM_OVERRIDES[formIdentifier]) || POSE_OVERRIDES[speciesId]; if (override) return override;
  const shape = pokemonBodyShape(speciesId);
  return shape ? FROM_SHAPE[shape] : 'biped';
}

/** Plans whose walk is a stepping cycle of planted feet. */
export const isSteppingPlan = (plan: BodyPlan) => plan === 'biped' || plan === 'quadruped' || plan === 'multileg';
