import { Html } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AnimationMixer, Box3, Color, LoopRepeat, Mesh, MeshStandardMaterial, SkinnedMesh, Vector3, type Group } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { getSpecies } from '../data/pokemon';
import { acquireModel } from '../three/model-cache';
import { releaseRenderObjects } from '../three/render-objects';
import type { WorldAtlas } from './atlas';
import { terrainSurfaceHeight } from './grounding';
import type { KantoGym, KantoLocation } from './kanto';
import { isRegionalLeagueLocation } from './scene-landmarks';
import { nearbyDungeon, npcLines, planTownNpcs, type NpcTalkContext, type TownNpc } from './town-npc-plan';
import type { WorldSample } from './types';

/** SD trainers stand a little taller than a 0.4 m Pokémon. */
const NPC_HEIGHT = 1.5;
/** A greeting hop and a click spin, in milliseconds. */
const HOP_MS = 420, SPIN_MS = 700;
/** Townsfolk are drawn in towns this close; the nearest one in talking range speaks. */
const NPC_DRAW_RANGE = 46, TALK_RANGE = 6.5;
const LINE_MS = 4500;

/** Matte skin and cloth, lifted a little by their own colours so the faces stay bright in the shade. */
function brighten(gltf: GLTF): void {
  if (gltf.userData.npcLook) return;
  gltf.userData.npcLook = true;
  gltf.scene.traverse(child => {
    if (!(child instanceof Mesh)) return;
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      if (!(material instanceof MeshStandardMaterial) || !material.map) continue;
      material.metalness = 0; material.roughness = .85;
      material.emissive = new Color('#ffffff'); material.emissiveMap = material.map; material.emissiveIntensity = .14;
      material.needsUpdate = true;
    }
  });
}

function useNpcModel(url: string): GLTF | null {
  const [gltf, setGltf] = useState<GLTF | null>(null);
  useEffect(() => {
    let active = true;
    setGltf(null);
    const request = acquireModel(url);
    request.promise.then(value => { if (active) { brighten(value); setGltf(value); } }, () => undefined);
    return () => { active = false; request.release(); };
  }, [url]);
  return gltf;
}

function TownNpcFigure({ npc, y, player, lines, talking, quiet }: { npc: TownNpc; y: number; player: { x: number; z: number }; lines: readonly string[]; talking: boolean; quiet: boolean }) {
  const gltf = useNpcModel(npc.model);
  const root = useRef<Group>(null);
  const figure = useMemo(() => {
    if (!gltf) return null;
    const object = cloneSkinned(gltf.scene);
    object.traverse(child => { if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; } });
    object.scale.setScalar(NPC_HEIGHT / (new Box3().setFromObject(object).getSize(new Vector3()).y || 1));
    return object;
  }, [gltf]);
  const mixer = useRef<AnimationMixer | null>(null);
  useEffect(() => {
    if (!figure || !gltf) return;
    const next = new AnimationMixer(figure), clip = gltf.animations.find(item => item.name === 'idle');
    mixer.current = next;
    // Each figure starts its idle loop at its own point, so neighbours never sway in step.
    if (clip) next.clipAction(clip).setLoop(LoopRepeat, Infinity).play().time = (npc.x * 7.3 + npc.z * 3.1) % clip.duration;
    return () => { next.stopAllAction(); next.uncacheRoot(figure); mixer.current = null; };
  }, [figure, gltf]);
  useEffect(() => () => {
    if (!figure) return;
    const skeletons = new Set<SkinnedMesh['skeleton']>();
    figure.traverse(child => { if (child instanceof SkinnedMesh) skeletons.add(child.skeleton); });
    skeletons.forEach(skeleton => skeleton.dispose());
    releaseRenderObjects(figure);
  }, [figure]);
  const hop = useRef(-1), spin = useRef(-1);
  const [line, setLine] = useState(0), [turn, setTurn] = useState(0);
  // Hops with joy when the player walks up.
  useEffect(() => { if (talking) hop.current = performance.now(); }, [talking]);
  useEffect(() => {
    if (!talking || lines.length < 2) return;
    const timer = window.setInterval(() => setLine(value => value + 1), LINE_MS);
    return () => window.clearInterval(timer);
  }, [talking, lines.length, turn]);
  const facing = useRef(npc.facing), target = useRef({ x: player.x, z: player.z });
  target.current = { x: player.x, z: player.z };
  useFrame((_, delta) => {
    mixer.current?.update(Math.min(delta, .05));
    if (!root.current) return;
    const goal = talking ? Math.atan2(target.current.x - npc.x, target.current.z - npc.z) : npc.facing;
    const turnBy = Math.atan2(Math.sin(goal - facing.current), Math.cos(goal - facing.current));
    facing.current += turnBy * Math.min(1, delta * 6);
    const now = performance.now(), hopT = hop.current < 0 ? 1 : (now - hop.current) / HOP_MS, spinT = spin.current < 0 ? 1 : (now - spin.current) / SPIN_MS;
    const lift = hopT < 1 ? Math.sin(hopT * Math.PI) : 0;
    root.current.position.y = lift * .32;
    // Squash on take-off and landing, stretch at the top.
    root.current.scale.set(1 - lift * .05, 1 + lift * .08 - (hopT < 1 ? Math.max(0, Math.sin(hopT * Math.PI * 2 - Math.PI)) * .06 : 0), 1 - lift * .05);
    root.current.rotation.y = facing.current + (spinT < 1 ? (1 - (1 - spinT) ** 3) * Math.PI * 2 : 0);
  });
  const next = (event?: { stopPropagation(): void; delta?: number }) => {
    event?.stopPropagation();
    if ((event?.delta ?? 0) > 5) return;
    setLine(value => value + 1); setTurn(value => value + 1);
    if (line % 3 === 2) spin.current = performance.now(); else hop.current = performance.now();
  };
  const text = lines.length ? lines[line % lines.length] : '';
  return <group position={[npc.x, y, npc.z]} name={`town-npc:${npc.id}`}>
    <group ref={root}>{figure && <primitive object={figure} dispose={null} />}</group>
    {/* An invisible column is the click target, so a tap anywhere on the figure talks. */}
    <mesh position={[0, NPC_HEIGHT / 2, 0]} onClick={(event: ThreeEvent<MouseEvent>) => next(event)}
      onPointerOver={event => { event.stopPropagation(); document.body.style.cursor = 'pointer'; }} onPointerOut={() => { document.body.style.cursor = ''; }}>
      <cylinderGeometry args={[.45, .45, NPC_HEIGHT, 10]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
    {talking && !quiet && text && <Html center position={[0, NPC_HEIGHT + .8, 0]} zIndexRange={[6, 5]} style={{ pointerEvents: 'auto' }}>
      <button type="button" className="ow-npc-bubble" aria-label={`${npc.title}: ${text}`}
        onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); next(); }}>
        <small>{npc.title}</small>
        <span key={`${line}`}>{text}</span>
        {lines.length > 1 && <i aria-hidden="true">▶</i>}
      </button>
    </Html>}
  </group>;
}

