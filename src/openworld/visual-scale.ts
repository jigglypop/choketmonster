/** Render height only; simulation positions, speed and collision stay unchanged. */
export const POKEMON_WORLD_SCALE_BOOST = 1.18 * 1.5 * .8;
/** Pokédex heights in the data run from 0.1 m (Joltik) to 20 m (Eternatus); others are clamped to this range. */
export const POKEMON_REAL_HEIGHT_RANGE = [.1, 20] as const;

/**
 * Relative size before the world multiplier: about 0.8 at 0.1 m and 4.8 at 20 m. Small and mid-size
 * species keep close to the former linear law (0.66 + 1.4 h); giants follow a gentle power law
 * (3.156 h^0.14), so an 8.8 m Onix stands clearly above a 1.7 m Charizard without dwarfing the town.
 * A smooth minimum of two increasing concave curves is itself increasing and concave.
 */
export function pokemonSizeCurve(heightMeters: number | undefined): number {
  const [lowest, highest] = POKEMON_REAL_HEIGHT_RANGE;
  const height = Number.isFinite(heightMeters) ? Math.min(highest, Math.max(lowest, heightMeters!)) : 1;
  const linear = .66 + 1.4 * height, giant = 3.156 * height ** .14;
  return (linear ** -8 + giant ** -8) ** (-1 / 8);
}

export function pokemonWorldDisplayHeight(heightMeters: number | undefined): number {
  return pokemonSizeCurve(heightMeters) * .73 * POKEMON_WORLD_SCALE_BOOST;
}
