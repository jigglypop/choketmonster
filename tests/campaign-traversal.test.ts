import { describe, expect, it } from 'vitest';
import { getWorldAtlas } from '../src/openworld/atlas';
import { regionalItinerary } from '../src/openworld/next-destination';
import { passagesOf, walkThroughCaves } from './helpers/cave-crossings';

describe('stage-by-stage campaign access', () => {
  for (const region of ['hoenn', 'sinnoh', 'unova', 'kalos', 'alola', 'galar', 'hisui', 'paldea']) {
    it(`${region} can reach each challenge before earning its reward`, () => {
      const atlas = getWorldAtlas(region);
      let from = atlas.start;
      for (const gym of atlas.gyms) {
        const badges = gym.badge - 1;
        const destination = atlas.locations.find(location => location.id === gym.locationId)!;
        expect(destination.requiredBadges, `${region}:${gym.locationId} self-lock`).toBeLessThanOrEqual(badges);
        expect(regionalItinerary(atlas, atlas.locationAt(from.x, from.z).id, destination.id, badges).length).toBeGreaterThan(0);
        const sample = (x: number, z: number) => ({ ...atlas.sample(x, z), blocked: !atlas.evaluateTraversal({ x, z }, { x, z }, badges).allowed });
        // A cave across the road is walked through, mouth to mouth.
        const path = walkThroughCaves(passagesOf(atlas), from, destination, sample, 24_000, 1);
        expect(path.length, `${region}:${gym.locationId} unreachable with ${badges}`).toBeGreaterThan(0);
        expect(Math.hypot(path.at(-1)!.x - destination.x, path.at(-1)!.z - destination.z)).toBeLessThan(1);
        for (const point of path) expect(atlas.evaluateTraversal(from, point, badges).allowed).toBe(true);
        from = destination;
      }
    }, 60_000);
  }

  it('Hisui gate markers coincide with real locked terrain and give an unlock condition', () => {
    const atlas = getWorldAtlas('hisui');
    expect(atlas.gates.length).toBeGreaterThan(0);
    for (const gate of atlas.gates) {
      const a = atlas.locations.find(location => location.id === gate.from)!, b = atlas.locations.find(location => location.id === gate.to)!;
      const length = Math.hypot(b.x - a.x, b.z - a.z), p = gate.position!;
      const before = { x: p.x - (b.x - a.x) / length * .01, z: p.z - (b.z - a.z) / length * .01 };
      const after = { x: p.x + (b.x - a.x) / length * .01, z: p.z + (b.z - a.z) / length * .01 };
      expect(atlas.evaluateTraversal(before, before, gate.requiredBadges - 1).allowed).not.toBe(atlas.evaluateTraversal(after, after, gate.requiredBadges - 1).allowed);
      expect(atlas.evaluateTraversal(before, after, gate.requiredBadges).allowed).toBe(true);
      expect(atlas.evaluateTraversal(after, before, gate.requiredBadges).allowed).toBe(true);
      expect(gate.reason).toContain('완료 후 개방');
      expect(atlas.gateHalfWidth(gate)).toBeGreaterThan(0);
    }
  });
});
