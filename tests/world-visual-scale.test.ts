import { describe, expect, it } from 'vitest';
import { POKEMON_REAL_HEIGHT_RANGE, POKEMON_WORLD_SCALE_BOOST, pokemonSizeCurve, pokemonWorldDisplayHeight } from '../src/openworld/visual-scale';

/** The former rule: a linear law clamped to 1.18..3.45 before the same world multiplier. */
const former = (height: number) => Math.min(3.45, Math.max(1.18, height * 2.15 * .72 + .7 * .72));

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
    expect(pokemonWorldDisplayHeight(-2)).toBeCloseTo(pokemonWorldDisplayHeight(POKEMON_REAL_HEIGHT_RANGE[0]));
    expect(pokemonWorldDisplayHeight(100)).toBeCloseTo(pokemonWorldDisplayHeight(POKEMON_REAL_HEIGHT_RANGE[1]));
  });

  it('shrinks the enlarged visual scale to 0.8 without changing species ratios', () => {
    expect(POKEMON_WORLD_SCALE_BOOST / 1.18).toBeCloseTo(1.2);
  });

  it('follows real height from about 0.8 (0.1 m) to 4.8 (20 m) on an increasing concave curve', () => {
    expect(pokemonSizeCurve(.1)).toBeCloseTo(.8, 2);
    expect(pokemonSizeCurve(20)).toBeCloseTo(4.8, 2);
    let previous = pokemonSizeCurve(.1), slope = Infinity;
    for (let height = .11; height <= 20; height += .01) {
      const value = pokemonSizeCurve(height), next = (value - previous) / .01;
      expect(next).toBeGreaterThan(0);
      expect(next).toBeLessThanOrEqual(slope + 1e-6);
      previous = value; slope = next;
    }
  });

  it('keeps 0.5-1.5 m species within 7% of the former size and spreads the extremes apart', () => {
    for (const height of [.5, .6, .7, .8, 1, 1.2, 1.5]) expect(Math.abs(pokemonSizeCurve(height) / former(height) - 1)).toBeLessThan(.07);
    // Joltik is smaller than before, Onix no longer shares Charizard's cap, Eternatus tops Wailord.
    expect(pokemonSizeCurve(.1)).toBeLessThan(former(.1) * .7);
    expect(pokemonSizeCurve(8.8) / pokemonSizeCurve(1.7)).toBeGreaterThan(1.4);
    expect(pokemonSizeCurve(20)).toBeGreaterThan(pokemonSizeCurve(14.5));
  });
});
