import type { WorldSample } from './types';

export type BlockedBoundarySegment = { x1: number; z1: number; x2: number; z2: number };

/**
 * Builds a deterministic outline wherever a walkable cell meets blocked land.
 * This is visual only; the atlas remains the source of collision truth.
 */
export function blockedBoundarySegments(
  sampleWorld: (x: number, z: number) => WorldSample,
  centerX: number,
  centerZ: number,
  size = 40,
  cellSize = 2,
): BlockedBoundarySegment[] {
  if (![centerX, centerZ, size, cellSize].every(Number.isFinite) || size <= 0 || cellSize <= 0) return [];
  const cells = Math.max(1, Math.round(size / cellSize));
  const step = size / cells;
  const minX = centerX - size / 2;
  const minZ = centerZ - size / 2;
  // One-cell halo lets each chunk own its left/top seam. Adjacent chunks do
  // not draw the same seam twice, and a transition on a chunk edge is retained.
  const blocked = Array.from({ length: cells + 2 }, (_, z) => Array.from({ length: cells + 2 }, (_, x) =>
    sampleWorld(minX + (x - .5) * step, minZ + (z - .5) * step).blocked));
  const segments: BlockedBoundarySegment[] = [];

  for (let z = 0; z < cells; z += 1) for (let x = 0; x < cells; x += 1) {
    if (blocked[z + 1][x] !== blocked[z + 1][x + 1]) {
      const boundaryX = minX + x * step;
      segments.push({ x1: boundaryX, z1: minZ + z * step, x2: boundaryX, z2: minZ + (z + 1) * step });
    }
    if (blocked[z][x + 1] !== blocked[z + 1][x + 1]) {
      const boundaryZ = minZ + z * step;
      segments.push({ x1: minX + x * step, z1: boundaryZ, x2: minX + (x + 1) * step, z2: boundaryZ });
    }
  }
  return segments;
}
