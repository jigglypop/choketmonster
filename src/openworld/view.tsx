import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Physics, RigidBody } from '@react-three/rapier';
import { GaesupWorld, createCameraPlugin } from 'gaesup-world';
import { createGaesupRuntime } from 'gaesup-world/runtime';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  AnimationMixer,
  type AnimationAction,
  LoopOnce,
  LoopRepeat,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Frustum,
  Sphere,
  Group,
  InstancedMesh,
  Material,
  Matrix4,
  MOUSE,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SRGBColorSpace,
  Spherical,
  Texture,
  Vector3,
} from 'three';
import { type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type {
  OpenWorldProp,
  OpenWorldRenderSnapshot,
  OpenWorldView,
  OpenWorldViewOptions,
  WorldCreature,
  WorldPoint,
  WorldSample,
} from './types';
import { createSceneryPlacements, SCENERY_ASSETS, type SceneryPlacement } from './scenery';
import { createGrounding, terrainSurfaceHeight } from './grounding';
import { getWorldAtlas, type WorldAtlas } from './atlas';
import { hasPokemonModel } from '../game/assets';
import { selectPokemonMotionClip } from '../data/model-motion';
import { createGLTFLoader } from '../three/gltf-loader';
import { creatureLods, terrainChunks, TERRAIN_CHUNK_SIZE, type TerrainChunk, type VisibilityTest } from './lod';
import { initialYaw, movementYaw, turnTowards } from './motion';
import { normalizePokemonModel } from './model-normalization';
import './view.css';
import { RenderProbe } from './render-probe';
import { SkyLighting, SurfaceMaterial, WaterMaterial, detailCanopy, detailSurface, useSurfaceTextures, type SurfaceTextures } from './materials';
import { AdaptiveResolution } from './adaptive-resolution';
import { applyCameraAction, MAX_CAMERA_DISTANCE, MIN_CAMERA_DISTANCE, type CameraAction } from './camera-navigation';
import { findWorldPath, headingForStep } from './navigation';
import { blockedBoundarySegments } from './blocked-boundaries';
import { onRenderSuspension, renderingSuspended } from '../three/render-budget';

const WORLD_MIN = -120;
const WORLD_MAX = 120;
const MODEL_CACHE_LIMIT = 16;
const NATURE_DETAIL_RADIUS = 68;
// Fog is fully opaque at 85 world units. The rounded 16-unit streaming cell can
// be eight units from the player, so 94 keeps every potentially visible prop.
const NATURE_VISIBLE_RADIUS = 94;
const NATURE_SHADOW_CASTERS = new Set([
  'tree-round', 'tree-oak', 'tree-pine', 'tree-fat', 'tree-thin',
  'rock-large', 'rock-moss', 'rock-tall', 'rock-ridge', 'cliff', 'moss-boulder',
  'stump', 'fallen-log',
]);
const loader = createGLTFLoader();
const DEFAULT_CAMERA_OFFSET = new Vector3(5.6, 7.6, 8.8);
type CameraCommand = { id: number; action: CameraAction };

type CachedModel = {
  promise: Promise<GLTF>;
  gltf?: GLTF;
  refs: number;
  lastUsed: number;
};

const modelCache = new Map<string, CachedModel>();

function disposeTree(root: Object3D): void {
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof Texture) value.dispose();
      }
      material.dispose();
    }
  });
}

function pruneModelCache(): void {
  if (modelCache.size <= MODEL_CACHE_LIMIT) return;
  const candidates = [...modelCache.entries()]
    .filter(([, entry]) => entry.refs === 0 && entry.gltf)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  while (modelCache.size > MODEL_CACHE_LIMIT && candidates.length) {
    const [url, entry] = candidates.shift()!;
    if (entry.gltf) disposeTree(entry.gltf.scene);
    modelCache.delete(url);
  }
}

type LoadTask = { url: string; entry: CachedModel; resolve(value: GLTF): void; reject(error: unknown): void };
const loadQueue: LoadTask[] = [];
let activeLoads = 0;
const failedModels = new Map<string, number>();
function drainModelQueue(): void {
  loadQueue.sort((a, b) => Number(/raw\.githubusercontent\.com/.test(b.url)) - Number(/raw\.githubusercontent\.com/.test(a.url)));
  while (activeLoads < 3 && loadQueue.length) {
    const task = loadQueue.shift()!;
    if (!task.entry.refs) {
      if (modelCache.get(task.url) === task.entry) modelCache.delete(task.url);
      task.reject(new Error('Model left the visible area before loading')); continue;
    }
    activeLoads++;
    loader.loadAsync(task.url).then(gltf => { task.entry.gltf = gltf; task.resolve(gltf); }, error => {
      failedModels.set(task.url, performance.now());
      if (modelCache.get(task.url) === task.entry) modelCache.delete(task.url);
      task.reject(error);
    }).finally(() => { activeLoads--; pruneModelCache(); drainModelQueue(); });
  }
}

function acquireModel(url: string): { promise: Promise<GLTF>; release(): void } {
  let entry = modelCache.get(url);
  if (!entry) {
    const lastFailure = failedModels.get(url);
    if (lastFailure !== undefined && performance.now() - lastFailure < 60_000) {
      return { promise: Promise.reject(new Error('Model temporarily unavailable')), release() {} };
    }
    let resolve!: (value: GLTF) => void, reject!: (error: unknown) => void;
    const promise = new Promise<GLTF>((yes, no) => { resolve = yes; reject = no; });
    entry = { promise, refs: 0, lastUsed: performance.now() };
    modelCache.set(url, entry);
    loadQueue.push({ url, entry, resolve, reject });
  }
  entry.refs++;
  entry.lastUsed = performance.now();
  const acquired = entry;
  queueMicrotask(drainModelQueue);
  let released = false;
  return { promise: entry.promise, release() {
    if (released) return; released = true;
    acquired.refs = Math.max(0, acquired.refs - 1);
    acquired.lastUsed = performance.now();
    pruneModelCache();
  } };
}

function useModelStatus(url: string): { url: string; gltf: GLTF | null; failed: boolean } {
  const [state, setState] = useState({ url, gltf: null as GLTF | null, failed: false });
  useEffect(() => {
    let active = true;
    setState({ url, gltf: null, failed: false });
    const request = acquireModel(url);
    request.promise.then(gltf => { if (active) setState({ url, gltf, failed: false }); })
      .catch(() => { if (active) setState({ url, gltf: null, failed: true }); });
    return () => { active = false; request.release(); };
  }, [url]);
  return state.url === url ? state : { url, gltf: null, failed: false };
}

function useCachedModel(url: string): GLTF | null {
  return useModelStatus(url).gltf;
}

class SnapshotStore {
  private snapshot: OpenWorldRenderSnapshot;
  private listeners = new Set<() => void>();

