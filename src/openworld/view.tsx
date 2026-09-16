import { Canvas, unmountComponentAtNode, useFrame, useThree } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import { Physics, RigidBody } from '@react-three/rapier';
import { GaesupWorld, createCameraPlugin } from 'gaesup-world';
import { createGaesupRuntime } from 'gaesup-world/runtime';
import { type ReactNode, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  AnimationMixer,
  type AnimationAction,
  LoopOnce,
  LoopRepeat,
  BufferGeometry,
  Box3,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Frustum,
  Sphere,
  Group,
  InstancedMesh,
  Material,
  Matrix4,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SRGBColorSpace,
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
import { createTerrainSurface } from './terrain-surface';
import { getSpecies } from '../data/pokemon';
import './view.css';
import { RenderProbe } from './render-probe';
import { SkyLighting, SurfaceMaterial, regionTrailColor, useTerrainMaterials, normalizeStandardMaterial } from './materials';
import { AdaptiveResolution } from './adaptive-resolution';
import { MAX_CAMERA_DISTANCE, MIN_CAMERA_DISTANCE } from './camera-navigation';
import { findWorldPath, headingForStep } from './navigation';
import { onRenderSuspension, renderingSuspended } from '../three/render-budget';

import { WORLD_MIN, WORLD_MAX, WORLD_SCALE, surfaceSceneId } from './world-space';
import { getCaveScene } from './caves';
import { CaveInterior, GymEntranceStatus, ProgressGate, RegionalLeagueLandmark, ScenePortals, isRegionalLeagueLocation } from './scene-landmarks';
import { DestinationPointer } from './destination-pointer';
import { TargetRoute } from './target-route';
import { createOpenWorldRenderer } from './gpu-renderer';
const MODEL_CACHE_LIMIT = 16;
const NATURE_DETAIL_RADIUS = 68;
// Bound scenery streaming even though the view no longer uses fog.
const NATURE_VISIBLE_RADIUS = 94;
const loader = createGLTFLoader();
const DEFAULT_CAMERA_OFFSET = new Vector3(5.6, 7.6, 8.8);

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
    if (sameRenderSnapshot(snapshot, this.snapshot)) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function samePoints(left?: readonly WorldPoint[], right?: readonly WorldPoint[]): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((item, index) => item.x === right[index].x && item.y === right[index].y && item.z === right[index].z);
}

function sameGuide(left?: OpenWorldRenderSnapshot['guide'], right?: OpenWorldRenderSnapshot['guide']): boolean {
  return left === right || Boolean(left && right && left.title === right.title && left.detail === right.detail
    && left.destinationId === right.destinationId && left.destinationName === right.destinationName && left.nextName === right.nextName
    && left.recommendedLevel === right.recommendedLevel && left.status === right.status && samePoints(left.points, right.points));
}

function sameGyms(left?: OpenWorldRenderSnapshot['gyms'], right?: OpenWorldRenderSnapshot['gyms']): boolean {
  return left === right || Boolean(left && right && left.length === right.length && left.every((gym, index) => {
    const other = right[index];
    return gym.locationId === other.locationId && gym.badge === other.badge && gym.badgeName === other.badgeName
      && gym.name === other.name && gym.speciesId === other.speciesId && gym.level === other.level;
  }));
}

export function sameRenderSnapshot(left: OpenWorldRenderSnapshot, right: OpenWorldRenderSnapshot): boolean {
  if (left === right) return true;
  if (left.regionId !== right.regionId || left.sceneId !== right.sceneId || left.tick !== right.tick || left.selectedWildId !== right.selectedWildId
    || left.badges !== right.badges || !sameGuide(left.guide, right.guide) || !sameGyms(left.gyms, right.gyms)
    || left.player.x !== right.player.x || left.player.y !== right.player.y || left.player.z !== right.player.z || left.player.heading !== right.player.heading) return false;
  if (left.entities.length !== right.entities.length) return false;
  for (let index = 0; index < left.entities.length; index++) {
    const a = left.entities[index], b = right.entities[index];
    if (a.id !== b.id || a.name !== b.name || a.x !== b.x || a.y !== b.y || a.z !== b.z || a.heading !== b.heading || a.hp !== b.hp || a.maxHp !== b.maxHp
      || a.level !== b.level || a.speciesId !== b.speciesId || a.action !== b.action || a.moveType !== b.moveType || a.inBattle !== b.inBattle
      || a.displayHeight !== b.displayHeight || a.movementSpeed !== b.movementSpeed || a.lookAt?.x !== b.lookAt?.x || a.lookAt?.z !== b.lookAt?.z
      || a.remotePlayer?.name !== b.remotePlayer?.name || a.remotePlayer?.activity !== b.remotePlayer?.activity) return false;
  }
  const simple = <T extends WorldPoint & { id: string }>(a?: readonly T[], b?: readonly T[]) => {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    return a.every((item, index) => item.id === b[index].id && item.x === b[index].x && item.y === b[index].y && item.z === b[index].z);
  };
  return simple(left.foods, right.foods) && simple(left.trainers, right.trainers) && simple(left.portals, right.portals)
    && (left.foods ?? []).every((food, index) => food.kind === right.foods?.[index].kind)
    && (left.trainers ?? []).every((trainer, index) => trainer.name === right.trainers?.[index].name
      && trainer.trainerClass === right.trainers?.[index].trainerClass && trainer.locationId === right.trainers?.[index].locationId)
    && (left.portals ?? []).every((portal, index) => portal.label === right.portals?.[index].label && portal.targetSceneId === right.portals?.[index].targetSceneId);
}

