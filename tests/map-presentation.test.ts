import { describe, expect, it } from 'vitest';
import { cameraMapRotation, nearestMapOrientation, rotateMapPoint } from '../src/openworld/map-presentation';

describe('map orientation', () => {
  it('matches the camera yaw convention at all four compass ends', () => {
    expect(nearestMapOrientation(Math.PI)).toBe('north');
    expect(nearestMapOrientation(Math.PI / 2)).toBe('east');
    expect(nearestMapOrientation(0)).toBe('south');
    expect(nearestMapOrientation(-Math.PI / 2)).toBe('west');
  });

  it('keeps north up and rotates east to the top in camera-follow mode', () => {
    expect(rotateMapPoint(50, 20, 100, cameraMapRotation(Math.PI))).toEqual({ x: 50, y: 20 });
    const east = rotateMapPoint(80, 50, 100, cameraMapRotation(Math.PI / 2));
    expect(east.x).toBeCloseTo(50);
    expect(east.y).toBeCloseTo(20);
  });
});
