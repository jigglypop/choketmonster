import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Physics, RigidBody } from '@react-three/rapier';
import { GaesupWorld, createCameraPlugin } from 'gaesup-world';
import { createGaesupRuntime } from 'gaesup-world/runtime';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  AnimationMixer,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Material,
  Matrix4,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Spherical,
  Texture,
  TextureLoader,
  Vector3,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type {
  OpenWorldProp,
  OpenWorldRenderSnapshot,
  OpenWorldView,
  OpenWorldViewOptions,
  WorldCreature,
  WorldSample,
} from './types';
import { createSceneryPlacements, SCENERY_ASSETS, TRAIL_POINTS, type SceneryPlacement } from './scenery';
import { createGrounding, terrainSurfaceHeight, TERRAIN_SEGMENTS } from './grounding';
import { normalizePokemonModel } from './model-normalization';
import './view.css';

const WORLD_MIN = -120;
const WORLD_MAX = 120;
const MAX_VISIBLE = 12;
const MODEL_LOD_DISTANCE = 54;
const MODEL_CACHE_LIMIT = 16;
const loader = new GLTFLoader();
const DEFAULT_CAMERA_OFFSET = new Vector3(12, 18, 16);

type CameraAction = 'left' | 'right' | 'up' | 'down' | 'zoom-in' | 'zoom-out' | 'reset';
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

function acquireModel(url: string): Promise<{ gltf: GLTF; release(): void }> {
  let entry = modelCache.get(url);
  if (!entry) {
    entry = {
      promise: loader.loadAsync(url),
      refs: 0,
      lastUsed: performance.now(),
    };
    modelCache.set(url, entry);
    entry.promise.then(gltf => { entry!.gltf = gltf; }).catch(() => modelCache.delete(url));
  }
  entry.refs += 1;
  entry.lastUsed = performance.now();
  return entry.promise.then(gltf => ({
    gltf,
    release: () => {
      const current = modelCache.get(url);
      if (!current) return;
      current.refs = Math.max(0, current.refs - 1);
      current.lastUsed = performance.now();
      pruneModelCache();
    },
  })).catch(error => {
    entry!.refs = Math.max(0, entry!.refs - 1);
    throw error;
  });
}

function useCachedModel(url: string): GLTF | null {
  const [gltf, setGltf] = useState<GLTF | null>(null);
  useEffect(() => {
    let active = true;
    let release: (() => void) | undefined;
    setGltf(null);
    acquireModel(url).then(result => {
      release = result.release;
      if (active) setGltf(result.gltf);
      else release();
    }).catch(() => { if (active) setGltf(null); });
    return () => {
      active = false;
      release?.();
    };
  }, [url]);
  return gltf;
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

function Terrain({ sampleWorld, visual = true }: { sampleWorld: (x: number, z: number) => WorldSample; visual?: boolean }) {
  const geometry = useMemo(() => {
    const plane = new PlaneGeometry(240, 240, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
    plane.rotateX(-Math.PI / 2);
    const positions = plane.attributes.position;
    const colors = new Float32Array(positions.count * 3);
    const palette: Record<WorldSample['biome'], Color> = {
      meadow: new Color('#729951'),
      forest: new Color('#315f3d'),
      lake: new Color('#4d9195'),
      rock: new Color('#877f69'),
    };
    for (let index = 0; index < positions.count; index += 1) {
      const x = positions.getX(index);
      const z = positions.getZ(index);
      const sample = sampleWorld(x, z);
      positions.setY(index, sample.height);
      const color = palette[sample.biome];
      colors[index * 3] = color.r;
      colors[index * 3 + 1] = color.g;
      colors[index * 3 + 2] = color.b;
    }
    plane.setAttribute('color', new BufferAttribute(colors, 3));
    plane.computeVertexNormals();
    return plane;
  }, [sampleWorld]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <RigidBody type="fixed" colliders="trimesh" friction={1}>
      <mesh geometry={geometry} receiveShadow userData={{ gaesupWorldObject: 'terrain' }}>
        <meshStandardMaterial vertexColors roughness={.96} metalness={0} visible={visual} />
      </mesh>
    </RigidBody>
  );
}

function InstancedPart({ geometry, material, sourceMatrix, placements, shadows }: {
  geometry: BufferGeometry;
  material: Material | Material[];
  sourceMatrix: Matrix4;
  placements: readonly SceneryPlacement[];
  shadows: boolean;
}) {
  const mesh = useRef<InstancedMesh>(null);
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

function InstancedAsset({ url, placements, shadows }: { url: string; placements: readonly SceneryPlacement[]; shadows: boolean }) {
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
          clone.roughness = .95;
          clone.needsUpdate = true;
        }
        return clone;
      });
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
  return <>{parts.map((part, index) => <InstancedPart key={index} geometry={part.geometry} material={part.material} sourceMatrix={part.matrix} placements={placements} shadows={shadows} />)}</>;
}

