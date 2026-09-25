import { describe, expect, it } from 'vitest';
import { nextPixelRatio, recoveryRate } from '../src/openworld/adaptive-resolution';

describe('adaptive canvas resolution', () => {
  it('keeps the 38 and 57 fps thresholds on 60 Hz and faster displays', () => {
    for (const display of [60, 75, 144]) {
      expect(recoveryRate(display)).toBe(57);
      expect(nextPixelRatio(37, display, 1.5, 1.5)).toBe(1.3);
      expect(nextPixelRatio(56, display, 1.1, 1.5)).toBe(1.1);
      expect(nextPixelRatio(58, display, 1.1, 1.5)).toBe(1.2);
    }
  });

  it('recovers on displays slower than 57 Hz without fighting the 38 fps drop', () => {
    expect(nextPixelRatio(49.8, 50, 1.1, 1.5)).toBe(1.2);
    expect(recoveryRate(48)).toBeCloseTo(45.6);
    // A 30 Hz cap stays low instead of rising and dropping in turn.
    expect(nextPixelRatio(30, 30, .7, 1.5)).toBe(.7);
    expect(nextPixelRatio(30, 30, .9, 1.5)).toBe(.7);
    expect(recoveryRate(30)).toBe(40);
  });

  it('never leaves the .7 to maximum range', () => {
    expect(nextPixelRatio(10, 60, .8, 1.5)).toBe(.7);
    expect(nextPixelRatio(60, 60, 1.45, 1.5)).toBe(1.5);
    expect(nextPixelRatio(60, 60, 1.5, 1.5)).toBe(1.5);
  });
});
