import { Canvas, unmountComponentAtNode, useFrame, useThree } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import { Physics, RigidBody } from '@react-three/rapier';
import { GaesupWorld, createCameraPlugin } from 'gaesup-world';
import { createGaesupRuntime } from 'gaesup-world/runtime';
import { Component, type ReactNode, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  AnimationMixer,
  BackSide,
  Box3,
  MeshBasicMaterial,
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
  SkinnedMesh,
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
import { cachedSceneryPlacements, SCENERY_ASSETS, type SceneryAssetId, type SceneryPlacement } from './scenery';
import { createGrounding, terrainSurfaceHeight } from './grounding';
import { getWorldAtlas, type WorldAtlas } from './atlas';
import { hasPokemonModel } from '../game/assets';
import { clipGroundSpeed, selectPokemonMotionClip } from '../data/model-motion';
import { acquireModel, modelCacheStats, retryFailedModels } from '../three/model-cache';
import { creatureLods, terrainChunks, TERRAIN_CHUNK_SIZE, type TerrainChunk, type VisibilityTest } from './lod';
import { initialYaw, movementYaw, turnTowards, walkCycleRate } from './motion';
import { normalizePokemonModel } from './model-normalization';
import { disposeNormalizedPokemonMaterials } from './pokemon-materials';
import { createTerrainSurface } from './terrain-surface';
import { getSpecies } from '../data/pokemon';
import './view.css';
import { RenderProbe } from './render-probe';
import { SkyLighting, SurfaceMaterial, regionTrailColor, useTerrainMaterials, normalizeStandardMaterial } from './materials';
import { AdaptiveResolution } from './adaptive-resolution';
import { MAX_CAMERA_DISTANCE, MIN_CAMERA_DISTANCE } from './camera-navigation';
import { findWorldPath, headingForStep } from './navigation';
import { onRenderSuspension, renderingSuspended } from '../three/render-budget';
import { releaseOnDetach, releaseRenderObjects, useReleasingRef } from '../three/render-objects';
import { visibleTimeout } from '../three/visible-time';

import { WORLD_MIN, WORLD_MAX, WORLD_SCALE, surfaceSceneId } from './world-space';
import { getCaveScene, hasDungeonLandmark } from './caves';
import { DUNGEON_LOOKS, DungeonEntrances, DungeonInterior } from './dungeon-interior';
import { IndoorLighting } from './interior-lighting';
import { getGymScene, gymBuildingPoint } from './gym-scenes';
import { GymInterior } from './gym-interior';
import { LeagueInterior } from './league-interior';
import { CaveInterior, GymEntranceStatus, ProgressGate, RegionalLeagueLandmark, ScenePortals, isRegionalLeagueLocation } from './scene-landmarks';
import { DestinationPointer } from './destination-pointer';
import { TargetRoute } from './target-route';
import { FieldItemPickups } from './field-item-pickups';
import { MoveEffects } from './move-effects';
import { statusLabel } from '../game/status-labels';
import { ExplorationLandmarks } from './exploration-landmarks';
import { createOpenWorldRenderer } from './gpu-renderer';
import { scenerySeed, townPavingCells, townStyle } from './town-style';
import { DETAIL_KINDS, PAVING_CELL, detailNoise, isTownPaved, trailHalfWidth, type DetailKind } from './world-details';
import { TownProps, createDetailGeometry, detailMaterial, regionalLandmarkGeometry, townPavingGeometry, useWorldDetails } from './town-details';
import { THEME_BY_REGION } from './exploration-sites';
import { FieldGrass } from './field-grass';
import { CaveMouths } from './cave-mouths';
import { ParkInterior } from './park-interior';
import { picketFenceGeometry } from './picket-fence';
const NATURE_DETAIL_RADIUS = 68;
// Bound scenery streaming even though the view no longer uses fog.
const NATURE_VISIBLE_RADIUS = 94;
const DEFAULT_CAMERA_OFFSET = new Vector3(5.6, 7.6, 8.8);

const MODEL_RETRY_EVENT = 'choketmon-retry-world-models';
function useModelStatus(url: string, renderFailed = false): { url: string; gltf: GLTF | null; failed: boolean } {
  const [state, setState] = useState({ url, gltf: null as GLTF | null, failed: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!state.failed && !renderFailed) return;
    const retry = () => setAttempt(value => value + 1);
    window.addEventListener(MODEL_RETRY_EVENT, retry);
    return () => window.removeEventListener(MODEL_RETRY_EVENT, retry);
  }, [state.failed, renderFailed]);
  useEffect(() => {
    let active = true;
    setState({ url, gltf: null, failed: false });
    const request = acquireModel(url);
    request.promise.then(gltf => { if (active) setState({ url, gltf, failed: false }); })
      .catch(() => { if (active) setState({ url, gltf: null, failed: true }); });
    return () => { active = false; request.release(); };
  }, [url, attempt]);
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
      || a.formIdentifier !== b.formIdentifier || a.formModelUrl !== b.formModelUrl || a.transformationKind !== b.transformationKind
      || a.displayHeight !== b.displayHeight || a.movementSpeed !== b.movementSpeed || a.lookAt?.x !== b.lookAt?.x || a.lookAt?.z !== b.lookAt?.z
      || a.remotePlayer?.name !== b.remotePlayer?.name || a.remotePlayer?.activity !== b.remotePlayer?.activity
      || a.cue?.key !== b.cue?.key || a.status !== b.status) return false;
  }
  if ((left.effects?.length ?? 0) !== (right.effects?.length ?? 0) || left.effects?.some((effect, index) => effect.key !== right.effects![index].key)) return false;
  const simple = <T extends WorldPoint & { id: string }>(a?: readonly T[], b?: readonly T[]) => {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    return a.every((item, index) => item.id === b[index].id && item.x === b[index].x && item.y === b[index].y && item.z === b[index].z);
  };
  return simple(left.fieldItems, right.fieldItems) && simple(left.foods, right.foods) && simple(left.trainers, right.trainers) && simple(left.portals, right.portals)
    && (left.fieldItems ?? []).every((item, index) => item.itemId === right.fieldItems?.[index].itemId)
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
  // The terrain materials outlive every chunk; each mesh lets go of its render objects when it leaves.
  const surface = <mesh ref={releaseOnDetach} geometry={geometry} material={geometry.userData.waterVertices ? waterMaterial : material} dispose={null} receiveShadow name={`terrain-chunk:${chunk.key}:${chunk.segments}`} onClick={event => {
    event.stopPropagation(); if (event.button === 0 && event.delta <= 5) onNavigate?.({ x: event.point.x, z: event.point.z });
  }} />;
  return <group>
    {surface}
    <mesh ref={releaseOnDetach} geometry={skirt} material={material} dispose={null} />
  </group>;
}, (before, after) => before.chunk.key === after.chunk.key && before.chunk.segments === after.chunk.segments
  && before.sampleWorld === after.sampleWorld && before.atlas === after.atlas && before.material === after.material && before.waterMaterial === after.waterMaterial && before.onNavigate === after.onNavigate);

const IDENTITY_MATRIX = new Matrix4();
const instanceScratch = { placement: new Matrix4(), result: new Matrix4(), position: new Vector3(), scale: new Vector3(), rotation: new Quaternion(), axis: new Vector3(0, 1, 0) };