function Nature({ sampleWorld }: { sampleWorld: (x: number, z: number) => WorldSample }) {
  const placements = useMemo(() => createSceneryPlacements(sampleWorld), [sampleWorld]);
  return (
    <group userData={{ gaesupWorldObject: 'kenney-nature-instances' }}>
      {SCENERY_ASSETS.map(asset => <InstancedAsset
        key={asset.id}
        url={asset.url}
        placements={placements[asset.id]}
        shadows={!asset.id.startsWith('flower') && asset.id !== 'grass-tuft'}
      />)}
    </group>
  );
}

function TrailAndWater({ sampleWorld }: { sampleWorld: (x: number, z: number) => WorldSample }) {
  const trail = useMemo(() => {
    const vertices: number[] = [];
    const indices: number[] = [];
    TRAIL_POINTS.forEach(([x, z], index) => {
      const before = TRAIL_POINTS[Math.max(0, index - 1)];
      const after = TRAIL_POINTS[Math.min(TRAIL_POINTS.length - 1, index + 1)];
      const dx = after[0] - before[0];
      const dz = after[1] - before[1];
      const length = Math.hypot(dx, dz) || 1;
      const sideX = -dz / length * 2.15;
      const sideZ = dx / length * 2.15;
      for (const direction of [-1, 1]) {
        const px = x + sideX * direction;
        const pz = z + sideZ * direction;
        vertices.push(px, sampleWorld(px, pz).height + .035, pz);
      }
      if (index < TRAIL_POINTS.length - 1) {
        const base = index * 2;
        indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      }
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }, [sampleWorld]);
  useEffect(() => () => trail.dispose(), [trail]);
  const lakeVisible = sampleWorld(42, -28).biome === 'lake';
  return (
    <group userData={{ gaesupWorldObject: 'landmarks' }}>
      <mesh geometry={trail} receiveShadow><meshStandardMaterial color="#b89a68" roughness={1} polygonOffset polygonOffsetFactor={-1} /></mesh>
      {lakeVisible && <>
        <mesh position={[42, -.52, -28]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
          <circleGeometry args={[19, 64]} />
          <meshStandardMaterial color="#4cacc0" emissive="#1d5f74" emissiveIntensity={.16} roughness={.28} metalness={.04} transparent opacity={.82} depthWrite={false} />
        </mesh>
        <mesh position={[42, -.5, -28]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[18.7, 19.35, 64]} />
          <meshBasicMaterial color="#a9d9c2" transparent opacity={.7} />
        </mesh>
      </>}
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
  const gltf = useCachedModel(url);
  const root = useRef<Group>(null);
  const mixer = useRef<AnimationMixer | null>(null);
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
    mixer.current?.update(Math.min(delta, .05) * MathUtils.clamp((creature.movementSpeed ?? 2.4) / 2.4, .65, 1.8));
    if (!root.current) return;
    const gait = MathUtils.clamp(creature.movementSpeed ?? 2.4, 1.2, 5.2);
    const phase = clock.elapsedTime * (creature.action === 'walk' ? gait * 2.7 : 2.4) + creature.speciesId;
    root.current.position.y = 0;
    const pulse = creature.action === 'attack' ? 1 + Math.max(0, Math.sin(phase * 1.8)) * .12 : 1;
    root.current.scale.set(pulse, creature.action === 'hurt' ? .88 : 1, pulse);
    root.current.rotation.z = creature.action === 'fainted' ? Math.PI / 2 : 0;
    if (!ground.current && normalized) ground.current = createGrounding(normalized.visual, root.current);
    root.current.parent?.getWorldPosition(worldPosition.current);
    ground.current?.(worldPosition.current.y);
  }, -1);
  useEffect(() => { ground.current = undefined; }, [normalized]);

  useEffect(() => {
    if (!normalized || !gltf?.animations.length) return;
    const nextMixer = new AnimationMixer(normalized.animatedRoot);
    mixer.current = nextMixer;
    const wanted = creature.action === 'attack' ? /attack|bite|skill/i : creature.action === 'walk' ? /walk|run/i : /idle/i;
    const clip = gltf.animations.find(candidate => wanted.test(candidate.name)) ?? gltf.animations[0];
    nextMixer.clipAction(clip).play();
    return () => {
      mixer.current = null;
      nextMixer.stopAllAction();
      nextMixer.uncacheRoot(normalized.animatedRoot);
    };
  }, [creature.action, gltf, normalized]);

  if (!normalized) return <FallbackCreature displayHeight={creature.displayHeight} />;
  return <group ref={root}><primitive object={normalized.visual} /></group>;
}

function FallbackCreature({ displayHeight = 1.2 }: { displayHeight?: number }) {
  return (
    <group scale={displayHeight / 1.8}>
      <mesh position={[0, 1.05, 0]} castShadow><sphereGeometry args={[.72, 20, 14]} /><meshStandardMaterial color="#e5cc67" /></mesh>
      <mesh position={[0, .38, 0]} castShadow><sphereGeometry args={[.46, 18, 12]} /><meshStandardMaterial color="#f2e9bd" /></mesh>
    </group>
  );
}

function SpriteCreature({ url, displayHeight = 1.2 }: { url: string; displayHeight?: number }) {
  const [texture, setTexture] = useState<ReturnType<TextureLoader['load']> | null>(null);
  useEffect(() => {
    let active = true;
    const loaded = new TextureLoader().load(url, value => { if (active) setTexture(value); }, undefined, () => {});
    return () => { active = false; loaded.dispose(); };
  }, [url]);
  if (!texture) return <FallbackCreature displayHeight={displayHeight} />;
  return <sprite position={[0, displayHeight * .55, 0]} scale={[displayHeight, displayHeight, 1]}><spriteMaterial map={texture} transparent alphaTest={.08} /></sprite>;
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
    context.fillText(`${creature.name} · Lv.${creature.level}`, 256, 45);
    context.font = '700 22px system-ui, sans-serif';
    context.fillText(`${Math.max(0, Math.ceil(creature.hp))} / ${creature.maxHp} HP`, 256, 76);
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
  }, [creature.hp, creature.level, creature.maxHp, creature.name, hp]);
  useEffect(() => () => texture.dispose(), [texture]);
  if (distance > 34 && !emphasized) return null;
  const width = emphasized ? 3.15 : distance < 5 ? 2.25 : 2.7;
  return <sprite position={[0, (creature.displayHeight ?? 1.2) + .62, 0]} scale={[width, width * .25, 1]} renderOrder={20}><spriteMaterial map={texture} transparent depthTest={false} depthWrite={false} /></sprite>;
}

