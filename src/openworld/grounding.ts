import { Box3, Object3D, SkinnedMesh, Vector3 } from 'three';
import type { WorldSample } from './types';
import { WORLD_MAX, WORLD_MIN } from './world-space';
export { terrainPlateauHeight, type TerrainPlateau } from './terrain-elevation';

export const TERRAIN_SEGMENTS = 72;

/** Height on the rendered PlaneGeometry triangle, rather than the curved source function. */
export function terrainSurfaceHeight(sample: (x: number, z: number) => WorldSample, x: number, z: number): number {
  const size = (WORLD_MAX - WORLD_MIN) / TERRAIN_SEGMENTS;
  const u = Math.max(0, Math.min(TERRAIN_SEGMENTS, (x - WORLD_MIN) / size));
  const v = Math.max(0, Math.min(TERRAIN_SEGMENTS, (z - WORLD_MIN) / size));
  const ix = Math.min(TERRAIN_SEGMENTS - 1, Math.floor(u)), iz = Math.min(TERRAIN_SEGMENTS - 1, Math.floor(v));
  const tx = u - ix, tz = v - iz;
  const x0 = Math.fround(WORLD_MIN + ix * size), z0 = Math.fround(WORLD_MIN + iz * size);
  const x1 = Math.fround(WORLD_MIN + (ix + 1) * size), z1 = Math.fround(WORLD_MIN + (iz + 1) * size);
  const corner = sample(x0, z0);
  if (corner.exactHeight) return sample(x, z).height;
  const a = Math.fround(corner.height), b = Math.fround(sample(x0, z1).height), d = Math.fround(sample(x1, z0).height);
  if (tx + tz <= 1) return a * (1 - tx - tz) + b * tz + d * tx;
  return b * (1 - tx) + Math.fround(sample(x1, z1).height) * (tx + tz - 1) + d * (1 - tz);
}

/** Fits the actual animated vertices to the floor. The offset group has an unscaled, upright parent. */
export function createGrounding(model: Object3D, offset: Object3D): (groundY: number) => number {
  const skinned: SkinnedMesh[] = [];
  model.traverse(object => { if (object instanceof SkinnedMesh) skinned.push(object); });
  const bounds = new Box3(), world = new Vector3();
  return groundY => {
    offset.position.y = 0;
    offset.parent?.updateWorldMatrix(true, false);
    // SkinnedMesh updates its attached bind inverse in updateMatrixWorld.
    // updateWorldMatrix alone leaves stale skin transforms after the parent moves.
    offset.updateMatrixWorld(true);
    for (const mesh of skinned) mesh.skeleton.update();
    bounds.setFromObject(model, true);
    if (!Number.isFinite(bounds.min.y)) return 0;
    const correction = groundY - bounds.min.y;
    offset.parent?.getWorldScale(world);
    offset.position.y = correction / (world.y || 1);
    offset.updateMatrixWorld(true);
    for (const mesh of skinned) mesh.skeleton.update();
    return correction;
  };
}
