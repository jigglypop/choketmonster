import { Html } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AnimationMixer, Box3, LoopOnce, LoopRepeat, Mesh, SkinnedMesh, Vector3, type AnimationAction, type AnimationClip, type Group } from 'three';
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

/** Trainers stand a little taller than a 1 m Pokémon. */
const NPC_HEIGHT = 2.3;
/** A greeting hop, in milliseconds. */
const HOP_MS = 420;
/** Townsfolk are drawn in towns this close; the nearest one in talking range speaks. */
const NPC_DRAW_RANGE = 46, TALK_RANGE = 6.5;
const LINE_MS = 4500;

function useNpcModel(url: string): GLTF | null {
  const [gltf, setGltf] = useState<GLTF | null>(null);
  useEffect(() => {
    let active = true;
    setGltf(null);
    const request = acquireModel(url);
    request.promise.then(value => { if (active) setGltf(value); }, () => undefined);
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
  const hop = useRef(-1);
  const mixer = useRef<AnimationMixer | null>(null), stance = useRef<AnimationAction | undefined>(undefined);
  const waves = useMemo(() => gltf?.animations.filter(clip => /wave/i.test(clip.name)) ?? [], [gltf]);
  useEffect(() => {
    if (!figure || !gltf) return;
    const next = new AnimationMixer(figure), idle = gltf.animations.find(clip => /^idle/i.test(clip.name));
    mixer.current = next;
    if (idle) {
      // Each figure starts its idle loop at its own point, so neighbours never sway in step.
      const action = next.clipAction(idle).setLoop(LoopRepeat, Infinity).play();
      action.time = (npc.x * 7.3 + npc.z * 3.1) % idle.duration; stance.current = action;
    } else if (waves[0]) {
      // No idle loop: a wave's first frame is the figure standing with its arms down (its rest pose is a T).
      const hold = next.clipAction(waves[0].clone()).play(); hold.paused = true; hold.time = 0; stance.current = hold;
    }
    // A finished wave hands back to the stance.
    const settle = (event: { action: AnimationAction }) => {
      const standing = stance.current; if (!standing || event.action === standing) return;
      const paused = standing.paused; standing.reset().play(); standing.paused = paused; standing.crossFadeFrom(event.action, .3, false);
    };
    next.addEventListener('finished', settle);
    return () => { next.removeEventListener('finished', settle); next.stopAllAction(); next.uncacheRoot(figure); mixer.current = null; stance.current = undefined; };
  }, [figure, gltf, waves]);
  /** Plays a wave once; a figure without one hops instead. */
  const greet = (clip: AnimationClip | undefined) => {
    if (!clip || !mixer.current) { hop.current = performance.now(); return; }
    const action = mixer.current.clipAction(clip).reset().setLoop(LoopOnce, 1);
    action.clampWhenFinished = true; action.play();
    if (stance.current) action.crossFadeFrom(stance.current, .25, false);
  };
  useEffect(() => () => {
    if (!figure) return;
    const skeletons = new Set<SkinnedMesh['skeleton']>();
    figure.traverse(child => { if (child instanceof SkinnedMesh) skeletons.add(child.skeleton); });
    skeletons.forEach(skeleton => skeleton.dispose());
    releaseRenderObjects(figure);
  }, [figure]);
  const [line, setLine] = useState(0), [turn, setTurn] = useState(0);
  // Waves (or hops) when the player walks up.
  useEffect(() => { if (talking) greet(waves.find(clip => /big/i.test(clip.name)) ?? waves[0]); }, [talking, figure]);
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
    const hopT = hop.current < 0 ? 1 : (performance.now() - hop.current) / HOP_MS;
    root.current.position.y = hopT < 1 ? Math.sin(hopT * Math.PI) * .3 : 0;
    root.current.rotation.y = facing.current;
  });
  const next = (event?: { stopPropagation(): void; delta?: number }) => {
    event?.stopPropagation();
    if ((event?.delta ?? 0) > 5) return;
    setLine(value => value + 1); setTurn(value => value + 1);
    greet(waves.find(clip => !/big/i.test(clip.name)) ?? waves[0]);
  };
  const text = lines.length ? lines[line % lines.length] : '';
  return <group position={[npc.x, y, npc.z]} name={`town-npc:${npc.id}`}>
    <group ref={root}>{figure && <primitive object={figure} dispose={null} />}</group>
    {/* An invisible column is the click target, so a tap anywhere on the figure talks. */}
    <mesh position={[0, NPC_HEIGHT / 2, 0]} onClick={(event: ThreeEvent<MouseEvent>) => next(event)}
      onPointerOver={event => { event.stopPropagation(); document.body.style.cursor = 'pointer'; }} onPointerOut={() => { document.body.style.cursor = ''; }}>
      <cylinderGeometry args={[.6, .6, NPC_HEIGHT, 10]} />
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
