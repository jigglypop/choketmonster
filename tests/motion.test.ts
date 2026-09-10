import { describe, expect, it } from 'vitest';
import { angleDifference, movementYaw, turnTowards } from '../src/openworld/motion';

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
