/** Render height only; simulation positions, speed and collision stay unchanged. */
export const POKEMON_WORLD_SCALE_BOOST = 1.18 * 1.5 * .8;

export function pokemonWorldDisplayHeight(heightMeters: number | undefined): number {
  const height = Number.isFinite(heightMeters) ? Math.max(0, heightMeters!) : 1;
  return Math.min(3.45, Math.max(1.18, height * 2.15 * .72 + .7 * .72)) * .73 * POKEMON_WORLD_SCALE_BOOST;
}
