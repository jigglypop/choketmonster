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

describe('open cave chambers', () => {
  it('keeps stable scenes and portals inside varied continuous chamber outlines', () => {
    expect(CAVE_SCENES).toHaveLength(16);
    expect(new Set(CAVE_SCENES.map(scene => scene.sceneId)).size).toBe(CAVE_SCENES.length);
    for (const scene of CAVE_SCENES) {
      expect(scene.sceneId).toBe(`cave:${scene.regionId}:${scene.id}`);
      expect(scene.label).toMatch(/^[\x20-\x7e]+$/);
      expect(scene.portals.length).toBeGreaterThan(0);
      expect(scene.wallSegments).toHaveLength(48);
      expect(scene.outline).toHaveLength(scene.wallSegments.length);
      expect(scene.width).toBeGreaterThan(scene.legacyWidth);
      expect(scene.depth).toBeGreaterThan(scene.legacyDepth);
      expect(getCaveScene(scene.sceneId)).toBe(scene);
      for (const portal of scene.portals) {
        expect(scene.sample(portal.interior.x, portal.interior.z).blocked).toBe(false);
        expect(scene.sample(portal.interiorArrival.x, portal.interiorArrival.z).blocked).toBe(false);
        expect(cavePortalAtInterior(scene.sceneId, portal.interior.x, portal.interior.z)).toBe(portal);
        expect(cavePortalAtSurface(scene.regionId, portal.surface.x, portal.surface.z)).toEqual({ scene, portal });
      }
    }
  });

  it('makes every interior tile directly traversable and recovers old blocked positions', () => {
    for (const scene of CAVE_SCENES) {
      for (let z = -scene.legacyDepth / 2 + scene.tileSize * 1.5; z <= scene.legacyDepth / 2 - scene.tileSize * 1.5; z += scene.tileSize)
        for (let x = -scene.legacyWidth / 2 + scene.tileSize * 1.5; x <= scene.legacyWidth / 2 - scene.tileSize * 1.5; x += scene.tileSize)
          expect(scene.sample(x, z).blocked, `${scene.sceneId} at ${x},${z}`).toBe(false);
      for (const from of scene.portals) for (const to of scene.portals) {
        const steps = Math.max(1, Math.ceil(Math.hypot(to.interior.x - from.interior.x, to.interior.z - from.interior.z) / .5));
        for (let step = 0; step <= steps; step++) {
          const ratio = step / steps;
          expect(scene.sample(from.interior.x + (to.interior.x - from.interior.x) * ratio, from.interior.z + (to.interior.z - from.interior.z) * ratio).blocked).toBe(false);
        }
      }
      const recovered = nearestCaveWalkable(scene.sceneId, scene.width, scene.depth);
      expect(recovered).toBeDefined();
      expect(scene.sample(recovered!.x, recovered!.z).blocked).toBe(false);
    }
  });

  it('uses every requested silhouette without splitting a chamber into a maze', () => {
    expect(new Set(CAVE_SCENES.map(scene => scene.silhouette))).toEqual(new Set(['rounded', 'oval', 'long', 'hall', 'bend']));
    for (const scene of CAVE_SCENES) {
      for (let index = 0; index < scene.outline.length; index += 4) {
        const point = scene.outline[index];
        const inside = { x: point.x * .75, z: point.z * .75 };
        expect(scene.sample(inside.x, inside.z).blocked, `${scene.id} radial ${index}`).toBe(false);
      }
    }
  });
});
