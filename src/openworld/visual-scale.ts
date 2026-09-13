/** Render height only; simulation positions, speed and collision stay unchanged. */
export function pokemonWorldDisplayHeight(heightMeters: number | undefined): number {
  const height = Number.isFinite(heightMeters) ? Math.max(0, heightMeters!) : 1;
  return Math.min(4.8, Math.max(1.65, height * 2.15 + .7));
}