  constructor(snapshot: OpenWorldRenderSnapshot) { this.snapshot = snapshot; }
  get = (): OpenWorldRenderSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(snapshot: OpenWorldRenderSnapshot): void {
    if (snapshot === this.snapshot) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function fallbackSample(x: number, z: number): WorldSample {
  const height = Math.sin(x * 0.045) * 1.15 + Math.cos(z * 0.038) * .85;
  return { height, biome: Math.abs(x) + Math.abs(z) > 175 ? 'rock' : 'meadow', blocked: false };
}

function Terrain({ sampleWorld, chunk, atlas, onNavigate }: { sampleWorld: (x: number, z: number) => WorldSample; chunk: TerrainChunk; atlas: WorldAtlas; onNavigate?: (point: WorldPoint) => void }) {
  const showBlockedBoundary = chunk.distance <= 44;
  const { geometry, skirt, blockedBoundary } = useMemo(() => {
    const n = chunk.segments, stride = n + 1;
    const vertices: number[] = [], colors: number[] = [], indices: number[] = [];
    const palette: Record<WorldSample['biome'], Color> = {
      meadow: new Color(atlas.palette.ground), forest: new Color('#285b35'),
      lake: new Color(atlas.palette.water), rock: new Color(atlas.id === 'sinnoh' || atlas.id === 'hisui' ? '#acb1ab' : '#777763'),
    };
    for (let iz = 0; iz <= n; iz++) for (let ix = 0; ix <= n; ix++) {
      const x = chunk.x - 20 + ix * TERRAIN_CHUNK_SIZE / n, z = chunk.z - 20 + iz * TERRAIN_CHUNK_SIZE / n;
      const sample = sampleWorld(x, z), color = palette[sample.biome].clone();
      vertices.push(x, terrainSurfaceHeight(sampleWorld, x, z), z);
      color.offsetHSL(0, .01, Math.sin(x * .12 + z * .07) * .035);
      colors.push(color.r, color.g, color.b);
      if (ix < n && iz < n) { const a = iz * stride + ix, b = a + stride; indices.push(a, b, a + 1, b, b + 1, a + 1); }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    // Separate skirts close coarse/fine seams without bending the ground normals.
    const skirtVertices: number[] = [], skirtColors: number[] = [], skirtIndices: number[] = [];
    const edges = [Array.from({ length: stride }, (_, i) => i), Array.from({ length: stride }, (_, i) => i * stride + n),
      Array.from({ length: stride }, (_, i) => n * stride + n - i), Array.from({ length: stride }, (_, i) => (n - i) * stride)];
    for (const edge of edges) for (let i = 0; i < n; i++) {
      const start = skirtVertices.length / 3;
      for (const vertex of [edge[i], edge[i + 1]]) for (const depth of [0, 4]) {
        skirtVertices.push(vertices[vertex * 3], vertices[vertex * 3 + 1] - depth, vertices[vertex * 3 + 2]);
        skirtColors.push(...colors.slice(vertex * 3, vertex * 3 + 3));
      }
      skirtIndices.push(start, start + 1, start + 2, start + 1, start + 3, start + 2, start + 2, start + 1, start, start + 2, start + 3, start + 1);
    }
    const skirt = new BufferGeometry(); skirt.setAttribute('position', new Float32BufferAttribute(skirtVertices, 3));
    skirt.setAttribute('color', new Float32BufferAttribute(skirtColors, 3)); skirt.setIndex(skirtIndices); skirt.computeVertexNormals();
    const blockedVertices: number[] = [], blockedIndices: number[] = [];
    if (showBlockedBoundary) for (const segment of blockedBoundarySegments(sampleWorld, chunk.x, chunk.z)) {
      const dx = segment.x2 - segment.x1, dz = segment.z2 - segment.z1, length = Math.hypot(dx, dz) || 1;
      const sideX = -dz / length * .09, sideZ = dx / length * .09;
      const start = blockedVertices.length / 3;
      const y1 = terrainSurfaceHeight(sampleWorld, segment.x1, segment.z1) + .11;
      const y2 = terrainSurfaceHeight(sampleWorld, segment.x2, segment.z2) + .11;
      blockedVertices.push(segment.x1 + sideX, y1, segment.z1 + sideZ, segment.x1 - sideX, y1, segment.z1 - sideZ,
        segment.x2 + sideX, y2, segment.z2 + sideZ, segment.x2 - sideX, y2, segment.z2 - sideZ);
      blockedIndices.push(start, start + 2, start + 1, start + 1, start + 2, start + 3);
    }
    const blockedBoundary = new BufferGeometry();
    blockedBoundary.setAttribute('position', new Float32BufferAttribute(blockedVertices, 3));
    blockedBoundary.setIndex(blockedIndices);
    return { geometry, skirt, blockedBoundary };
  }, [chunk.x, chunk.z, chunk.segments, showBlockedBoundary, sampleWorld, atlas]);
  useEffect(() => () => { geometry.dispose(); skirt.dispose(); blockedBoundary.dispose(); }, [geometry, skirt, blockedBoundary]);
  const surface = <mesh geometry={geometry} receiveShadow name={`terrain-chunk:${chunk.key}:${chunk.segments}`} onClick={event => {
    event.stopPropagation(); if (event.button === 0 && event.delta <= 5) onNavigate?.({ x: event.point.x, z: event.point.z });
  }}><SurfaceMaterial surface="ground" vertexColors /></mesh>;
  return <group>
    {chunk.distance <= 20 ? <RigidBody type="fixed" colliders="trimesh" friction={1}>{surface}</RigidBody> : surface}
    <mesh geometry={skirt}><SurfaceMaterial surface="ground" vertexColors /></mesh>
    {blockedBoundary.getAttribute('position').count > 0 && <mesh name={`blocked-boundary:${chunk.key}`} geometry={blockedBoundary} renderOrder={4}>
      <meshBasicMaterial color="#f4c95d" transparent opacity={.82} depthWrite={false} />
    </mesh>}
  </group>;
}

function InstancedPart({ geometry, material, sourceMatrix, placements, shadows }: {
  geometry: BufferGeometry;
  material: Material | Material[];
  sourceMatrix: Matrix4;
  placements: readonly SceneryPlacement[];
  shadows: boolean;
}) {
  const mesh = useRef<InstancedMesh>(null);
  useEffect(() => { const instance = mesh.current; return () => { instance?.dispose(); }; }, [placements.length]);
  useLayoutEffect(() => {
    if (!mesh.current) return;
    const placementMatrix = new Matrix4();
    const result = new Matrix4();
    const position = new Vector3();
    const scale = new Vector3();
    const rotation = new Quaternion();
    const axis = new Vector3(0, 1, 0);
    placements.forEach((item, index) => {
      position.set(item.x, item.y, item.z);
      scale.setScalar(item.scale);
      rotation.setFromAxisAngle(axis, item.rotationY);
      placementMatrix.compose(position, rotation, scale);
      result.multiplyMatrices(placementMatrix, sourceMatrix);
      mesh.current!.setMatrixAt(index, result);
    });
    mesh.current.instanceMatrix.needsUpdate = true;
    mesh.current.computeBoundingSphere();
  }, [placements, sourceMatrix]);
  return <instancedMesh ref={mesh} args={[geometry, material, placements.length]} castShadow={shadows} receiveShadow dispose={null} />;
}

function InstancedAsset({ url, placements, shadows, wind, rockTextures }: { url: string; placements: readonly SceneryPlacement[]; shadows: boolean; wind: boolean; rockTextures?: SurfaceTextures }) {
  const gltf = useCachedModel(url);
  const parts = useMemo(() => {
    if (!gltf) return [];
    gltf.scene.updateMatrixWorld(true);
    const meshes: Array<{ geometry: BufferGeometry; material: Material | Material[]; matrix: Matrix4 }> = [];
    gltf.scene.traverse(object => {
      if (!(object instanceof Mesh)) return;
      const source = Array.isArray(object.material) ? object.material : [object.material];
      const normalized = source.map(material => {
        const clone = material.clone();
        if (clone instanceof MeshStandardMaterial) {
          clone.metalness = 0;
          // Imported assets retain their painted colors, UVs and normal maps.
          if (!clone.roughnessMap) clone.roughness = .95;
          if (url.includes('/props/tree-')) detailCanopy(clone);
          if (rockTextures) detailSurface(clone, rockTextures, 'rock');
          if (wind) {
            clone.onBeforeCompile = shader => {
              shader.uniforms.owWindTime = { value: 0 };
              clone.userData.windTime = shader.uniforms.owWindTime;
              shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\nuniform float owWindTime;')
                .replace('#include <begin_vertex>', `#include <begin_vertex>
                  float owTip = smoothstep(0.04, 0.7, position.y);
                  float owPhase = position.x * 2.1 + position.z * 1.7;
                  #ifdef USE_INSTANCING
                    owPhase += instanceMatrix[3].x * 0.13 + instanceMatrix[3].z * 0.17;
                  #endif
                  transformed.x += sin(owWindTime * 1.35 + owPhase) * 0.035 * owTip;
                  transformed.z += cos(owWindTime * 1.05 + owPhase) * 0.022 * owTip;`);
            };
            clone.customProgramCacheKey = () => 'openworld-soft-wind-v1';
          }
          clone.needsUpdate = true;
        }
        return clone;
      });
      meshes.push({ geometry: object.geometry, material: Array.isArray(object.material) ? normalized : normalized[0], matrix: object.matrixWorld.clone() });
    });
    return meshes;
  }, [gltf, wind, rockTextures, url]);
  useFrame(({ clock }) => {
    if (!wind) return;
    for (const part of parts) {
      const materials = Array.isArray(part.material) ? part.material : [part.material];
      for (const material of materials) {
        const uniform = material.userData.windTime as { value: number } | undefined;
        if (uniform) uniform.value = clock.elapsedTime;
      }
    }
  });
  useEffect(() => () => {
    for (const part of parts) {
      const materials = Array.isArray(part.material) ? part.material : [part.material];
      for (const material of materials) material.dispose();
    }
  }, [parts]);
  if (!placements.length) return null;
  return <group name={`nature:${url.split('/').at(-1)?.split('?')[0]}`}>{parts.map((part, index) => <InstancedPart key={index} geometry={part.geometry} material={part.material} sourceMatrix={part.matrix} placements={placements} shadows={shadows} />)}</group>;
}

function Nature({ sampleWorld, player, atlas, isVisible }: { sampleWorld: (x: number, z: number) => WorldSample; player: { x: number; z: number }; atlas: WorldAtlas; isVisible: VisibilityTest }) {
  const placements = useMemo(() => createSceneryPlacements(sampleWorld, atlas), [sampleWorld, atlas]);
  const rockTextures = useSurfaceTextures('rock');
  const cellX = Math.round(player.x / 16) * 16, cellZ = Math.round(player.z / 16) * 16;
  // 85m fog + 48m camera reach + 12m cell margin: unload only fully hidden props.
  const nearby = useMemo(() => Object.fromEntries(SCENERY_ASSETS.map(asset => {
    const visible = placements[asset.id]
      .filter(item => Math.hypot(item.x - cellX, item.z - cellZ) < (['moss-boulder', 'moss-stone', 'fern'].includes(asset.id) ? NATURE_DETAIL_RADIUS : NATURE_VISIBLE_RADIUS) && (Math.hypot(item.x - player.x, item.z - player.z) < 12 || isVisible(item.x, item.y + 3, item.z, 6)))
      .map(item => ({ ...item, scale: item.scale * asset.scale }));
    return [asset.id, visible];
  })), [placements, cellX, cellZ, isVisible]);
  return (
    <group userData={{ gaesupWorldObject: 'imported-nature-instances' }}>
      {SCENERY_ASSETS.filter(asset => nearby[asset.id].length).map(asset => <InstancedAsset
        key={asset.id}
        url={asset.url}
        placements={nearby[asset.id]}
        rockTextures={!asset.authoredMaterials && (asset.id.startsWith('rock') || asset.id === 'cliff') ? rockTextures : undefined}
        shadows={NATURE_SHADOW_CASTERS.has(asset.id)}
        wind={asset.id === 'grass-tuft' || asset.id === 'grass-soft' || asset.id.startsWith('flower') || asset.id === 'bush' || asset.id === 'lily' || asset.id === 'fern'}
      />)}
    </group>
  );
}

function BuildingSign({ text, color }: { text: string; color: string }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 128;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#f4ecd2'; context.fillRect(4, 4, 248, 120);
    context.strokeStyle = color; context.lineWidth = 12; context.strokeRect(8, 8, 240, 112);
    context.fillStyle = color; context.textAlign = 'center'; context.textBaseline = 'middle';
    context.font = `900 ${text.length > 2 ? 58 : 78}px system-ui, sans-serif`; context.fillText(text, 128, 67);
    const result = new CanvasTexture(canvas); result.colorSpace = SRGBColorSpace; return result;
  }, [color, text]);
  useEffect(() => () => texture.dispose(), [texture]);
  return <group position={[-1.25, 0, -1.5]}>
    <mesh position={[0, .55, 0]} castShadow><boxGeometry args={[.09, 1.1, .09]} /><meshStandardMaterial color="#71583d" /></mesh>
    <sprite position={[0, 1.15, 0]} scale={[.95, .475, 1]}><spriteMaterial map={texture} depthWrite={false} /></sprite>
  </group>;
}

function TownPaving({ color }: { color: string }) {
  const ref = useRef<InstancedMesh>(null);
  const tiles = useMemo(() => {
    const result: Array<[number, number]> = [];
    for (let x = -7; x <= 7; x++) for (let z = -7; z <= 7; z++) if (Math.hypot(x, z) <= 7.1) result.push([x, z]);
    return result;
  }, []);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const matrix = new Matrix4(), base = new Color(color), cream = new Color('#e7dfc9');
    tiles.forEach(([x, z], index) => {
      ref.current!.setMatrixAt(index, matrix.makeTranslation(x * 1.12, -.015, z * 1.12));
      ref.current!.setColorAt(index, cream.clone().lerp(base, (x + z) % 2 === 0 ? .34 : .12));
    });
    ref.current.instanceMatrix.needsUpdate = true;
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
  }, [color, tiles]);
  return <instancedMesh ref={ref} args={[undefined, undefined, tiles.length]} receiveShadow name="town-paving">
    <boxGeometry args={[1.08, .045, 1.08]} /><meshStandardMaterial roughness={.94} />
  </instancedMesh>;
}

