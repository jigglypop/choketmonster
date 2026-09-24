import { describe, expect, it } from 'vitest';
import { getWorldAtlas, getWorldScene } from '../src/openworld/atlas';
import {
  CAVE_SCENES, cavePortalAtInterior, cavePortalAtSurface, caveStairsAt, dungeonExits, dungeonFloors, getCaveScene, hasDungeonLandmark, nearestCaveWalkable, stairsToward, type CaveScene,
} from '../src/openworld/caves';
import { DUNGEON_PLANS, dungeonPlanForScene, dungeonSceneIdsByRegion } from '../src/openworld/dungeons';
import { findWorldPath } from '../src/openworld/navigation';
import dungeonSceneIds from '../src/data/dungeon-scenes.json';
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

const CHAMBERS = CAVE_SCENES.filter(scene => scene.kind === 'cave');
const LEGACY_CAVES = {
  kanto: ['mt-moon', 'diglett-cave', 'rock-tunnel', 'seafoam-islands', 'victory-road', 'cerulean-cave', 'power-plant'],
  johto: ['tohjo-falls', 'union-cave', 'slowpoke-well', 'whirl-islands', 'mt-mortar', 'ice-path', 'dragons-den', 'dark-cave', 'mt-silver'],
};
const walkable = (scene: CaveScene, from: { x: number; z: number }, to: { x: number; z: number }) => {
  const points = findWorldPath(from, to, scene.sample);
  return points.length > 0 && Math.hypot(points.at(-1)!.x - to.x, points.at(-1)!.z - to.z) < 1.2;
};

describe('open cave chambers', () => {
  it('keeps stable scenes and doorways inside varied continuous chamber outlines', () => {
    expect(CAVE_SCENES).toHaveLength(DUNGEON_PLANS.reduce((sum, plan) => sum + plan.floors.length, 0));
    expect(new Set(CAVE_SCENES.map(scene => scene.sceneId)).size).toBe(CAVE_SCENES.length);
    for (const scene of CAVE_SCENES) {
      expect(scene.sceneId).toBe(`cave:${scene.regionId}:${scene.id}`);
      expect(scene.label).toMatch(/^[\x20-\x7e]+$/);
      expect(scene.portals.length + scene.stairs.length).toBeGreaterThan(0);
      expect(scene.outline).toHaveLength(scene.kind === 'cave' ? 48 : 4);
      if (scene.kind === 'cave') {
        expect(scene.wallSegments).toHaveLength(48);
        expect(scene.width).toBeGreaterThan(scene.legacyWidth);
        expect(scene.depth).toBeGreaterThan(scene.legacyDepth);
      }
      expect(getCaveScene(scene.sceneId)).toBe(scene);
      for (const portal of scene.portals) {
        expect(scene.sample(portal.interior.x, portal.interior.z).blocked).toBe(false);
        expect(scene.sample(portal.interiorArrival.x, portal.interiorArrival.z).blocked).toBe(false);
        expect(cavePortalAtInterior(scene.sceneId, portal.interior.x, portal.interior.z)).toBe(portal);
        expect(cavePortalAtSurface(scene.regionId, portal.surface.x, portal.surface.z)).toEqual({ scene, portal });
      }
      for (const stairs of scene.stairs) {
        expect(scene.sample(stairs.interior.x, stairs.interior.z).blocked).toBe(false);
        expect(scene.sample(stairs.interiorArrival.x, stairs.interiorArrival.z).blocked).toBe(false);
        expect(caveStairsAt(scene.sceneId, stairs.interior.x, stairs.interior.z)).toBe(stairs);
      }
    }
  });

  it('keeps every older single-chamber cave id as the floor its first entrance opens onto', () => {
    for (const [regionId, ids] of Object.entries(LEGACY_CAVES)) for (const id of ids) {
      const scene = getCaveScene(`cave:${regionId}:${id}`)!;
      expect(scene, id).toBeDefined();
      expect(scene.dungeonId).toBe(id);
      expect(scene.portals.some(portal => portal.id === `${id}:0`), id).toBe(true);
    }
  });

  it('makes every interior tile directly traversable and recovers old blocked positions', () => {
    // Older saves only ever stood on the historical single chambers.
    for (const scene of CHAMBERS.filter(item => item.id === item.dungeonId && dungeonPlanForScene(item.sceneId)?.plan.legacy)) {
      for (let z = -scene.legacyDepth / 2 + scene.tileSize * 1.5; z <= scene.legacyDepth / 2 - scene.tileSize * 1.5; z += scene.tileSize)
        for (let x = -scene.legacyWidth / 2 + scene.tileSize * 1.5; x <= scene.legacyWidth / 2 - scene.tileSize * 1.5; x += scene.tileSize)
          expect(scene.sample(x, z).blocked, `${scene.sceneId} at ${x},${z}`).toBe(false);
    }
    for (const scene of CHAMBERS) {
      const doorways = [...scene.portals, ...scene.stairs];
      for (const from of doorways) for (const to of doorways) {
        const steps = Math.max(1, Math.ceil(Math.hypot(to.interior.x - from.interior.x, to.interior.z - from.interior.z) / .5));
        for (let step = 0; step <= steps; step++) {
          const ratio = step / steps;
          expect(scene.sample(from.interior.x + (to.interior.x - from.interior.x) * ratio, from.interior.z + (to.interior.z - from.interior.z) * ratio).blocked).toBe(false);
        }
      }
    }
    for (const scene of CAVE_SCENES) {
      const recovered = nearestCaveWalkable(scene.sceneId, scene.width, scene.depth);
      expect(recovered).toBeDefined();
      expect(scene.sample(recovered!.x, recovered!.z).blocked).toBe(false);
    }
  });

  it('uses every requested silhouette without splitting a chamber into a maze', () => {
    expect(new Set(CHAMBERS.map(scene => scene.silhouette))).toEqual(new Set(['rounded', 'oval', 'long', 'hall', 'bend']));
    for (const scene of CHAMBERS) {
      for (let index = 0; index < scene.outline.length; index += 4) {
        const point = scene.outline[index];
        const inside = { x: point.x * .75, z: point.z * .75 };
        expect(scene.sample(inside.x, inside.z).blocked, `${scene.id} radial ${index}`).toBe(false);
      }
    }
  });
});