function InstancedPart({ geometry, material, sourceMatrix, placements, shadows, scale = 1 }: {
  geometry: BufferGeometry;
  material: Material | Material[];
  sourceMatrix: Matrix4;
  placements: readonly SceneryPlacement[];
  shadows: boolean;
  scale?: number;
}) {
  const mesh = useRef<InstancedMesh>(null);
  // A larger capacity rebuilds the mesh; the old one frees its render objects on the shared material.
  const attach = useReleasingRef(mesh);
  // Reuse GPU buffers when visibility changes the active instance count.
  const capacity = useRef(64);
  capacity.current = Math.max(capacity.current, 2 ** Math.ceil(Math.log2(Math.max(1, placements.length))));
  useEffect(() => { const instance = mesh.current; return () => { instance?.dispose(); }; }, [capacity.current]);
  useLayoutEffect(() => {
    if (!mesh.current) return;
    const { placement, result, position, scale: size, rotation, axis } = instanceScratch;
    placements.forEach((item, index) => {
      position.set(item.x, item.y, item.z);
      size.setScalar(item.scale * scale);
      rotation.setFromAxisAngle(axis, item.rotationY);
      placement.compose(position, rotation, size);
      result.multiplyMatrices(placement, sourceMatrix);
      mesh.current!.setMatrixAt(index, result);
    });
    mesh.current.instanceMatrix.needsUpdate = true;
    mesh.current.computeBoundingSphere();
  }, [placements, sourceMatrix, scale]);
  return <instancedMesh ref={attach} args={[geometry, material, capacity.current]} count={placements.length} castShadow={shadows} receiveShadow dispose={null} />;
}

function InstancedAsset({ url, placements, shadows = false, scale = 1 }: { url: string; placements: readonly SceneryPlacement[]; shadows?: boolean; scale?: number }) {
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
  return <group name={`nature:${url.split('/').at(-1)?.split('?')[0]}`}>{parts.map((part, index) => <InstancedPart key={index} geometry={part.geometry} material={part.material} sourceMatrix={part.matrix} placements={placements} shadows={shadows} scale={scale} />)}</group>;
}

// Placements are bucketed once so streaming only scans cells near the player.
const NATURE_BUCKET = 32;
type NatureLayer = { buckets: Map<number, SceneryPlacement[]>; radius: number; mobileRadius: number; lift: number; bound: number };
const bucketKey = (ix: number, iz: number) => (ix + 512) * 1024 + iz + 512;
function natureLayer(list: readonly SceneryPlacement[] | undefined, radius: number, mobileRadius: number, lift: number, bound: number): NatureLayer[] {
  if (!list?.length) return [];
  const buckets = new Map<number, SceneryPlacement[]>();
  for (const item of list) {
    const key = bucketKey(Math.floor(item.x / NATURE_BUCKET), Math.floor(item.z / NATURE_BUCKET));
    let cell = buckets.get(key);
    if (!cell) buckets.set(key, cell = []);
    cell.push(item);
  }
  return [{ buckets, radius, mobileRadius, lift, bound }];
}
function nearbyPlacements(layers: readonly NatureLayer[], cellX: number, cellZ: number, player: { x: number; z: number }, isVisible: VisibilityTest, mobile: boolean, previous?: SceneryPlacement[]): SceneryPlacement[] {
  const result: SceneryPlacement[] = [];
  for (const layer of layers) {
    const radius = mobile ? layer.mobileRadius : layer.radius;
    const minX = Math.floor((cellX - radius) / NATURE_BUCKET), maxX = Math.floor((cellX + radius) / NATURE_BUCKET);
    const minZ = Math.floor((cellZ - radius) / NATURE_BUCKET), maxZ = Math.floor((cellZ + radius) / NATURE_BUCKET);
    for (let ix = minX; ix <= maxX; ix++) for (let iz = minZ; iz <= maxZ; iz++) {
      const cell = layer.buckets.get(bucketKey(ix, iz));
      if (cell) for (const item of cell) if (Math.hypot(item.x - cellX, item.z - cellZ) < radius
        && (Math.hypot(item.x - player.x, item.z - player.z) < 12 || isVisible(item.x, item.y + layer.lift, item.z, layer.bound))) result.push(item);
    }
  }
  // Unchanged sets keep their array identity, so instance matrices are not re-uploaded.
  return previous && previous.length === result.length && previous.every((item, index) => item === result[index]) ? previous : result;
}
const DETAIL_RADIUS_IDS = new Set<SceneryAssetId>(['moss-boulder', 'moss-stone', 'fern']);
const leagueFilters = new Map<string, (id: string) => boolean>();
const leagueFilter = (region: string) => {
  let filter = leagueFilters.get(region);
  if (!filter) leagueFilters.set(region, filter = id => isRegionalLeagueLocation(region, id));
  return filter;
};

function Nature({ sampleWorld, player, atlas, isVisible, mobile = false }: { sampleWorld: (x: number, z: number) => WorldSample; player: { x: number; z: number }; atlas: WorldAtlas; isVisible: VisibilityTest; mobile?: boolean }) {
  const placements = useMemo(() => cachedSceneryPlacements(sampleWorld, atlas), [sampleWorld, atlas]);
  const details = useWorldDetails(sampleWorld, atlas, leagueFilter(atlas.id));
  const theme = THEME_BY_REGION[atlas.id];
  const detailGeometries = useMemo(() => Object.fromEntries(DETAIL_KINDS.map(kind => [kind, createDetailGeometry(kind, theme)])) as Record<DetailKind, BufferGeometry>, [theme]);
  useEffect(() => () => { Object.values(detailGeometries).forEach(geometry => geometry.dispose()); }, [detailGeometries]);
  const layers = useMemo(() => {
    const layers: Record<string, NatureLayer[]> = {};
    for (const asset of SCENERY_ASSETS) {
      const radius = DETAIL_RADIUS_IDS.has(asset.id) ? NATURE_DETAIL_RADIUS : NATURE_VISIBLE_RADIUS;
      layers[asset.id] = [...natureLayer(placements[asset.id], radius, radius, 3, 6),
        ...natureLayer(details?.framing[asset.id], NATURE_VISIBLE_RADIUS, 72, 3, 6)];
    }
    // Small procedural dressing streams in a tighter radius, smaller still on phones.
    for (const kind of DETAIL_KINDS) layers[kind] = natureLayer(details?.ground[kind], kind === 'route-post' ? 70 : 46, kind === 'route-post' ? 50 : 30, .5, 2);
    return layers;
  }, [placements, details]);
  const cellX = Math.round(player.x / 16) * 16, cellZ = Math.round(player.z / 16) * 16;
  const previous = useRef<Record<string, SceneryPlacement[]>>({});
  // Keep distant props bounded without adding fog or animated shader effects.
  const nearby = useMemo(() => {
    const next: Record<string, SceneryPlacement[]> = {};
    for (const id of [...SCENERY_ASSETS.map(asset => asset.id), ...DETAIL_KINDS]) next[id] = nearbyPlacements(layers[id], cellX, cellZ, player, isVisible, mobile, previous.current[id]);
    previous.current = next;
    return next;
  }, [layers, cellX, cellZ, isVisible, mobile]);
  return (
    <group userData={{ gaesupWorldObject: 'imported-nature-instances' }}>
      {SCENERY_ASSETS.filter(asset => nearby[asset.id].length && asset.id !== 'fence').map(asset => <InstancedAsset
        key={asset.id}
        url={asset.url}
        placements={nearby[asset.id]}
        scale={asset.scale}
        shadows={asset.id.startsWith('tree') || asset.id.startsWith('rock') || asset.id === 'cliff'}
      />)}
      {DETAIL_KINDS.filter(kind => nearby[kind].length).map(kind => <group key={kind} name={`route-detail:${kind}`}>
        <InstancedPart geometry={detailGeometries[kind]} material={detailMaterial()} sourceMatrix={IDENTITY_MATRIX} placements={nearby[kind]} shadows={false} />
      </group>)}
      {nearby.fence.length > 0 && <group name="route-detail:picket-fence">
        <InstancedPart geometry={picketFenceGeometry()} material={detailMaterial()} sourceMatrix={IDENTITY_MATRIX} placements={nearby.fence} shadows={!mobile} />
      </group>}
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

function TownPaving({ townId }: { townId: string }) {
  const { color } = townStyle(townId);
  const ref = useRef<InstancedMesh>(null);
  const tiles = useMemo(() => townPavingCells(townId), [townId]);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const matrix = new Matrix4(), base = new Color(color), cream = new Color('#e7dfc9');
    tiles.forEach(([x, z, accent], index) => {
      ref.current!.setMatrixAt(index, matrix.makeTranslation(x * PAVING_CELL, 0, z * PAVING_CELL));
      ref.current!.setColorAt(index, cream.clone().lerp(base, accent ? .56 : .2).multiplyScalar(.95 + (scenerySeed(`${townId}:${x}:${z}`) % 1000) / 1000 * .08));
    });
    ref.current.instanceMatrix.needsUpdate = true;
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
  }, [color, tiles, townId]);
  return <instancedMesh ref={ref} args={[townPavingGeometry(), undefined, tiles.length]} receiveShadow name="town-paving">
    <meshStandardMaterial roughness={.92} vertexColors />
  </instancedMesh>;
}

