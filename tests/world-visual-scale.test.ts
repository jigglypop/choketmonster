import { describe, expect, it } from 'vitest';
import { POKEMON_WORLD_SCALE_BOOST, pokemonWorldDisplayHeight } from '../src/openworld/visual-scale';

describe('open-world character scale', () => {
  it('keeps partners below nearby buildings while preserving species size order', () => {
    expect(pokemonWorldDisplayHeight(.4)).toBeLessThan(1.3);
    expect(pokemonWorldDisplayHeight(.7)).toBeLessThan(2.1);
    expect(pokemonWorldDisplayHeight(.7)).toBeGreaterThan(pokemonWorldDisplayHeight(.4));
    expect(pokemonWorldDisplayHeight(1.7)).toBeGreaterThan(pokemonWorldDisplayHeight(.7));
    expect(pokemonWorldDisplayHeight(8.8)).toBeLessThan(3.5);
  });

  it('uses a safe display size for missing or invalid source heights', () => {
    expect(pokemonWorldDisplayHeight(undefined)).toBeCloseTo(pokemonWorldDisplayHeight(1));
    expect(pokemonWorldDisplayHeight(Number.NaN)).toBeCloseTo(pokemonWorldDisplayHeight(1));
  });

  it('applies the requested visual-only 18 percent size boost', () => {
    expect(POKEMON_WORLD_SCALE_BOOST).toBeGreaterThanOrEqual(1.15);
    expect(POKEMON_WORLD_SCALE_BOOST).toBeLessThanOrEqual(1.2);
  });
});
