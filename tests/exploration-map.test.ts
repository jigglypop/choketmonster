import { describe, expect, it } from 'vitest';
import { getWorldAtlas } from '../src/openworld/atlas';
import { PLAYABLE_WORLDS } from '../src/openworld/availability';
import { buildExplorationSites, buildRouteEdgeMarkers, nearbyExplorationSites } from '../src/openworld/exploration-sites';
import { filterMapLocations } from '../src/openworld/map-explorer';
import { atlasMapProjection, terrainMapColor } from '../src/openworld/map-terrain';

describe('regional exploration map', () => {
  it('adds reachable roadside landmarks without covering the center of the roads in every region', () => {
    const themes = new Set<string>();
    for (const region of PLAYABLE_WORLDS) {
      const atlas = getWorldAtlas(region.id), sites = buildExplorationSites(atlas, atlas.sample, 8);
      expect(sites.length, region.id).toBeGreaterThan(0);
      expect(new Set(sites.map(site => site.id)).size).toBe(sites.length);
      for (const site of sites) {
        themes.add(site.theme); expect(atlas.sample(site.x, site.z).blocked).toBe(false);
        if (site.kind !== 'bridge') expect(atlas.distanceToPath(site.x, site.z)).toBeGreaterThanOrEqual(3.45);
      }
      for (const post of buildRouteEdgeMarkers(atlas, atlas.sample, 8)) expect(atlas.sample(post.x, post.z).blocked).toBe(false);
      expect(nearbyExplorationSites(sites, { x: 10000, z: 10000 }, 92)).toEqual([]);
      const projection = atlasMapProjection(atlas);
      for (const location of atlas.locations) expect(Math.abs((location.x - projection.centerX) * projection.scale)).toBeLessThanOrEqual(98.01);
    }
    expect(themes.size).toBe(PLAYABLE_WORLDS.length);
  });
  it('searches actual Pokemon and item acquisition sites and filters unvisited towns', () => {
    const atlas = getWorldAtlas('kanto');
    expect(filterMapLocations(atlas, '먹다남은음식', 'items', []).length).toBeGreaterThan(0);
    expect(filterMapLocations(atlas, 'Pikachu', 'all', []).length).toBeGreaterThan(0);
    const towns = atlas.locations.filter(item => item.kind === 'town');
    expect(filterMapLocations(atlas, '', 'unvisited', towns.map(item => item.id))).toEqual([]);
    expect(filterMapLocations(atlas, '존재하지않는도구', 'all', [])).toEqual([]);
    expect(terrainMapColor({ height: 0, biome: 'lake', blocked: false }, 0)).not.toEqual(terrainMapColor({ height: 0, biome: 'forest', blocked: false }, 0));
  });
});