/**
 * An inverted hull around a building: its meshes drawn back-faced, slightly enlarged about their centre. Geometry stays
 * shared; the hull owns its material, so disposing that frees the hull's render objects.
 */
function buildingOutline(model: Object3D): { object: Object3D; material: Material } {
  const material = new MeshBasicMaterial({ color: '#ffe27a', side: BackSide, depthWrite: false });
  const object = model.clone(true);
  object.updateMatrixWorld(true);
  const center = new Box3().setFromObject(object).getCenter(new Vector3());
  object.traverse(child => { if (child instanceof Mesh) { child.material = material; child.castShadow = false; child.receiveShadow = false; child.raycast = () => undefined; } });
  const pivot = new Group(); pivot.name = 'gym-hover-outline';
  pivot.position.copy(center); pivot.scale.setScalar(1.06); object.position.sub(center);
  pivot.add(object);
  return { object: pivot, material };
}

function TownBuilding({ townId, townColor, index, gym, badges, showGymLabel, onGymEnter }: { townId: string; townColor: string; index: number; gym?: WorldAtlas['gyms'][number]; badges: number; showGymLabel: boolean; onGymEnter?: (locationId: string) => void }) {
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
    const tint = new Color(townColor), ownedMaterials = new Map<Material, Material>();
    clone.traverse(object => { if (object instanceof Mesh) {
      object.castShadow = true; object.receiveShadow = true;
      const recolor = (source: Material) => {
        let material = ownedMaterials.get(source);
        if (!material) {
          material = source.clone();
          if (material instanceof MeshStandardMaterial) material.color.multiply(new Color('#ffffff').lerp(tint, .32));
          ownedMaterials.set(source, material);
        }
        return material;
      };
      object.material = Array.isArray(object.material) ? object.material.map(recolor) : recolor(object.material);
    } });
    return clone;
  }, [gltf, townColor]);
  useEffect(() => () => {
    const owned = new Set<Material>();
    model?.traverse(object => { if (object instanceof Mesh) (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => owned.add(material)); });
    owned.forEach(material => material.dispose());
  }, [model]);
  const enterable = index === 2 && gym && onGymEnter ? gym : undefined;
  const [hovered, setHovered] = useState(false), [outlineUsed, setOutlineUsed] = useState(false);
  useEffect(() => () => { if (hovered) document.body.style.cursor = ''; }, [hovered]);
  // Built on the first hover and then only shown or hidden, so hovering never clones the building again.
  const outlined = Boolean(enterable) && outlineUsed;
  const outline = useMemo(() => outlined && model ? buildingOutline(model) : null, [outlined, model]);
  useEffect(() => () => outline?.material.dispose(), [outline]);
  const pointer = enterable ? {
    onPointerOver: (event: { stopPropagation(): void }) => { event.stopPropagation(); setHovered(true); setOutlineUsed(true); document.body.style.cursor = 'pointer'; },
    onPointerOut: () => { setHovered(false); document.body.style.cursor = ''; },
    onClick: (event: { stopPropagation(): void; delta: number }) => { event.stopPropagation(); if (event.delta <= 5) onGymEnter!(enterable.locationId); },
  } : {};
  return <group name={`town-building:${townId}:${index}:${model ? 'loaded' : 'fallback'}`} scale={[1, townStyle(townId).height, 1]}>
    <group {...pointer}>
      {model
        ? <primitive object={model} dispose={null} />
        : <mesh position={[0, 1.05, 0]} castShadow><boxGeometry args={[3.1, 2.1, 2.5]} /><meshStandardMaterial color="#e8dfc7" roughness={.9} /></mesh>}
    </group>
    {outline && <primitive object={outline.object} visible={hovered} dispose={null} />}
    <BuildingSign text={role} color={accent} />
    {index === 2 && gym && <GymEntranceStatus gym={gym} badges={badges} showLabel={showGymLabel} />}
  </group>;
}

function WorldLabel({ name, x, y, z }: { name: string; x: number; y: number; z: number }) {
  // Screen-space type keeps its natural aspect ratio regardless of terrain scale or camera distance.
  return <Html center position={[x, y, z]} zIndexRange={[3, 2]} style={{ pointerEvents: 'none' }}>
    <span className="ow-place-label" data-world-label={name}>{name}</span>
  </Html>;
}

function RegionalLandmark({ region, x, y, z }: { region: string; x: number; y: number; z: number }) {
  return <group name={`regional-landmark:${region}`} position={[x, y, z]}>
    <mesh ref={releaseOnDetach} geometry={regionalLandmarkGeometry(region)} material={detailMaterial()} castShadow receiveShadow dispose={null} />
  </group>;
}