type TownNpcsProps = {
  atlas: WorldAtlas; sampleWorld: (x: number, z: number) => WorldSample; player: { x: number; z: number };
  gyms?: readonly KantoGym[]; badges: number; busy: boolean;
  outbreak?: { locationId: string; speciesId: number }; partnerName?: string;
};

/** Townsfolk beside each town's buildings who turn to the player and talk: shop, gym and neighbourhood news. */
export const TownNpcs = memo(function TownNpcs({ atlas, sampleWorld, player, gyms = atlas.gyms, badges, busy, outbreak, partnerName }: TownNpcsProps) {
  const plans = useMemo(() => new Map<string, { npcs: TownNpc[]; dungeon: NpcTalkContext['nearbyDungeon'] }>(), [atlas]);
  const towns = atlas.locations.filter(place => place.kind === 'town' && !isRegionalLeagueLocation(atlas.id, place.id)
    && Math.hypot(place.x - player.x, place.z - player.z) <= NPC_DRAW_RANGE);
  const plan = (town: KantoLocation) => {
    let entry = plans.get(town.id);
    if (!entry) plans.set(town.id, entry = { npcs: planTownNpcs(atlas, town, gyms.some(gym => gym.locationId === town.id)), dungeon: nearbyDungeon(atlas, town) });
    return entry;
  };
  const outbreakPlace = outbreak ? atlas.locations.find(place => place.id === outbreak.locationId) : undefined;
  const news = outbreak && outbreakPlace ? { placeName: outbreakPlace.name, speciesName: getSpecies(outbreak.speciesId).name } : undefined;
  const drawn = towns.flatMap(town => plan(town).npcs.map(npc => ({ npc, town })));
  let speaker: string | undefined, closest = TALK_RANGE;
  for (const { npc } of drawn) {
    const distance = Math.hypot(npc.x - player.x, npc.z - player.z);
    if (distance < closest) { closest = distance; speaker = npc.id; }
  }
  return <group name="town-npcs">
    {drawn.map(({ npc, town }) => {
      const context: NpcTalkContext = {
        regionId: atlas.id, regionName: atlas.name, town: { id: town.id, name: town.name },
        gym: gyms.find(gym => gym.locationId === town.id), badges, outbreak: news, partnerName, nearbyDungeon: plan(town).dungeon,
      };
      return <TownNpcFigure key={npc.id} npc={npc} y={terrainSurfaceHeight(sampleWorld, npc.x, npc.z)} player={player}
        lines={npcLines(npc.role, context)} talking={npc.id === speaker} quiet={busy} />;
    })}
  </group>;
});
