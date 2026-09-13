import { describe, expect, it } from 'vitest';
import { pokemonWorldDisplayHeight } from '../src/openworld/visual-scale';

describe('open-world character scale', () => {
  it('makes small partners legible beside 2.1m town buildings without inflating giants', () => {
    expect(pokemonWorldDisplayHeight(.4)).toBe(1.65);
    expect(pokemonWorldDisplayHeight(.7)).toBeCloseTo(2.205);
    expect(pokemonWorldDisplayHeight(1.7)).toBeCloseTo(4.355);
    expect(pokemonWorldDisplayHeight(8.8)).toBe(4.8);
  });

  it('uses a safe display size for missing or invalid source heights', () => {
    expect(pokemonWorldDisplayHeight(undefined)).toBeCloseTo(2.85);
    expect(pokemonWorldDisplayHeight(Number.NaN)).toBeCloseTo(2.85);
  });
});
