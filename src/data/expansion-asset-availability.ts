import { hasPokemonModel } from './pokemon-models';
import type { ExpansionRegion } from './expansion-encounters';

export const EXPANSION_ASSET_AUDIT = {
  sourceCommit: '429de1288cea0d43f5b4f56305d2276e94239d65',
  rigVersion: 'regional-authored-v2',
  evidence: {
    geometry: 'artifacts/research/region-expansion/model-audit.json',
    rigging: 'artifacts/research/region-expansion/rig-verification.json',
  },
  regions: {
    hoenn: { nationalDex: [252,386], geometryVerified: 135, rigRuntimeVerified: 135 },
    sinnoh: { nationalDex: [387,493], geometryVerified: 107, rigRuntimeVerified: 107 },
    unova: { nationalDex: [494,649], geometryVerified: 156, rigRuntimeVerified: 156 },
  },
  limitations: ['Automated deformation checks do not replace per-species human visual review.', 'Region exposure additionally requires integrated browser traversal, encounters, and save recovery.'],
} as const;

export function expansionSpeciesAssetAvailable(region: ExpansionRegion, speciesId: number): boolean {
  const [first,last]=EXPANSION_ASSET_AUDIT.regions[region].nationalDex;
  return Number.isInteger(speciesId)&&speciesId>=first&&speciesId<=last&&hasPokemonModel(speciesId);
}
