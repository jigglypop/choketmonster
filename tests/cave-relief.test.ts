import { describe, expect, it } from 'vitest';
import { CAVE_SCENES } from '../src/openworld/caves';
import { caveFloorHeight, caveVertexHeight } from '../src/openworld/cave-relief';
import { terrainSurfaceHeight } from '../src/openworld/grounding';
import { caveFormations } from '../src/openworld/cave-details';

describe('authored cave relief', () => {
  it('keeps every portal path open with gentle slopes and exact rendered footing', () => {
    for (const cave of CAVE_SCENES) {
      for (const portal of cave.portals) {
        const start = portal.interiorArrival;
        for (let i = 0; i <= 100; i++) {
          const t = i / 100, x = start.x * (1 - t), z = start.z * (1 - t);
          expect(cave.sample(x, z).blocked).toBe(false);
          const height = caveFloorHeight(cave.relief, x, z);
          expect(terrainSurfaceHeight(cave.sample, x, z)).toBe(height);
          expect(Math.abs(caveFloorHeight(cave.relief, x + .1, z) - height)).toBeLessThan(.15);
        }
      }
      for (const pool of cave.relief.pools) {
        expect(cave.sample(pool.x, pool.z).blocked).toBe(false);
        expect(caveFloorHeight(cave.relief, pool.x, pool.z)).toBeLessThan(pool.level - .25);
      }
    }
  });
  it('matches the floor mesh triangle between vertices, and varies cave themes', () => {
    expect(new Set(CAVE_SCENES.map(cave => cave.relief.theme)).size).toBe(5);
    for (const cave of CAVE_SCENES) {
      const a = caveVertexHeight(cave.relief, 2, 3), b = caveVertexHeight(cave.relief, 2, 4), d = caveVertexHeight(cave.relief, 3, 3);
      expect(caveFloorHeight(cave.relief, 2.2, 3.3)).toBeCloseTo(a * .5 + b * .3 + d * .2, 10);
    }
  });
  it('adds dense edge strata and pointed formations without filling walkable chamber centers', () => {
    for (const cave of CAVE_SCENES) {
      const formations = caveFormations(cave);
      expect(formations.ledges.length).toBeGreaterThan(20);
      expect(formations.stalactites.length).toBe(cave.relief.theme === 'industrial' ? 0 : formations.ledges.length / 2);
      if (cave.relief.theme === 'industrial') expect(formations.stalagmites).toHaveLength(0);
      else expect(formations.stalagmites.length).toBeGreaterThanOrEqual(Math.floor(formations.stalactites.length / 2));
      expect([...formations.ledges, ...formations.stalactites, ...formations.stalagmites].every(item =>
        cave.sample(item.x, item.z).blocked)).toBe(true);
    }
  });
});