function fallbackSample(x: number, z: number): WorldSample {
  const height = Math.sin(x * 0.045) * 1.15 + Math.cos(z * 0.038) * .85;
  return { height, biome: Math.abs(x) + Math.abs(z) > 175 ? 'rock' : 'meadow', blocked: false };
}

const Terrain = memo(function Terrain({ sampleWorld, chunk, atlas, material, waterMaterial, onNavigate }: { sampleWorld: (x: number, z: number) => WorldSample; chunk: TerrainChunk; atlas: WorldAtlas; material: Material; waterMaterial: Material; onNavigate?: (point: WorldPoint) => void }) {
  const { geometry, skirt } = useMemo(() => createTerrainSurface(chunk, sampleWorld, atlas),
    [chunk.x, chunk.z, chunk.segments, sampleWorld, atlas]);
  useEffect(() => () => { geometry.dispose(); skirt.dispose(); }, [geometry, skirt]);
  const surface = <mesh geometry={geometry} material={geometry.userData.waterVertices ? waterMaterial : material} dispose={null} receiveShadow name={`terrain-chunk:${chunk.key}:${chunk.segments}`} onClick={event => {
    event.stopPropagation(); if (event.button === 0 && event.delta <= 5) onNavigate?.({ x: event.point.x, z: event.point.z });
  }} />;
  return <group>
    {surface}
    <mesh geometry={skirt} material={material} dispose={null} />
  </group>;
}, (before, after) => before.chunk.key === after.chunk.key && before.chunk.segments === after.chunk.segments
  && before.sampleWorld === after.sampleWorld && before.atlas === after.atlas && before.material === after.material && before.waterMaterial === after.waterMaterial && before.onNavigate === after.onNavigate);

function InstancedPart({ geometry, material, sourceMatrix, placements, shadows }: {
  geometry: BufferGeometry;
  material: Material | Material[];
  sourceMatrix: Matrix4;
  placements: readonly SceneryPlacement[];
  shadows: boolean;
}) {
  const mesh = useRef<InstancedMesh>(null);
  // Reuse GPU buffers when visibility changes the active instance count.
  const capacity = useRef(64);
  capacity.current = Math.max(capacity.current, 2 ** Math.ceil(Math.log2(Math.max(1, placements.length))));
  useEffect(() => { const instance = mesh.current; return () => { instance?.dispose(); }; }, [capacity.current]);
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
  return <instancedMesh ref={mesh} args={[geometry, material, capacity.current]} count={placements.length} castShadow={shadows} receiveShadow dispose={null} />;
}

function InstancedAsset({ url, placements, shadows = false }: { url: string; placements: readonly SceneryPlacement[]; shadows?: boolean }) {
  const gltf = useCachedModel(url);
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
  const cellX = Math.round(player.x / 16) * 16, cellZ = Math.round(player.z / 16) * 16;
  // Keep distant props bounded without adding fog or animated shader effects.
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
        shadows={asset.id.startsWith('tree') || asset.id.startsWith('rock') || asset.id === 'cliff'}
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
      ref.current!.setMatrixAt(index, matrix.makeTranslation(x * 1.12 * WORLD_SCALE, -.015, z * 1.12 * WORLD_SCALE));
      ref.current!.setColorAt(index, cream.clone().lerp(base, (x + z) % 2 === 0 ? .34 : .12));
    });
    ref.current.instanceMatrix.needsUpdate = true;
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
  }, [color, tiles]);
  return <instancedMesh ref={ref} args={[undefined, undefined, tiles.length]} receiveShadow name="town-paving">
    <boxGeometry args={[1.125 * WORLD_SCALE, .045, 1.125 * WORLD_SCALE]} /><meshStandardMaterial roughness={.94} />
  </instancedMesh>;
}

