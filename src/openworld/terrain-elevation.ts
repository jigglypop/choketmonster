import { scaleWorldDistance } from './world-space';

export type TerrainPlateau = { x: number; z: number; height: number };

/**
 * Keeps a flat authored landmark attached to the sampled terrain mesh.
 * The flat radius includes one render-grid diagonal beyond the town paving.
 * The outer band eases back without changing walkability or obstacles.
 */
export function terrainPlateauHeight(
  height: number,
  x: number,
  z: number,
  plateaus: readonly TerrainPlateau[],
  flatRadius = scaleWorldDistance(13.2),
  outerRadius = scaleWorldDistance(18),
): number {
  let nearest: TerrainPlateau | undefined;
  let distance = Infinity;
  for (const plateau of plateaus) {
    const next = Math.hypot(x - plateau.x, z - plateau.z);
    if (next < distance) { nearest = plateau; distance = next; }
  }
  if (!nearest || distance >= outerRadius) return height;
  if (distance <= flatRadius) return nearest.height;
  const ratio = (distance - flatRadius) / (outerRadius - flatRadius);
  const eased = ratio * ratio * (3 - 2 * ratio);
  return nearest.height + (height - nearest.height) * eased;
}
