import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BoxGeometry, BufferGeometry, Color, CylinderGeometry, Float32BufferAttribute, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh,
  MeshStandardMaterial, Quaternion, RepeatWrapping, SphereGeometry, TextureLoader, TorusGeometry, Vector3, type Material,
} from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { WorldAtlas } from './atlas';
import type { CaveScene } from './caves';
import type { KantoLocation } from './kanto';
import type { WorldPoint, WorldSample } from './types';
import { FieldGrass } from './field-grass';
import { createWaterNodeMaterial, forestFloorColor, normalizeStandardMaterial, regionTrailColor, useSurfaceMaterial } from './materials';
import { acquireModel } from '../three/model-cache';
import { releaseOnDetach, useReleasingRef } from '../three/render-objects';
import { SCENERY_ASSETS, type SceneryAssetId } from './scenery';
import { MergedBuilder, at, detailMaterial } from './town-details';
import { detailNoise, trailHalfWidth } from './world-details';
import {
  PARK_GATE_POST, PARK_HEDGE_OFFSET, PARK_WOODS_HEIGHT, parkLatticeHeight, parkPathDistance, parkPondRatio, parkPondShore, parkRimGap, parkRimRadius,
  type ParkLayout, type ParkPlant, type ParkPond,
} from './park-layout';

/** Detailed ground runs this far past the park footprint; a flat ring carries the woods floor on to the horizon. */
const GROUND_MARGIN = 20, HORIZON = 420;
/** Phones draw the outer row of rim woods only this close. */
const PLANT_RADIUS = { desktop: 150, mobile: 76 } as const, MOBILE_OUTER_ROW = 46;
const SHADOW_ASSETS = new Set<SceneryAssetId>(['tree-round', 'tree-oak', 'tree-pine', 'tree-fat', 'tree-thin', 'rock-large', 'rock-moss']);
const LOOKS = {
  safari: { hedge: ['#3f6b35', '#86ad55'], post: '#7a5634', beam: '#654629', roof: '#b08c52', sign: '#efe2b8', emblem: '#d8a33e' },
  garden: { hedge: ['#355f36', '#6f9f58'], post: '#e6dfd0', beam: '#cbc2ae', roof: '#667a8f', sign: '#f2eee4', emblem: '#5c8f4f' },
} as const;
const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
const noTown = () => false;