function Creature({ creature, selected, distance, options }: {
  creature: WorldCreature;
  selected: boolean;
  distance: number;
  options: OpenWorldViewOptions;
}) {
  const sample = options.sampleWorld ?? fallbackSample;
  const y = terrainSurfaceHeight(sample, creature.x, creature.z);
  const hp = MathUtils.clamp(creature.maxHp > 0 ? creature.hp / creature.maxHp : 0, 0, 1);
  const yaw = [Math.PI, -Math.PI / 2, 0, Math.PI / 2, 0][creature.heading ?? 4];
  const root = useRef<Group>(null);
  const target = useRef(new Vector3(creature.x, y, creature.z));
  const visual = useRef(new Vector3(creature.x, y, creature.z));
  useEffect(() => { target.current.set(creature.x, y, creature.z); }, [creature.x, creature.z, y]);
  useFrame((_, delta) => {
    if (!root.current) return;
    const remaining = visual.current.distanceTo(target.current);
    const speed = MathUtils.clamp(creature.movementSpeed ?? 2.4, .5, 8);
    const step = Math.max(speed * Math.min(delta, .05) * 1.2, remaining * Math.min(1, delta * 4));
    if (remaining > 0) visual.current.lerp(target.current, Math.min(1, step / remaining));
    visual.current.y = terrainSurfaceHeight(sample, visual.current.x, visual.current.z);
    root.current.position.copy(visual.current);
    root.current.rotation.y = MathUtils.damp(root.current.rotation.y, yaw, 14, delta);
  }, -2);
  return (
    <group
      ref={root}
      position={[creature.x, y, creature.z]}
      rotation={[0, yaw, 0]}
      onClick={event => { event.stopPropagation(); options.onSelect(creature.id); }}
      onDoubleClick={event => { event.stopPropagation(); options.onInteract?.(creature.id); }}
    >
      {distance <= MODEL_LOD_DISTANCE
        ? <PokemonModel creature={creature} url={(options.modelUrl ?? (id => `/models/pokemon/${id}.glb`))(creature.speciesId)} />
        : <SpriteCreature displayHeight={creature.displayHeight} url={(options.spriteUrl ?? (id => `/pokemon/${id}.png`))(creature.speciesId)} />}
      {(selected || creature.inBattle) && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .04, 0]}><ringGeometry args={[1.1, 1.34, 40]} /><meshBasicMaterial color={creature.inBattle ? '#f09155' : '#f6dd67'} transparent opacity={.86} /></mesh>}
      <AttackEffect active={creature.action === 'attack'} moveType={creature.moveType} />
      <CreatureBillboard creature={creature} hp={hp} distance={distance} emphasized={selected || !!creature.inBattle} />
    </group>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

