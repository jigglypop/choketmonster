export type CavePool = { x: number; z: number; radius: number; level: number };
export type CaveRelief = {
  /** `interior` is the flat floor of towers, buildings and plants. */
  theme: 'limestone' | 'water' | 'ice' | 'volcanic' | 'interior';
  seed: number; pools: readonly CavePool[];
};

export function caveRelief(id: string, seed: number, width: number, depth: number, interior = false): CaveRelief {
  const theme: CaveRelief['theme'] = interior ? 'interior' : ['ice-path', 'frost-cavern', 'mount-lanakila', 'glaseado-mountain'].includes(id) ? 'ice'
    : ['slowpoke-well', 'whirl-islands', 'seafoam-islands', 'dragons-den', 'tohjo-falls', 'meteor-falls', 'wellspring-cave', 'reflection-cave'].includes(id) ? 'water'
    : ['mt-mortar', 'mt-silver', 'fiery-path', 'wela-volcano-park', 'blush-mountain', 'mount-hokulani', 'twist-mountain'].includes(id) || id.endsWith('victory-road') ? 'volcanic' : 'limestone';
  return { theme, seed, pools: theme === 'interior' ? [] : [
    { x: width * .2, z: depth * -.08, radius: Math.min(width, depth) * (theme === 'water' ? .14 : .09), level: -.08 },
    ...(theme === 'water' ? [{ x: width * -.13, z: depth * .22, radius: Math.min(width, depth) * .105, level: -.08 }] : []),
  ] };
}

const ease = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
/** Authored relief; no simulation RNG is consumed. Vertices are sampled on a 1m grid. */
export function caveVertexHeight(relief: CaveRelief, x: number, z: number): number {
  if (relief.theme === 'interior') return 0;
  const phase = relief.seed * .13;
  // Several broad, crossing strata read as eroded stone without turning the
  // chamber into noisy ankle-height bumps. The simulation samples this exact
  // function, so feet and the rendered surface keep agreeing.
  const ridge = Math.abs(Math.sin(x * .115 - z * .085 + phase * .7));
  let height = .18 + .42 * Math.sin(x * .15 + phase) + .34 * Math.cos(z * .135 - phase)
    + .28 * Math.sin(x * .29 + z * .21 + phase * 1.7)
    + .42 * ease((Math.sin(x * .062 + z * .048 + phase) + .2) / 1.2)
    + .18 * ridge;
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

/** Baked floor modulation. It follows the same authored height field and adds
 * no runtime lights or geometry; low seams and steeper strata read darker. */
export function caveFloorShade(relief: CaveRelief, x: number, z: number): number {
  if (relief.theme === 'interior') return .92;
  const height = caveVertexHeight(relief, x, z);
  const dx = caveVertexHeight(relief, x + .5, z) - caveVertexHeight(relief, x - .5, z);
  const dz = caveVertexHeight(relief, x, z + .5) - caveVertexHeight(relief, x, z - .5);
  const strata = .5 + .5 * Math.sin(height * 4.6 + x * .17 - z * .13 + relief.seed * .09);
  return Math.max(.62, Math.min(1.04, .72 + height * .075 + strata * .19 - Math.hypot(dx, dz) * .2));
}
