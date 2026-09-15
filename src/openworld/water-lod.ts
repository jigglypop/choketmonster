export type WaterLod = 'detailed' | 'simple';

export type WaterLodShape = {
  lake?: boolean;
  center?: readonly [number, number];
  extent?: readonly [number, number];
  radius?: number;
};

export type WaterLodPlayer = { x: number; z: number };

export const WATER_LOD_THRESHOLDS = {
  desktop: { enter: 40, exit: 52 },
  mobile: { enter: 24, exit: 34 },
} as const;

/** Shortest horizontal distance to the water edge; points over the water return zero. */
export function distanceToWaterSurface(player: WaterLodPlayer, {
  lake = false,
  center = lake ? [122, -50] : [-68, 202],
  extent = [91, 33],
  radius = 24,
}: WaterLodShape = {}): number {
  const dx = Math.abs(player.x - center[0]);
  const dz = Math.abs(player.z - center[1]);
  if (lake) return Math.max(0, Math.hypot(dx, dz) - radius);
  return Math.hypot(Math.max(0, dx - extent[0]), Math.max(0, dz - extent[1]));
}

/** Keep the current level between the enter and exit boundaries to prevent flicker. */
export function selectWaterLod(current: WaterLod | undefined, distance: number, mobile = false): WaterLod {
  const threshold = mobile ? WATER_LOD_THRESHOLDS.mobile : WATER_LOD_THRESHOLDS.desktop;
  if (current === 'detailed') return distance > threshold.exit ? 'simple' : 'detailed';
  return distance <= threshold.enter ? 'detailed' : 'simple';
}
