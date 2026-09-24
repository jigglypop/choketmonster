import { describe, expect, it } from 'vitest';
import { NOMINAL_STRIDE_SPEED, WALK_CYCLE_RATE_RANGE, angleDifference, movementYaw, turnTowards, walkCycleRate } from '../src/openworld/motion';

describe('walk cycle rate', () => {
  it('steps larger bodies more slowly at the same ground speed', () => {
    const rates = [.8, 1.3, 2.1, 3, 4.4, 5].map(height => walkCycleRate(6, height));
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeLessThanOrEqual(rates[i - 1]);
    expect(rates[0]).toBe(WALK_CYCLE_RATE_RANGE[1]);
    expect(walkCycleRate(6, 2.1)).toBeCloseTo(6 / (NOMINAL_STRIDE_SPEED * 2.1));
    expect(walkCycleRate(3, 5)).toBe(WALK_CYCLE_RATE_RANGE[0]);
  });

  it('keeps planted feet still for clips with a measured ground speed', () => {
    // 3.6 heights per second at timeScale 1, 2.2 tall, 6 units per second.
    const rate = walkCycleRate(6, 2.2, 3.6);
    expect(rate * 3.6 * 2.2).toBeCloseTo(6);
    expect(walkCycleRate(undefined, undefined)).toBeCloseTo(2.4 / (NOMINAL_STRIDE_SPEED * 1.2));
    expect(walkCycleRate(Number.NaN, 0, -1)).toBeCloseTo(walkCycleRate(2.4, 1.2));
  });
});

describe('continuous model steering', () => {
  it('crosses the angle wrap along the short arc without a full turn or overshoot', () => {
    let yaw = Math.PI - .05;
    const target = -Math.PI + .05;
    for (let frame = 0; frame < 60; frame++) {
      const before = yaw;
      yaw = turnTowards(yaw, target, 1 / 60);
      expect(yaw).toBeGreaterThanOrEqual(before);
      expect(Math.abs(angleDifference(yaw, target))).toBeLessThanOrEqual(Math.abs(angleDifference(before, target)));
    }
    expect(Math.abs(angleDifference(yaw, target))).toBeLessThan(.001);
    expect(yaw).toBeLessThan(Math.PI + .051);
  });

  it('limits turn speed at different frame rates and retains the diagonal and idle direction', () => {
    const target = movementYaw(1, -1, 0);
    expect(target).toBeCloseTo(Math.PI * .75);
    expect(movementYaw(0, 0, target)).toBe(target);
    const results = [30, 60, 120].map(fps => {
      let yaw = 0;
      for (let frame = 0; frame < fps; frame++) {
        const next = turnTowards(yaw, target, 1 / fps);
        expect(Math.abs(next - yaw)).toBeLessThanOrEqual(6 / fps + 1e-10);
        yaw = next;
      }
      return yaw;
    });
    for (const yaw of results) expect(yaw).toBeCloseTo(target, 2);
    expect(Math.max(...results) - Math.min(...results)).toBeLessThan(.002);
    expect(turnTowards(1, 2, 0)).toBe(1);
  });
});
