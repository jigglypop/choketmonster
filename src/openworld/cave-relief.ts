export type CavePool = { x: number; z: number; radius: number; level: number };
export type CaveRelief = {
  theme: 'limestone' | 'water' | 'ice' | 'volcanic' | 'industrial';
  seed: number; pools: readonly CavePool[];
};

export function caveRelief(id: string, seed: number, width: number, depth: number): CaveRelief {
  const theme = id === 'power-plant' ? 'industrial' : id === 'ice-path' ? 'ice'
    : ['slowpoke-well', 'whirl-islands', 'seafoam-islands', 'dragons-den', 'tohjo-falls'].includes(id) ? 'water'
    : ['mt-mortar', 'mt-silver', 'victory-road'].includes(id) ? 'volcanic' : 'limestone';
  return { theme, seed, pools: theme === 'industrial' ? [] : [
    { x: width * .2, z: depth * -.08, radius: Math.min(width, depth) * (theme === 'water' ? .14 : .09), level: -.08 },
    ...(theme === 'water' ? [{ x: width * -.13, z: depth * .22, radius: Math.min(width, depth) * .105, level: -.08 }] : []),
  ] };
}

const ease = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
/** Authored relief; no simulation RNG is consumed. Vertices are sampled on a 1m grid. */
export function caveVertexHeight(relief: CaveRelief, x: number, z: number): number {
  if (relief.theme === 'industrial') return 0;
  const phase = relief.seed * .13;
  let height = .24 + .36 * Math.sin(x * .18 + phase) + .3 * Math.cos(z * .15 - phase)
    + .7 * ease((Math.sin(x * .075 + z * .055 + phase) + .2) / 1.2);
  for (const pool of relief.pools) {
    const d = Math.hypot(x - pool.x, z - pool.z) / pool.radius;
    const blend = ease((1.4 - d) / .55);
    height += (pool.level - .48 - height) * blend;
  }
  return height;
}

/** Same diagonal as PlaneGeometry, so walking and visible slopes agree. */
export function caveFloorHeight(relief: CaveRelief, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z), tx = x - ix, tz = z - iz;
  const a = caveVertexHeight(relief, ix, iz), b = caveVertexHeight(relief, ix, iz + 1), d = caveVertexHeight(relief, ix + 1, iz);
  return tx + tz <= 1 ? a * (1 - tx - tz) + b * tz + d * tx
    : b * (1 - tx) + caveVertexHeight(relief, ix + 1, iz + 1) * (tx + tz - 1) + d * (1 - tz);
}