function TownBuilding({ townId, townColor, index, gym, badges, showGymLabel }: { townId: string; townColor: string; index: number; gym?: WorldAtlas['gyms'][number]; badges: number; showGymLabel: boolean }) {
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
  return <group name={`town-building:${townId}:${index}:${model ? 'loaded' : 'fallback'}`}>
    {model
      ? <primitive object={model} dispose={null} />
      : <mesh position={[0, 1.05, 0]} castShadow><boxGeometry args={[3.1, 2.1, 2.5]} /><meshStandardMaterial color="#e8dfc7" roughness={.9} /></mesh>}
    <BuildingSign text={role} color={accent} />
    {index === 2 && gym && <GymEntranceStatus gym={gym} badges={badges} showLabel={showGymLabel} />}
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

function TrailAndWater({ sampleWorld, player, badges, atlas, visible, mobile, gyms = atlas.gyms }: { sampleWorld: (x: number, z: number) => WorldSample; player: { x: number; z: number }; badges: number; atlas: WorldAtlas; visible: VisibilityTest; mobile: boolean; gyms?: WorldAtlas['gyms'] }) {
  const locations = useMemo(() => new Map(atlas.locations.map(item => [item.id, item])), [atlas]);
  const trail = useMemo(() => {
    const vertices: number[] = [];
    const indices: number[] = [];
    for (const [fromId, toId] of atlas.surfaceConnections) {
      const from = locations.get(fromId)!, to = locations.get(toId)!;
      const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz) || 1;
      const steps = Math.max(1, Math.ceil(length / 5));
      const sideX = -dz / length * 2.05 * WORLD_SCALE, sideZ = dx / length * 2.05 * WORLD_SCALE;
      const offset = vertices.length / 3;
      for (let step = 0; step <= steps; step += 1) {
        const t = step / steps, x = from.x + dx * t, z = from.z + dz * t;
        for (const direction of [-1, 1]) {
          const px = x + sideX * direction, pz = z + sideZ * direction;
          vertices.push(px, terrainSurfaceHeight(sampleWorld, px, pz) + .055, pz);
        }
        if (step < steps && sampleWorld(from.x + dx * ((step + .5) / steps), from.z + dz * ((step + .5) / steps)).biome !== 'lake') {
          const base = offset + step * 2;
          indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
        }
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(vertices.flatMap((_, index) => index % 3 === 0 ? [vertices[index] * .28, vertices[index + 2] * .28] : []), 2));
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
      <mesh geometry={trail} receiveShadow><SurfaceMaterial surface="path" color={regionTrailColor(atlas)} /></mesh>
      {atlas.id !== 'kanto' && atlas.locations.filter(item => item.kind === 'special' && !isRegionalLeagueLocation(atlas.id, item.id) && Math.hypot(item.x - player.x, item.z - player.z) < 70 && visible(item.x, 5, item.z, 10)).map(item => <RegionalLandmark key={item.id} region={atlas.id} x={item.x} y={terrainSurfaceHeight(sampleWorld, item.x, item.z)} z={item.z} />)}
      {atlas.locations.filter(item => isRegionalLeagueLocation(atlas.id, item.id) && Math.hypot(item.x - player.x, item.z - player.z) < 100).map(item => {
        // Place scenery beyond the existing blocked edge, leaving arrival and walking paths clear.
        const candidates = [18, 24, 30].flatMap(radius => [0, -.7, .7, -1.4, 1.4].map(angle => ({ x: item.x + Math.sin(angle) * radius, z: item.z - Math.cos(angle) * radius })));
        const point = candidates.find(point => [-5.2, 0, 5.2].every(dx => [-4, 0, 5.2].every(dz => sampleWorld(point.x + dx, point.z + dz).blocked)));
        if (!point) return null;
        return <RegionalLeagueLandmark key={item.id} region={atlas.id} x={point.x} y={terrainSurfaceHeight(sampleWorld, point.x, point.z)} z={point.z} />;
      })}
      {atlas.locations.filter(item => item.kind === 'town' && !isRegionalLeagueLocation(atlas.id, item.id) && Math.hypot(item.x - player.x, item.z - player.z) <= 85 && visible(item.x, 3, item.z, 14 * WORLD_SCALE)).map(town => <group key={town.id} name={`town:${town.id}`} position={[town.x, terrainSurfaceHeight(sampleWorld, town.x, town.z) + .05, town.z]}>
        <TownPaving color={townColors[town.id] ?? atlas.palette.town} />
        {atlas.buildingOffsets(town).map(([x, z], index) => <group key={index} position={[x, 0, z]} scale={WORLD_SCALE}>
          <TownBuilding townId={town.id} townColor={townColors[town.id] ?? atlas.palette.town} index={index} gym={gyms.find(item => item.locationId === town.id)} badges={badges} showGymLabel={Math.hypot(town.x - player.x, town.z - player.z) <= 14 * WORLD_SCALE} />
        </group>)}
        <group position={[0, 0, -6 * WORLD_SCALE]}>
          <mesh position={[0, .9, 0]} castShadow><boxGeometry args={[2.4, 1.15, .24]} /><meshStandardMaterial color="#eadb9d" /></mesh>
          <mesh position={[-.82, .35, 0]}><boxGeometry args={[.16, 1.1, .16]} /><meshStandardMaterial color="#6b4b2c" /></mesh>
          <mesh position={[.82, .35, 0]}><boxGeometry args={[.16, 1.1, .16]} /><meshStandardMaterial color="#6b4b2c" /></mesh>
        </group>
      </group>)}
      {atlas.locations.filter(item => item.kind === 'cave' && !isRegionalLeagueLocation(atlas.id, item.id) && Math.hypot(item.x - player.x, item.z - player.z) <= 80 && visible(item.x, 3, item.z, 16)).map(cave => {
        // The location center is a walking/arrival point, so solid scenery belongs beyond the path.
        const candidates = [8, 12, 16, 22].flatMap(radius => [0, -.8, .8, -1.6, 1.6, Math.PI].map(angle => ({ x: cave.x + Math.sin(angle) * radius, z: cave.z - Math.cos(angle) * radius })));
        const point = candidates.find(point => [-3.8, 0, 3.8].every(dx => [-1.8, 0, 1.8].every(dz => sampleWorld(point.x + dx, point.z + dz).blocked)));
        if (!point) return null;
        return <group key={cave.id} name={`cave-entrance:${cave.id}`} position={[point.x, terrainSurfaceHeight(sampleWorld, point.x, point.z), point.z]}>
          {[-1, 1].map(side => <group key={side} position={[side * 2.65, 0, 0]}>
            <mesh position={[0, 1.35, 0]} scale={[1.1, 1.6, .9]} rotation={[.1, side * .2, side * .15]} castShadow receiveShadow><dodecahedronGeometry args={[1.35, 1]} /><SurfaceMaterial surface="rock" color="#74766b" /></mesh>
            <mesh position={[-side * .9, 3.05, -.2]} scale={[1.35, .75, .95]} rotation={[0, 0, side * -.3]} castShadow receiveShadow><dodecahedronGeometry args={[1.45, 1]} /><SurfaceMaterial surface="rock" color="#686b61" /></mesh>
          </group>)}
          <mesh position={[0, 3.6, -.35]} scale={[1.3, .6, 1]} castShadow receiveShadow><dodecahedronGeometry args={[1.4, 1]} /><SurfaceMaterial surface="rock" color="#7b7c70" /></mesh>
          <mesh position={[0, 1.5, -1.2]}><circleGeometry args={[1.7, 24]} /><meshBasicMaterial color="#171b1c" side={DoubleSide} /></mesh>
        </group>;
      })}
      {atlas.gates.filter(gate => gate.visible !== false).map(gate => {
        const from = locations.get(gate.from)!, to = locations.get(gate.to)!;
        const x = (from.x + to.x) / 2, z = (from.z + to.z) / 2;
        const y = terrainSurfaceHeight(sampleWorld, x, z);
        const halfWidth = atlas.gateHalfWidth(gate);
        return <ProgressGate key={gate.id} gate={gate} from={from} to={to} y={y} halfWidth={halfWidth} badges={badges} showLabel={Math.hypot(x - player.x, z - player.z) <= 14} />;
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
    return normalizePokemonModel(scene, gltf.animations, creature.displayHeight ?? 1.2, { speciesId: creature.speciesId, types: getSpecies(creature.speciesId).types });
  }, [creature.displayHeight, creature.speciesId, gltf]);
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
  if (distance > 34 && !emphasized) return null;
  const remote = creature.remotePlayer;
  return <group name="creature-nameplate" position={[0, (creature.displayHeight ?? 1.2) + .5, 0]}>
    <Html center zIndexRange={[2, 1]} style={{ pointerEvents: 'none' }}>
      <div className={`ow-creature-label${emphasized ? ' ow-creature-label-selected' : ''}`} data-creature-id={creature.id}>
        <strong>{remote ? remote.name : `${creature.name} · Lv.${creature.level}`}</strong>
        <span>{remote ? remote.activity === 'battle' ? '배틀 중' : remote.activity === 'moving' ? '이동 중' : '대기'
          : `${Math.max(0, Math.ceil(creature.hp))} / ${creature.maxHp} HP`}</span>
        {!remote && <div className="ow-hp-track"><i className="ow-hp-fill" style={{ width: `${Math.max(0, Math.min(1, hp)) * 100}%`, background: hp > .45 ? '#82d179' : hp > .2 ? '#e5ca55' : '#e56f59' }} /></div>}
      </div>
    </Html>
  </group>;
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
    const speed = MathUtils.clamp(creature.movementSpeed ?? 2.4, .5, 16);
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
      {showLabels && (distance <= 28 || selected || creature.inBattle || creature.remotePlayer) && <CreatureBillboard creature={creature} hp={hp} distance={distance} emphasized={selected || !!creature.inBattle || !!creature.remotePlayer} />}
    </group>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return !['checkbox', 'button', 'submit', 'reset'].includes(target.type);
  return target.isContentEditable || ['TEXTAREA', 'SELECT'].includes(target.tagName);
}

type ViewCommands = { navigateTo?: (point: WorldPoint) => boolean; setCameraHeading?: (radians: number) => void };

function PlayerCamera({ snapshot, options, destination, onDestination, commands }: { commands: ViewCommands; snapshot: OpenWorldRenderSnapshot; options: OpenWorldViewOptions; destination: WorldPoint | null; onDestination: (point: WorldPoint | null) => void }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const keys = useRef(new Set<string>());
  const position = useRef(new Vector3(snapshot.player.x, terrainSurfaceHeight(options.sampleWorld ?? fallbackSample, snapshot.player.x, snapshot.player.z), snapshot.player.z));
  const external = useRef(position.current.clone());
  const forward = useRef(new Vector3());
  const right = useRef(new Vector3());
  const movement = useRef(new Vector3());
  const cameraTarget = useRef(new Vector3());
  const listenersReady = useRef(false);
  const path = useRef<WorldPoint[]>([]);
  const announcedReady = useRef(false);
  const movementActive = useRef(false);
  const cameraHeading = useRef({ time: 0, angle: Infinity });
  const { camera, size } = useThree();
  const sample = options.sampleWorld ?? fallbackSample;

  useEffect(() => {
    path.current = destination ? findWorldPath(position.current, destination, sample) : [];
    if (destination && !path.current.length) {
      onDestination(null);
      if (!keys.current.size) { movementActive.current = false; options.onMovementEnd?.(); }
    }
    else if (destination) {
      const resolved = path.current[path.current.length - 1];
      if (Math.hypot(resolved.x - destination.x, resolved.z - destination.z) > .01) onDestination(resolved);
    }
  }, [destination, onDestination, sample]);

  useEffect(() => {
    external.current.set(snapshot.player.x, terrainSurfaceHeight(sample, snapshot.player.x, snapshot.player.z), snapshot.player.z);
    const locallyMoving = movementActive.current || keys.current.size > 0 || path.current.length > 0;
    if (position.current.distanceTo(external.current) > 3 || !locallyMoving) {
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
    commands.setCameraHeading = radians => {
      if (!Number.isFinite(radians) || !controls.current) return;
      const center = controls.current.target;
      const radius = Math.hypot(camera.position.x - center.x, camera.position.z - center.z);
      camera.position.x = center.x - Math.sin(radians) * radius;
      camera.position.z = center.z - Math.cos(radians) * radius;
      camera.lookAt(center); controls.current.update();
      options.onCameraHeading?.(radians);
    };
    return () => { delete commands.setCameraHeading; };
  }, [camera, commands, options]);

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
    const forwardAxis = Number(pressed.has('KeyW') || pressed.has('ArrowUp')) - Number(pressed.has('KeyS') || pressed.has('ArrowDown'));
    const sideAxis = Number(pressed.has('KeyD') || pressed.has('ArrowRight')) - Number(pressed.has('KeyA') || pressed.has('ArrowLeft'));
    const target = position.current;
    const keyboardMovement = Boolean(forwardAxis || sideAxis);
    const wantsMovement = keyboardMovement || path.current.length > 0;
    const movementAllowed = wantsMovement && options.onMovementInput?.() !== false;
    if (movementAllowed) {
      const speed = snapshot.entities.find(entity => entity.id.startsWith('companion:'))?.movementSpeed ?? 2.2;
      let remainingFrame = Math.min(Math.max(delta, 0), .35);
      let substeps = 0;
      if (keyboardMovement) {
        camera.getWorldDirection(forward.current);
        forward.current.y = 0;
        forward.current.normalize();
        right.current.set(-forward.current.z, 0, forward.current.x);
      }
      // Consume the bounded frame time now, in collision-safe chunks. Deferring
      // one chunk per rendered frame permanently slows movement below 10 FPS.
      while (remainingFrame > .0001 && substeps++ < 32) {
        let routeDistance = Infinity;
        if (keyboardMovement) {
          movement.current.copy(forward.current).multiplyScalar(forwardAxis).addScaledVector(right.current, sideAxis).normalize();
        } else {
          const waypoint = path.current[0];
          if (!waypoint) break;
          const dx = waypoint.x - target.x, dz = waypoint.z - target.z;
          routeDistance = Math.hypot(dx, dz);
          if (routeDistance <= .12) {
            path.current.shift();
            if (!path.current.length) onDestination(null);
            continue;
          }
          movement.current.set(dx / routeDistance, 0, dz / routeDistance);
        }
        const movementDelta = Math.min(.1, remainingFrame, routeDistance / speed);
        movement.current.multiplyScalar(movementDelta * speed);
        const x = MathUtils.clamp(target.x + movement.current.x, WORLD_MIN, WORLD_MAX);
        const z = MathUtils.clamp(target.z + movement.current.z, WORLD_MIN, WORLD_MAX);
        const terrain = sample(x, z);
        if (terrain.blocked) {
          if (path.current.length) { path.current = []; onDestination(null); }
          break;
        }
        const nextHeading = Math.abs(movement.current.x) > Math.abs(movement.current.z)
          ? (movement.current.x > 0 ? 1 : 3)
          : headingForStep(movement.current.x, movement.current.z);
        if (options.onPlayerMove({ x, z, heading: nextHeading }) === false) {
          if (path.current.length) { path.current = []; onDestination(null); }
          break;
        }
        camera.position.x += x - target.x;
        const groundY = terrainSurfaceHeight(sample, x, z);
        camera.position.y += groundY - target.y;
        camera.position.z += z - target.z;
        target.set(x, groundY, z);
        external.current.copy(target);
        remainingFrame -= movementDelta;
      }
    }
    const stillMoving = keyboardMovement || path.current.length > 0;
    if (!stillMoving && (movementActive.current || wantsMovement)) options.onMovementEnd?.();
    movementActive.current = stillMoving;
    const now = performance.now();
    if (now - cameraHeading.current.time >= 100) {
      camera.getWorldDirection(forward.current);
      const angle = Math.atan2(forward.current.x, forward.current.z);
      if (Math.abs(angle - cameraHeading.current.angle) > .01) options.onCameraHeading?.(angle);
      cameraHeading.current = { time: now, angle };
    }
    if (controls.current) {
      cameraTarget.current.set(target.x, target.y + 1.2, target.z);
      // Translate the focus together with the camera. A lagging focus changes
      // the orbit angle while walking, especially at close zoom.
      controls.current.target.copy(cameraTarget.current);
      const cameraFloor = terrainSurfaceHeight(sample, camera.position.x, camera.position.z) + 2;
      if (camera.position.y < cameraFloor) { camera.position.y = cameraFloor; camera.lookAt(controls.current.target); }
    }
  }, -2); // Follow first; drei updates OrbitControls once at priority -1.

  return <OrbitControls ref={controls} makeDefault enablePan={false} enableDamping dampingFactor={.2}
    rotateSpeed={size.width <= 720 ? .25 : .32} zoomSpeed={.65}
    minDistance={MIN_CAMERA_DISTANCE} maxDistance={MAX_CAMERA_DISTANCE} minPolarAngle={.38} maxPolarAngle={1.18} />;
}

function Sunlight({ player, mobile }: { player: { x: number; z: number }; mobile: boolean }) {
  const sun = useRef<DirectionalLight>(null);
  const target = useMemo(() => new Object3D(), []);
  const elapsed = useRef(1);
  const reach = mobile ? 16 : 24;
  useFrame((_, delta) => {
    elapsed.current += delta;
    if (sun.current && elapsed.current >= 1 / (mobile ? 10 : 15)) {
      sun.current.shadow.needsUpdate = true;
      elapsed.current = 0;
    }
  });
  const x = Math.round(player.x / 4) * 4, z = Math.round(player.z / 4) * 4;
  useLayoutEffect(() => { target.position.set(x, 0, z); target.updateMatrixWorld(); }, [x, z, target]);
  return <><primitive object={target} /><directionalLight ref={sun} target={target} position={[x + 28, 52, z + 22]} intensity={2.6} color="#fff0d5" castShadow
    shadow-autoUpdate={false} shadow-mapSize={[mobile ? 256 : 512, mobile ? 256 : 512]}
    shadow-camera-near={1} shadow-camera-far={120} shadow-camera-left={-reach} shadow-camera-right={reach}
    shadow-camera-top={reach} shadow-camera-bottom={-reach} shadow-normalBias={.06} shadow-bias={-.0004} /></>;
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

function Scene({ snapshot, options, showLabels, destination, onNavigate, onDestination, commands }: { commands: ViewCommands; snapshot: OpenWorldRenderSnapshot; options: OpenWorldViewOptions; showLabels: boolean; destination: WorldPoint | null; onNavigate: (point: WorldPoint) => void; onDestination: (point: WorldPoint | null) => void }) {
  const atlas = getWorldAtlas(snapshot.regionId ?? 'kanto');
  const sceneId = snapshot.sceneId ?? surfaceSceneId(atlas.id), cave = getCaveScene(sceneId);
  const sample = cave?.sample ?? atlas.sample;
  const waterMaterials = useTerrainMaterials(atlas.palette.water);
  const groundMaterial = waterMaterials.ground;
  // Fixed daytime presentation: never rebuild lighting or sky for a world clock tick.
  const daylight = 1;
  const skyColor = useMemo(() => new Color(cave ? '#182326' : '#afcfc1'), [cave]);
  const worldOptions = useMemo(() => ({ ...options, sampleWorld: sample }), [options, sample]);
  const windowState = useViewWindow();
  const chunks = useMemo(() => terrainChunks(snapshot.player, windowState.visible), [snapshot.player.x, snapshot.player.z, windowState.visible]);
  const visible = useMemo(() => creatureLods(snapshot.entities, snapshot.player, windowState.visible, windowState.mobile, snapshot.selectedWildId), [snapshot, windowState]);
  const labelIds = useMemo(() => {
    if (!showLabels) return new Set<string>();
    const priority = (item: typeof visible[number]) => item.creature.id === snapshot.selectedWildId ? 0
      : item.creature.id.startsWith('companion:') ? 1 : item.creature.inBattle ? 2 : item.creature.remotePlayer ? 3 : 4;
    return new Set([...visible].sort((a, b) => priority(a) - priority(b) || a.distance - b.distance)
      .slice(0, windowState.mobile ? 3 : 6).map(item => item.creature.id));
  }, [showLabels, snapshot.selectedWildId, visible, windowState.mobile]);
  const { scene } = useThree();
  useLayoutEffect(() => {
    // Scene is rendered inside a group. JSX attach="background"/"fog" there
    // would only assign unused properties to that group, not the root scene.
    const previousBackground = scene.background, previousFog = scene.fog;
    scene.background = skyColor; scene.fog = null;
    return () => { scene.background = previousBackground; scene.fog = previousFog; };
  }, [scene, skyColor]);
  useFrame(() => { scene.userData.streaming = { region: atlas.id, sceneId, daylight, player: { x: snapshot.player.x, z: snapshot.player.z }, terrainChunks: cave ? 0 : chunks.length, terrainTotal: ((WORLD_MAX - WORLD_MIN) / TERRAIN_CHUNK_SIZE) ** 2, highDetailChunks: chunks.filter(c => c.segments === 12).length,
    visibleCreatures: visible.length, detailedCreatures: visible.filter(v => v.model && hasPokemonModel(v.creature.speciesId)).length, cachedModels: modelCache.size, activeLoads, queuedLoads: loadQueue.length, modelLimit: windowState.mobile ? 4 : 8 }; });
  return (
    <>
      <hemisphereLight color={cave ? '#b9cbd1' : '#d9eeed'} groundColor="#434f3f" intensity={cave ? .85 : 1.1} />
      <SkyLighting />
      {!cave && <Sunlight player={snapshot.player} mobile={windowState.mobile} />}
      {cave && <pointLight position={[snapshot.player.x, 5, snapshot.player.z]} color="#ffdda6" intensity={35} distance={28} decay={1.4} />}
      <Physics gravity={[0, -18, 0]} timeStep="vary">
        {cave ? <CaveInterior cave={cave} player={snapshot.player} mobile={windowState.mobile} onNavigate={onNavigate} /> : <>
          <group key={`terrain:${sceneId}`}>{chunks.map(chunk => <Terrain key={`${chunk.key}:${chunk.segments}`} sampleWorld={sample} atlas={atlas} chunk={chunk} material={groundMaterial} waterMaterial={waterMaterials[chunk.distance <= (windowState.mobile ? 24 : 40) ? 'detailed' : 'simple']} onNavigate={onNavigate} />)}</group>
          <Nature key={`nature:${sceneId}`} sampleWorld={sample} player={snapshot.player} atlas={atlas} isVisible={windowState.visible} />
          <TrailAndWater key={`water:${sceneId}`} sampleWorld={sample} player={snapshot.player} atlas={atlas} gyms={snapshot.gyms} visible={windowState.visible} badges={snapshot.badges ?? 0} mobile={windowState.mobile} />
        </>}
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
      {snapshot.guide && <DestinationPointer guide={snapshot.guide} sample={sample} />}
      <TargetRoute snapshot={snapshot} destination={destination} sample={sample} />
      <ScenePortals sceneId={sceneId} regionId={atlas.id} player={snapshot.player} sample={sample} onNavigate={onNavigate} onPortal={() => options.onPortal?.('nearest')} />
      {visible.map(({ creature, distance, model }) => <Creature key={creature.id} creature={creature} selected={creature.id === snapshot.selectedWildId} showLabels={labelIds.has(creature.id)} distance={distance} model={model} options={worldOptions} />)}
      {destination && <group position={[destination.x, terrainSurfaceHeight(sample, destination.x, destination.z) + .08, destination.z]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[.42, .62, 28]} /><meshBasicMaterial color="#ffe27a" transparent opacity={.9} /></mesh>
        <mesh position={[0, .08, 0]} rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[.13, 20]} /><meshBasicMaterial color="#fff4b8" /></mesh>
      </group>}
      <PlayerCamera commands={commands} key={sceneId} snapshot={snapshot} options={worldOptions} destination={destination} onDestination={onDestination} />
    </>
  );
}

function SaveRenderBudget() {
  const setFrameloop = useThree(state => state.setFrameloop);
  useLayoutEffect(() => onRenderSuspension(suspended => setFrameloop(suspended ? 'never' : 'always')), [setFrameloop]);
  return null;
}

type ViewLifetime = { active: boolean; host: HTMLElement };
function ActiveWorld({ lifetime, children }: { lifetime: ViewLifetime; children: ReactNode }) {
  return lifetime.active ? children : null;
}

function OpenWorldApp({ store, options, lifetime, commands }: { commands: ViewCommands; store: SnapshotStore; options: OpenWorldViewOptions; lifetime: ViewLifetime }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.get, store.get);
  const renderPaused = useSyncExternalStore(onRenderSuspension, renderingSuspended, renderingSuspended);
  const runtime = useMemo(() => createGaesupRuntime({ plugins: [createCameraPlugin()], pluginRuntime: 'client' }), []);
  const [ready, setReady] = useState(false);
  const [renderDpr, setRenderDpr] = useState(() => Math.min(window.devicePixelRatio || 1, 1.5));
  const [showLabels, setShowLabels] = useState(true);
  const toggleLabels = () => setShowLabels(previous => !previous);
  const [destination, setDestination] = useState<WorldPoint | null>(null);
  const createRenderer = useMemo(() => {
    let pending: ReturnType<typeof createOpenWorldRenderer> | undefined;
    return (defaults: Parameters<typeof createOpenWorldRenderer>[0]) => pending ??= createOpenWorldRenderer(defaults, { forceWebGL: new URLSearchParams(location.search).get('renderer') === 'webgl' });
  }, []);
  useEffect(() => { setDestination(null); }, [snapshot.regionId, snapshot.sceneId]);
  const navigate = useCallback((point: WorldPoint) => {
    if (![point.x, point.z].every(Number.isFinite) || options.onNavigationStart?.() === false) return false;
    setDestination(point); return true;
  }, [options]);
  useEffect(() => { commands.navigateTo = navigate; return () => { delete commands.navigateTo; }; }, [commands, navigate]);
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
      worldSize={{ width: WORLD_MAX - WORLD_MIN, height: 48, depth: WORLD_MAX - WORLD_MIN }}
      enablePhysics
      gravity={[0, -18, 0]}
    >
      <Canvas eventSource={lifetime.host} frameloop={renderPaused ? 'never' : 'always'} shadows="percentage" dpr={renderDpr} camera={{ position: [12, 18, 16], fov: 48, near: .1, far: 160 }} gl={defaults => createRenderer({ ...defaults, canvas: defaults.canvas as HTMLCanvasElement })} onPointerMissed={() => options.onSelect(null)} onCreated={state => {
        // Canvas can finish its async WebGPU setup after logout or a tab change.
        // Keep the event target valid, then retire that stale R3F root before it
        // can render or install scene controls for the previous adventure.
        if (!lifetime.active) {
          state.setFrameloop('never');
          queueMicrotask(() => unmountComponentAtNode(state.gl.domElement));
        }
      }}>
        <ActiveWorld lifetime={lifetime}>
        <AdaptiveResolution setDpr={setRenderDpr} />
        <SaveRenderBudget />
        {new URLSearchParams(location.search).has('renderProbe') && <RenderProbe />}
        <group name="gaesup-world">
          <Scene commands={commands} snapshot={snapshot} options={options} showLabels={showLabels} destination={destination} onNavigate={navigate} onDestination={setDestination} />
        </group>
        </ActiveWorld>
      </Canvas>
      {!ready && <div className="ow-loading">Gaesup World 준비 중…</div>}
      <div className="ow-camera-controls" aria-label="이름과 체력 표시">
        <button type="button" id="world-nameplates" className="ow-camera-reset" aria-label="포켓몬 이름·HP 표시" aria-pressed={showLabels} onClick={toggleLabels}>이름·HP</button>
      </div>
    </GaesupWorld>
  );
}

export function mountOpenWorld(host: HTMLElement, options: OpenWorldViewOptions): OpenWorldView {
  const initial = options.getSnapshot();
  const store = new SnapshotStore(initial);
  const root: Root = createRoot(host);
  const lifetime: ViewLifetime = { active: true, host };
  const commands: ViewCommands = {};
  host.classList.add('choketmon-openworld');
  // Gaesup's plugin registry rejects concurrent duplicate setup. The view owns
  // one runtime lifecycle, so avoid React development StrictMode's effect replay.
  root.render(<OpenWorldApp store={store} options={options} lifetime={lifetime} commands={commands} />);
  const poll = window.setInterval(() => store.set(options.getSnapshot()), 100);
  return {
    update(snapshot = options.getSnapshot()) { store.set(snapshot); },
    navigateTo(point) { return commands.navigateTo?.(point) ?? false; },
    setCameraHeading(radians) { commands.setCameraHeading?.(radians); },
    destroy() {
      lifetime.active = false;
      window.clearInterval(poll);
      root.unmount();
      host.classList.remove('choketmon-openworld');
    },
  };
}
