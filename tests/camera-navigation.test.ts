import { describe, expect, it } from 'vitest';
import { applyCameraAction, MAX_CAMERA_DISTANCE, MIN_CAMERA_DISTANCE } from '../src/openworld/camera-navigation';

describe('open-world camera controls', () => {
  it('clamps repeated wheel/button zoom to the supported range', () => {
    let near = { radius: 4.1, phi: .7, theta: 0 };
    let far = { radius: 47, phi: .7, theta: 0 };
    for (let index = 0; index < 20; index += 1) near = applyCameraAction(near, 'zoom-in');
    for (let index = 0; index < 20; index += 1) far = applyCameraAction(far, 'zoom-out');
    expect(near.radius).toBe(MIN_CAMERA_DISTANCE);
    expect(far.radius).toBe(MAX_CAMERA_DISTANCE);
  });

  it('keeps orbit pitch readable while rotating freely around the partner', () => {
    expect(applyCameraAction({ radius: 12, phi: .4, theta: 0 }, 'up').phi).toBe(.38);
    expect(applyCameraAction({ radius: 12, phi: 1.15, theta: 0 }, 'down').phi).toBe(1.18);
    expect(applyCameraAction({ radius: 12, phi: .7, theta: 0 }, 'right').theta).toBeLessThan(0);
  });
});
