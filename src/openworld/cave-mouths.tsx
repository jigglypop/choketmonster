import { useEffect, useMemo, useState } from 'react';
import { BufferGeometry, Color, Float32BufferAttribute, Mesh, MeshStandardMaterial, Vector3, type Object3D } from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { acquireModel } from '../three/model-cache';
import { releaseOnDetach } from '../three/render-objects';
import type { WorldAtlas } from './atlas';
import { caveMouths, type CaveMouth } from './caves';
import { terrainSurfaceHeight } from './grounding';
import type { VisibilityTest } from './lod';
import type { WorldSample } from './types';

/** OpenGameArt "LowPoly Cave Entrance" (CC0): a rock mound whose arched doorway faces +Z. Parts: cave-rock, cave-rim, cave-void. */
const CAVE_MOUTH_URL = '/models/openworld/rocks/cave-mouth.glb?v=20260925-oga';
const MOUTH_COLORS = { rock: new Color('#9a9384'), rim: new Color('#cbc3b0'), void: new Color('#0c0e0f') };
type MouthModel = { geometry: BufferGeometry; size: Vector3 };

/**
 * The mound as one flat-shaded geometry in vertex colours, its doorway centred on x = 0 and its front on z = 0, the
 * body behind it (-z). The source is an open shell; a convex cap built from its rock, mirrored behind the front,
 * closes the back so the mound reads as solid rock from every side.
 */
export function caveMouthModel(scene: Object3D): MouthModel {
  scene.updateMatrixWorld(true);
  const parts: BufferGeometry[] = [], rock: Vector3[] = [], door = { min: Infinity, max: -Infinity };
  const painted = (geometry: BufferGeometry, color: Color) => {
    const position = geometry.getAttribute('position'), colors = new Float32Array(position.count * 3);
    for (let index = 0; index < position.count; index++) colors.set([color.r, color.g, color.b], index * 3);
    const part = new BufferGeometry();
    part.setAttribute('position', position); part.setAttribute('color', new Float32BufferAttribute(colors, 3));
    return part;
  };
  scene.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const source = object.geometry as BufferGeometry, flat = (source.index ? source.toNonIndexed() : source.clone()).applyMatrix4(object.matrixWorld);
    const kind = /void/i.test(object.name) ? 'void' : /rim/i.test(object.name) ? 'rim' : 'rock', position = flat.getAttribute('position');
    for (let index = 0; index < position.count; index++) {
      const x = position.getX(index);
      if (kind === 'void') { door.min = Math.min(door.min, x); door.max = Math.max(door.max, x); }
      if (kind === 'rock') rock.push(new Vector3(x, position.getY(index), position.getZ(index)));
    }
    parts.push(painted(flat, MOUTH_COLORS[kind]));
    flat.dispose();
  });
  const cap = new ConvexGeometry(rock.map(point => new Vector3(point.x, point.y, -Math.abs(point.z))));
  parts.push(painted(cap, MOUTH_COLORS.rock)); cap.dispose();
  const geometry = mergeGeometries(parts) ?? new BufferGeometry();
  parts.forEach(part => part.dispose());
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!, doorX = Number.isFinite(door.min) ? (door.min + door.max) / 2 : 0;
  geometry.translate(-doorX, -box.min.y, -box.max.z);
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return { geometry, size: geometry.boundingBox!.getSize(new Vector3()) };
}

/** The mound stands on the lowest ground under its footprint, sunk a little so slopes never show its base. */
function mouthBase(mouth: CaveMouth, sample: (x: number, z: number) => WorldSample): number {
  const cos = Math.cos(mouth.rotationY), sin = Math.sin(mouth.rotationY);
  let lowest = terrainSurfaceHeight(sample, mouth.x, mouth.z);
  for (const [u, v] of [[-.5, -.5], [.5, -.5], [-.5, .5], [.5, .5], [0, -.5]]) {
    const lx = u * mouth.width, lz = v * mouth.depth;
    lowest = Math.min(lowest, terrainSurfaceHeight(sample, mouth.x + lx * cos + lz * sin, mouth.z - lx * sin + lz * cos));
  }
  return lowest - .2;
}

/** A rock mound at every cave entrance on the surface, its doorway around the portal ring. */
export function CaveMouths({ atlas, sampleWorld, player, visible }: {
  atlas: WorldAtlas; sampleWorld: (x: number, z: number) => WorldSample; player: { x: number; z: number }; visible: VisibilityTest;
}) {
  const [scene, setScene] = useState<Object3D | null>(null);
  useEffect(() => {
    let active = true;
    const request = acquireModel(CAVE_MOUTH_URL);
    request.promise.then(gltf => { if (active) setScene(gltf.scene); }).catch(() => undefined);
    return () => { active = false; request.release(); };
  }, []);
  const model = useMemo(() => scene ? caveMouthModel(scene) : null, [scene]);
  const material = useMemo(() => new MeshStandardMaterial({ name: 'cave-mouth', vertexColors: true, roughness: .93, metalness: 0, flatShading: true }), []);
  useEffect(() => () => model?.geometry.dispose(), [model]);
  useEffect(() => () => material.dispose(), [material]);
  const placed = useMemo(() => caveMouths(atlas.id).map(mouth => ({ mouth, y: mouthBase(mouth, sampleWorld) })), [atlas, sampleWorld]);
  if (!model) return null;
  return <group name="cave-mouths">
    {placed.filter(({ mouth, y }) => Math.hypot(mouth.x - player.x, mouth.z - player.z) <= 80 && visible(mouth.x, y + mouth.height / 2, mouth.z, Math.hypot(mouth.width, mouth.height, mouth.depth) / 2)).map(({ mouth, y }) => {
      // `rotationY` turns local -Z to face out of the cave; the model's doorway faces +Z, so it turns half a circle more.
      const outX = -Math.sin(mouth.rotationY), outZ = -Math.cos(mouth.rotationY);
      // The mound material outlives the meshes that come and go with the view, so each frees its render objects.
      return <mesh key={mouth.id} ref={releaseOnDetach} name={`cave-mouth:${mouth.id}`} geometry={model.geometry} material={material}
        position={[mouth.x + outX * mouth.depth / 2, y, mouth.z + outZ * mouth.depth / 2]} rotation={[0, mouth.rotationY + Math.PI, 0]}
        scale={[mouth.width / model.size.x, (mouth.height + .2) / model.size.y, mouth.depth / model.size.z]} castShadow receiveShadow dispose={null} />;
    })}
  </group>;
}