/** Lawn, bank, pond bed and woods floor tinted into one vertex-coloured mesh on the exact sampling lattice. */
function groundGeometry(park: ParkLayout, atlas: WorldAtlas): BufferGeometry {
  const halfX = Math.ceil(park.width / 2) + GROUND_MARGIN, halfZ = Math.ceil(park.depth / 2) + GROUND_MARGIN, columns = halfX * 2 + 1;
  const lawn = new Color(atlas.palette.ground), woods = forestFloorColor(atlas), bank = new Color('#d7c893'), bed = new Color('#7d8a6a'), color = new Color();
  const positions: number[] = [], colors: number[] = [], indices: number[] = [];
  for (let z = -halfZ; z <= halfZ; z++) for (let x = -halfX; x <= halfX; x++) {
    positions.push(x, parkLatticeHeight(park, x, z), z);
    const variation = Math.sin(x * .19 + Math.sin(z * .11)) * Math.cos(z * .17);
    color.copy(lawn).multiplyScalar(1 + variation * .065).lerp(woods, smooth((1 - parkRimGap(park, x, z)) / 7));
    const pond = Math.min(Infinity, ...park.ponds.map(item => parkPondRatio(item, x, z)));
    if (pond < 1.35) color.lerp(pond < 1 ? bed : bank, pond < 1 ? .85 : .55 * smooth((1.35 - pond) / .3));
    colors.push(color.r, color.g, color.b);
  }
  // Same triangles as parkFloorHeight: the diagonal runs from (x, z + 1) to (x + 1, z).
  for (let row = 0; row < halfZ * 2; row++) for (let column = 0; column < halfX * 2; column++) {
    const a = row * columns + column, b = a + columns, c = b + 1, d = a + 1;
    indices.push(a, b, d, b, c, d);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

/** A flat woods floor ringing the detailed ground out to the horizon. */
function horizonGeometry(park: ParkLayout, atlas: WorldAtlas): BufferGeometry {
  const x = Math.ceil(park.width / 2) + GROUND_MARGIN, z = Math.ceil(park.depth / 2) + GROUND_MARGIN, y = PARK_WOODS_HEIGHT - .01, far = HORIZON;
  const corners = [[-x, -z], [x, -z], [x, z], [-x, z], [-far, -far], [far, -far], [far, far], [-far, far]];
  const woods = forestFloorColor(atlas), geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(corners.flatMap(([px, pz]) => [px, y, pz]), 3));
  geometry.setAttribute('color', new Float32BufferAttribute(corners.flatMap(() => [woods.r, woods.g, woods.b]), 3));
  // Each side is one quad between the inner and outer rectangles, facing up.
  geometry.setIndex([0, 4, 1, 1, 4, 5, 1, 5, 2, 2, 5, 6, 2, 6, 3, 3, 6, 7, 3, 7, 0, 0, 7, 4]);
  geometry.computeVertexNormals();
  return geometry;
}

/** Feathered dirt paths, built like the surface trails, with round joints where they meet. */
function trailGeometry(park: ParkLayout, sample: (x: number, z: number) => WorldSample): BufferGeometry {
  const vertices: number[] = [], colors: number[] = [], indices: number[] = [];
  const nodes = new Map(park.nodes.map(node => [node.id, node]));
  const profile = [-1.22, -1, -.74, .74, 1, 1.22], shoulder = [.86, .9, 1.02, 1.02, .9, .86], alpha = [0, .96, 1, 1, .96, 0];
  const push = (x: number, z: number, tone: number, opacity: number) => { vertices.push(x, sample(x, z).height + .055, z); colors.push(tone, tone * 1.01, tone * .96, opacity); };
  const meander = (salt: number, distance: number) => {
    const cell = Math.floor(distance / 4.5), t = distance / 4.5 - cell, eased = t * t * (3 - 2 * t);
    return 1 + (detailNoise(cell, salt, 77) * (1 - eased) + detailNoise(cell + 1, salt, 77) * eased - .5) * .18;
  };
  const joints = new Map<string, number>();
  park.paths.forEach(([fromId, toId], index) => {
    const from = nodes.get(fromId)!, to = nodes.get(toId)!, width = trailHalfWidth(fromId, toId);
    const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz) || 1, steps = Math.max(1, Math.ceil(length / 1.8));
    for (const id of [fromId, toId]) joints.set(id, Math.max(joints.get(id) ?? 0, width));
    const sideX = -dz / length, sideZ = dx / length, offset = vertices.length / 3;
    for (let step = 0; step <= steps; step++) {
      const t = step / steps, x = from.x + dx * t, z = from.z + dz * t, end = step === 0 || step === steps;
      profile.forEach((lateral, column) => {
        const edge = column < 2 || column > 3, reach = lateral * width * (end || !edge ? 1 : meander(index * 2 + (column < 2 ? 0 : 1), t * length));
        push(x + sideX * reach, z + sideZ * reach, shoulder[column], alpha[column]);
      });
      if (step === steps) continue;
      // Counter-clockwise seen from above, so the face points at the sky.
      const base = offset + step * 6;
      for (let column = 0; column < 5; column++) { const a = base + column, c = base + 6 + column; indices.push(a, a + 1, c, a + 1, c + 1, c); }
    }
  });
  for (const [id, width] of joints) {
    const node = nodes.get(id)!;
    if (node.kind === 'exit') continue;
    const center = vertices.length / 3, rim = 20;
    push(node.x, node.z, 1.02, 1);
    for (let index = 0; index < rim; index++) {
      const angle = index / rim * Math.PI * 2, cos = Math.cos(angle), sin = Math.sin(angle);
      push(node.x + cos * width * .74, node.z + sin * width * .74, 1.02, 1);
      push(node.x + cos * width, node.z + sin * width, .9, .96);
      push(node.x + cos * width * 1.22, node.z + sin * width * 1.22, .86, 0);
    }
    for (let index = 0; index < rim; index++) {
      const a = center + 1 + index * 3, b = center + 1 + (index + 1) % rim * 3;
      indices.push(center, b, a);
      for (let ring = 0; ring < 2; ring++) indices.push(a + ring, b + ring, a + ring + 1, a + ring + 1, b + ring, b + ring + 1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 4));
  geometry.setAttribute('uv', new Float32BufferAttribute(vertices.flatMap((_, index) => index % 3 === 0 ? [vertices[index] * .28, vertices[index + 2] * .28] : []), 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

/** A pond's water sheet, a little past its shore so the bank slides under it. */
function pondGeometry(pond: ParkPond): BufferGeometry {
  const shore = parkPondShore(pond, .6), positions = [pond.x, pond.level, pond.z, ...shore.flatMap(point => [point.x, pond.level, point.z])], indices: number[] = [];
  for (let index = 0; index < shore.length; index++) indices.push(0, 1 + (index + 1) % shore.length, 1 + index);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

/** The hedge: leafy lumps just outside the walkable rim, open where each path leaves through its gate. */
function hedgeGeometry(park: ParkLayout, sample: (x: number, z: number) => WorldSample): BufferGeometry {
  const builder = new MergedBuilder(), [bottom, top] = LOOKS[park.style].hedge;
  let travelled = 0, lump = 0;
  for (let index = 0; index < 1440; index++) {
    const angle = index / 1440 * Math.PI * 2, radius = parkRimRadius(park, angle) + PARK_HEDGE_OFFSET;
    travelled += radius * Math.PI * 2 / 1440;
    if (travelled < 1.3) continue;
    travelled = 0; lump++;
    const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
    if (park.gates.some(gate => Math.hypot(x - gate.rim.x, z - gate.rim.z) < PARK_GATE_POST + 1.2)) continue;
    const salt = detailNoise(lump, park.seed, 5), height = .85 + salt * .35;
    builder.add(new IcosahedronGeometry(1, 1), bottom, at(x, sample(x, z).height + height * .52, z, -angle, 1.05 + detailNoise(lump, park.seed, 6) * .3, height, 1 + detailNoise(lump, park.seed, 7) * .25),
      { top, height: 2, soft: .35 });
  }
  return builder.build();
}

/** Every gate: two posts under a roofed beam with a hanging sign, straddling its doorway. */
function gateGeometry(scene: CaveScene): BufferGeometry {
  const park = scene.park!, look = LOOKS[park.style], builder = new MergedBuilder();
  const place = new Matrix4(), turn = new Quaternion(), up = new Vector3(0, 1, 0);
  for (const gate of park.gates) {
    place.compose(new Vector3(gate.frame.x, scene.sample(gate.frame.x, gate.frame.z).height, gate.frame.z), turn.setFromAxisAngle(up, gate.rotationY), new Vector3(1, 1, 1));
    const part = (local: Matrix4) => place.clone().multiply(local);
    for (const side of [-1, 1]) {
      builder.add(new BoxGeometry(.34, 3.2, .34), look.post, part(at(side * PARK_GATE_POST, 1.6, 0)), { top: look.beam, height: 3.2 });
      builder.add(new BoxGeometry(.48, .16, .48), look.beam, part(at(side * PARK_GATE_POST, 3.28, 0)));
      builder.add(new BoxGeometry(.05, .3, .05), look.beam, part(at(side * .8, 2.83, .12)));
    }
    builder.add(new BoxGeometry(5.3, .32, .42), look.beam, part(at(0, 3.02, 0)));
    for (const side of [-1, 1]) builder.add(new BoxGeometry(5.7, .1, .62), look.roof, part(at(0, 3.36, side * .24, 0, 1, 1, 1, side * .5)));
    builder.add(new BoxGeometry(2.2, .62, .1), look.sign, part(at(0, 2.43, .12)));
    builder.add(new CylinderGeometry(.19, .19, .04, 16), look.emblem, part(at(0, 2.43, .19, 0, 1, 1, 1, Math.PI / 2)));
  }
  return builder.build();
}

function fountainGeometry(park: ParkLayout, y: number): BufferGeometry {
  const { x, z, radius } = park.fountain!, builder = new MergedBuilder();
  builder.add(new CylinderGeometry(radius, radius + .15, .36, 32), '#cfc6b2', at(x, y + .18, z), { top: '#dcd4c3', height: .36 });
  builder.add(new TorusGeometry(radius - .15, .16, 8, 36), '#e4ddcd', at(x, y + .38, z, 0, 1, 1, 1, Math.PI / 2));
  builder.add(new CylinderGeometry(.32, .42, 1.3, 14), '#cfc6b2', at(x, y + .9, z));
  builder.add(new CylinderGeometry(.95, .45, .28, 20), '#ddd5c4', at(x, y + 1.62, z));
  builder.add(new SphereGeometry(.2, 12, 8), '#e9e2d2', at(x, y + 1.95, z));
  return builder.build();
}

/** Grass needs an atlas: this one carries the park's paths as its roads, so blades clear the trails and tall grass lines them. */
const grassAtlases = new WeakMap<CaveScene, Map<WorldAtlas, WorldAtlas>>();
function parkGrassAtlas(atlas: WorldAtlas, scene: CaveScene): WorldAtlas {
  let byAtlas = grassAtlases.get(scene);
  if (!byAtlas) grassAtlases.set(scene, byAtlas = new Map());
  let result = byAtlas.get(atlas);
  if (result) return result;
  const park = scene.park!;
  // Gates count as landmarks, so tall grass leaves their approach open.
  const locations = park.nodes.map((node): KantoLocation => ({ id: node.id, name: scene.name, x: node.x, z: node.z, kind: node.kind === 'gate' ? 'special' : 'route',
    minLevel: scene.minLevel, maxLevel: scene.maxLevel, encounters: [], requiredBadges: 0 }));
  result = { ...atlas, mapVersion: `park:${scene.sceneId}`, locations, connections: park.paths, surfaceConnections: park.paths, gates: [],
    distanceToPath: (x: number, z: number) => parkPathDistance(park, x, z) };
  byAtlas.set(atlas, result);
  return result;
}

type Placement = { x: number; y: number; z: number; rotationY: number; scale: number };
const scratch = { placement: new Matrix4(), result: new Matrix4(), position: new Vector3(), size: new Vector3(), rotation: new Quaternion(), axis: new Vector3(0, 1, 0) };

function PlantPart({ geometry, material, matrix, placements, scale, shadows }: { geometry: BufferGeometry; material: Material | Material[]; matrix: Matrix4; placements: readonly Placement[]; scale: number; shadows: boolean }) {
  const mesh = useRef<InstancedMesh>(null);
  // A larger capacity remounts the mesh on the same materials; the old one frees its render objects.
  const attach = useReleasingRef(mesh);
  // Capacity only grows, so walking past the rim woods reuses the instance buffer.
  const grown = useRef(8);
  const capacity = grown.current = Math.max(grown.current, 2 ** Math.ceil(Math.log2(Math.max(1, placements.length))));
  useEffect(() => { const instance = mesh.current; return () => { instance?.dispose(); }; }, [capacity]);
  useLayoutEffect(() => {
    const target = mesh.current; if (!target) return;
    const { placement, result, position, size, rotation, axis } = scratch;
    placements.forEach((item, index) => {
      placement.compose(position.set(item.x, item.y, item.z), rotation.setFromAxisAngle(axis, item.rotationY), size.setScalar(item.scale * scale));
      target.setMatrixAt(index, result.multiplyMatrices(placement, matrix));
    });
    target.count = placements.length; target.instanceMatrix.needsUpdate = true; target.computeBoundingSphere();
  }, [placements, matrix, scale, capacity]);
  return <instancedMesh key={capacity} ref={attach} args={[geometry, material, capacity]} count={placements.length} castShadow={shadows} receiveShadow dispose={null} />;
}

/** One shared nature model drawn at every placement, one instanced draw per material. */
function ParkModel({ asset, placements }: { asset: SceneryAssetId; placements: readonly Placement[] }) {
  const entry = SCENERY_ASSETS.find(item => item.id === asset)!;
  const [gltf, setGltf] = useState<GLTF | null>(null);
  useEffect(() => {
    let active = true;
    const request = acquireModel(entry.url);
    request.promise.then(value => { if (active) setGltf(value); }, () => undefined);
    return () => { active = false; request.release(); };
  }, [entry.url]);
  const parts = useMemo(() => {
    if (!gltf) return [];
    gltf.scene.updateMatrixWorld(true);
    const meshes: Array<{ geometry: BufferGeometry; material: Material | Material[]; matrix: Matrix4 }> = [];
    gltf.scene.traverse(object => {
      if (!(object instanceof Mesh)) return;
      const source = Array.isArray(object.material) ? object.material : [object.material];
      const normalized = source.map(material => material instanceof MeshStandardMaterial ? normalizeStandardMaterial(material) : material.clone());
      meshes.push({ geometry: object.geometry, material: Array.isArray(object.material) ? normalized : normalized[0], matrix: object.matrixWorld.clone() });
    });
    return meshes;
  }, [gltf]);
  useEffect(() => () => { for (const part of parts) for (const material of [part.material].flat()) material.dispose(); }, [parts]);
  return <group name={`park-plants:${asset}`}>{parts.map((part, index) => <PlantPart key={index} {...part} placements={placements} scale={entry.scale} shadows={SHADOW_ASSETS.has(asset)} />)}</group>;
}

/** Trees, bushes, boulders, flowers and lily pads near the player; phones keep the outer rim row close. */
function ParkPlants({ park, sample, player, mobile }: { park: ParkLayout; sample: (x: number, z: number) => WorldSample; player: WorldPoint; mobile: boolean }) {
  const placed = useMemo(() => park.plants.map(plant => ({ plant, placement: {
    x: plant.x, z: plant.z, rotationY: plant.rotationY, scale: plant.scale,
    y: plant.asset === 'lily' ? (park.ponds.find(pond => parkPondRatio(pond, plant.x, plant.z) < 1)?.level ?? sample(plant.x, plant.z).height) + .012 : sample(plant.x, plant.z).height,
  } })), [park, sample]);
  const cellX = Math.round(player.x / 8) * 8, cellZ = Math.round(player.z / 8) * 8;
  const groups = useMemo(() => {
    const result = new Map<SceneryAssetId, Placement[]>(), radius = mobile ? PLANT_RADIUS.mobile : PLANT_RADIUS.desktop;
    const shown = (plant: ParkPlant) => { const distance = Math.hypot(plant.x - cellX, plant.z - cellZ); return distance < radius && (!mobile || !plant.tier || distance < MOBILE_OUTER_ROW); };
    for (const { plant, placement } of placed) if (shown(plant)) { const list = result.get(plant.asset); if (list) list.push(placement); else result.set(plant.asset, [placement]); }
    return result;
  }, [placed, cellX, cellZ, mobile]);
  return <group name="park-plants">{[...groups].map(([asset, placements]) => <ParkModel key={asset} asset={asset} placements={placements} />)}</group>;
}

/** An open-air park zone: lawn and tall grass, ponds, paths between the gates, trees and a hedge in the outdoor sun. */
export function ParkInterior({ scene, atlas, player, mobile, onNavigate }: { scene: CaveScene; atlas: WorldAtlas; player: WorldPoint; mobile: boolean; onNavigate(point: WorldPoint): void }) {
  const park = scene.park!, sample = scene.sample;
  const groundMaterial = useSurfaceMaterial({ surface: 'ground', vertexColors: true });
  const pathMaterial = useSurfaceMaterial({ surface: 'path', color: regionTrailColor(atlas), vertexColors: true });
  const geometries = useMemo(() => ({
    ground: groundGeometry(park, atlas), horizon: horizonGeometry(park, atlas), trail: trailGeometry(park, sample), hedge: hedgeGeometry(park, sample), gates: gateGeometry(scene),
    ponds: park.ponds.map(pondGeometry),
    fountain: park.fountain ? fountainGeometry(park, sample(park.fountain.x, park.fountain.z).height) : undefined,
  }), [atlas, park, sample, scene]);
  useEffect(() => () => { for (const geometry of Object.values(geometries).flat()) geometry?.dispose(); }, [geometries]);
  const waterNormals = useMemo(() => { const texture = new TextureLoader().load('/textures/water/three-waternormals.jpg'); texture.wrapS = texture.wrapT = RepeatWrapping; return texture; }, []);
  useEffect(() => () => waterNormals.dispose(), [waterNormals]);
  const water = useMemo(() => {
    const pools = park.ponds.map(pond => createWaterNodeMaterial({ lake: true, center: [pond.x, pond.z], radius: (pond.radiusX + pond.radiusZ) / 2, waterNormals }));
    const basin = park.fountain && createWaterNodeMaterial({ lake: true, center: [park.fountain.x, park.fountain.z], radius: park.fountain.radius - .3, waterNormals });
    return { pools, basin };
  }, [park, waterNormals]);
  useEffect(() => () => { water.pools.forEach(material => material.dispose()); water.basin?.dispose(); }, [water]);
  const grassAtlas = useMemo(() => parkGrassAtlas(atlas, scene), [atlas, scene]);
  const fountainY = park.fountain ? sample(park.fountain.x, park.fountain.z).height : 0;
  // No dispose={null}: R3F then disposes the fountain water's inline geometry on unmount. Props stay with their owners.
  return <group name={`park-interior:${scene.id}`}>
    <mesh name="park-ground" geometry={geometries.ground} material={groundMaterial} receiveShadow
      onClick={event => { event.stopPropagation(); if (event.button === 0 && event.delta <= 5) onNavigate({ x: event.point.x, z: event.point.z }); }} />
    <mesh name="park-horizon" geometry={geometries.horizon} material={groundMaterial} receiveShadow />
    <mesh name="park-trails" geometry={geometries.trail} material={pathMaterial} receiveShadow />
    {geometries.ponds.map((geometry, index) => <mesh key={index} name={`park-pond:${index}`} geometry={geometry} material={water.pools[index]} receiveShadow />)}
    {/* The shared detail material outlives the park, so these meshes free their own render objects. */}
    <mesh ref={releaseOnDetach} name="park-hedge" geometry={geometries.hedge} material={detailMaterial()} castShadow receiveShadow />
    <mesh ref={releaseOnDetach} name="park-gates" geometry={geometries.gates} material={detailMaterial()} castShadow receiveShadow />
    {geometries.fountain && <>
      <mesh ref={releaseOnDetach} name="park-fountain" geometry={geometries.fountain} material={detailMaterial()} castShadow receiveShadow />
      <mesh name="park-fountain-water" position={[park.fountain!.x, fountainY + .34, park.fountain!.z]} rotation={[-Math.PI / 2, 0, 0]} material={water.basin}>
        <circleGeometry args={[park.fountain!.radius - .25, 32]} />
      </mesh>
    </>}
    <ParkPlants park={park} sample={sample} player={player} mobile={mobile} />
    <FieldGrass key={scene.sceneId} atlas={grassAtlas} sampleWorld={sample} player={player} mobile={mobile} skipTown={noTown} />
  </group>;
}