function TownBuilding({ townId, townColor, index }: { townId: string; townColor: string; index: number }) {
  const pallet = townId === 'pallet';
  const role = pallet ? (index === 0 ? 'RED' : index === 1 ? 'BLUE' : 'LAB') : (index === 0 ? 'P' : index === 1 ? 'M' : 'G');
  const accent = pallet ? (index === 0 ? '#c94b3d' : index === 1 ? '#3f79ad' : '#437c62') : (index === 0 ? '#cf493e' : index === 1 ? '#397bb0' : townColor);
  const url = pallet
    ? (index === 2 ? '/models/kanto-buildings/town-house-large.glb?v=b40ea2fd5a6b' : '/models/kanto-buildings/town-house.glb?v=b4742c7bb903')
    : (index === 0 ? '/models/kanto-buildings/town-clinic.glb?v=3b049c935182'
      : index === 1 ? '/models/kanto-buildings/town-mart.glb?v=91d33bcbe904'
        : '/models/kanto-buildings/town-gym.glb?v=2ca345798350');
  const gltf = useCachedModel(url);
  const model = useMemo(() => {
    if (!gltf) return null;
    const clone = cloneSkinned(gltf.scene);
    clone.traverse(object => { if (object instanceof Mesh) { object.castShadow = true; object.receiveShadow = true; } });
    return clone;
  }, [gltf]);
  return <group>
    {model
      ? <primitive object={model} dispose={null} />
      : <mesh position={[0, 1.05, 0]} castShadow><boxGeometry args={[3.1, 2.1, 2.5]} /><meshStandardMaterial color="#e8dfc7" roughness={.9} /></mesh>}
    <BuildingSign text={role} color={accent} />
  </group>;
}

function WorldLabel({ name, x, y, z }: { name: string; x: number; y: number; z: number }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'rgba(20, 48, 41, .9)'; context.beginPath(); context.roundRect(5, 5, 502, 118, 24); context.fill();
    context.strokeStyle = '#ead77c'; context.lineWidth = 5; context.stroke();
    context.fillStyle = '#fff6d5'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.font = '800 42px system-ui, sans-serif'; context.fillText(name, 256, 65);
    const result = new CanvasTexture(canvas); result.colorSpace = SRGBColorSpace; return result;
  }, [name]);
  useEffect(() => () => texture.dispose(), [texture]);
  return <sprite position={[x, y, z]} scale={[3, .75, 1]}><spriteMaterial map={texture} transparent depthWrite={false} /></sprite>;
}

