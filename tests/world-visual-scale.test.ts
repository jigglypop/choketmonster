import { describe, expect, it } from 'vitest';
import { POKEMON_WORLD_SCALE_BOOST, pokemonWorldDisplayHeight } from '../src/openworld/visual-scale';

describe('open-world character scale', () => {
  it('keeps partners below nearby buildings while preserving species size order', () => {
    expect(pokemonWorldDisplayHeight(.4)).toBeLessThan(1.95);
    expect(pokemonWorldDisplayHeight(.7)).toBeLessThan(3.15);
    expect(pokemonWorldDisplayHeight(.7)).toBeGreaterThan(pokemonWorldDisplayHeight(.4));
    expect(pokemonWorldDisplayHeight(1.7)).toBeGreaterThan(pokemonWorldDisplayHeight(.7));
    expect(pokemonWorldDisplayHeight(8.8)).toBeLessThan(5.25);
  });

  it('uses a safe display size for missing or invalid source heights', () => {
    expect(pokemonWorldDisplayHeight(undefined)).toBeCloseTo(pokemonWorldDisplayHeight(1));
    expect(pokemonWorldDisplayHeight(Number.NaN)).toBeCloseTo(pokemonWorldDisplayHeight(1));
  });

  it('shrinks the enlarged visual scale to 0.8 without changing species ratios', () => {
    expect(POKEMON_WORLD_SCALE_BOOST / 1.18).toBeCloseTo(1.2);
  });
});
