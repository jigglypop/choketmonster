import { useLayoutEffect, useMemo, useRef } from 'react';
import { ConeGeometry, Euler, IcosahedronGeometry, InstancedMesh, Matrix4, Quaternion, Vector3, type BufferGeometry, type MeshStandardMaterial } from 'three';
import { WaterMaterial } from './materials';
import type { CaveScene } from './caves';
import type { WorldPoint } from './types';

type Detail = { x: number; y: number; z: number; sx: number; sy: number; sz: number; rotationY?: number; upsideDown?: boolean };
const variation = (index: number, seed: number) => { const n = Math.sin(index * 127.1 + seed * 311.7) * 43758.5453; return n - Math.floor(n); };

export function caveFormations(cave: CaveScene) {
  const ledges: Detail[] = [], stalactites: Detail[] = [], stalagmites: Detail[] = [];
  for (let side = 0; side < cave.wallSegments.length; side++) {
    const wall = cave.wallSegments[side], tangentX = Math.cos(wall.rotationY), tangentZ = -Math.sin(wall.rotationY);
    const normalA = { x: -tangentZ, z: tangentX }, normalB = { x: tangentZ, z: -tangentX };
    const inward = normalA.x * -wall.x + normalA.z * -wall.z > normalB.x * -wall.x + normalB.z * -wall.z ? normalA : normalB;
    const count = Math.max(1, Math.ceil(wall.width / 2.7));
    for (let index = 0; index < count; index++) {
      const along = (index + .5) / count * wall.width - wall.width / 2;
      const v = variation(index + side * 31, cave.relief.seed);
      const x = wall.x + tangentX * along + inward.x * 1.25;
      const z = wall.z + tangentZ * along + inward.z * 1.25;
      // Keep all solid bases inside the already blocked outer wall ring.
      if (cave.portals.some(portal => Math.hypot(portal.interior.x - x, portal.interior.z - z) < 4)) continue;
      const y = cave.sample(x, z).height;
      ledges.push({ x, z, y: y + .6 + v, sx: 2.1, sy: .65 + v * .5, sz: .8, rotationY: wall.rotationY });
      ledges.push({ x, z, y: 4 + v * .3, sx: 2, sy: .45, sz: 1, rotationY: wall.rotationY });
      if (cave.relief.theme !== 'industrial') {
        const height = .8 + v * 1.5;
        stalactites.push({ x, z, y: 4.05 - height / 2, sx: .28 + v * .32, sy: height, sz: .35 + v * .22, rotationY: wall.rotationY, upsideDown: true });
        if (index % 2 === 0) stalagmites.push({ x, z, y: y + height / 2, sx: .35 + v * .3, sy: height, sz: .4 + v * .3, rotationY: wall.rotationY });
      }
    }
  }
  return { ledges, stalactites, stalagmites };
}

function Batch({ name, entries, material, pointed = false }: { name: string; entries: Detail[]; material: MeshStandardMaterial; pointed?: boolean }) {
  const ref = useRef<InstancedMesh>(null);
  const geometry = useMemo(() => {
    const shape: BufferGeometry = pointed ? new ConeGeometry(1, 1, 7, 2) : new IcosahedronGeometry(1, 1);
    const positions = shape.attributes.position;
    // The same rock textures are shared with the chamber surfaces.
    if (shape.attributes.uv) for (let i = 0; i < positions.count; i++) shape.attributes.uv.setXY(i, positions.getX(i), positions.getY(i));
    return shape;
  }, [pointed]);
  useLayoutEffect(() => {
    const mesh = ref.current!;
    const matrix = new Matrix4(), rotation = new Quaternion(), angles = new Euler(), scale = new Vector3(), position = new Vector3();
    for (let index = 0; index < entries.length; index++) {
      const item = entries[index];
      rotation.setFromEuler(angles.set(item.upsideDown ? Math.PI : 0, item.rotationY ?? 0, 0));
      matrix.compose(position.set(item.x, item.y, item.z), rotation, scale.set(item.sx, item.sy, item.sz));
      mesh.setMatrixAt(index, matrix);
    }
    mesh.count = entries.length; mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
  }, [entries]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  return <instancedMesh ref={ref} name={name} args={[geometry, material, Math.max(1, entries.length)]} dispose={null} receiveShadow castShadow />;
}

export function CaveDetails({ cave, material, player, mobile, onNavigate }: {
  cave: CaveScene; material: MeshStandardMaterial; player: WorldPoint; mobile: boolean; onNavigate(point: WorldPoint): void;
}) {
  const all = useMemo(() => caveFormations(cave), [cave]);
  const cellX = Math.round(player.x / 4) * 4, cellZ = Math.round(player.z / 4) * 4;
  const close = useMemo(() => {
    const near = (item: Detail) => Math.hypot(item.x - cellX, item.z - cellZ) < (mobile ? 24 : 36);
    return { stalactites: all.stalactites.filter(near), stalagmites: all.stalagmites.filter(near) };
  }, [all, cellX, cellZ, mobile]);
  return <group name="cave-geology">
    <Batch name="cave-rock-strata" entries={all.ledges} material={material} />
    <Batch name="cave-stalactites" entries={close.stalactites} material={material} pointed />
    <Batch name="cave-stalagmites" entries={close.stalagmites} material={material} pointed />
    {cave.relief.pools.map((pool, index) => <mesh key={index} name={`cave-water:${index}`} position={[pool.x, pool.level, pool.z]} rotation={[-Math.PI / 2, 0, 0]}
      onClick={event => { event.stopPropagation(); if (event.button === 0 && event.delta <= 5) onNavigate({ x: event.point.x, z: event.point.z }); }}>
      <circleGeometry args={[pool.radius, mobile ? 24 : 40]} />
      <WaterMaterial lake center={[pool.x, pool.z]} radius={pool.radius} player={player} mobile={mobile} />
    </mesh>)}
  </group>;
}