function RegionalLandmark({ region, x, y, z }: { region: string; x: number; y: number; z: number }) {
  const mountain = ['hoenn', 'sinnoh', 'hisui'].includes(region);
  return <group name={`regional-landmark:${region}`} position={[x, y, z]}>
    {mountain ? <>
      <mesh position={[0, 3.5, 0]} castShadow><coneGeometry args={[7, 8, 7]} /><meshStandardMaterial color={region === 'hoenn' ? '#73584e' : '#7d8b87'} flatShading /></mesh>
      <mesh position={[0, 6.5, 0]}><coneGeometry args={[2, 2.4, 7]} /><meshStandardMaterial color={region === 'hoenn' ? '#e59045' : '#ebf0e8'} flatShading /></mesh>
    </> : region === 'johto' ? <>
      <mesh position={[0, 2.6, 0]} castShadow><boxGeometry args={[3, 5.2, 3]} /><meshStandardMaterial color="#c49765" /></mesh>
      {[0, 1, 2].map(i => <mesh key={i} position={[0, 2 + i * 1.5, 0]} rotation={[0, Math.PI / 4, 0]} castShadow><coneGeometry args={[4 - i * .65, 1.5, 4]} /><meshStandardMaterial color="#755b43" /></mesh>)}
    </> : region === 'alola' ? <>
      {[-2, 2].map(offset => <group key={offset} position={[offset, 0, 0]}><mesh position={[0, 2.5, 0]} castShadow><cylinderGeometry args={[.25, .45, 5, 6]} /><meshStandardMaterial color="#a9834a" /></mesh><mesh position={[0, 5, 0]} scale={[2.3, .45, 2.3]} castShadow><icosahedronGeometry args={[1.3, 0]} /><meshStandardMaterial color="#5d9661" /></mesh></group>)}
    </> : <>
      <mesh position={[0, 3, 0]} castShadow><cylinderGeometry args={[1.1, 2.2, 6, region === 'kalos' ? 4 : 8]} /><meshStandardMaterial color={region === 'galar' ? '#a35d5d' : '#bdb69c'} /></mesh>
      <mesh position={[0, 6.1, 0]}><octahedronGeometry args={[1.6]} /><meshStandardMaterial color={region === 'paldea' ? '#8e78bd' : '#d3b66c'} /></mesh>
    </>}
  </group>;
}

