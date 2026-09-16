import type { KantoLocationKind } from './kanto';

export const CARDINAL_CAMERA_HEADINGS = {
  north: Math.PI,
  east: Math.PI / 2,
  south: 0,
  west: -Math.PI / 2,
} as const;

export type MapOrientation = keyof typeof CARDINAL_CAMERA_HEADINGS;

const TAU = Math.PI * 2;

export function normalizeMapAngle(angle: number): number {
  if (!Number.isFinite(angle)) return CARDINAL_CAMERA_HEADINGS.north;
  return ((angle + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

export function nearestMapOrientation(heading: number): MapOrientation {
  const entries = Object.entries(CARDINAL_CAMERA_HEADINGS) as Array<[MapOrientation, number]>;
  return entries.reduce((best, entry) => {
    const distance = Math.abs(normalizeMapAngle(heading - entry[1]));
    const bestDistance = Math.abs(normalizeMapAngle(heading - best[1]));
    return distance < bestDistance ? entry : best;
  }, entries[0])[0];
}

/** Rotate a north-up map so the current camera direction points to the top. */
export function cameraMapRotation(heading: number): number {
  return normalizeMapAngle(heading - Math.PI);
}

export function rotateMapPoint(x: number, y: number, size: number, rotation: number): { x: number; y: number } {
  const center = size / 2, dx = x - center, dy = y - center;
  const cosine = Math.cos(rotation), sine = Math.sin(rotation);
  return { x: center + dx * cosine - dy * sine, y: center + dx * sine + dy * cosine };
}

export function mapKindLabel(kind: KantoLocationKind): string {
  return ({ town: '도시', route: '도로', forest: '숲', cave: '동굴', sea: '수로', special: '특별 지점' })[kind];
}

export function mapKindSymbol(kind: KantoLocationKind): string {
  return ({ town: '◆', route: '●', forest: '♣', cave: '▲', sea: '≈', special: '★' })[kind];
}

export function compassLabel(orientation: MapOrientation): string {
  return ({ north: '북', east: '동', south: '남', west: '서' })[orientation];
}
