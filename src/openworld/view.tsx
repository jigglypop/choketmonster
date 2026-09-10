import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Physics, RigidBody } from '@react-three/rapier';
import { GaesupWorld, GaesupWorldContent, createCameraPlugin } from 'gaesup-world';
import { createGaesupRuntime } from 'gaesup-world/runtime';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  AnimationClip,
  AnimationMixer,
  Box3,
  BufferAttribute,
  CanvasTexture,
  Color,
  Group,
  InstancedMesh,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  SRGBColorSpace,
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
import './view.css';

const WORLD_MIN = -120;
const WORLD_MAX = 120;
const MAX_VISIBLE = 12;
const MODEL_LOD_DISTANCE = 54;
const MODEL_CACHE_LIMIT = 16;
const loader = new GLTFLoader();

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
    const plane = new PlaneGeometry(240, 240, 72, 72);
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

function Nature({ sampleWorld }: { sampleWorld: (x: number, z: number) => WorldSample }) {
  const trunks = useRef<InstancedMesh>(null);
  const crowns = useRef<InstancedMesh>(null);
  const rocks = useRef<InstancedMesh>(null);
  const placements = useMemo(() => {
    const forest: Array<[number, number, number, number]> = [];
    const rock: Array<[number, number, number, number]> = [];
    for (let gridX = -112; gridX <= 112; gridX += 8) {
      for (let gridZ = -112; gridZ <= 112; gridZ += 8) {
        const jitterX = Math.sin(gridX * 12.9898 + gridZ * 78.233) * 2.4;
        const jitterZ = Math.cos(gridX * 39.346 + gridZ * 11.135) * 2.4;
        const x = gridX + jitterX;
        const z = gridZ + jitterZ;
        const sample = sampleWorld(x, z);
        if (!sample.blocked) continue;
        const scale = .72 + Math.abs(Math.sin(x * .71 + z * .37)) * .68;
        (sample.biome === 'forest' ? forest : rock).push([x, sample.height, z, scale]);
      }
    }
    return { forest: forest.slice(0, 180), rock: rock.slice(0, 140) };
  }, [sampleWorld]);
  useLayoutEffect(() => {
    const dummy = new Object3D();
    placements.forest.forEach(([x, y, z, scale], index) => {
      dummy.position.set(x, y + 1.25 * scale, z);
      dummy.rotation.set(0, (x * .17 + z * .11) % Math.PI, 0);
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      trunks.current?.setMatrixAt(index, dummy.matrix);
      dummy.position.y = y + 3.2 * scale;
      dummy.scale.set(1.55 * scale, 2.1 * scale, 1.55 * scale);
      dummy.updateMatrix();
      crowns.current?.setMatrixAt(index, dummy.matrix);
    });
    placements.rock.forEach(([x, y, z, scale], index) => {
      dummy.position.set(x, y + .55 * scale, z);
      dummy.rotation.set(z * .13, x * .19, (x + z) * .07);
      dummy.scale.set(1.15 * scale, .75 * scale, scale);
      dummy.updateMatrix();
      rocks.current?.setMatrixAt(index, dummy.matrix);
    });
    if (trunks.current) trunks.current.instanceMatrix.needsUpdate = true;
    if (crowns.current) crowns.current.instanceMatrix.needsUpdate = true;
    if (rocks.current) rocks.current.instanceMatrix.needsUpdate = true;
  }, [placements]);
  return (
    <group userData={{ gaesupWorldObject: 'nature-lod' }}>
      <instancedMesh ref={trunks} args={[undefined, undefined, placements.forest.length]} castShadow receiveShadow><cylinderGeometry args={[.24, .38, 2.5, 7]} /><meshStandardMaterial color="#604934" roughness={1} /></instancedMesh>
      <instancedMesh ref={crowns} args={[undefined, undefined, placements.forest.length]} castShadow receiveShadow><coneGeometry args={[1.1, 3, 8]} /><meshStandardMaterial color="#2e6940" roughness={.96} /></instancedMesh>
      <instancedMesh ref={rocks} args={[undefined, undefined, placements.rock.length]} castShadow receiveShadow><dodecahedronGeometry args={[.9, 0]} /><meshStandardMaterial color="#746f63" roughness={.94} /></instancedMesh>
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
  const normalized = useMemo(() => {
    if (!gltf) return null;
    const scene = cloneSkinned(gltf.scene);
    const bounds = new Box3().setFromObject(scene);
    const size = bounds.getSize(new Vector3());
    const scale = 2.4 / Math.max(size.y, size.x * .7, size.z * .7, .01);
    scene.scale.setScalar(scale);
    scene.position.set(-(bounds.min.x + bounds.max.x) * .5 * scale, -bounds.min.y * scale, -(bounds.min.z + bounds.max.z) * .5 * scale);
    scene.traverse(object => {
      if (object instanceof Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
    return scene;
  }, [gltf]);
  useFrame(({ clock }) => {
    if (!root.current) return;
    const phase = clock.elapsedTime * (creature.action === 'walk' ? 7 : 2.4) + creature.speciesId;
    root.current.position.y = creature.action === 'fainted' ? .08 : Math.max(0, Math.sin(phase)) * (creature.action === 'walk' ? .13 : .045);
    const pulse = creature.action === 'attack' ? 1 + Math.max(0, Math.sin(phase * 1.8)) * .12 : 1;
    root.current.scale.set(pulse, creature.action === 'hurt' ? .88 : 1, pulse);
    root.current.rotation.z = creature.action === 'fainted' ? Math.PI / 2 : 0;
  });

  useEffect(() => {
    if (!normalized || !gltf?.animations.length) return;
    const mixer = new AnimationMixer(normalized);
    const wanted = creature.action === 'attack' ? /attack|bite|skill/i : creature.action === 'walk' ? /walk|run/i : /idle/i;
    const clip = gltf.animations.find(candidate => wanted.test(candidate.name)) ?? gltf.animations[0];
    mixer.clipAction(clip).play();
    let frame = 0;
    let before = performance.now();
    const animate = (now: number) => {
      mixer.update(Math.min((now - before) / 1000, .05));
      before = now;
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(frame);
      mixer.stopAllAction();
      mixer.uncacheRoot(normalized);
    };
  }, [creature.action, gltf, normalized]);

  if (!normalized) return <FallbackCreature />;
  return <group ref={root}><primitive object={normalized} /></group>;
}

function FallbackCreature() {
  return (
    <group>
      <mesh position={[0, 1.05, 0]} castShadow><sphereGeometry args={[.72, 20, 14]} /><meshStandardMaterial color="#e5cc67" /></mesh>
      <mesh position={[0, .38, 0]} castShadow><sphereGeometry args={[.46, 18, 12]} /><meshStandardMaterial color="#f2e9bd" /></mesh>
    </group>
  );
}

function SpriteCreature({ url }: { url: string }) {
  const [texture, setTexture] = useState<ReturnType<TextureLoader['load']> | null>(null);
  useEffect(() => {
    let active = true;
    const loaded = new TextureLoader().load(url, value => { if (active) setTexture(value); }, undefined, () => {});
    return () => { active = false; loaded.dispose(); };
  }, [url]);
  if (!texture) return <FallbackCreature />;
  return <sprite position={[0, 1.4, 0]} scale={[2.8, 2.8, 1]}><spriteMaterial map={texture} transparent alphaTest={.08} /></sprite>;
}

function AttackEffect({ active }: { active: boolean }) {
  const ref = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (!ref.current || !active) return;
    const phase = (clock.elapsedTime * 3.5) % 1;
    ref.current.scale.setScalar(.8 + phase * 2.2);
    const material = ref.current.material as MeshStandardMaterial;
    material.opacity = 1 - phase;
  });
  if (!active) return null;
  return <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} position={[0, .08, 0]}><ringGeometry args={[.75, .92, 32]} /><meshStandardMaterial color="#ffd85d" transparent opacity={1} emissive="#d7782f" /></mesh>;
}

function CreatureBillboard({ creature, hp }: { creature: WorldCreature; hp: number }) {
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
  return <sprite position={[0, 3.35, 0]} scale={[5.4, 1.35, 1]} renderOrder={20}><spriteMaterial map={texture} transparent depthTest={false} depthWrite={false} /></sprite>;
}

function Creature({ creature, selected, distance, options }: {
  creature: WorldCreature;
  selected: boolean;
  distance: number;
  options: OpenWorldViewOptions;
}) {
  const sample = options.sampleWorld ?? fallbackSample;
  const y = creature.y ?? sample(creature.x, creature.z).height;
  const hp = MathUtils.clamp(creature.maxHp > 0 ? creature.hp / creature.maxHp : 0, 0, 1);
  const yaw = [Math.PI, -Math.PI / 2, 0, Math.PI / 2, 0][creature.heading ?? 4];
  return (
    <group
      position={[creature.x, y, creature.z]}
      rotation={[0, yaw, 0]}
      onClick={event => { event.stopPropagation(); options.onSelect(creature.id); }}
      onDoubleClick={event => { event.stopPropagation(); options.onInteract?.(creature.id); }}
    >
      {distance <= MODEL_LOD_DISTANCE
        ? <PokemonModel creature={creature} url={(options.modelUrl ?? (id => `/models/pokemon/${id}.glb`))(creature.speciesId)} />
        : <SpriteCreature url={(options.spriteUrl ?? (id => `/pokemon/${id}.png`))(creature.speciesId)} />}
      {(selected || creature.inBattle) && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .04, 0]}><ringGeometry args={[1.1, 1.34, 40]} /><meshBasicMaterial color={creature.inBattle ? '#f09155' : '#f6dd67'} transparent opacity={.86} /></mesh>}
      <AttackEffect active={creature.action === 'attack'} />
      <CreatureBillboard creature={creature} hp={hp} />
    </group>
  );
}

