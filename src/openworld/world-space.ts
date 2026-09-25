export const WORLD_SCALE = 2 as const;
export const WORLD_MIN = -240 as const;
export const WORLD_MAX = 240 as const;
export const LEGACY_WORLD_MIN = -120 as const;
export const LEGACY_WORLD_MAX = 120 as const;
export const SURFACE_SCENE_PREFIX = 'surface:' as const;

export type ScenePoint = { x: number; z: number };

export const scaleWorldDistance = (value: number) => value * WORLD_SCALE;
export const scaleLegacyPoint = <T extends ScenePoint>(point: T): T => ({ ...point, x: point.x * WORLD_SCALE, z: point.z * WORLD_SCALE });
export const surfaceSceneId = (regionId: string) => `${SURFACE_SCENE_PREFIX}${regionId}`;
export const isSurfaceScene = (sceneId: string) => sceneId.startsWith(SURFACE_SCENE_PREFIX);
export const inWorldBounds = (point: ScenePoint) => [point.x, point.z].every(Number.isFinite)
  && point.x >= WORLD_MIN && point.x <= WORLD_MAX && point.z >= WORLD_MIN && point.z <= WORLD_MAX;

/** Town plazas are laid in square tiles this wide around the town centre. */
export const PAVING_CELL = 1.12 * WORLD_SCALE;

/** True when a town-local point lies on one of the fixed paving cells. */
export function isTownPaved(x: number, z: number): boolean {
  return Math.hypot(Math.round(x / PAVING_CELL), Math.round(z / PAVING_CELL)) <= 7.1;
}

/**
 * The town whose drawn ground covers (x, z): its meadow disc of `radius`, or a plaza tile, whose corners reach a
 * little past the disc. This, not the nearest map place, is the town the player sees.
 */
export function townGroundAt<T extends ScenePoint>(towns: readonly T[], radius: number, x: number, z: number): T | undefined {
  // Plaza tiles end within 17.5 of the centre.
  const reach = Math.max(radius, 18);
  for (const town of towns) {
    const dx = x - town.x, dz = z - town.z;
    if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue;
    if (Math.hypot(dx, dz) < radius || isTownPaved(dx, dz)) return town;
  }
  return undefined;
}

/** Mutates only coordinate-bearing snapshot fields when admitting a pre-expanded surface save. */
export function migrateSurfaceSnapshotCoordinates<T extends {
  player: ScenePoint;
  entities?: Array<ScenePoint & { target?: ScenePoint }>;
  companionMemories?: Array<ScenePoint & { target?: ScenePoint }>;
  foods?: ScenePoint[];
  spawnAnchor?: ScenePoint;
  respawnQueue?: Array<{ originX: number; originZ: number }>;
}>(snapshot: T): T {
  const scale = (point: ScenePoint | undefined) => { if (point) { point.x *= WORLD_SCALE; point.z *= WORLD_SCALE; } };
  const scaleEntity = (entity: ScenePoint & { target?: ScenePoint }) => { scale(entity); scale(entity.target); };
  scale(snapshot.player); snapshot.entities?.forEach(scaleEntity); snapshot.companionMemories?.forEach(scaleEntity); snapshot.foods?.forEach(scale); scale(snapshot.spawnAnchor);
  snapshot.respawnQueue?.forEach(item => { item.originX *= WORLD_SCALE; item.originZ *= WORLD_SCALE; });
  return snapshot;
}
