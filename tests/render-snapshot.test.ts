import { describe, expect, it } from 'vitest';
import { sameRenderSnapshot } from '../src/openworld/view';
import type { OpenWorldRenderSnapshot } from '../src/openworld/types';

const snapshot = (): OpenWorldRenderSnapshot => ({
  regionId: 'johto', sceneId: 'surface:johto', tick: 4, badges: 0,
  player: { x: 1, z: 2, heading: 0 }, selectedWildId: null,
  guide: { title: '다음 목적지', detail: '길을 따라 이동', status: 'route', points: [{ x: 3, z: 4 }] },
  gyms: [{ locationId: 'violet', badge: 1, badgeName: '윙배지', name: '도라지체육관', speciesId: 16, level: 9 }],
  entities: [{ id: 'companion:1', speciesId: 152, name: '치코리타', level: 5, hp: 20, maxHp: 20, x: 1, z: 2, action: 'idle' }],
  foods: [{ id: '1', x: 5, z: 6 }],
});

describe('render snapshot equality', () => {
  it('skips structurally identical polling snapshots', () => {
    expect(sameRenderSnapshot(snapshot(), snapshot())).toBe(true);
  });

  it('admits visible state changes', () => {
    const previous = snapshot(), moved = snapshot(), damaged = snapshot();
    moved.player.x += .1;
    damaged.entities = [{ ...damaged.entities[0], hp: 12 }];
    expect(sameRenderSnapshot(moved, previous)).toBe(false);
    expect(sameRenderSnapshot(damaged, previous)).toBe(false);
    const renamed = snapshot();
    renamed.entities = [{ ...renamed.entities[0], name: '새 이름' }];
    expect(sameRenderSnapshot(renamed, previous)).toBe(false);
  });
});
