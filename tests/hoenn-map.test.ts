import { describe, expect, it } from 'vitest';
import { HOENN_CONNECTIONS, HOENN_GATES, HOENN_GYMS, HOENN_LOCATIONS, evaluateHoennTraversal, sampleHoennWorld } from '../src/openworld/hoenn';
import { getWorldAtlas } from '../src/openworld/atlas';
import { WORLD_SCALE } from '../src/openworld/world-space';

const at = (id: string) => HOENN_LOCATIONS.find(item => item.id === id)!;

describe('Hoenn story gating', () => {
  it('opens each area with the Emerald badge that first lets the player reach it', () => {
    expect(Object.fromEntries(['rustboro-city', 'dewford-town', 'slateport-city', 'hoenn-route-111', 'hoenn-route-119', 'hoenn-route-120', 'sootopolis-city', 'hoenn-victory-road']
      .map(id => [id, at(id).requiredBadges]))).toEqual({ 'rustboro-city': 0, 'dewford-town': 1, 'slateport-city': 2, 'hoenn-route-111': 3, 'hoenn-route-119': 5, 'hoenn-route-120': 6, 'sootopolis-city': 7, 'hoenn-victory-road': 8 });
    for (const gym of HOENN_GYMS) expect(at(gym.locationId).requiredBadges, gym.locationId).toBeLessThan(gym.badge);
    for (let badges = 0; badges <= 8; badges++) {
      const reached = new Set(['littleroot-town']), queue = ['littleroot-town'];
      for (let head = 0; head < queue.length; head++) for (const [a, b] of HOENN_CONNECTIONS) {
        const next = a === queue[head] ? b : b === queue[head] ? a : undefined;
        if (next && !reached.has(next) && at(next).requiredBadges <= badges) { reached.add(next); queue.push(next); }
      }
      expect(HOENN_LOCATIONS.filter(item => item.requiredBadges <= badges && !reached.has(item.id)).map(item => item.id), `stage ${badges}`).toEqual([]);
    }
  });

  it('marks every badge boundary on a road with a gate at the real locked terrain', () => {
    const atlas = getWorldAtlas('hoenn');
    expect(atlas.gates).toBe(HOENN_GATES);
    expect(HOENN_GATES.length).toBeGreaterThan(0);
    for (const gate of HOENN_GATES) {
      const a = at(gate.from), b = at(gate.to), length = Math.hypot(b.x - a.x, b.z - a.z), p = gate.position!;
      const before = { x: p.x - (b.x - a.x) / length * .01, z: p.z - (b.z - a.z) / length * .01 };
      const after = { x: p.x + (b.x - a.x) / length * .01, z: p.z + (b.z - a.z) / length * .01 };
      expect(evaluateHoennTraversal(before, before, gate.requiredBadges - 1).allowed).not.toBe(evaluateHoennTraversal(after, after, gate.requiredBadges - 1).allowed);
      expect(evaluateHoennTraversal(before, after, gate.requiredBadges).allowed).toBe(true);
      expect(gate.reason).toContain('완료 후 개방');
      expect(atlas.gateHalfWidth(gate)).toBeGreaterThan(0);
    }
  });

  it('adds the legendary lairs beside their anchors on dry ground, locked until the eighth badge', () => {
    const lairs = { 'sky-pillar': ['하늘기둥', 'special', 'pacifidlog-town'], 'cave-of-origin': ['각성의사당', 'cave', 'sootopolis-city'],
      'desert-ruins': ['사막유적', 'special', 'hoenn-route-111'], 'island-cave': ['섬의동굴', 'cave', 'dewford-town'],
      'ancient-tomb': ['고대무덤', 'special', 'hoenn-route-120'], 'southern-island': ['남쪽외딴섬', 'special', 'hoenn-route-121'] } as const;
    const units = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z) / WORLD_SCALE;
    for (const [id, [name, kind, anchorId]] of Object.entries(lairs)) {
      const lair = at(id), anchor = at(anchorId);
      expect(lair).toMatchObject({ name, kind, requiredBadges: 8 });
      expect(HOENN_CONNECTIONS.filter(link => link.includes(id))).toEqual([[anchorId, id]]);
      expect(units(lair, anchor)).toBeGreaterThanOrEqual(8); expect(units(lair, anchor)).toBeLessThanOrEqual(14);
      for (const other of HOENN_LOCATIONS.filter(item => item.id !== id)) {
        expect(units(lair, other), `${id}:${other.id}`).toBeGreaterThanOrEqual(7);
        if (other.id === anchorId) continue;
        const dx = lair.x - anchor.x, dz = lair.z - anchor.z, t = Math.max(0, Math.min(1, ((other.x - anchor.x) * dx + (other.z - anchor.z) * dz) / (dx * dx + dz * dz)));
        expect(units(other, { x: anchor.x + dx * t, z: anchor.z + dz * t }), `${id} link:${other.id}`).toBeGreaterThanOrEqual(4);
      }
      for (let step = 0; step <= 20; step++) {
        const t = step / 20, ground = sampleHoennWorld(anchor.x + (lair.x - anchor.x) * t, anchor.z + (lair.z - anchor.z) * t);
        expect(ground.blocked, `${id}@${t}`).toBe(false); expect(ground.biome, `${id}@${t}`).not.toBe('lake');
      }
      expect(evaluateHoennTraversal(lair, lair, 7).allowed).toBe(false);
      expect(evaluateHoennTraversal(lair, lair, 8).allowed).toBe(true);
    }
  });
});
