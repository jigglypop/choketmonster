import { hasPokemonModel } from './pokemon-models';
import type { ExpansionRegion } from './expansion-encounters';

export const EXPANSION_ASSET_AUDIT = {
  sourceCommit: '429de1288cea0d43f5b4f56305d2276e94239d65',
  rigVersion: 'regional-authored-v3',
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
    paldea: { nationalDex: [906,1025], geometryVerified: 83, rigRuntimeVerified: 83 },
  },
  limitations: ['Automated deformation checks do not replace per-species human visual review.', 'Region exposure additionally requires integrated browser traversal, encounters, and save recovery.'],
} as const;

export function expansionSpeciesAssetAvailable(region: ExpansionRegion, speciesId: number): boolean {
  const audit=EXPANSION_ASSET_AUDIT.regions[region as keyof typeof EXPANSION_ASSET_AUDIT.regions];
  // Hisui is form-defined rather than a contiguous National Dex generation. Keep it unavailable
  // until its regional forms have their own model/form audit instead of treating base-species GLBs
  // as proof that the Hisuian model is present.
  if(!audit)return false;
  const [first,last]=audit.nationalDex;
  return Number.isInteger(speciesId)&&speciesId>=first&&speciesId<=last&&hasPokemonModel(speciesId);
}
