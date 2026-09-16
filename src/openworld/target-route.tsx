import { useEffect, useMemo } from 'react';
import { CatmullRomCurve3, TubeGeometry, Vector3 } from 'three';
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
  const geometry = useMemo(() => {
    if (!points.length) return null;
    const nearby = [{ x, z }, ...points.slice(0, 100)];
    const curve = new CatmullRomCurve3(nearby.map(point => new Vector3(point.x, terrainSurfaceHeight(sample, point.x, point.z) + .12, point.z)), false, 'centripetal');
    return new TubeGeometry(curve, Math.min(200, points.length * 2 + 2), .045, 4, false);
  }, [points, x, z, sample]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  // r178 WebGPU retains vertex-buffer bindings when only mesh.geometry changes.
  // Give each route geometry a fresh render object before retiring the old one.
  return <mesh key={geometry.uuid} geometry={geometry} name="world-target-route" renderOrder={3}>
    <meshBasicMaterial color={target ? '#8cf4f7' : '#ffdf79'} transparent opacity={.9} depthWrite={false} />
  </mesh>;
}
