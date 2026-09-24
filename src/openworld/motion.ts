/** Render-only steering: angles take the shortest arc and never consume simulation RNG. */
export function angleDifference(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export function turnTowards(current: number, target: number, deltaSeconds: number): number {
  const dt = Math.max(0, Math.min(deltaSeconds, .05));
  const difference = angleDifference(current, target);
  const step = difference * (1 - Math.exp(-10 * dt));
  const maximum = 6 * dt;
  return current + Math.max(-maximum, Math.min(maximum, step));
}

/** The source models face +Z; diagonal input retains its full direction. */
export function movementYaw(dx: number, dz: number, previous: number): number {
  return Math.hypot(dx, dz) > .002 ? Math.atan2(dx, dz) : previous;
}

/** In-place stride speed, in display heights per second at timeScale 1, assumed for clips without measured root motion. */
export const NOMINAL_STRIDE_SPEED = 1.6;
/** Small bodies cross several of their heights per second, so their stepping cycle may run four times over. */
export const WALK_CYCLE_RATE_RANGE = [.5, 4] as const;

/**
 * Playback rate of the moving clip. Larger bodies take longer strides, so they step more slowly at
 * the same ground speed. A clip whose root motion was measured (`clipGroundSpeed`, heights per
 * second) plays at the rate that keeps its planted feet still; others assume a nominal stride.
 */
export function walkCycleRate(movementSpeed: number | undefined, displayHeight: number | undefined, clipGroundSpeed?: number): number {
  const speed = movementSpeed !== undefined && Number.isFinite(movementSpeed) && movementSpeed > 0 ? movementSpeed : 2.4;
  const height = displayHeight !== undefined && Number.isFinite(displayHeight) && displayHeight > 0 ? Math.max(.3, displayHeight) : 1.2;
  const stride = clipGroundSpeed !== undefined && Number.isFinite(clipGroundSpeed) && clipGroundSpeed > 0 ? clipGroundSpeed : NOMINAL_STRIDE_SPEED;
  const [slowest, fastest] = WALK_CYCLE_RATE_RANGE;
  return Math.min(fastest, Math.max(slowest, speed / (stride * height)));
}

export function initialYaw(heading = 4): number {
  return [Math.PI, Math.PI / 2, 0, -Math.PI / 2, 0][heading] ?? 0;
}