describe('multi-floor dungeons', () => {
  const floorLabels = (regionId: string, dungeonId: string) => dungeonFloors({ regionId, dungeonId }).map(scene => scene.floorLabel);

  it('builds the original floors of every Kanto and Johto cave, tower and building', () => {
    expect(floorLabels('kanto', 'mt-moon')).toEqual(['1층', '지하 1층', '지하 2층']);
    expect(floorLabels('kanto', 'rock-tunnel')).toEqual(['1층', '지하 1층']);
    expect(floorLabels('kanto', 'seafoam-islands')).toEqual(['1층', '지하 1층', '지하 2층', '지하 3층', '지하 4층']);
    expect(floorLabels('kanto', 'victory-road')).toEqual(['1층', '2층', '3층']);
    expect(floorLabels('kanto', 'cerulean-cave')).toEqual(['2층', '1층', '지하 1층']);
    expect(floorLabels('kanto', 'pokemon-tower')).toEqual(['1층', '2층', '3층', '4층', '5층', '6층', '7층']);
    expect(floorLabels('kanto', 'pokemon-mansion')).toEqual(['3층', '2층', '1층', '지하 1층']);
    expect(floorLabels('kanto', 'power-plant')).toHaveLength(1);
    expect(floorLabels('kanto', 'diglett-cave')).toHaveLength(1);
    expect(floorLabels('johto', 'union-cave')).toEqual(['1층', '지하 1층', '지하 2층']);
    expect(floorLabels('johto', 'slowpoke-well')).toEqual(['지하 1층', '지하 2층']);
    expect(floorLabels('johto', 'whirl-islands')).toEqual(['1층', '지하 1층', '지하 2층', '지하 3층']);
    expect(floorLabels('johto', 'mt-mortar')).toEqual(['1층 바깥', '1층 안쪽', '2층 안쪽', '지하 1층']);
    expect(floorLabels('johto', 'ice-path')).toEqual(['1층', '지하 1층', '지하 2층', '지하 3층']);
    expect(floorLabels('johto', 'dragons-den')).toEqual(['1층', '지하 1층']);
    expect(floorLabels('johto', 'dark-cave')).toEqual(['검은먹시티 입구', '도라지시티 입구']);
    expect(floorLabels('johto', 'mt-silver')).toEqual(['1층', '2층', '정상']);
    expect(floorLabels('johto', 'sprout-tower')).toEqual(['1층', '2층', '3층']);
    expect(floorLabels('johto', 'burned-tower')).toEqual(['1층', '지하 1층']);
    expect(floorLabels('johto', 'bell-tower')).toEqual(['1층', '2층', '3층', '4층', '5층', '6층', '7층', '8층', '9층', '옥상']);
    expect(floorLabels('johto', 'lighthouse')).toEqual(['1층', '2층', '3층', '4층', '5층', '6층']);
    for (const scene of CAVE_SCENES) expect(scene.name).toBe(scene.floorCount > 1 ? `${scene.dungeonName} ${scene.floorLabel}` : scene.dungeonName);
    expect(new Set(CAVE_SCENES.map(scene => scene.kind))).toEqual(new Set(['cave', 'tower', 'building', 'plant', 'ruins']));
  });

  it('opens a through dungeon on its first floor and leaves from its last; towers are entered at 1F', () => {
    for (const plan of DUNGEON_PLANS) {
      const floors = dungeonFloors({ regionId: plan.regionId, dungeonId: plan.id }), exits = dungeonExits(floors[0]);
      expect(exits.map(exit => exit.portal.surfaceLocationId), plan.id).toEqual(plan.surfaceLocations);
      if (plan.surfaceFloors) expect(exits.map(exit => exit.scene.floorIndex), plan.id).toEqual(plan.surfaceFloors);
      else if (plan.surfaceLocations.length > 1) expect(exits.map(exit => exit.scene.floorIndex), plan.id).toEqual(floors.length > 1 ? [0, floors.length - 1] : [0, 0]);
      else expect(exits[0].scene.floorIndex, plan.id).toBe(plan.entry ?? 0);
    }
    const tower = dungeonFloors({ regionId: 'kanto', dungeonId: 'pokemon-tower' });
    expect(tower[0].portals).toHaveLength(1);
    expect(tower.at(-1)!.stairs.map(stairs => stairs.direction)).toEqual(['down']);
    expect(tower.at(-1)!.portals).toHaveLength(0);
  });

  it('joins neighbouring floors with paired stairs that climb and descend by real floor order', () => {
    for (const scene of CAVE_SCENES) for (const stairs of scene.stairs) {
      const target = getCaveScene(stairs.targetSceneId)!, back = target.stairs.find(item => item.id === stairs.targetStairsId)!;
      expect(back.targetSceneId, stairs.id).toBe(scene.sceneId);
      expect(back.targetStairsId).toBe(stairs.id);
      expect(Math.abs(target.floorIndex - scene.floorIndex)).toBe(1);
      expect(stairs.direction).toBe(target.level > scene.level ? 'up' : 'down');
      expect(back.direction).not.toBe(stairs.direction);
      expect(stairs.targetLabel).toBe(target.floorLabel);
      // Doorways on one floor are far enough apart that each floor is walked across.
      for (const other of [...scene.portals, ...scene.stairs]) if (other !== stairs) expect(Math.hypot(other.interior.x - stairs.interior.x, other.interior.z - stairs.interior.z)).toBeGreaterThan(8);
    }
    const moon = getCaveScene('cave:kanto:mt-moon')!;
    expect(stairsToward(moon, getCaveScene('cave:kanto:mt-moon-b2f')!)?.targetSceneId).toBe('cave:kanto:mt-moon-b1f');
  });

  it('lays out towers and buildings as furnished rooms that stay walkable between every doorway', () => {
    for (const scene of CAVE_SCENES.filter(item => item.room)) {
      expect(scene.relief.theme).toBe('interior');
      expect(scene.room!.props.length, scene.sceneId).toBeGreaterThan(0);
      const doorways = [...scene.portals, ...scene.stairs].map(item => item.interiorArrival);
      for (const to of doorways.slice(1)) expect(walkable(scene, doorways[0], to), scene.sceneId).toBe(true);
      for (const prop of scene.room!.props.filter(item => item.blocking)) expect(scene.sample(prop.x, prop.z).blocked).toBe(true);
    }
  });

  it('stands every tower, building and plant beside its clearing with a walkable door', () => {
    for (const scene of CAVE_SCENES.filter(item => item.kind !== 'cave')) for (const portal of scene.portals) {
      const atlas = getWorldAtlas(scene.regionId);
      expect(portal.landmark, scene.sceneId).toBeDefined();
      expect(atlas.sample(portal.surface.x, portal.surface.z).blocked).toBe(false);
      expect(atlas.sample(portal.surfaceArrival.x, portal.surfaceArrival.z).blocked).toBe(false);
      expect(atlas.sample(portal.landmark!.x, portal.landmark!.z).blocked).toBe(true);
      expect(hasDungeonLandmark(scene.regionId, portal.surfaceLocationId)).toBe(true);
    }
  });

  it('shares the allowed dungeon scene ids with the save server', () => {
    expect(dungeonSceneIds).toEqual(dungeonSceneIdsByRegion());
    for (const scene of CAVE_SCENES) expect(dungeonPlanForScene(scene.sceneId)?.plan.id).toBe(scene.dungeonId);
  });
});