function TrailAndWater({ sampleWorld, player, badges, atlas, visible }: { sampleWorld: (x: number, z: number) => WorldSample; player: { x: number; z: number }; badges: number; atlas: WorldAtlas; visible: VisibilityTest }) {
  const locations = useMemo(() => new Map(atlas.locations.map(item => [item.id, item])), [atlas]);
  const trail = useMemo(() => {
    const vertices: number[] = [];
    const indices: number[] = [];
    for (const [fromId, toId] of atlas.surfaceConnections) {
      const from = locations.get(fromId)!, to = locations.get(toId)!;
      const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz) || 1;
      const steps = Math.max(1, Math.ceil(length / 5));
      const sideX = -dz / length * 2.05, sideZ = dx / length * 2.05;
      const offset = vertices.length / 3;
      for (let step = 0; step <= steps; step += 1) {
        const t = step / steps, x = from.x + dx * t, z = from.z + dz * t;
        for (const direction of [-1, 1]) {
          const px = x + sideX * direction, pz = z + sideZ * direction;
          vertices.push(px, terrainSurfaceHeight(sampleWorld, px, pz) + .055, pz);
        }
        if (step < steps) {
          const base = offset + step * 2;
          indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
        }
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }, [locations, sampleWorld, atlas]);
  useEffect(() => () => trail.dispose(), [trail]);
  const townColors: Record<string, string> = {
    pallet: '#e8dfc5', viridian: '#4d9b61', pewter: '#83858a', cerulean: '#4e94c8', vermilion: '#c5934d',
    lavender: '#9b77b4', celadon: '#74a86a', saffron: '#d6b54c', fuchsia: '#d87498', cinnabar: '#b84d45',
  };
  return (
    <group name={`region-landmarks:${atlas.id}`} userData={{ gaesupWorldObject: 'region-landmarks' }}>
      <mesh geometry={trail} receiveShadow><SurfaceMaterial surface="path" color="#b89a68" /></mesh>
      {atlas.id === 'kanto' && <><mesh position={[-34, -.66, 101]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
        <planeGeometry args={[91, 33]} /><WaterMaterial />
      </mesh>
      <mesh position={[61, -.66, -25]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
        <circleGeometry args={[12, 48]} /><WaterMaterial lake />
      </mesh></>}
      {atlas.id !== 'kanto' && atlas.locations.filter(item => item.kind === 'sea' && Math.hypot(item.x - player.x, item.z - player.z) < 90).map(item => <mesh key={item.id} position={[item.x, sampleWorld(item.x, item.z).height + .025, item.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}><circleGeometry args={[12, 32]} /><WaterMaterial lake /></mesh>)}
      {atlas.id !== 'kanto' && atlas.locations.filter(item => item.kind === 'special' && Math.hypot(item.x - player.x, item.z - player.z) < 70 && visible(item.x, 5, item.z, 10)).map(item => <RegionalLandmark key={item.id} region={atlas.id} x={item.x} y={terrainSurfaceHeight(sampleWorld, item.x, item.z)} z={item.z} />)}
      {atlas.locations.filter(item => item.kind === 'town' && Math.hypot(item.x - player.x, item.z - player.z) <= 85 && visible(item.x, 3, item.z, 14)).map(town => <group key={town.id} name={`town:${town.id}`} position={[town.x, terrainSurfaceHeight(sampleWorld, town.x, town.z) + .05, town.z]}>
        <TownPaving color={townColors[town.id] ?? atlas.palette.town} />
        {atlas.buildingOffsets(town).map(([x, z], index) => <group key={index} position={[x, 0, z]}>
          <TownBuilding townId={town.id} townColor={townColors[town.id] ?? atlas.palette.town} index={index} />
        </group>)}
        <group position={[0, 0, -6]}>
          <mesh position={[0, .9, 0]} castShadow><boxGeometry args={[2.4, 1.15, .24]} /><meshStandardMaterial color="#eadb9d" /></mesh>
          <mesh position={[-.82, .35, 0]}><boxGeometry args={[.16, 1.1, .16]} /><meshStandardMaterial color="#6b4b2c" /></mesh>
          <mesh position={[.82, .35, 0]}><boxGeometry args={[.16, 1.1, .16]} /><meshStandardMaterial color="#6b4b2c" /></mesh>
        </group>
      </group>)}
      {atlas.locations.filter(item => item.kind === 'cave' && Math.hypot(item.x - player.x, item.z - player.z) <= 80 && visible(item.x, 3, item.z, 8)).map(cave => <group key={cave.id} position={[cave.x, terrainSurfaceHeight(sampleWorld, cave.x, cave.z), cave.z]}>
        <mesh position={[0, 1.3, 0]} castShadow><dodecahedronGeometry args={[2.8, 0]} /><meshStandardMaterial color="#5f615f" roughness={1} /></mesh>
        <mesh position={[0, .8, -2.15]}><circleGeometry args={[1.05, 24]} /><meshBasicMaterial color="#171b1c" /></mesh>
      </group>)}
      {atlas.gates.filter(gate => gate.visible !== false).map(gate => {
        const from = locations.get(gate.from)!, to = locations.get(gate.to)!;
        const x = (from.x + to.x) / 2, z = (from.z + to.z) / 2;
        const rotationY = Math.atan2(to.x - from.x, to.z - from.z);
        const y = terrainSurfaceHeight(sampleWorld, x, z);
        const locked = badges < gate.requiredBadges;
        const halfWidth = atlas.gateHalfWidth(gate);
        return <group key={gate.id} position={[x, y, z]} rotation={[0, rotationY, 0]}>
          {[-halfWidth, halfWidth].map(side => <RigidBody key={side} type="fixed" colliders="cuboid" position={[side, 0, 0]}>
            <mesh position={[0, 1.35, 0]} castShadow><boxGeometry args={[.55, 2.7, .55]} /><meshStandardMaterial color="#5f513f" roughness={.92} /></mesh>
          </RigidBody>)}
          <mesh position={[0, 2.62, 0]} castShadow><boxGeometry args={[halfWidth * 2 + .55, .42, .48]} /><meshStandardMaterial color="#755e3d" roughness={.9} /></mesh>
          {locked && <RigidBody type="fixed" colliders="cuboid">
            <mesh position={[0, .72, 0]} castShadow><boxGeometry args={[halfWidth * 2, 1.12, .38]} /><meshStandardMaterial color="#9d4438" roughness={.9} /></mesh>
          </RigidBody>}
          {Math.hypot(x - player.x, z - player.z) <= 14 && <WorldLabel name={locked ? `${gate.requiredBadges}배지 필요` : '관문 통과 가능'} x={0} y={3.35} z={0} />}
        </group>;
      })}
      {atlas.locations.filter(item => (item.kind === 'town' || item.kind === 'cave') && Math.hypot(item.x - player.x, item.z - player.z) <= 12)
        .map(item => <WorldLabel key={`label:${item.id}`} name={item.name} x={item.x} y={terrainSurfaceHeight(sampleWorld, item.x, item.z) + (item.kind === 'town' ? 1.85 : 3.2)} z={item.kind === 'town' ? item.z - 6 : item.z} />)}
      <mesh position={[atlas.start.x, .12, atlas.start.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.3, 1.85, 32]} /><meshBasicMaterial color="#f4d44d" />
      </mesh>
    </group>
  );
}

function StaticModel({ item }: { item: OpenWorldProp }) {
  const gltf = useCachedModel(item.url);
  const object = useMemo(() => gltf ? cloneSkinned(gltf.scene) : null, [gltf]);
  if (!object) return null;
  const visual = <primitive object={object} castShadow receiveShadow />;
  const transform = {
    position: [item.x, item.y ?? 0, item.z] as [number, number, number],
    rotation: [0, item.rotationY ?? 0, 0] as [number, number, number],
    scale: item.scale ?? 1,
  };
  if (item.collider === 'none') return <group {...transform}>{visual}</group>;
  return <RigidBody type="fixed" colliders={item.collider ?? 'trimesh'} {...transform}>{visual}</RigidBody>;
}

function PokemonModel({ creature, url }: { creature: WorldCreature; url: string }) {
  const { gltf, failed } = useModelStatus(url);
  const root = useRef<Group>(null);
  const mixer = useRef<AnimationMixer | null>(null);
  const activeAction = useRef<AnimationAction | undefined>(undefined);
  const ground = useRef<((groundY: number) => number) | undefined>(undefined);
  const worldPosition = useRef(new Vector3());
  const normalized = useMemo(() => {
    if (!gltf) return null;
    const scene = cloneSkinned(gltf.scene);
    scene.traverse(object => {
      if (object instanceof Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
    return normalizePokemonModel(scene, gltf.animations, creature.displayHeight ?? 1.2);
  }, [creature.displayHeight, gltf]);
  useFrame(({ clock }, delta) => {
    mixer.current?.update(Math.min(delta, .05) * (creature.action === 'walk' ? MathUtils.clamp((creature.movementSpeed ?? 2.4) / 2.4, .65, 1.8) : 1));
    if (!root.current) return;
    const gait = MathUtils.clamp(creature.movementSpeed ?? 2.4, 1.2, 5.2);
    const phase = clock.elapsedTime * (creature.action === 'walk' ? gait * 2.7 : 2.4) + creature.speciesId;
    root.current.position.y = 0;
    const pulse = creature.action === 'attack' ? 1 + Math.max(0, Math.sin(phase * 1.8)) * .12 : 1;
    root.current.scale.set(pulse, creature.action === 'hurt' ? .88 : 1, pulse);
    root.current.rotation.z = creature.action === 'fainted' ? Math.PI / 2 : !gltf?.animations.length && creature.action === 'walk' ? Math.sin(phase) * .045 : 0;
    if (!ground.current && normalized) ground.current = createGrounding(normalized.visual, root.current);
    root.current.parent?.getWorldPosition(worldPosition.current);
    ground.current?.(worldPosition.current.y);
    if (!gltf?.animations.length && creature.action === 'walk') root.current.position.y += Math.abs(Math.sin(phase)) * .07;
  }, -1);
  useEffect(() => { ground.current = undefined; }, [normalized]);

  useEffect(() => {
    if (!normalized || !gltf?.animations.length) return;
    const nextMixer = new AnimationMixer(normalized.animatedRoot);
    mixer.current = nextMixer;
    return () => {
      mixer.current = null;
      activeAction.current = undefined;
      nextMixer.stopAllAction();
      nextMixer.uncacheRoot(normalized.animatedRoot);
    };
  }, [gltf, normalized]);

  useEffect(() => {
    if (!mixer.current || !gltf?.animations.length) return;
    const { clip, matched } = selectPokemonMotionClip(gltf.animations,
      creature.action === 'attack' ? 'attack' : creature.action === 'walk' ? 'walk' : 'idle');
    if (!clip) return;
    const next = mixer.current.clipAction(clip), previous = activeAction.current;
    if (next === previous && next.isRunning()) return;
    next.reset().setEffectiveWeight(1).setEffectiveTimeScale(1);
    const playOnce = creature.action === 'attack' && matched;
    next.setLoop(playOnce ? LoopOnce : LoopRepeat, playOnce ? 1 : Infinity);
    next.clampWhenFinished = playOnce;
    next.play();
    if (previous && previous !== next) next.crossFadeFrom(previous, .2, false);
    activeAction.current = next;
  }, [creature.action, gltf, normalized]);

  if (!normalized) return <ModelStatus name={failed ? '3D 불러오기 실패' : '3D 불러오는 중'} />;
  return <group ref={root} name={`pokemon-model:${creature.speciesId}`}><primitive object={normalized.visual} /></group>;
}

function ModelStatus({ name }: { name: string }) {
  return <group name={`pokemon-model-status:${name}`}>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .04, 0]}><ringGeometry args={[.45, .6, 24]} /><meshBasicMaterial color="#d2d9d1" transparent opacity={.65} /></mesh>
    <WorldLabel name={name} x={0} y={.65} z={0} />
  </group>;
}

const MOVE_COLORS: Record<string, [string, string]> = {
  fire: ['#ff7b36', '#b92716'], water: ['#54c7ff', '#176fb5'], electric: ['#ffe74d', '#ca8b00'],
  grass: ['#7cda58', '#267b35'], ice: ['#b8f2ff', '#4a9fbd'], psychic: ['#ff67bd', '#9b2e8f'],
  ghost: ['#9e83e8', '#49377f'], dark: ['#756580', '#292130'], dragon: ['#7c75ff', '#382dba'],
  poison: ['#c96be2', '#6f2785'], fighting: ['#e46c4f', '#873424'], ground: ['#d9ad63', '#77542c'],
  rock: ['#bdad6f', '#65572b'], bug: ['#a9ca48', '#50691c'], flying: ['#92bdf0', '#49689e'],
  steel: ['#b8c4ce', '#66717d'], fairy: ['#ffa7d9', '#ad4f82'], normal: ['#eadfc9', '#827463'],
};

function AttackEffect({ active, moveType }: { active: boolean; moveType?: string }) {
  const ref = useRef<Mesh>(null);
  const colors = MOVE_COLORS[moveType?.toLowerCase() ?? 'normal'] ?? MOVE_COLORS.normal;
  useFrame(({ clock }) => {
    if (!ref.current || !active) return;
    const phase = (clock.elapsedTime * 3.5) % 1;
    ref.current.scale.setScalar(.8 + phase * 2.2);
    const material = ref.current.material as MeshStandardMaterial;
    material.opacity = 1 - phase;
  });
  if (!active) return null;
  return <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} position={[0, .08, 0]}><ringGeometry args={[.72, .98, 32]} /><meshStandardMaterial color={colors[0]} transparent opacity={1} emissive={colors[1]} emissiveIntensity={1.1} /></mesh>;
}

function CreatureBillboard({ creature, hp, distance, emphasized }: { creature: WorldCreature; hp: number; distance: number; emphasized: boolean }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'rgba(19, 56, 47, .92)';
    context.beginPath();
    context.roundRect(4, 4, 504, 120, 24);
    context.fill();
    context.strokeStyle = 'rgba(244, 226, 151, .75)';
    context.lineWidth = 4;
    context.stroke();
    context.fillStyle = '#fff5d6';
    context.textAlign = 'center';
    context.font = '700 30px system-ui, sans-serif';
    context.fillText(creature.remotePlayer ? creature.remotePlayer.name : `${creature.name} · Lv.${creature.level}`, 256, 45);
    context.font = '700 22px system-ui, sans-serif';
    context.fillText(creature.remotePlayer ? `같은 지역 플레이어 · ${creature.remotePlayer.activity === 'battle' ? '배틀 중' : creature.remotePlayer.activity === 'moving' ? '이동 중' : '대기'}` : `${Math.max(0, Math.ceil(creature.hp))} / ${creature.maxHp} HP`, 256, 76);
    if (creature.remotePlayer) {
      const result = new CanvasTexture(canvas); result.colorSpace = SRGBColorSpace; return result;
    }
    context.fillStyle = '#102b25';
    context.beginPath();
    context.roundRect(44, 91, 424, 17, 8);
    context.fill();
    context.fillStyle = hp > .45 ? '#82d179' : hp > .2 ? '#e5ca55' : '#e56f59';
    context.beginPath();
    context.roundRect(44, 91, Math.max(8, 424 * hp), 17, 8);
    context.fill();
    const result = new CanvasTexture(canvas);
    result.colorSpace = SRGBColorSpace;
    return result;
  }, [creature.hp, creature.level, creature.maxHp, creature.name, creature.remotePlayer?.activity, hp]);
  useEffect(() => () => texture.dispose(), [texture]);
  if (distance > 34 && !emphasized) return null;
  const width = emphasized ? 2.4 : 2.0;
  return <sprite name="creature-nameplate" position={[0, (creature.displayHeight ?? 1.2) + .5, 0]} scale={[width, width * .25, 1]}><spriteMaterial map={texture} transparent depthTest depthWrite={false} /></sprite>;
}

function Creature({ creature, selected, distance, options, showLabels, model }: {
  creature: WorldCreature;
  selected: boolean;
  showLabels: boolean;
  model: boolean;
  distance: number;
  options: OpenWorldViewOptions;
}) {
  const sample = options.sampleWorld ?? fallbackSample;
  const y = terrainSurfaceHeight(sample, creature.x, creature.z);
  const hp = MathUtils.clamp(creature.maxHp > 0 ? creature.hp / creature.maxHp : 0, 0, 1);
  const root = useRef<Group>(null);
  const target = useRef(new Vector3(creature.x, y, creature.z));
  const visual = useRef(new Vector3(creature.x, y, creature.z));
  const desiredYaw = useRef(initialYaw(creature.heading));
  useLayoutEffect(() => {
    if (!root.current) return;
    root.current.position.copy(visual.current);
    root.current.rotation.y = desiredYaw.current;
  }, [creature.id]);
  useLayoutEffect(() => {
    const dx = creature.x - target.current.x, dz = creature.z - target.current.z;
    // Offscreen population relocation is a new placement, not a very fast walk across the world.
    if (Math.hypot(dx, dz) > 24) visual.current.set(creature.x, y, creature.z);
    else desiredYaw.current = movementYaw(dx, dz, desiredYaw.current);
    target.current.set(creature.x, y, creature.z);
  }, [creature.x, creature.z, y]);
  useFrame((_, delta) => {
    if (!root.current) return;
    const remaining = visual.current.distanceTo(target.current);
    const speed = MathUtils.clamp(creature.movementSpeed ?? 2.4, .5, 12);
    const step = Math.max(speed * Math.min(delta, .05) * 1.2, remaining * Math.min(1, delta * 4));
    if (remaining > 0) visual.current.lerp(target.current, Math.min(1, step / remaining));
    visual.current.y = terrainSurfaceHeight(sample, visual.current.x, visual.current.z);
    root.current.position.copy(visual.current);
    const lookAt = creature.lookAt;
    if (lookAt) desiredYaw.current = movementYaw(lookAt.x - visual.current.x, lookAt.z - visual.current.z, desiredYaw.current);
    root.current.rotation.y = turnTowards(root.current.rotation.y, desiredYaw.current, delta);
  }, -2);
  return (
    <group
      ref={root}
      name={`creature:${creature.id}`}
      onClick={event => { event.stopPropagation(); if (!creature.remotePlayer) options.onSelect(creature.id); }}
      onDoubleClick={event => { event.stopPropagation(); if (!creature.remotePlayer) options.onInteract?.(creature.id); }}
    >
      {model && hasPokemonModel(creature.speciesId)
        ? <PokemonModel creature={creature} url={(options.modelUrl ?? (id => `/models/pokemon/${id}.glb`))(creature.speciesId)} />
        : <ModelStatus name="3D 미지원 · 저장 기록 유지" />}
      {(selected || creature.inBattle) && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .04, 0]}><ringGeometry args={[1.1, 1.34, 40]} /><meshBasicMaterial color={creature.inBattle ? '#f09155' : '#f6dd67'} transparent opacity={.86} /></mesh>}
      <AttackEffect active={creature.action === 'attack'} moveType={creature.moveType} />
      {(showLabels || creature.remotePlayer) && (distance <= 28 || selected || creature.inBattle) && <CreatureBillboard creature={creature} hp={hp} distance={distance} emphasized={selected || !!creature.inBattle || !!creature.remotePlayer} />}
    </group>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return !['checkbox', 'button', 'submit', 'reset'].includes(target.type);
  return target.isContentEditable || ['TEXTAREA', 'SELECT'].includes(target.tagName);
}

function PlayerCamera({ snapshot, options, command, destination, onDestination }: { snapshot: OpenWorldRenderSnapshot; options: OpenWorldViewOptions; command: CameraCommand; destination: WorldPoint | null; onDestination: (point: WorldPoint | null) => void }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const keys = useRef(new Set<string>());
  const position = useRef(new Vector3(snapshot.player.x, terrainSurfaceHeight(options.sampleWorld ?? fallbackSample, snapshot.player.x, snapshot.player.z), snapshot.player.z));
  const external = useRef(position.current.clone());
  const forward = useRef(new Vector3());
  const right = useRef(new Vector3());
  const movement = useRef(new Vector3());
  const cameraTarget = useRef(new Vector3());
  const orbitOffset = useRef(new Vector3());
  const spherical = useRef(new Spherical());
  const listenersReady = useRef(false);
  const path = useRef<WorldPoint[]>([]);
  const announcedReady = useRef(false);
  const { camera } = useThree();
  const sample = options.sampleWorld ?? fallbackSample;

  useEffect(() => {
    path.current = destination ? findWorldPath(position.current, destination, sample) : [];
    if (destination && !path.current.length) onDestination(null);
    else if (destination) {
      const resolved = path.current[path.current.length - 1];
      if (Math.hypot(resolved.x - destination.x, resolved.z - destination.z) > .01) onDestination(resolved);
    }
  }, [destination, onDestination, sample]);

  useEffect(() => {
    external.current.set(snapshot.player.x, terrainSurfaceHeight(sample, snapshot.player.x, snapshot.player.z), snapshot.player.z);
    if (position.current.distanceTo(external.current) > 3 || !keys.current.size) {
      const dx = external.current.x - position.current.x;
      const dy = external.current.y - position.current.y;
      const dz = external.current.z - position.current.z;
      position.current.copy(external.current);
      camera.position.x += dx;
      camera.position.y += dy;
      camera.position.z += dz;
    }
  }, [camera, sample, snapshot.player.heading, snapshot.player.x, snapshot.player.y, snapshot.player.z]);
  useEffect(() => {
    const initialTarget = cameraTarget.current.set(position.current.x, position.current.y + 1.2, position.current.z);
    controls.current?.target.copy(initialTarget);
    camera.position.copy(initialTarget).add(DEFAULT_CAMERA_OFFSET);
    controls.current?.update();
  }, [camera]);
  useEffect(() => {
    const control = controls.current;
    if (!control || command.id === 0) return;
    if (command.action === 'reset') {
      control.target.set(position.current.x, position.current.y + 1.2, position.current.z);
      camera.position.copy(control.target).add(DEFAULT_CAMERA_OFFSET);
      control.update();
      return;
    }
    orbitOffset.current.copy(camera.position).sub(control.target);
    spherical.current.setFromVector3(orbitOffset.current);
    const next = applyCameraAction(spherical.current, command.action);
    spherical.current.set(next.radius, next.phi, next.theta);
    orbitOffset.current.setFromSpherical(spherical.current);
    camera.position.copy(control.target).add(orbitOffset.current);
    control.update();
  }, [camera, command]);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'].includes(event.code)) {
        event.preventDefault();
        path.current = [];
        onDestination(null);
        keys.current.add(event.code);
      }
    };
    const up = (event: KeyboardEvent) => keys.current.delete(event.code);
    const clear = () => keys.current.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);
    listenersReady.current = true;
    return () => {
      listenersReady.current = false;
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', clear);
    };
  }, [onDestination]);

  useFrame((_, delta) => {
    if (listenersReady.current && !announcedReady.current) {
      announcedReady.current = true;
      options.onReady?.();
    }
    const pressed = keys.current;
    let forwardAxis = Number(pressed.has('KeyW') || pressed.has('ArrowUp')) - Number(pressed.has('KeyS') || pressed.has('ArrowDown'));
    let sideAxis = Number(pressed.has('KeyD') || pressed.has('ArrowRight')) - Number(pressed.has('KeyA') || pressed.has('ArrowLeft'));
    const target = position.current;
    if (!forwardAxis && !sideAxis && path.current.length) {
      const waypoint = path.current[0];
      const dx = waypoint.x - target.x, dz = waypoint.z - target.z, remaining = Math.hypot(dx, dz);
      if (remaining <= .12) {
        path.current.shift();
        if (!path.current.length) onDestination(null);
      } else {
        forwardAxis = dz / remaining;
        sideAxis = dx / remaining;
        movement.current.set(dx / remaining, 0, dz / remaining);
      }
    }
    if ((forwardAxis || sideAxis) && options.onMovementInput?.() !== false) {
      if (!path.current.length) {
        camera.getWorldDirection(forward.current);
        forward.current.y = 0;
        forward.current.normalize();
        right.current.set(-forward.current.z, 0, forward.current.x);
        movement.current.copy(forward.current).multiplyScalar(forwardAxis).addScaledVector(right.current, sideAxis).normalize();
      }
      movement.current.multiplyScalar(Math.min(delta, .05) * (snapshot.entities.find(entity => entity.id.startsWith('companion:'))?.movementSpeed ?? 2.2));
      const x = MathUtils.clamp(target.x + movement.current.x, WORLD_MIN, WORLD_MAX);
      const z = MathUtils.clamp(target.z + movement.current.z, WORLD_MIN, WORLD_MAX);
      const terrain = sample(x, z);
      if (!terrain.blocked) {
        const nextHeading = Math.abs(movement.current.x) > Math.abs(movement.current.z)
          ? (movement.current.x > 0 ? 1 : 3)
          : headingForStep(movement.current.x, movement.current.z);
        const accepted = options.onPlayerMove({ x, z, heading: nextHeading });
        if (accepted !== false) {
          camera.position.x += x - target.x;
          const groundY = terrainSurfaceHeight(sample, x, z);
          camera.position.y += groundY - target.y;
          camera.position.z += z - target.z;
          target.set(x, groundY, z);
          external.current.copy(target);
        } else if (path.current.length) {
          path.current = [];
          onDestination(null);
        }
      } else if (path.current.length) {
        path.current = [];
        onDestination(null);
      }
    }
    if (controls.current) {
      cameraTarget.current.set(target.x, target.y + 1.2, target.z);
      controls.current.target.lerp(cameraTarget.current, 1 - Math.exp(-delta * 12));
      controls.current.update();
      const cameraFloor = terrainSurfaceHeight(sample, camera.position.x, camera.position.z) + 2;
      if (camera.position.y < cameraFloor) { camera.position.y = cameraFloor; camera.lookAt(controls.current.target); }
    }
  });

  return <OrbitControls ref={controls} makeDefault enablePan={false} enableDamping dampingFactor={.08} mouseButtons={{ LEFT: undefined as unknown as MOUSE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE }} minDistance={MIN_CAMERA_DISTANCE} maxDistance={MAX_CAMERA_DISTANCE} minPolarAngle={.38} maxPolarAngle={1.18} />;
}

