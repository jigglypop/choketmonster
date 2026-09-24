import { useLayoutEffect, useMemo, useRef } from 'react';
import { BufferGeometry, ConeGeometry, DataTexture, DoubleSide, Euler, Float32BufferAttribute, IcosahedronGeometry, InstancedMesh, LinearFilter, Matrix4, MeshBasicMaterial, Quaternion, RGBAFormat, Vector3, type Material, type MeshStandardMaterial } from 'three';
import { WaterMaterial } from './materials';
import type { CaveScene } from './caves';
import type { WorldPoint } from './types';

type Detail = { x: number; y: number; z: number; sx: number; sy: number; sz: number; rotationY?: number; upsideDown?: boolean };
const variation = (index: number, seed: number) => { const n = Math.sin(index * 127.1 + seed * 311.7) * 43758.5453; return n - Math.floor(n); };

export function caveFormations(cave: CaveScene) {
  const ledges: Detail[] = [], stalactites: Detail[] = [], stalagmites: Detail[] = [], boulders: Detail[] = [], rubble: Detail[] = [], portalRocks: Detail[] = [];
  // Exits and stairs keep a clear approach.
  const doorways = [...cave.portals, ...cave.stairs].map(item => item.interior);
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
      if (doorways.some(point => Math.hypot(point.x - x, point.z - z) < 4)) continue;
      const y = cave.sample(x, z).height;
      ledges.push({ x, z, y: y + .6 + v, sx: 2.1, sy: .65 + v * .5, sz: .8, rotationY: wall.rotationY });
      ledges.push({ x, z, y: 4 + v * .3, sx: 2, sy: .45, sz: 1, rotationY: wall.rotationY });
      if (cave.relief.theme !== 'interior') {
        const height = .8 + v * 1.5;
        stalactites.push({ x, z, y: 4.05 - height / 2, sx: .28 + v * .32, sy: height, sz: .35 + v * .22, rotationY: wall.rotationY, upsideDown: true });
        if (index % 2 === 0) stalagmites.push({ x, z, y: y + height / 2, sx: .35 + v * .3, sy: height, sz: .4 + v * .3, rotationY: wall.rotationY });
        if (index % 3 === 1) boulders.push({ x: x + inward.x * .35, z: z + inward.z * .35, y: y + .35 + v * .18,
          sx: .55 + v * .42, sy: .45 + v * .35, sz: .5 + variation(index + side * 43, cave.relief.seed) * .45, rotationY: v * Math.PI });
      }
    }
  }
  if (cave.relief.theme !== 'interior') for (let index = 0; index < 52; index++) {
    const angle = variation(index, cave.relief.seed) * Math.PI * 2;
    const radius = 4 + variation(index + 71, cave.relief.seed) * Math.min(cave.legacyWidth, cave.legacyDepth) * .38;
    const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
    if (cave.sample(x, z).blocked || doorways.some(point => Math.hypot(point.x - x, point.z - z) < 5)) continue;
    const v = variation(index + 149, cave.relief.seed), y = cave.sample(x, z).height;
    rubble.push({ x, z, y: y + .09 + v * .08, sx: .16 + v * .2, sy: .12 + v * .13, sz: .2 + variation(index + 211, cave.relief.seed) * .22, rotationY: angle });
  }
  for (const portal of cave.portals) {
    const length = Math.max(.001, Math.hypot(portal.interior.x, portal.interior.z));
    const toward = { x: -portal.interior.x / length, z: -portal.interior.z / length };
    const side = { x: -toward.z, z: toward.x }, rotationY = Math.atan2(toward.x, toward.z);
    const ground = cave.sample(portal.interior.x, portal.interior.z).height;
    for (const sign of [-1, 1]) portalRocks.push({ x: portal.interior.x + side.x * sign * 1.05, z: portal.interior.z + side.z * sign * 1.05,
      y: ground + 1.05, sx: .72, sy: 1.35, sz: .62, rotationY: rotationY + sign * .18 });
    portalRocks.push({ x: portal.interior.x, z: portal.interior.z, y: ground + 2.38, sx: 1.5, sy: .48, sz: .7, rotationY });
  }
  return { ledges, stalactites, stalagmites, boulders, rubble, portalRocks };
}

