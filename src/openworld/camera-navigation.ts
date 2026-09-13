export const MIN_CAMERA_DISTANCE = 4;
// The radar provides the map overview; keeping play zoom closer preserves the
// readable character/building ratio after the player deliberately zooms out.
export const MAX_CAMERA_DISTANCE = 32;
export type CameraAction = 'left' | 'right' | 'up' | 'down' | 'zoom-in' | 'zoom-out' | 'reset';
export type CameraOrbit = { radius: number; phi: number; theta: number };

export function applyCameraAction(orbit: CameraOrbit, action: Exclude<CameraAction, 'reset'>): CameraOrbit {
  const next = { ...orbit };
  if (action === 'left') next.theta += .22;
  if (action === 'right') next.theta -= .22;
  if (action === 'up') next.phi = Math.max(.38, next.phi - .14);
  if (action === 'down') next.phi = Math.min(1.18, next.phi + .14);
  if (action === 'zoom-in') next.radius = Math.max(MIN_CAMERA_DISTANCE, next.radius * .84);
  if (action === 'zoom-out') next.radius = Math.min(MAX_CAMERA_DISTANCE, next.radius * 1.18);
  return next;
}