function Sunlight({ player }: { player: { x: number; z: number } }) {
  const sun = useRef<DirectionalLight>(null);
  const target = useMemo(() => new Object3D(), []);
  const x = Math.round(player.x / 4) * 4, z = Math.round(player.z / 4) * 4;
  useLayoutEffect(() => { target.position.set(x, 0, z); target.updateMatrixWorld(); }, [x, z, target]);
  return <><primitive object={target} /><directionalLight ref={sun} target={target} position={[x + 28, 52, z + 22]} intensity={2.6} color="#fff0d5" castShadow
    shadow-mapSize={[1024, 1024]} shadow-camera-near={1} shadow-camera-far={150}
    shadow-camera-left={-44} shadow-camera-right={44} shadow-camera-top={44} shadow-camera-bottom={-44}
    shadow-normalBias={.10} shadow-bias={-.0004} /></>;
}

function FoodInstances({ foods, sampleWorld }: { foods: OpenWorldRenderSnapshot['foods']; sampleWorld: (x: number, z: number) => WorldSample }) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const transform = new Matrix4();
    foods?.forEach((food, i) => ref.current!.setMatrixAt(i, transform.makeTranslation(food.x, (food.y ?? sampleWorld(food.x, food.z).height) + .25, food.z)));
    ref.current.instanceMatrix.needsUpdate = true;
    ref.current.computeBoundingSphere();
  }, [foods, sampleWorld]);
  if (!foods?.length) return null;
  return <instancedMesh ref={ref} args={[undefined, undefined, foods.length]}><icosahedronGeometry args={[.24, 1]} /><meshStandardMaterial color="#efca58" emissive="#785e16" emissiveIntensity={.35} /></instancedMesh>;
}