function TrailAndWater({ sampleWorld, player, badges, atlas, visible, gyms = atlas.gyms, onGymEnter, onLeagueEnter }: { sampleWorld: (x: number, z: number) => WorldSample; player: { x: number; z: number }; badges: number; atlas: WorldAtlas; visible: VisibilityTest; gyms?: WorldAtlas['gyms']; onGymEnter?: (locationId: string) => void; onLeagueEnter?: (locationId: string) => void }) {
  const locations = useMemo(() => new Map(atlas.locations.map(item => [item.id, item])), [atlas]);
  const details = useWorldDetails(sampleWorld, atlas, leagueFilter(atlas.id));
  const trail = useMemo(() => {
    const vertices: number[] = [], colors: number[] = [], indices: number[] = [];
    const towns = atlas.locations.filter(item => item.kind === 'town' && !isRegionalLeagueLocation(atlas.id, item.id));
    const paved = (x: number, z: number) => towns.some(town => Math.abs(x - town.x) < 18 && Math.abs(z - town.z) < 18 && isTownPaved(x - town.x, z - town.z));
    // Solid dirt to the wobbling edge, then a feather column that fades into the lawn (alpha in the vertex colour).
    const profile = [-1.22, -1, -.74, .74, 1, 1.22], shoulder = [.86, .9, 1.02, 1.02, .9, .86], alpha = [0, .96, 1, 1, .96, 0];
    const push = (x: number, z: number, tone: number, opacity: number) => {
      vertices.push(x, terrainSurfaceHeight(sampleWorld, x, z) + .055, z);
      colors.push(tone, tone * 1.01, tone * .96, opacity);
    };
    // Each edge meanders smoothly (a value noise every 4.5 m) within the ±9% the grass clearance allows.
    const meander = (salt: number, distance: number) => {
      const cell = Math.floor(distance / 4.5), t = distance / 4.5 - cell, eased = t * t * (3 - 2 * t);
      return 1 + (detailNoise(cell, salt, 77) * (1 - eased) + detailNoise(cell + 1, salt, 77) * eased - .5) * .18;
    };
    const joints = new Map<string, number>();
    atlas.surfaceConnections.forEach(([fromId, toId], index) => {
      const from = locations.get(fromId)!, to = locations.get(toId)!;
      const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz) || 1;
      const steps = Math.max(1, Math.ceil(length / 1.8));
      const width = trailHalfWidth(fromId, toId);
      for (const id of [fromId, toId]) joints.set(id, Math.max(joints.get(id) ?? 0, width));
      const sideX = -dz / length, sideZ = dx / length;
      const offset = vertices.length / 3;
      for (let step = 0; step <= steps; step += 1) {
        const t = step / steps, x = from.x + dx * t, z = from.z + dz * t, end = step === 0 || step === steps;
        profile.forEach((lateral, column) => {
          const edge = column < 2 || column > 3, wobble = end || !edge ? 1 : meander(index * 2 + (column < 2 ? 0 : 1), t * length);
          const reach = lateral * width * wobble;
          push(x + sideX * reach, z + sideZ * reach, shoulder[column], alpha[column]);
        });
        const mx = from.x + dx * ((step + .5) / steps), mz = from.z + dz * ((step + .5) / steps);
        if (step < steps && sampleWorld(mx, mz).biome !== 'lake' && !paved(mx, mz)) {
          // Counter-clockwise seen from above, so the front face (and its normal) points at the sky.
          const base = offset + step * 6;
          for (let column = 0; column < 5; column++) {
            const a = base + column, c = base + 6 + column;
            indices.push(a, a + 1, c, a + 1, c + 1, c);
          }
        }
      }
    });
    // Round joints fill the notch where straight roads meet at an angle or end.
    for (const [id, width] of joints) {
      const node = locations.get(id)!;
      if (node.kind === 'sea' || paved(node.x, node.z) || sampleWorld(node.x, node.z).biome === 'lake') continue;
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
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }, [locations, sampleWorld, atlas]);
  useEffect(() => () => trail.dispose(), [trail]);
  return (
    <group name={`region-landmarks:${atlas.id}`} userData={{ gaesupWorldObject: 'region-landmarks' }}>
      <mesh geometry={trail} receiveShadow><SurfaceMaterial surface="path" color={regionTrailColor(atlas)} vertexColors /></mesh>
      {atlas.id !== 'kanto' && atlas.locations.filter(item => item.kind === 'special' && !isRegionalLeagueLocation(atlas.id, item.id) && !hasDungeonLandmark(atlas.id, item.id) && Math.hypot(item.x - player.x, item.z - player.z) < 70 && visible(item.x, 5, item.z, 10)).map(item => <RegionalLandmark key={item.id} region={atlas.id} x={item.x} y={terrainSurfaceHeight(sampleWorld, item.x, item.z)} z={item.z} />)}
      {atlas.locations.filter(item => isRegionalLeagueLocation(atlas.id, item.id) && Math.hypot(item.x - player.x, item.z - player.z) < 100)
        .map(item => <RegionalLeagueLandmark key={item.id} region={atlas.id} x={item.x} y={terrainSurfaceHeight(sampleWorld, item.x, item.z)} z={item.z} onEnter={onLeagueEnter && badges >= 8 ? () => onLeagueEnter(item.id) : undefined} />)}
      {/* Towns stay mounted while in range: the renderer culls them off screen, and turning the camera
          never clones their buildings, materials and sign textures again. */}
      {atlas.locations.filter(item => item.kind === 'town' && !isRegionalLeagueLocation(atlas.id, item.id) && Math.hypot(item.x - player.x, item.z - player.z) <= 85).map(town => <group key={town.id} name={`town:${town.id}`} position={[town.x, terrainSurfaceHeight(sampleWorld, town.x, town.z) + .05, town.z]}>
        <TownPaving townId={town.id} />
        {details?.towns.get(town.id) && <TownProps layout={details.towns.get(town.id)!} color={townStyle(town.id).color} />}
        {atlas.buildingOffsets(town).map(([x, z], index) => <group key={index} position={[x, 0, z]} scale={WORLD_SCALE}>
          <TownBuilding townId={town.id} townColor={townStyle(town.id).color} index={index} gym={gyms.find(item => item.locationId === town.id)} badges={badges} showGymLabel={Math.hypot(town.x - player.x, town.z - player.z) <= 14 * WORLD_SCALE} onGymEnter={onGymEnter} />
        </group>)}
        <group position={[0, 0, -6 * WORLD_SCALE]}>
          <mesh position={[0, .9, 0]} castShadow><boxGeometry args={[2.4, 1.15, .24]} /><meshStandardMaterial color="#eadb9d" /></mesh>
          <mesh position={[-.82, .35, 0]}><boxGeometry args={[.16, 1.1, .16]} /><meshStandardMaterial color="#6b4b2c" /></mesh>
          <mesh position={[.82, .35, 0]}><boxGeometry args={[.16, 1.1, .16]} /><meshStandardMaterial color="#6b4b2c" /></mesh>
        </group>
      </group>)}
      {/* Gyms away from towns (trial sites, arenas) stand at their place's edge and open the same hall. */}
      {gyms.filter(gym => locations.get(gym.locationId)?.kind !== 'town').map(gym => {
        const point = gymBuildingPoint(atlas.id, gym.locationId);
        if (!point || Math.hypot(point.x - player.x, point.z - player.z) > 85) return null;
        return <group key={gym.locationId} name={`field-gym:${gym.locationId}`} position={[point.x, terrainSurfaceHeight(sampleWorld, point.x, point.z), point.z]} scale={WORLD_SCALE}>
          <TownBuilding townId={gym.locationId} townColor={townStyle(gym.locationId).color} index={2} gym={gym} badges={badges} showGymLabel={Math.hypot(point.x - player.x, point.z - player.z) <= 14 * WORLD_SCALE} onGymEnter={onGymEnter} />
        </group>;
      })}
      <CaveMouths atlas={atlas} sampleWorld={sampleWorld} player={player} visible={visible} />
      {atlas.gates.filter(gate => gate.visible !== false).map(gate => {
        const from = locations.get(gate.from)!, to = locations.get(gate.to)!;
        const x = gate.position?.x ?? (from.x + to.x) / 2, z = gate.position?.z ?? (from.z + to.z) / 2;
        const y = terrainSurfaceHeight(sampleWorld, x, z);
        const halfWidth = atlas.gateHalfWidth(gate);
        return <ProgressGate key={gate.id} gate={gate} from={from} to={to} y={y} halfWidth={halfWidth} badges={badges} showLabel={Math.hypot(x - player.x, z - player.z) <= (badges < gate.requiredBadges ? 26 : 14)} />;
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
  // The clone draws with the cached asset's materials, which outlive it.
  useEffect(() => () => releaseRenderObjects(object), [object]);
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

function PokemonModel({ creature, url, onStatus }: { creature: WorldCreature; url: string; onStatus?: OpenWorldViewOptions['onModelStatus'] }) {
  const [renderFailed, setRenderFailed] = useState(false);
  const { gltf, failed } = useModelStatus(url, renderFailed);
  const [drawnModel, setDrawnModel] = useState<Object3D | null>(null);
  const root = useRef<Group>(null);
  const mixer = useRef<AnimationMixer | null>(null);
  const activeAction = useRef<AnimationAction | undefined>(undefined);
  const ground = useRef<((groundY: number) => number) | undefined>(undefined);
  const nextGroundingAt = useRef(0);
  const groundingOffset = useRef(0);
  const groundedAction = useRef<WorldCreature['action'] | undefined>(undefined);
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
    try {
      return normalizePokemonModel(scene, gltf.animations, creature.displayHeight ?? 1.2, { speciesId: creature.speciesId, types: getSpecies(creature.speciesId).types }, gltf.scene);
    } catch {
      disposeNormalizedPokemonMaterials(scene);
      const skeletons = new Set<SkinnedMesh['skeleton']>();
      scene.traverse(object => { if (object instanceof SkinnedMesh) skeletons.add(object.skeleton); });
      skeletons.forEach(skeleton => skeleton.dispose());
      return null;
    }
  }, [creature.displayHeight, creature.speciesId, gltf]);
  const status = failed || renderFailed || (gltf && !normalized) ? 'failed' : normalized && drawnModel === normalized.visual ? 'ready' : 'loading';
  useLayoutEffect(() => { onStatus?.(creature.id, status, creature.speciesId); }, [creature.id, creature.speciesId, onStatus, status]);
  useLayoutEffect(() => () => onStatus?.(creature.id, 'untracked', creature.speciesId), [creature.id, creature.speciesId, onStatus]);
  useLayoutEffect(() => {
    setRenderFailed(!!gltf && !normalized);
    if (!normalized) return;
    let active = true, drawn = false;
    // Only visible time counts toward the first draw: a hidden tab draws nothing at all.
    const cancelDeadline = visibleTimeout(() => { if (active && !drawn) setRenderFailed(true); }, 45_000);
    const restore: Array<() => void> = [];
    normalized.visual.traverse(object => {
      if (!(object instanceof Mesh)) return;
      const previous = object.onAfterRender;
      object.onAfterRender = function (...args) {
        previous.apply(this, args);
        if (!active) return;
        object.userData.pokemonDrawCount = (object.userData.pokemonDrawCount ?? 0) + 1;
        // A first draw after the deadline clears that failure too.
        if (!drawn) { drawn = true; cancelDeadline(); setRenderFailed(false); setDrawnModel(normalized.visual); }
      };
      restore.push(() => { object.onAfterRender = previous; });
    });
    return () => { active = false; cancelDeadline(); restore.forEach(reset => reset()); };
  }, [gltf, normalized]);
  useFrame(({ clock, camera }, delta) => {
    mixer.current?.update(Math.min(delta, .05) * (creature.action === 'walk' ? walkCycleRate(creature.movementSpeed, creature.displayHeight, activeAction.current && clipGroundSpeed(activeAction.current.getClip())) : 1));
    if (!root.current) return;
    const gait = MathUtils.clamp(creature.movementSpeed ?? 2.4, 1.2, 5.2);
    const phase = clock.elapsedTime * (creature.action === 'walk' ? gait * 2.7 : 2.4) + creature.speciesId;
    root.current.position.y = 0;
    const pulse = creature.action === 'attack' ? 1 + Math.max(0, Math.sin(phase * 1.8)) * .12 : 1;
    root.current.scale.set(pulse, creature.action === 'hurt' ? .88 : 1, pulse);
    // The hurt shake is cosmetic: the floor fit sees the upright pose, which stays within the support-set tilt.
    const tilt = creature.action === 'fainted' ? Math.PI / 2 : !gltf?.animations.length && creature.action === 'walk' ? Math.sin(phase) * .045 : 0;
    root.current.rotation.z = tilt;
    if (!ground.current && normalized) ground.current = createGrounding(normalized.visual, root.current, normalized.grounding);
    const animated = !!gltf?.animations.length;
    // Grounding skins the support vertices on the CPU, so clip playback stays at
    // the display rate while the floor fit runs at 30 Hz near the camera, 10 Hz
    // far away, and 4 Hz while a fainted body lies still (full vertex scan).
    // The procedural walk bounce is re-applied every frame below. Its schedule uses
    // performance time: R3F restarts its clock at zero whenever the frameloop changes.
    const now = performance.now() / 1000;
    if (creature.action === 'attack' || now >= nextGroundingAt.current || groundedAction.current !== creature.action) {
      root.current.parent?.getWorldPosition(worldPosition.current);
      ground.current?.(worldPosition.current.y);
      groundingOffset.current = root.current.position.y;
      const far = camera.position.distanceTo(worldPosition.current) > 30;
      nextGroundingAt.current = now + (creature.action === 'fainted' ? 1 / 4 : far ? 1 / 10 : 1 / 30);
      groundedAction.current = creature.action;
    }
    root.current.position.y = groundingOffset.current;
    if (!animated && creature.action === 'walk') root.current.position.y += Math.abs(Math.sin(phase)) * .07;
    if (creature.action === 'hurt') root.current.rotation.z = Math.sin(clock.elapsedTime * 55) * .09;
  }, -1);
  useEffect(() => {
    ground.current = undefined;
    groundingOffset.current = 0;
    nextGroundingAt.current = 0;
    groundedAction.current = undefined;
  }, [normalized]);
  useEffect(() => () => {
    if (!normalized) return;
    disposeNormalizedPokemonMaterials(normalized.animatedRoot);
    // Uncorrected surfaces are the cached asset's own materials; they keep this clone's render objects otherwise.
    releaseRenderObjects(normalized.visual);
    const skeletons = new Set<SkinnedMesh['skeleton']>();
    normalized.animatedRoot.traverse(object => { if (object instanceof SkinnedMesh) skeletons.add(object.skeleton); });
    skeletons.forEach(skeleton => skeleton.dispose());
  }, [normalized]);

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
    // Pace in display heights per second picks the walk loop whose stride fits the ground speed.
    const pace = (creature.movementSpeed ?? 2.4) / Math.max(.3, creature.displayHeight ?? 1.2);
    const { clip, matched } = selectPokemonMotionClip(gltf.animations,
      creature.action === 'attack' ? 'attack' : creature.action === 'hurt' ? 'damage' : creature.action === 'walk' ? 'walk' : 'idle', pace);
    if (!clip) return;
    const next = mixer.current.clipAction(clip), previous = activeAction.current;
    if (next === previous && next.isRunning()) return;
    next.reset().setEffectiveWeight(1).setEffectiveTimeScale(1);
    const playOnce = (creature.action === 'attack' || creature.action === 'hurt') && matched;
    next.setLoop(playOnce ? LoopOnce : LoopRepeat, playOnce ? 1 : Infinity);
    next.clampWhenFinished = playOnce;
    next.play();
    if (previous && previous !== next) next.crossFadeFrom(previous, .2, false);
    activeAction.current = next;
  }, [creature.action, creature.displayHeight, creature.movementSpeed, gltf, normalized]);

  if (!normalized) return <ModelStatus name={status === 'failed' ? '모델 오류' : ''} />;
  // Past its draw deadline the model stays in the scene, so a later draw can still clear the failure.
  return <>
    {renderFailed && <ModelStatus name="모델 오류" />}
    <group ref={root} name={`pokemon-model:${creature.speciesId}`} userData={{ formIdentifier: creature.formIdentifier, sourceUrl: url }} dispose={null}>
      <primitive object={normalized.visual} />
    </group>
  </>;
}

function ModelStatus({ name }: { name: string }) {
  return <group name={`pokemon-model-status:${name}`}>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .04, 0]}><ringGeometry args={[.45, .6, 24]} /><meshBasicMaterial color="#d2d9d1" transparent opacity={.65} /></mesh>
    {name && <WorldLabel name={name} x={0} y={.65} z={0} />}
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