function Batch({ name, entries, material, pointed = false, castsShadow = true }: { name: string; entries: Detail[]; material: Material; pointed?: boolean; castsShadow?: boolean }) {
  const ref = useRef<InstancedMesh>(null);
  const geometry = useMemo(() => {
    const shape: BufferGeometry = pointed ? new ConeGeometry(1, 1, 7, 2) : new IcosahedronGeometry(1, 1);
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
  return <instancedMesh ref={ref} name={name} args={[geometry, material, Math.max(1, entries.length)]} dispose={null} receiveShadow castShadow={castsShadow} />;
}

function ContactShadows({ cave, entries }: { cave: CaveScene; entries: Detail[] }) {
  const geometry = useMemo(() => {
    const positions: number[] = [], uvs: number[] = [], indices: number[] = [], segments = 12;
    entries.forEach(item => {
      const base = positions.length / 3, radiusX = item.sx * 1.55, radiusZ = item.sz * 1.55;
      positions.push(item.x, cave.sample(item.x, item.z).height + .035, item.z); uvs.push(.5, .5);
      for (let step = 0; step <= segments; step++) {
        const angle = step / segments * Math.PI * 2, x = item.x + Math.cos(angle) * radiusX, z = item.z + Math.sin(angle) * radiusZ;
        positions.push(x, cave.sample(x, z).height + .035, z); uvs.push(.5 + Math.cos(angle) * .5, .5 + Math.sin(angle) * .5);
      }
      for (let step = 0; step < segments; step++) indices.push(base, base + step + 2, base + step + 1);
    });
    const result = new BufferGeometry();
    result.setAttribute('position', new Float32BufferAttribute(positions, 3));
    result.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    result.setIndex(indices); result.computeVertexNormals(); result.computeBoundingSphere();
    return result;
  }, [cave, entries]);
  const material = useMemo(() => {
    const size = 32, pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const distance = Math.hypot((x + .5) / size * 2 - 1, (y + .5) / size * 2 - 1);
      const alpha = Math.max(0, 1 - distance), index = (y * size + x) * 4;
      pixels[index] = 5; pixels[index + 1] = 12; pixels[index + 2] = 11;
      pixels[index + 3] = Math.round(alpha * alpha * 255);
    }
    const map = new DataTexture(pixels, size, size, RGBAFormat); map.minFilter = map.magFilter = LinearFilter; map.needsUpdate = true;
    const result = new MeshBasicMaterial({ color: '#07100f', map, transparent: true, opacity: .28, depthWrite: false, side: DoubleSide });
    result.forceSinglePass = true;
    return result;
  }, []);
  useLayoutEffect(() => () => { geometry.dispose(); material.map?.dispose(); material.dispose(); }, [geometry, material]);
  return <mesh name="cave-contact-shadows" geometry={geometry} material={material} dispose={null} renderOrder={1} />;
}

export function CaveDetails({ cave, material, player, mobile, onNavigate }: {
  cave: CaveScene; material: MeshStandardMaterial; player: WorldPoint; mobile: boolean; onNavigate(point: WorldPoint): void;
}) {
  const all = useMemo(() => caveFormations(cave), [cave]);
  const cellX = Math.round(player.x / 4) * 4, cellZ = Math.round(player.z / 4) * 4;
  const close = useMemo(() => {
    const near = (item: Detail) => Math.hypot(item.x - cellX, item.z - cellZ) < (mobile ? 24 : 36);
    return { stalactites: all.stalactites.filter(near), stalagmites: all.stalagmites.filter(near), boulders: all.boulders.filter(near),
      rubble: all.rubble.filter(near), portalRocks: all.portalRocks.filter(near) };
  }, [all, cellX, cellZ, mobile]);
  const shadowCasters = useMemo(() => [...close.stalagmites, ...close.boulders, ...close.rubble, ...close.portalRocks], [close]);
  const rockFeatures = useMemo(() => [...close.boulders, ...close.rubble, ...close.portalRocks], [close]);
  return <group name="cave-geology">
    <Batch name="cave-rock-strata" entries={all.ledges} material={material} />
    <Batch name="cave-stalactites" entries={close.stalactites} material={material} pointed />
    <Batch name="cave-stalagmites" entries={close.stalagmites} material={material} pointed />
    <Batch name="cave-rock-features" entries={rockFeatures} material={material} castsShadow={false} />
    <ContactShadows cave={cave} entries={shadowCasters} />
    {cave.relief.pools.map((pool, index) => <mesh key={index} name={`cave-water:${index}`} position={[pool.x, pool.level, pool.z]} rotation={[-Math.PI / 2, 0, 0]}
      onClick={event => { event.stopPropagation(); if (event.button === 0 && event.delta <= 5) onNavigate({ x: event.point.x, z: event.point.z }); }}>
      <circleGeometry args={[pool.radius, mobile ? 24 : 40]} />
      <WaterMaterial lake center={[pool.x, pool.z]} radius={pool.radius} player={player} mobile={mobile} />
    </mesh>)}
  </group>;
}
