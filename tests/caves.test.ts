import { describe, expect, it } from 'vitest';
import { getWorldAtlas, getWorldScene } from '../src/openworld/atlas';
import {
  CAVE_SCENES, cavePortalAtInterior, cavePortalAtSurface, getCaveScene, nearestCaveWalkable,
} from '../src/openworld/caves';
import {
  WORLD_MAX, WORLD_MIN, migrateSurfaceSnapshotCoordinates, surfaceSceneId,
} from '../src/openworld/world-space';

describe('expanded world space', () => {
  it('uses stable scene ids and migrates every persisted surface coordinate once at the v2-to-v3 boundary', () => {
    expect([WORLD_MIN, WORLD_MAX]).toEqual([-240, 240]);
    expect(surfaceSceneId('kanto')).toBe('surface:kanto');
    const snapshot = {
      player: { x: -68, z: 82, heading: 1 }, entities: [{ x: 4, z: -5, id: 'wild', target: { x: 2, z: 3 } }],
      companionMemories: [{ x: -3, z: 5 }], foods: [{ x: 7, z: 8 }],
      spawnAnchor: { x: 9, z: -10 }, respawnQueue: [{ originX: 11, originZ: -12, dueAt: 9 }], untouched: 37,
    };
    expect(migrateSurfaceSnapshotCoordinates(snapshot)).toMatchObject({
      player: { x: -136, z: 164, heading: 1 }, entities: [{ x: 8, z: -10, id: 'wild', target: { x: 4, z: 6 } }],
      companionMemories: [{ x: -6, z: 10 }], foods: [{ x: 14, z: 16 }],
      spawnAnchor: { x: 18, z: -20 }, respawnQueue: [{ originX: 22, originZ: -24, dueAt: 9 }], untouched: 37,
    });
  });

  it('expands every selectable atlas and exposes only region-owned cave scenes', () => {
    for (const regionId of ['kanto', 'johto', 'hoenn', 'sinnoh', 'unova', 'kalos', 'alola', 'galar', 'hisui', 'paldea']) {
      const atlas = getWorldAtlas(regionId);
      expect(atlas.surfaceSceneId).toBe(`surface:${regionId}`);
      expect(atlas.locations.every(point => Math.abs(point.x) <= WORLD_MAX && Math.abs(point.z) <= WORLD_MAX)).toBe(true);
      expect(atlas.locations.some(point => Math.abs(point.x) > 120 || Math.abs(point.z) > 120)).toBe(true);
      expect(getWorldScene(regionId, atlas.surfaceSceneId)).toBe(atlas);
      expect(atlas.caves.every(cave => cave.regionId === regionId)).toBe(true);
    }
    expect(() => getWorldScene('kanto', 'surface:johto')).toThrow(RangeError);
    expect(() => getWorldScene('kanto', 'cave:johto:union-cave')).toThrow(RangeError);
  });
});

describe('isolated cave layouts', () => {
  it('provides distinct bounded wall layouts and readable portal labels', () => {
    expect(CAVE_SCENES).toHaveLength(16);
    expect(new Set(CAVE_SCENES.map(scene => scene.sceneId)).size).toBe(CAVE_SCENES.length);
    expect(new Set(CAVE_SCENES.map(scene => scene.wallSegments.map(wall => `${wall.x},${wall.z},${wall.width}`).join('|'))).size).toBe(CAVE_SCENES.length);
    for (const scene of CAVE_SCENES) {
      expect(scene.sceneId).toBe(`cave:${scene.regionId}:${scene.id}`);
      expect(scene.label).toMatch(/^[\x20-\x7e]+$/);
      expect(scene.portals.length).toBeGreaterThan(0);
      expect(scene.wallSegments.length).toBeGreaterThan(20);
      expect(getCaveScene(scene.sceneId)).toBe(scene);
      for (const portal of scene.portals) {
        expect(scene.sample(portal.interior.x, portal.interior.z).blocked).toBe(false);
        expect(scene.sample(portal.interiorArrival.x, portal.interiorArrival.z).blocked).toBe(false);
        expect(cavePortalAtInterior(scene.sceneId, portal.interior.x, portal.interior.z)).toBe(portal);
        expect(cavePortalAtSurface(scene.regionId, portal.surface.x, portal.surface.z)).toEqual({ scene, portal });
      }
    }
  });

  it('connects all entrances through walkable interior tiles and recovers from walls', () => {
    for (const scene of CAVE_SCENES) {
      const start = scene.portals[0].interior;
      const queue = [start], reached = new Set([`${start.x},${start.z}`]);
      while (queue.length) {
        const point = queue.shift()!;
        for (const [dx, dz] of [[scene.tileSize, 0], [-scene.tileSize, 0], [0, scene.tileSize], [0, -scene.tileSize]]) {
          const next = { x: point.x + dx, z: point.z + dz }, key = `${next.x},${next.z}`;
          if (!reached.has(key) && !scene.sample(next.x, next.z).blocked) { reached.add(key); queue.push(next); }
        }
      }
      for (const portal of scene.portals) expect(reached.has(`${portal.interior.x},${portal.interior.z}`), scene.sceneId).toBe(true);
      const recovered = nearestCaveWalkable(scene.sceneId, scene.width, scene.depth);
      expect(recovered).toBeDefined();
      expect(scene.sample(recovered!.x, recovered!.z).blocked).toBe(false);
    }
  });
});
