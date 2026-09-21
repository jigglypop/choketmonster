import manifest from './pokemon-alola-models-manifest.json' with { type: 'json' };
import megaManifest from './pokemon-mega-models-manifest.json' with { type: 'json' };

export type PokemonFormModelSource = { identifier: string; speciesId: number; url: string; heightMeters: number; sha256: string; bytes: number };
export const ALOLA_MODEL_SOURCES: readonly PokemonFormModelSource[] = manifest.entries;
export const MEGA_MODEL_SOURCES: readonly PokemonFormModelSource[] = megaManifest.entries;
const sources = [...ALOLA_MODEL_SOURCES, ...MEGA_MODEL_SOURCES];
const byIdentifier = new Map(sources.map(source => [source.identifier, source]));
const byUrl = new Map(sources.map(source => [source.url, source]));

export function getPokemonFormModelSource(identifier?: string): PokemonFormModelSource | undefined {
  return identifier ? byIdentifier.get(identifier) : undefined;
}
export function getPokemonFormModelByUrl(url: string): PokemonFormModelSource | undefined {
  return byUrl.get(url);
}