function useViewWindow() {
  const { camera, size } = useThree();
  const [windowState, setWindowState] = useState<{ frustum: Frustum | null; mobile: boolean }>({ frustum: null, mobile: size.width <= 720 });
  const elapsed = useRef(1), previous = useRef('');
  useFrame((_, delta) => {
    elapsed.current += delta;
    if (elapsed.current < .16) return;
    elapsed.current = 0;
    const key = [...camera.position.toArray(), ...camera.quaternion.toArray()].map(n => n.toFixed(2)).join(':') + `:${size.width}:${size.height}`;
    if (previous.current === key) return; previous.current = key;
    camera.updateMatrixWorld();
    setWindowState({ frustum: new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)), mobile: size.width <= 720 });
  });
  const visible = useMemo<VisibilityTest>(() => {
    const sphere = new Sphere();
    return (x, y, z, radius) => { if (!windowState.frustum) return false; sphere.center.set(x, y, z); sphere.radius = radius; return windowState.frustum.intersectsSphere(sphere); };
  }, [windowState.frustum]);
  return { ...windowState, visible };
}

function Scene({ snapshot, options, cameraCommand, showLabels, destination, onNavigate, onDestination }: { snapshot: OpenWorldRenderSnapshot; options: OpenWorldViewOptions; cameraCommand: CameraCommand; showLabels: boolean; destination: WorldPoint | null; onNavigate: (point: WorldPoint) => void; onDestination: (point: WorldPoint | null) => void }) {
  const atlas = getWorldAtlas(snapshot.regionId ?? 'kanto');
  const sample = atlas.sample;
  const worldOptions = useMemo(() => ({ ...options, sampleWorld: sample }), [options, sample]);
  const windowState = useViewWindow();
  const chunks = useMemo(() => terrainChunks(snapshot.player, windowState.visible), [snapshot.player.x, snapshot.player.z, windowState.visible]);
  const visible = useMemo(() => creatureLods(snapshot.entities, snapshot.player, windowState.visible, windowState.mobile, snapshot.selectedWildId), [snapshot, windowState]);
  const { scene } = useThree();
  useFrame(() => { scene.userData.streaming = { region: atlas.id, player: { x: snapshot.player.x, z: snapshot.player.z }, terrainChunks: chunks.length, terrainTotal: 36, highDetailChunks: chunks.filter(c => c.segments === 12).length,
    visibleCreatures: visible.length, detailedCreatures: visible.filter(v => v.model && hasPokemonModel(v.creature.speciesId)).length, cachedModels: modelCache.size, activeLoads, queuedLoads: loadQueue.length, modelLimit: windowState.mobile ? 4 : 8 }; });
  return (
    <>
      <color attach="background" args={['#afcfc1']} />
      <fog attach="fog" args={['#afcfc1', 48, 85]} />
      <hemisphereLight args={['#d9eeed', '#66703c', 1.1]} />
      <SkyLighting />
      <Sunlight player={snapshot.player} />
      <Physics gravity={[0, -18, 0]} timeStep="vary">
        <group key={`terrain:${atlas.id}`}>{chunks.map(chunk => <Terrain key={`${chunk.key}:${chunk.segments}`} sampleWorld={sample} atlas={atlas} chunk={chunk} onNavigate={onNavigate} />)}</group>
        <Nature key={`nature:${atlas.id}`} sampleWorld={sample} player={snapshot.player} atlas={atlas} isVisible={windowState.visible} />
        <TrailAndWater key={`water:${atlas.id}`} sampleWorld={sample} player={snapshot.player} atlas={atlas} visible={windowState.visible} badges={(snapshot as OpenWorldRenderSnapshot & { badges?: number }).badges ?? 0} />
        {options.terrainUrl && <StaticModel item={{
          id: 'openworld-terrain',
          url: options.terrainUrl,
          x: options.terrainTransform?.x ?? 0,
          y: options.terrainTransform?.y ?? sample(0, 0).height - .1,
          z: options.terrainTransform?.z ?? 0,
          rotationY: options.terrainTransform?.rotationY,
          scale: options.terrainTransform?.scale,
          collider: 'none',
        }} />}
        {options.props?.filter(item => Math.hypot(item.x - snapshot.player.x, item.z - snapshot.player.z) < 85 && windowState.visible(item.x, item.y ?? 0, item.z, 8)).map(item => <StaticModel key={item.id} item={item} />)}
        <FoodInstances foods={snapshot.foods} sampleWorld={sample} />
      </Physics>
      {visible.map(({ creature, distance, model }) => <Creature key={creature.id} creature={creature} selected={creature.id === snapshot.selectedWildId} showLabels={showLabels} distance={distance} model={model} options={worldOptions} />)}
      {destination && <group position={[destination.x, terrainSurfaceHeight(sample, destination.x, destination.z) + .08, destination.z]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[.42, .62, 28]} /><meshBasicMaterial color="#ffe27a" transparent opacity={.9} /></mesh>
        <mesh position={[0, .08, 0]} rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[.13, 20]} /><meshBasicMaterial color="#fff4b8" /></mesh>
      </group>}
      <PlayerCamera key={atlas.id} snapshot={snapshot} options={worldOptions} command={cameraCommand} destination={destination} onDestination={onDestination} />
    </>
  );
}

