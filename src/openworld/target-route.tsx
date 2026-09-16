import { useMemo } from 'react';
import { CatmullRomCurve3, Vector3 } from 'three';
import { terrainSurfaceHeight } from './grounding';
import { findWorldPath } from './navigation';
import type { OpenWorldRenderSnapshot, WorldPoint, WorldSample } from './types';

/** A visible route is a UI aid, not an input to the neural circuit. */
export function TargetRoute({ snapshot, destination, sample }: { snapshot: OpenWorldRenderSnapshot; destination: WorldPoint | null; sample(x: number, z: number): WorldSample }) {
  const target = destination ?? snapshot.entities.find(entity => entity.id === snapshot.selectedWildId);
  const x = Math.round(snapshot.player.x * 2) / 2, z = Math.round(snapshot.player.z * 2) / 2;
  const targetX = target && Math.round(target.x * 2) / 2, targetZ = target && Math.round(target.z * 2) / 2;
  const points = useMemo(() => targetX !== undefined && targetZ !== undefined
    ? findWorldPath({ x, z }, { x: targetX, z: targetZ }, sample)
    : snapshot.guide?.points ?? [], [x, z, targetX, targetZ, sample, snapshot.guide?.points]);
  const curve = useMemo(() => {
    if (!points.length) return null;
    const nearby = [{ x, z }, ...points.slice(0, 100)];
    return new CatmullRomCurve3(nearby.map(point => new Vector3(point.x, terrainSurfaceHeight(sample, point.x, point.z) + .12, point.z)), false, 'centripetal');
  }, [points, x, z, sample]);
  if (!curve) return null;
  return <mesh name="world-target-route" renderOrder={3}>
    <tubeGeometry args={[curve, Math.min(200, points.length * 2 + 2), .045, 4, false]} />
    <meshBasicMaterial color={target ? '#8cf4f7' : '#ffdf79'} transparent opacity={.9} depthWrite={false} />
  </mesh>;
}
