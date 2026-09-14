import { describe, expect, it } from 'vitest';
import { pokemonWorldDisplayHeight } from '../src/openworld/visual-scale';

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
});