function PlayerCamera({ snapshot, options }: { snapshot: OpenWorldRenderSnapshot; options: OpenWorldViewOptions }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const keys = useRef(new Set<string>());
  const position = useRef(new Vector3(snapshot.player.x, snapshot.player.y ?? 0, snapshot.player.z));
  const { camera } = useThree();
  const sample = options.sampleWorld ?? fallbackSample;

  useEffect(() => {
    position.current.set(snapshot.player.x, snapshot.player.y ?? sample(snapshot.player.x, snapshot.player.z).height, snapshot.player.z);
  }, [sample, snapshot.player.x, snapshot.player.y, snapshot.player.z]);
  useEffect(() => {
    camera.position.set(position.current.x + 8, position.current.y + 7, position.current.z + 10);
  }, [camera]);
  useEffect(() => {
    const down = (event: KeyboardEvent) => keys.current.add(event.code);
    const up = (event: KeyboardEvent) => keys.current.delete(event.code);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  useFrame((_, delta) => {
    const pressed = keys.current;
    let forwardAxis = Number(pressed.has('KeyW') || pressed.has('ArrowUp')) - Number(pressed.has('KeyS') || pressed.has('ArrowDown'));
    let sideAxis = Number(pressed.has('KeyD') || pressed.has('ArrowRight')) - Number(pressed.has('KeyA') || pressed.has('ArrowLeft'));
    const target = position.current;
    if (forwardAxis || sideAxis) {
      const forward = new Vector3();
      camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();
      const right = new Vector3(-forward.z, 0, forward.x);
      const movement = forward.multiplyScalar(forwardAxis).add(right.multiplyScalar(sideAxis)).normalize().multiplyScalar(Math.min(delta, .05) * 10);
      const x = MathUtils.clamp(target.x + movement.x, WORLD_MIN, WORLD_MAX);
      const z = MathUtils.clamp(target.z + movement.z, WORLD_MIN, WORLD_MAX);
      const terrain = sample(x, z);
      if (!terrain.blocked) {
        const heading = Math.abs(movement.x) > Math.abs(movement.z)
          ? (movement.x > 0 ? 1 : 3)
          : (movement.z > 0 ? 2 : 0);
        const accepted = options.onPlayerMove({ x, z, heading });
        if (accepted !== false) {
          camera.position.x += x - target.x;
          camera.position.z += z - target.z;
          target.set(x, terrain.height, z);
        }
      }
    }
    if (controls.current) {
      controls.current.target.lerp(new Vector3(target.x, target.y + 1.2, target.z), .28);
      controls.current.update();
    }
  });

  return <OrbitControls ref={controls} makeDefault enablePan={false} enableDamping dampingFactor={.08} minDistance={4} maxDistance={28} minPolarAngle={.25} maxPolarAngle={1.42} />;
}

function Scene({ snapshot, options }: { snapshot: OpenWorldRenderSnapshot; options: OpenWorldViewOptions }) {
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
      <PlayerCamera snapshot={snapshot} options={options} />
    </>
  );
}

function OpenWorldApp({ store, options }: { store: SnapshotStore; options: OpenWorldViewOptions }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.get, store.get);
  const runtime = useMemo(() => createGaesupRuntime({ plugins: [createCameraPlugin()], pluginRuntime: 'client' }), []);
  const [ready, setReady] = useState(false);
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
      <Canvas shadows dpr={[1, 1.65]} camera={{ position: [8, 8, 12], fov: 48, near: .1, far: 320 }} gl={{ antialias: true, powerPreference: 'high-performance' }} onPointerMissed={() => options.onSelect(null)}>
        <GaesupWorldContent showGrid={false} showAxes={false}>
          <Scene snapshot={snapshot} options={options} />
        </GaesupWorldContent>
      </Canvas>
      {!ready && <div className="ow-loading">Gaesup World 준비 중…</div>}
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