function SaveRenderBudget() {
  const setFrameloop = useThree(state => state.setFrameloop);
  useLayoutEffect(() => onRenderSuspension(suspended => setFrameloop(suspended ? 'never' : 'always')), [setFrameloop]);
  return null;
}

function OpenWorldApp({ store, options }: { store: SnapshotStore; options: OpenWorldViewOptions }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.get, store.get);
  const renderPaused = useSyncExternalStore(onRenderSuspension, renderingSuspended, renderingSuspended);
  const runtime = useMemo(() => createGaesupRuntime({ plugins: [createCameraPlugin()], pluginRuntime: 'client' }), []);
  const [ready, setReady] = useState(false);
  const [renderDpr, setRenderDpr] = useState(() => Math.min(window.devicePixelRatio || 1, 1.5));
  const [showLabels, setShowLabels] = useState(() => { try { return localStorage.getItem('choketmon-nameplates') === 'true'; } catch { return false; } });
  const toggleLabels = () => setShowLabels(previous => { try { localStorage.setItem('choketmon-nameplates', String(!previous)); } catch { /* Session-only preference when storage is unavailable. */ } return !previous; });
  const [cameraCommand, setCameraCommand] = useState<CameraCommand>({ id: 0, action: 'reset' });
  const [destination, setDestination] = useState<WorldPoint | null>(null);
  useEffect(() => { setDestination(null); }, [snapshot.regionId]);
  const navigate = useCallback((point: WorldPoint) => {
    if (options.onNavigationStart?.() === false) return;
    setDestination(point);
  }, [options]);
  const moveCamera = (action: CameraAction) => setCameraCommand(previous => ({ id: previous.id + 1, action }));
  useEffect(() => {
    let active = true;
    runtime.setup().then(() => { if (active) setReady(true); });
    return () => { active = false; void runtime.dispose(); };
  }, [runtime]);
  return (
    <GaesupWorld
      runtime={runtime}
      runtimeRevision={ready ? 1 : 0}
      mode={{ type: 'character', controller: 'keyboard', control: 'thirdPerson' }}
      cameraOption={{ type: 'thirdPerson', distance: 12, height: 5, fov: 48, enableZoom: true, minZoom: 4, maxZoom: 28, enableCollision: true, bounds: { minX: WORLD_MIN, maxX: WORLD_MAX, minZ: WORLD_MIN, maxZ: WORLD_MAX } }}
      worldSize={{ width: 240, height: 48, depth: 240 }}
      enablePhysics
      gravity={[0, -18, 0]}
    >
      <Canvas frameloop={renderPaused ? 'never' : 'always'} shadows dpr={renderDpr} camera={{ position: [12, 18, 16], fov: 48, near: .1, far: 160 }} gl={{ antialias: true, powerPreference: 'high-performance' }} onPointerMissed={() => options.onSelect(null)}>
        <AdaptiveResolution setDpr={setRenderDpr} />
        <SaveRenderBudget />
        {new URLSearchParams(location.search).has('renderProbe') && <RenderProbe />}
        <group name="gaesup-world">
          <Scene snapshot={snapshot} options={options} cameraCommand={cameraCommand} showLabels={showLabels} destination={destination} onNavigate={navigate} onDestination={setDestination} />
        </group>
      </Canvas>
      {!ready && <div className="ow-loading">Gaesup World 준비 중…</div>}
      <div className="ow-camera-controls" aria-label="카메라 시점 조절">
        <button type="button" onClick={() => moveCamera('left')} aria-label="카메라 왼쪽 회전">↶</button>
        <button type="button" onClick={() => moveCamera('right')} aria-label="카메라 오른쪽 회전">↷</button>
        <button type="button" onClick={() => moveCamera('up')} aria-label="카메라 위로 회전">↑</button>
        <button type="button" onClick={() => moveCamera('down')} aria-label="카메라 아래로 회전">↓</button>
        <button type="button" onClick={() => moveCamera('zoom-in')} aria-label="카메라 확대">＋</button>
        <button type="button" onClick={() => moveCamera('zoom-out')} aria-label="카메라 축소">－</button>
        <button type="button" className="ow-camera-reset" onClick={() => moveCamera('reset')}>시점 초기화</button>
        <button type="button" id="world-nameplates" className="ow-camera-reset" aria-label="포켓몬 이름·HP 표시" aria-pressed={showLabels} onClick={toggleLabels}>이름·HP</button>
      </div>
      <div className="ow-terrain-key"><i aria-hidden="true" />노란 선 · 통행 불가 지형 경계</div>
      <div className="ow-help">WASD / 방향키 이동 · 드래그 시점 · 휠 확대 · 포켓몬 선택</div>
    </GaesupWorld>
  );
}

export function mountOpenWorld(host: HTMLElement, options: OpenWorldViewOptions): OpenWorldView {
  const initial = options.getSnapshot();
  const store = new SnapshotStore(initial);
  const root: Root = createRoot(host);
  host.classList.add('choketmon-openworld');
  // Gaesup's plugin registry rejects concurrent duplicate setup. The view owns
  // one runtime lifecycle, so avoid React development StrictMode's effect replay.
  root.render(<OpenWorldApp store={store} options={options} />);
  const poll = window.setInterval(() => store.set(options.getSnapshot()), 100);
  return {
    update(snapshot = options.getSnapshot()) { store.set(snapshot); },
    destroy() {
      window.clearInterval(poll);
      root.unmount();
      host.classList.remove('choketmon-openworld');
    },
  };
}
