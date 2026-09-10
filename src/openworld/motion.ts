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

export function initialYaw(heading = 4): number {
  return [Math.PI, Math.PI / 2, 0, -Math.PI / 2, 0][heading] ?? 0;
}
