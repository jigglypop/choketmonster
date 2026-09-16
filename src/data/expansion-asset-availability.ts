import { hasPokemonModel } from './pokemon-models';
import type { ExpansionRegion } from './expansion-encounters';

export const EXPANSION_ASSET_AUDIT = {
  sourceCommit: '429de1288cea0d43f5b4f56305d2276e94239d65',
  rigVersion: 'regional-authored-v4',
  evidence: {
    geometry: 'artifacts/research/region-expansion/model-audit.json',
    rigging: 'artifacts/research/region-expansion/rig-verification-{region}.json',
  },
  regions: {
    hoenn: { nationalDex: [252,386], geometryVerified: 135, rigRuntimeVerified: 135 },
    sinnoh: { nationalDex: [387,493], geometryVerified: 107, rigRuntimeVerified: 107 },
    unova: { nationalDex: [494,649], geometryVerified: 156, rigRuntimeVerified: 156 },
    kalos: { nationalDex: [650,721], geometryVerified: 72, rigRuntimeVerified: 72 },
    alola: { nationalDex: [722,809], geometryVerified: 88, rigRuntimeVerified: 88 },
    galar: { nationalDex: [810,905], geometryVerified: 79, rigRuntimeVerified: 79 },
    hisui: { nationalDex: [899,905], geometryVerified: 7, rigRuntimeVerified: 7, regionalFormsVerified: 0, encounterModelPolicy: 'national-dex-regular-form' },
    paldea: { nationalDex: [906,1025], geometryVerified: 83, rigRuntimeVerified: 83 },
  },
  limitations: ['Automated deformation checks do not replace per-species human visual review.', 'Region exposure additionally requires integrated browser traversal, encounters, and save recovery.'],
} as const;

export function expansionSpeciesAssetAvailable(region: ExpansionRegion, speciesId: number): boolean {
  const audit=EXPANSION_ASSET_AUDIT.regions[region];
  // Hisui encounter data stores National Dex species IDs. Those entries intentionally render the
  // regular form unless a separate form-aware model identity is introduced; they are never evidence
  // that a Hisuian variant model was verified. Native new species 899..905 have a focused audit.
  if(region==='hisui')return Number.isInteger(speciesId)&&speciesId>=1&&speciesId<=905&&hasPokemonModel(speciesId);
  const [first,last]=audit.nationalDex;
  return Number.isInteger(speciesId)&&speciesId>=first&&speciesId<=last&&hasPokemonModel(speciesId);
}
