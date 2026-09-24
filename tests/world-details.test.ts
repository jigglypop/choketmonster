import { describe, expect, it } from 'vitest';
import { WORLDS } from '../src/openworld/atlas';
import { createSceneryPlacements } from '../src/openworld/scenery';
import { isRegionalLeagueLocation } from '../src/openworld/scene-landmarks';
import {
  DETAIL_KINDS, SOLID_PATH_CLEARANCE, TOWN_ARRIVAL_CORE, createWorldDetails, isTownPaved, trailHalfWidth,
} from '../src/openworld/world-details';
import type { WorldAtlas } from '../src/openworld/atlas';

const SOLID_PROPS = new Set(['lamp', 'bench', 'fountain', 'statue', 'pillar']);
const details = (atlas: WorldAtlas) => {
  const base = createSceneryPlacements(atlas.sample, atlas);
  const trees = [...base['tree-round'], ...base['tree-oak'], ...base['tree-pine'], ...base['tree-fat'], ...base['tree-thin']];
  return createWorldDetails(atlas.sample, atlas, trees, id => isRegionalLeagueLocation(atlas.id, id));
};

describe('town and roadside detail placement', () => {
  for (const atlas of WORLDS) it(`${atlas.id} keeps solid dressing off roads, arrival points and buildings`, () => {
    const result = details(atlas);
    const towns = atlas.locations.filter(item => item.kind === 'town' && !isRegionalLeagueLocation(atlas.id, item.id));
    expect(result.towns.size).toBe(towns.length);
    for (const town of towns) {
      const layout = result.towns.get(town.id)!;
      expect(layout.props.length).toBeLessThan(260);
      for (const prop of layout.props.filter(item => SOLID_PROPS.has(item.kind))) {
        const x = town.x + prop.x, z = town.z + prop.z;
        if (prop.kind === 'pillar') { expect(atlas.sample(x, z).blocked).toBe(true); continue; }
        expect(Math.hypot(prop.x, prop.z)).toBeGreaterThanOrEqual(TOWN_ARRIVAL_CORE - .5);
        expect(atlas.distanceToPath(x, z)).toBeGreaterThanOrEqual(SOLID_PATH_CLEARANCE - .5);
        for (const [bx, bz] of atlas.buildingOffsets(town)) expect(Math.abs(prop.x - bx) > 4 || Math.abs(prop.z - bz) > 3.4).toBe(true);
      }
    }
    // Fences, hedges and tree lines sit on blocked ground (or inside a town lot for bedded trees).
    for (const [id, list] of Object.entries(result.framing)) for (const item of list!) {
      const sample = atlas.sample(item.x, item.z);
      if (id.startsWith('tree') && !sample.blocked) {
        const town = towns.find(candidate => Math.hypot(candidate.x - item.x, candidate.z - item.z) < 17)!;
        expect(town).toBeDefined();
        expect(atlas.distanceToPath(item.x, item.z)).toBeGreaterThanOrEqual(SOLID_PATH_CLEARANCE - .5);
      } else {
        expect(sample.blocked).toBe(true);
        expect(sample.biome).not.toBe('lake');
      }
    }
    // Flat dressing never lands in water, on town paving or on a visible road surface.
    for (const kind of DETAIL_KINDS) for (const item of result.ground[kind]) {
      expect(atlas.sample(item.x, item.z).biome).not.toBe('lake');
      if (kind === 'route-post') expect(atlas.sample(item.x, item.z).blocked).toBe(true);
    }
    const narrowest = Math.min(...atlas.surfaceConnections.map(([from, to]) => trailHalfWidth(from, to)));
    const onRoad = [...result.ground['flower-patch'], ...result.ground.pebbles].filter(item => atlas.distanceToPath(item.x, item.z) < narrowest - .05);
    expect(onRoad.length).toBe(0);
    // Posies may sit in plaza flower beds; loose pebbles never land on paving.
    const paved = result.ground.pebbles.filter(item => towns.some(town => Math.hypot(town.x - item.x, town.z - item.z) < 18 && isTownPaved(item.x - town.x, item.z - town.z)));
    expect(paved.length).toBe(0);
    // Budget: the whole region stays within a few thousand small instances.
    const total = Object.values(result.ground).reduce((sum, list) => sum + list.length, 0) + Object.values(result.framing).reduce((sum, list) => sum + list!.length, 0);
    expect(total).toBeLessThan(4000);
  });

  it('is deterministic and cached per atlas', () => {
    const atlas = WORLDS.find(item => item.id === 'johto')!;
    const first = details(atlas);
    expect(details(atlas)).toBe(first);
    const again = createWorldDetails((x, z) => atlas.sample(x, z), atlas, [], id => isRegionalLeagueLocation(atlas.id, id));
    expect(again).not.toBe(first);
    expect(again.towns.get('new-bark')!.props).toEqual(first.towns.get('new-bark')!.props);
    expect(again.ground['flower-patch'].length).toBe(first.ground['flower-patch'].length);
  });
});
