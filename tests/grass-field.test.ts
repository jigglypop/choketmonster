import { describe, expect, it } from 'vitest';
import { WORLDS, getWorldAtlas } from '../src/openworld/atlas';
import { terrainSurfaceHeight } from '../src/openworld/grounding';
import {
  GRASS_BUDGETS, GRASS_CELL, GRASS_FOREST_STEPS, buildGrassCell, grassBudgetScale, grassCellCapacity, grassCellsNear, grassField, grassLodWeight,
} from '../src/openworld/grass-field';
import { isRegionalLeagueLocation } from '../src/openworld/scene-landmarks';
import { isTownPaved, trailHalfWidth } from '../src/openworld/world-details';

const skip = (region: string) => (id: string) => isRegionalLeagueLocation(region, id);

describe('streamed wind grass placement', () => {
  for (const atlas of WORLDS) it(`${atlas.id} grows on the lawn, never on trails, water, paving or other surfaces`, () => {
    const field = grassField(atlas.sample, atlas, skip(atlas.id));
    const byId = new Map(atlas.locations.map(item => [item.id, item]));
    const towns = atlas.locations.filter(item => item.kind === 'town' && !isRegionalLeagueLocation(atlas.id, item.id));
    const probe = atlas.locations.find(item => item.kind === 'town')!;
    let blades = 0;
    for (const slot of grassCellsNear(probe, 40)) {
      const cell = buildGrassCell(field, slot.ix, slot.iz);
      if (!cell) continue;
      expect(cell.count).toBe(cell.offsets.length / 4);
      for (let index = 0; index < cell.count; index += 7) {
        const x = cell.offsets[index * 4], y = cell.offsets[index * 4 + 1], z = cell.offsets[index * 4 + 2], w = cell.offsets[index * 4 + 3];
        blades++;
        const sample = atlas.sample(x, z);
        expect(sample.biome).not.toBe('lake');
        expect(sample.biome).not.toBe('rock');
        expect(sample.surface).toBeUndefined();
        if (sample.blocked) expect(sample.biome).toBe('forest');
        expect(y).toBeCloseTo(terrainSurfaceHeight(atlas.sample, x, z) - .02, 4);
        expect(Math.floor(w)).toBeLessThanOrEqual(GRASS_FOREST_STEPS);
        expect(towns.some(town => Math.hypot(town.x - x, town.z - z) < 18 && isTownPaved(x - town.x, z - town.z))).toBe(false);
        for (const [fromId, toId] of atlas.surfaceConnections) {
          const from = byId.get(fromId)!, to = byId.get(toId)!, dx = to.x - from.x, dz = to.z - from.z;
          const t = Math.max(0, Math.min(1, ((x - from.x) * dx + (z - from.z) * dz) / (dx * dx + dz * dz || 1)));
          expect(Math.hypot(x - from.x - dx * t, z - from.z - dz * t)).toBeGreaterThan(trailHalfWidth(fromId, toId) * 1.09);
        }
      }
    }
    expect(blades).toBeGreaterThan(200);
  });

  it('is deterministic per cell and cached per sampler', () => {
    const atlas = getWorldAtlas('kanto');
    const pallet = atlas.locations.find(item => item.id === 'pallet')!;
    const slot = grassCellsNear(pallet, 30).find(item => buildGrassCell(grassField(atlas.sample, atlas), item.ix, item.iz))!;
    const first = buildGrassCell(grassField(atlas.sample, atlas), slot.ix, slot.iz)!;
    expect(buildGrassCell(grassField(atlas.sample, atlas), slot.ix, slot.iz)).toBe(first);
    const fresh = (x: number, z: number) => atlas.sample(x, z);
    expect(Array.from(buildGrassCell(grassField(fresh, atlas), slot.ix, slot.iz)!.offsets)).toEqual(Array.from(first.offsets));
  });

  it('keeps each budget prefix spread across the whole cell', () => {
    const atlas = getWorldAtlas('johto');
    const field = grassField(atlas.sample, atlas, skip('johto'));
    const cells = grassCellsNear(atlas.start, 60).map(slot => buildGrassCell(field, slot.ix, slot.iz)).filter(cell => cell && cell.count > 1000);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells.slice(0, 4)) {
      const prefix = grassCellCapacity(cell!, GRASS_BUDGETS.mobile), quadrants = [0, 0, 0, 0];
      expect(prefix).toBeLessThan(cell!.count);
      for (let index = 0; index < prefix; index++) {
        quadrants[(cell!.offsets[index * 4] > cell!.x ? 1 : 0) + (cell!.offsets[index * 4 + 2] > cell!.z ? 2 : 0)]++;
      }
      // Rejection by the lawn mask can empty a quadrant, but the R2 order never front-loads one.
      expect(Math.max(...quadrants)).toBeLessThan(prefix * .75);
    }
  });

  it('stays inside the desktop and mobile blade budgets with gaesup SFE LOD', () => {
    for (const mode of ['desktop', 'mobile'] as const) {
      const budget = GRASS_BUDGETS[mode];
      expect(grassLodWeight(budget.near, budget)).toBe(1);
      expect(grassLodWeight(budget.far, budget)).toBe(0);
      for (const atlas of WORLDS) {
        const field = grassField(atlas.sample, atlas, skip(atlas.id));
        for (const probe of atlas.locations.filter(item => item.kind === 'town').slice(0, 3)) {
          let total = 0;
          for (const slot of grassCellsNear(probe, budget.radius)) {
            const cell = buildGrassCell(field, slot.ix, slot.iz);
            // Worst case: camera at the player, no frustum culling.
            if (cell) total += Math.floor(grassCellCapacity(cell, budget) * grassLodWeight(slot.distance, budget));
          }
          // Frustum culling halves this in play; the runtime clamp covers the rest.
          expect(total).toBeLessThanOrEqual(budget.maxBlades * (mode === 'desktop' ? 1.2 : 1));
          expect(total * grassBudgetScale(total, budget)).toBeLessThanOrEqual(budget.maxBlades + 1e-6);
        }
      }
    }
    expect(grassBudgetScale(90_000, GRASS_BUDGETS.desktop)).toBeCloseTo(28_000 / 90_000);
    expect(grassBudgetScale(10_000, GRASS_BUDGETS.mobile)).toBe(1);
    expect(GRASS_BUDGETS.mobile.radius).toBeLessThan(GRASS_BUDGETS.desktop.radius);
    expect(grassCellsNear({ x: 0, z: 0 }, GRASS_BUDGETS.desktop.radius).every(slot => slot.distance <= GRASS_BUDGETS.desktop.radius)).toBe(true);
    expect(GRASS_CELL * GRASS_CELL * GRASS_BUDGETS.desktop.density).toBeLessThan(12_000);
  // Builds every cell around three towns in each region, tall grass included.
  }, 30_000);
});