function PlayerCamera({ snapshot, options, command }: { snapshot: OpenWorldRenderSnapshot; options: OpenWorldViewOptions; command: CameraCommand }) {
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
  const announcedReady = useRef(false);
  const { camera } = useThree();
  const sample = options.sampleWorld ?? fallbackSample;

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
    if (command.action === 'left') spherical.current.theta += .22;
    if (command.action === 'right') spherical.current.theta -= .22;
    if (command.action === 'up') spherical.current.phi = Math.max(.38, spherical.current.phi - .14);
    if (command.action === 'down') spherical.current.phi = Math.min(1.18, spherical.current.phi + .14);
    if (command.action === 'zoom-in') spherical.current.radius = Math.max(10, spherical.current.radius * .84);
    if (command.action === 'zoom-out') spherical.current.radius = Math.min(42, spherical.current.radius * 1.18);
    orbitOffset.current.setFromSpherical(spherical.current);
    camera.position.copy(control.target).add(orbitOffset.current);
    control.update();
  }, [camera, command]);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'].includes(event.code)) {
        event.preventDefault();
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
  }, []);

  useFrame((_, delta) => {
    if (listenersReady.current && !announcedReady.current) {
      announcedReady.current = true;
      options.onReady?.();
    }
    const pressed = keys.current;
    let forwardAxis = Number(pressed.has('KeyW') || pressed.has('ArrowUp')) - Number(pressed.has('KeyS') || pressed.has('ArrowDown'));
    let sideAxis = Number(pressed.has('KeyD') || pressed.has('ArrowRight')) - Number(pressed.has('KeyA') || pressed.has('ArrowLeft'));
    const target = position.current;
    if (forwardAxis || sideAxis) {
      camera.getWorldDirection(forward.current);
      forward.current.y = 0;
      forward.current.normalize();
      right.current.set(-forward.current.z, 0, forward.current.x);
      movement.current.copy(forward.current).multiplyScalar(forwardAxis).addScaledVector(right.current, sideAxis).normalize().multiplyScalar(Math.min(delta, .05) * (snapshot.entities.find(entity => entity.id.startsWith('companion:'))?.movementSpeed ?? 2.2));
      const x = MathUtils.clamp(target.x + movement.current.x, WORLD_MIN, WORLD_MAX);
      const z = MathUtils.clamp(target.z + movement.current.z, WORLD_MIN, WORLD_MAX);
      const terrain = sample(x, z);
      if (!terrain.blocked) {
        const nextHeading = Math.abs(movement.current.x) > Math.abs(movement.current.z)
          ? (movement.current.x > 0 ? 1 : 3)
          : (movement.current.z > 0 ? 2 : 0);
        const accepted = options.onPlayerMove({ x, z, heading: nextHeading });
        if (accepted !== false) {
          camera.position.x += x - target.x;
          const groundY = terrainSurfaceHeight(sample, x, z);
          camera.position.y += groundY - target.y;
          camera.position.z += z - target.z;
          target.set(x, groundY, z);
          external.current.copy(target);
        }
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

  return <OrbitControls ref={controls} makeDefault enablePan={false} enableDamping dampingFactor={.08} minDistance={10} maxDistance={42} minPolarAngle={.38} maxPolarAngle={1.18} />;
}

function Scene({ snapshot, options, cameraCommand }: { snapshot: OpenWorldRenderSnapshot; options: OpenWorldViewOptions; cameraCommand: CameraCommand }) {
  const sample = options.sampleWorld ?? fallbackSample;
  const visible = useMemo(() => [...snapshot.entities]
    .sort((a, b) => {
      const priorityA = Number(a.id === snapshot.selectedWildId || a.inBattle);
      const priorityB = Number(b.id === snapshot.selectedWildId || b.inBattle);
      if (priorityA !== priorityB) return priorityB - priorityA;
      return Math.hypot(a.x - snapshot.player.x, a.z - snapshot.player.z) - Math.hypot(b.x - snapshot.player.x, b.z - snapshot.player.z);
    }).slice(0, MAX_VISIBLE), [snapshot]);
  return (
    <>
      <color attach="background" args={['#9bcfca']} />
      <fog attach="fog" args={['#b8d8c8', 55, 175]} />
      <ambientLight color="#fff1cc" intensity={1.5} />
      <directionalLight position={[35, 52, 25]} intensity={2.25} color="#fff2c2" castShadow shadow-mapSize={[2048, 2048]} shadow-camera-far={170} shadow-camera-left={-75} shadow-camera-right={75} shadow-camera-top={75} shadow-camera-bottom={-75} />
      <Physics gravity={[0, -18, 0]} timeStep="vary">
        <Terrain sampleWorld={sample} />
        <Nature sampleWorld={sample} />
        <TrailAndWater sampleWorld={sample} />
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
        {options.props?.map(item => <StaticModel key={item.id} item={item} />)}
        {snapshot.foods?.map(food => {
          const y = food.y ?? sample(food.x, food.z).height;
          return <mesh key={food.id} position={[food.x, y + .25, food.z]} castShadow><icosahedronGeometry args={[.24, 1]} /><meshStandardMaterial color="#efca58" emissive="#785e16" emissiveIntensity={.35} /></mesh>;
        })}
      </Physics>
      {visible.map(creature => <Creature key={creature.id} creature={creature} selected={creature.id === snapshot.selectedWildId} distance={Math.hypot(creature.x - snapshot.player.x, creature.z - snapshot.player.z)} options={options} />)}
      <PlayerCamera snapshot={snapshot} options={options} command={cameraCommand} />
    </>
  );
}

function OpenWorldApp({ store, options }: { store: SnapshotStore; options: OpenWorldViewOptions }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.get, store.get);
  const runtime = useMemo(() => createGaesupRuntime({ plugins: [createCameraPlugin()], pluginRuntime: 'client' }), []);
  const [ready, setReady] = useState(false);
  const [cameraCommand, setCameraCommand] = useState<CameraCommand>({ id: 0, action: 'reset' });
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
      <Canvas shadows dpr={[1, 1.65]} camera={{ position: [12, 18, 16], fov: 48, near: .1, far: 320 }} gl={{ antialias: true, powerPreference: 'high-performance' }} onPointerMissed={() => options.onSelect(null)}>
        <group name="gaesup-world">
          <Scene snapshot={snapshot} options={options} cameraCommand={cameraCommand} />
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
      </div>
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
