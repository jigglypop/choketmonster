import { describe, expect, it } from 'vitest';
import { cameraMapRotation, nearestMapOrientation, rotateMapPoint, unrotateMapPoint } from '../src/openworld/map-presentation';

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

  it('converts a clicked rotated map coordinate back to the same world-facing point', () => {
    for (const heading of Object.values({ north: Math.PI, east: Math.PI / 2, south: 0, west: -Math.PI / 2 })) {
      const rotation = cameraMapRotation(heading), displayed = rotateMapPoint(37, 181, 240, rotation);
      const restored = unrotateMapPoint(displayed.x, displayed.y, 240, rotation);
      expect(restored.x).toBeCloseTo(37);
      expect(restored.y).toBeCloseTo(181);
    }
  });
});