function PokemonFormUnavailable({ creature, onStatus }: { creature: WorldCreature; onStatus?: OpenWorldViewOptions['onModelStatus'] }) {
  useLayoutEffect(() => {
    onStatus?.(creature.id, 'untracked', creature.speciesId);
  }, [creature.id, creature.speciesId, onStatus]);
  return null;
}

function TransformationEffect({ creature }: { creature: WorldCreature }) {
  const ref = useRef<Group>(null);
  const kind = creature.transformationKind;
  const colors = MOVE_COLORS.psychic;
  useFrame(({ clock }) => {
    if (!ref.current || !kind) return;
    ref.current.rotation.y = clock.elapsedTime * -.8;
    ref.current.scale.setScalar(1 + Math.sin(clock.elapsedTime * 3) * .035);
  });
  if (!kind) return null;
  return <group ref={ref} name={`pokemon-transformation:${kind}`}>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .07, 0]}>
      <torusGeometry args={[.68, .035, 8, 40]} />
      <meshStandardMaterial color={colors[0]} emissive={colors[1]} emissiveIntensity={1.5} transparent opacity={.82} />
    </mesh>
  </group>;
}

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
        {creature.cue && <b key={creature.cue.key} className={`ow-move-cue ow-move-${creature.cue.moveType}`}>{creature.cue.text}</b>}
        <strong>{remote ? remote.name : `${creature.name} · Lv.${creature.level}`}{statusLabel(creature.status) && <em className={`ow-status ow-status-${creature.status}`}>{statusLabel(creature.status)}</em>}</strong>
        {remote && <span>{remote.activity === 'battle' ? '배틀 중' : remote.activity === 'moving' ? '이동 중' : '대기'}</span>}
        {!remote && <div className="ow-hp-track"><i className="ow-hp-fill" style={{ width: `${Math.max(0, Math.min(1, hp)) * 100}%`, background: hp > .45 ? '#82d179' : hp > .2 ? '#e5ca55' : '#e56f59' }} /></div>}
      </div>
    </Html>
  </group>;
}

/** Hides a nameplate while it covers one with higher priority on screen (selected, partner, battle, then nearest). */
function NameplateDeclutter({ order }: { order: readonly string[] }) {
  const gl = useThree(state => state.gl), nextCheck = useRef(0);
  useFrame(() => {
    // Performance time: R3F restarts its clock at zero whenever the frameloop changes (saves pause it).
    const now = performance.now();
    if (now < nextCheck.current) return;
    nextCheck.current = now + 120;
    const root = gl.domElement.parentElement; if (!root) return;
    const labels = new Map([...root.querySelectorAll<HTMLElement>('.ow-creature-label')].map(label => [label.dataset.creatureId, label]));
    const kept: DOMRect[] = [];
    for (const id of order) {
      const label = labels.get(id); if (!label) continue;
      const box = label.getBoundingClientRect();
      const covered = kept.some(other => box.left < other.right - 4 && box.right > other.left + 4 && box.top < other.bottom - 2 && box.bottom > other.top + 2);
      if (label.classList.contains('ow-label-covered') !== covered) label.classList.toggle('ow-label-covered', covered);
      if (!covered) kept.push(box);
    }
  });
  return null;
}

function Creature({ creature, selected, distance, options, showLabels, model }: {
  creature: WorldCreature;
  selected: boolean;
  showLabels: boolean;
  model: boolean;
  distance: number;
  options: OpenWorldViewOptions;
}) {
  const supportedModel = hasPokemonModel(creature.speciesId);
  const modelKey = creature.formModelUrl ?? creature.formIdentifier ?? String(creature.speciesId);
  const [modelState, setModelState] = useState({ modelKey, status: 'loading' });
  const onModelStatus = useCallback<NonNullable<OpenWorldViewOptions['onModelStatus']>>((id, status, speciesId) => {
    setModelState(previous => previous.modelKey === modelKey && previous.status === status ? previous : { modelKey, status });
    options.onModelStatus?.(id, status, speciesId);
  }, [modelKey, options.onModelStatus]);
  const modelReady = model && modelState.modelKey === modelKey && modelState.status === 'ready';
  const modelUrl = creature.formModelUrl ?? (supportedModel && !creature.formIdentifier ? (options.modelUrl ?? (id => `/models/pokemon/${id}.glb`))(creature.speciesId) : undefined);
  // The last model that finished loading stands in while a new form or species loads (Mega Evolution, evolution),
  // so the creature never vanishes for the length of a download. Both share one keyed list, so the previous model
  // keeps its instance, clone and animation instead of being rebuilt, at the size it was drawn with.
  const [shown, setShown] = useState<{ key: string; url: string; speciesId: number; displayHeight?: number } | null>(null);
  useEffect(() => {
    if (modelReady && modelUrl) setShown({ key: modelKey, url: modelUrl, speciesId: creature.speciesId, displayHeight: creature.displayHeight });
  }, [creature.displayHeight, creature.speciesId, modelKey, modelReady, modelUrl]);
  const standIn = model && shown && shown.key !== modelKey && !modelReady ? shown : undefined;
  const standInCreature = useMemo(() => standIn
    ? { ...creature, speciesId: standIn.speciesId, displayHeight: standIn.displayHeight, formIdentifier: undefined, formModelUrl: undefined } : undefined, [creature, standIn]);
  useEffect(() => {
    if (supportedModel || creature.formIdentifier) return;
    options.onModelStatus?.(creature.id, 'failed', creature.speciesId);
    return () => options.onModelStatus?.(creature.id, 'untracked', creature.speciesId);
  }, [creature.formIdentifier, creature.id, creature.speciesId, options, supportedModel]);
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
    // Remote-player snapshots also move independently of our simulation gate.
    // Do not interpolate an empty actor while its model is still unavailable; a stand-in keeps moving.
    if (!modelReady && !standIn) return;
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
  if (creature.formIdentifier && !creature.formModelUrl) return <PokemonFormUnavailable creature={creature} onStatus={onModelStatus} />;
  return (
    <group
      ref={root}
      name={`creature:${creature.id}`}
      onClick={event => { event.stopPropagation(); if (!creature.remotePlayer) options.onSelect(creature.id); }}
      onDoubleClick={event => { event.stopPropagation(); if (!creature.remotePlayer) options.onInteract?.(creature.id); }}
    >
      {[
        standIn && standInCreature ? <PokemonModel key={standIn.key} creature={standInCreature} url={standIn.url} /> : null,
        model && modelUrl ? <PokemonModel key={modelKey} creature={creature} url={modelUrl} onStatus={onModelStatus} /> : null,
      ]}
      {!(model && modelUrl) && !supportedModel && <ModelStatus name="3D 미지원 · 이동 중지" />}
      <TransformationEffect creature={creature} />
      {(selected || creature.inBattle) && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .04, 0]}><ringGeometry args={[1.1, 1.34, 40]} /><meshBasicMaterial color={creature.inBattle ? '#f09155' : '#f6dd67'} transparent opacity={.86} /></mesh>}
      <AttackEffect active={modelReady && creature.action === 'attack'} moveType={creature.moveType} />
      {modelReady && showLabels && (distance <= 28 || selected || creature.inBattle || creature.remotePlayer) && <CreatureBillboard creature={creature} hp={hp} distance={distance} emphasized={selected || !!creature.inBattle || !!creature.remotePlayer} />}
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

/**
 * The sun: the one shadow-casting light outdoors, following the player. Caves, dungeon floors and halls use
 * IndoorLighting's angled key light instead.
 */
function Sunlight({ player, mobile, color = '#fff3da', intensity = 2.55 }: { player: { x: number; z: number }; mobile: boolean; color?: string; intensity?: number }) {
  const sun = useRef<DirectionalLight>(null);
  const target = useMemo(() => new Object3D(), []);
  const elapsed = useRef(1);
  const reach = mobile ? 16 : 24, [offsetX, height, offsetZ] = [28, 52, 22];
  useFrame((_, delta) => {
    elapsed.current += delta;
    if (sun.current && elapsed.current >= 1 / (mobile ? 10 : 15)) {
      sun.current.shadow.needsUpdate = true;
      elapsed.current = 0;
    }
  });
  const x = Math.round(player.x / 4) * 4, z = Math.round(player.z / 4) * 4;
  useLayoutEffect(() => { target.position.set(x, 0, z); target.updateMatrixWorld(); }, [x, z, target]);
  return <><primitive object={target} /><directionalLight ref={sun} target={target} position={[x + offsetX, height, z + offsetZ]} intensity={intensity} color={color} castShadow
    shadow-autoUpdate={false} shadow-mapSize={[mobile ? 256 : 512, mobile ? 256 : 512]}
    shadow-camera-near={1} shadow-camera-far={120} shadow-camera-left={-reach} shadow-camera-right={reach}
    shadow-camera-top={reach} shadow-camera-bottom={-reach} shadow-normalBias={.06} shadow-bias={-.0004} /></>;
}

function FoodInstances({ foods, sampleWorld }: { foods: OpenWorldRenderSnapshot['foods']; sampleWorld: (x: number, z: number) => WorldSample }) {
  const ref = useRef<InstancedMesh>(null);
  // A new count rebuilds the mesh around the same material; the replaced mesh frees its render objects.
  const attach = useReleasingRef(ref);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const transform = new Matrix4();
    foods?.forEach((food, i) => ref.current!.setMatrixAt(i, transform.makeTranslation(food.x, (food.y ?? sampleWorld(food.x, food.z).height) + .25, food.z)));
    ref.current.instanceMatrix.needsUpdate = true;
    ref.current.computeBoundingSphere();
  }, [foods, sampleWorld]);
  if (!foods?.length) return null;
  return <instancedMesh ref={attach} args={[undefined, undefined, foods.length]}><icosahedronGeometry args={[.24, 1]} /><meshStandardMaterial color="#efca58" emissive="#785e16" emissiveIntensity={.35} /></instancedMesh>;
}

function useViewWindow() {
  const { camera, size } = useThree();
  const [windowState, setWindowState] = useState<{ frustum: Frustum | null; mobile: boolean }>({ frustum: null, mobile: size.width <= 720 });
  const elapsed = useRef(1);
  const previous = useRef({ px: NaN, py: NaN, pz: NaN, qx: NaN, qy: NaN, qz: NaN, qw: NaN, width: NaN, height: NaN });
  useFrame((_, delta) => {
    elapsed.current += delta;
    if (elapsed.current < .16) return;
    elapsed.current = 0;
    const next = {
      px: Math.round(camera.position.x * 100), py: Math.round(camera.position.y * 100), pz: Math.round(camera.position.z * 100),
      qx: Math.round(camera.quaternion.x * 100), qy: Math.round(camera.quaternion.y * 100), qz: Math.round(camera.quaternion.z * 100), qw: Math.round(camera.quaternion.w * 100),
      width: size.width, height: size.height,
    };
    const prior = previous.current;
    if (next.px === prior.px && next.py === prior.py && next.pz === prior.pz && next.qx === prior.qx && next.qy === prior.qy
      && next.qz === prior.qz && next.qw === prior.qw && next.width === prior.width && next.height === prior.height) return;
    previous.current = next;
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
  const sceneId = snapshot.sceneId ?? surfaceSceneId(atlas.id), cave = getCaveScene(sceneId), gymHall = cave ? undefined : getGymScene(sceneId);
  // Parks are open air: the outdoor sun, sky and ground lighting, no dungeon look.
  const indoor = Boolean((cave && !cave.park) || gymHall);
  const sample = cave?.sample ?? gymHall?.sample ?? atlas.sample;
  const waterMaterials = useTerrainMaterials(atlas.palette.water, indoor ? undefined : atlas.sample);
  const groundMaterial = waterMaterials.ground;
  // Fixed daytime presentation: never rebuild lighting or sky for a world clock tick.
  const daylight = 1;
  const look = cave && indoor ? DUNGEON_LOOKS[cave.style] : undefined;
  const skyColor = useMemo(() => new Color(look ? look.sky : gymHall?.kind === 'league' ? '#2c2618' : gymHall ? '#2a2f33' : '#b2e1f4'), [look, gymHall]);
  const worldOptions = useMemo(() => ({ ...options, sampleWorld: sample }), [options, sample]);
  const windowState = useViewWindow();
  // Ground once shown stays mounted while in range; only walking away or a detail change replaces a chunk.
  const shownChunks = useRef<ReadonlySet<string>>(new Set());
  const chunks = useMemo(() => {
    const next = terrainChunks(snapshot.player, windowState.visible, shownChunks.current);
    shownChunks.current = new Set(next.map(chunk => chunk.key));
    return next;
  }, [snapshot.player.x, snapshot.player.z, windowState.visible]);
  const visible = useMemo(() => creatureLods(gymHall ? snapshot.entities.filter(creature => !creature.id.startsWith('wild-') && gymHall.contains(creature.x, creature.z)) : snapshot.entities,
    snapshot.player, windowState.visible, windowState.mobile, snapshot.selectedWildId),
    [gymHall, snapshot.entities, snapshot.player.x, snapshot.player.z, snapshot.selectedWildId, windowState.mobile, windowState.visible]);
  const labelIds = useMemo(() => {
    if (!showLabels) return new Set<string>();
    const priority = (item: typeof visible[number]) => item.creature.id === snapshot.selectedWildId ? 0
      : item.creature.id.startsWith('companion:') ? 1 : item.creature.inBattle ? 2 : item.creature.remotePlayer ? 3 : 4;
    return new Set([...visible].sort((a, b) => priority(a) - priority(b) || a.distance - b.distance)
      .slice(0, windowState.mobile ? 3 : 6).map(item => item.creature.id));
  }, [showLabels, snapshot.selectedWildId, visible, windowState.mobile]);
  const labelOrder = useMemo(() => [...labelIds], [labelIds]);
  const { scene } = useThree();
  useLayoutEffect(() => {
    // Scene is rendered inside a group. JSX attach="background"/"fog" there
    // would only assign unused properties to that group, not the root scene.
    const previousBackground = scene.background, previousFog = scene.fog;
    scene.background = skyColor; scene.fog = null;
    return () => { scene.background = previousBackground; scene.fog = previousFog; };
  }, [scene, skyColor]);
  const streaming = useMemo(() => {
    let highDetailChunks = 0, detailedCreatures = 0;
    for (const chunk of chunks) if (chunk.segments === 12) highDetailChunks++;
    for (const item of visible) if (item.model && hasPokemonModel(item.creature.speciesId)) detailedCreatures++;
    return { region: atlas.id, sceneId, daylight, player: { x: snapshot.player.x, z: snapshot.player.z }, terrainChunks: indoor ? 0 : chunks.length,
      terrainTotal: ((WORLD_MAX - WORLD_MIN) / TERRAIN_CHUNK_SIZE) ** 2, highDetailChunks, visibleCreatures: visible.length,
      detailedCreatures, modelLimit: windowState.mobile ? 4 : 8 };
  }, [atlas.id, indoor, chunks, sceneId, snapshot.player.x, snapshot.player.z, visible, windowState.mobile]);
  const streamingElapsed = useRef(1);
  useFrame((_, delta) => {
    // Probe metadata does not affect rendering. Refreshing it four times a second
    // keeps async cache counters useful without allocating and filtering per frame.
    streamingElapsed.current += delta;
    if (streamingElapsed.current < .25) return;
    streamingElapsed.current = 0;
    scene.userData.streaming = { ...streaming, ...modelCacheStats() };
  });
  return (
    <>
      {indoor ? <IndoorLighting scene={cave} hall={gymHall?.kind} player={snapshot.player} mobile={windowState.mobile} sample={sample} creatures={visible} />
        : <><hemisphereLight color="#eaf6ff" groundColor="#6f8a57" intensity={1.22} /><Sunlight player={snapshot.player} mobile={windowState.mobile} /></>}
      <SkyLighting />
      <Physics gravity={[0, -18, 0]} timeStep="vary">
        {cave?.park ? <ParkInterior key={cave.sceneId} scene={cave} atlas={atlas} player={snapshot.player} mobile={windowState.mobile} onNavigate={onNavigate} />
          : cave?.room ? <DungeonInterior scene={cave} onNavigate={onNavigate} />
          : cave ? <CaveInterior cave={cave} player={snapshot.player} mobile={windowState.mobile} onNavigate={onNavigate} />
          : gymHall?.kind === 'league' ? <LeagueInterior hall={gymHall} trainer={snapshot.hallTrainer} busy={Boolean(snapshot.busy)} player={snapshot.player} spriteUrl={options.spriteUrl} modelUrl={options.modelUrl} onNavigate={onNavigate} onExit={() => options.onGymExit?.()} onChallenge={() => options.onGymChallenge?.()} />
          : gymHall ? <GymInterior hall={gymHall} gym={snapshot.gyms?.find(gym => gym.locationId === gymHall.locationId)} party={snapshot.gymParty ?? []} spriteUrl={options.spriteUrl} badges={snapshot.badges ?? 0} busy={Boolean(snapshot.busy)} player={snapshot.player} onNavigate={onNavigate} onExit={() => options.onGymExit?.()} onChallenge={() => options.onGymChallenge?.()} /> : <>
          <group key={`terrain:${sceneId}`}>{chunks.map(chunk => <Terrain key={`${chunk.key}:${chunk.segments}`} sampleWorld={sample} atlas={atlas} chunk={chunk} material={groundMaterial} waterMaterial={waterMaterials[chunk.distance <= (windowState.mobile ? 24 : 40) ? 'detailed' : 'simple']} onNavigate={onNavigate} />)}</group>
          <Nature key={`nature:${sceneId}`} sampleWorld={sample} player={snapshot.player} atlas={atlas} isVisible={windowState.visible} mobile={windowState.mobile} />
          <FieldGrass key={`grass:${sceneId}`} atlas={atlas} sampleWorld={sample} player={snapshot.player} mobile={windowState.mobile} skipTown={leagueFilter(atlas.id)} />
          <ExplorationLandmarks atlas={atlas} sampleWorld={sample} player={snapshot.player} visibility={windowState.visible} onNavigate={onNavigate} badges={snapshot.badges ?? 0} />
          <TrailAndWater key={`water:${sceneId}`} sampleWorld={sample} player={snapshot.player} atlas={atlas} gyms={snapshot.gyms} visible={windowState.visible} badges={snapshot.badges ?? 0} onGymEnter={options.onGymEnter} onLeagueEnter={options.onLeagueEnter} />
          <DungeonEntrances regionId={atlas.id} player={snapshot.player} sample={sample} onEnter={portalId => options.onPortal?.(portalId)} />
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
        <FieldItemPickups items={snapshot.fieldItems ?? []} player={snapshot.player} sample={sample} onNavigate={onNavigate} onCollect={id => options.onCollectItem?.(id)} />
        {!gymHall && <FoodInstances foods={snapshot.foods} sampleWorld={sample} />}
      </Physics>
      {snapshot.guide && !gymHall && <DestinationPointer guide={snapshot.guide} sample={sample} />}
      <TargetRoute snapshot={snapshot} destination={destination} sample={sample} />
      {!gymHall && <ScenePortals sceneId={sceneId} regionId={atlas.id} player={snapshot.player} badges={snapshot.badges ?? 0} sample={sample} onNavigate={onNavigate} onPortal={() => options.onPortal?.('nearest')} />}
      {visible.map(({ creature, distance, model }) => <Creature key={creature.id} creature={creature} selected={creature.id === snapshot.selectedWildId} showLabels={labelIds.has(creature.id)} distance={distance} model={model} options={worldOptions} />)}
      <NameplateDeclutter order={labelOrder} />
      <MoveEffects effects={snapshot.effects} sample={sample} />
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

class WorldLoadBoundary extends Component<{ children: ReactNode; onError?: (error: unknown) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.onError?.(error); }
  render() { return this.state.failed ? null : this.props.children; }
}

function OpenWorldApp({ store, options, lifetime, commands }: { commands: ViewCommands; store: SnapshotStore; options: OpenWorldViewOptions; lifetime: ViewLifetime }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.get, store.get);
  const renderPaused = useSyncExternalStore(onRenderSuspension, renderingSuspended, renderingSuspended);
  const runtime = useMemo(() => createGaesupRuntime({ plugins: [createCameraPlugin()], pluginRuntime: 'client' }), []);
  const [ready, setReady] = useState(false);
  const fixedProbeDpr = useMemo(() => {
    if (!import.meta.env.DEV) return undefined;
    const query = new URLSearchParams(location.search), dpr = Number(query.get('fixedDpr'));
    return query.has('renderProbe') && dpr >= .7 && dpr <= 1.5 ? dpr : undefined;
  }, []);
  const [renderDpr, setRenderDpr] = useState(() => fixedProbeDpr ?? Math.min(window.devicePixelRatio || 1, 1.5));
  const [rendererGeneration, setRendererGeneration] = useState(0);
  const [rendererLost, setRendererLost] = useState(false);
  const rendererEpoch = useRef(0);
  const [destination, setDestination] = useState<WorldPoint | null>(null);
  const createRenderer = useMemo(() => {
    let pending: ReturnType<typeof createOpenWorldRenderer> | undefined;
    return (defaults: Parameters<typeof createOpenWorldRenderer>[0]) => pending ??= createOpenWorldRenderer(defaults, {
      forceWebGL: new URLSearchParams(location.search).get('renderer') === 'webgl',
      onDeviceLost: () => {
        if (!lifetime.active || rendererEpoch.current !== rendererGeneration) return;
        rendererEpoch.current++;
        options.onRendererLost?.();
        setRendererLost(true);
      },
    });
  }, [rendererGeneration, lifetime, options]);
  useEffect(() => { setDestination(null); }, [snapshot.regionId, snapshot.sceneId]);
  const navigate = useCallback((point: WorldPoint) => {
    if (![point.x, point.z].every(Number.isFinite) || options.onNavigationStart?.() === false) return false;
    setDestination(point); return true;
  }, [options]);
  useEffect(() => { commands.navigateTo = navigate; return () => { delete commands.navigateTo; }; }, [commands, navigate]);
  useEffect(() => {
    let active = true;
    runtime.setup().then(() => {
      if (active) { setReady(true); options.onLoadProgress?.(20, '3D 런타임 준비 완료 · 그래픽 장치 연결 중'); }
    }).catch(error => { if (active) options.onLoadError?.(error); });
    return () => { active = false; void runtime.dispose(); };
  }, [runtime, options]);
  return (
    <GaesupWorld
      runtime={runtime}
      runtimeRevision={ready ? 1 : 0}
      mode={{ type: 'character', controller: 'keyboard', control: 'thirdPerson' }}
      cameraOption={{ type: 'thirdPerson', distance: 12, height: 5, fov: 48, enableZoom: true, minZoom: 4, maxZoom: 28, enableCollision: true }}
      worldSize={{ width: WORLD_MAX - WORLD_MIN, height: 48, depth: WORLD_MAX - WORLD_MIN }}
      enablePhysics
      gravity={[0, -18, 0]}
    >
      {rendererLost ? <div className="ow-loading ow-render-error" role="alert">
        <p>그래픽 연결이 끊겨 이동·배틀을 멈췄습니다. 진행 상태는 유지됩니다.</p>
        <button type="button" data-world-renderer-retry onClick={() => {
          rendererEpoch.current++;
          setRendererGeneration(rendererEpoch.current);
          setRendererLost(false);
        }}>3D 화면 다시 시작</button>
      </div> : <WorldLoadBoundary key={rendererGeneration} onError={options.onLoadError}><Canvas eventSource={lifetime.host} frameloop={renderPaused ? 'never' : 'always'} shadows="percentage" dpr={renderDpr} camera={{ position: [12, 18, 16], fov: 48, near: .1, far: 160 }} gl={defaults => createRenderer({ ...defaults, canvas: defaults.canvas as HTMLCanvasElement })} onPointerMissed={() => options.onSelect(null)} onCreated={state => {
        // Canvas can finish its async WebGPU setup after logout or a tab change.
        // Keep the event target valid, then retire that stale R3F root before it
        // can render or install scene controls for the previous adventure.
        if (!lifetime.active || rendererEpoch.current !== rendererGeneration) {
          state.setFrameloop('never');
          queueMicrotask(() => unmountComponentAtNode(state.gl.domElement));
          return;
        }
        options.onLoadProgress?.(45, '그래픽 장치 준비 완료 · 지형과 모델을 불러오는 중');
      }}>
        <ActiveWorld lifetime={lifetime}>
        {fixedProbeDpr === undefined && <AdaptiveResolution setDpr={setRenderDpr} />}
        <SaveRenderBudget />
        {new URLSearchParams(location.search).has('renderProbe') && <RenderProbe />}
        <group name="gaesup-world">
          <Scene commands={commands} snapshot={snapshot} options={options} showLabels destination={destination} onNavigate={navigate} onDestination={setDestination} />
        </group>
        </ActiveWorld>
      </Canvas></WorldLoadBoundary>}
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
    retryModels() { retryFailedModels(); window.dispatchEvent(new Event(MODEL_RETRY_EVENT)); },
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
