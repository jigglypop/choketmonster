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
import { shadeFigure } from './figure-shading';
import type { WorldSample } from './types';

/** Townsfolk stand a little shorter than a 1 m Pokémon on screen. */
export const NPC_HEIGHT = 1.9;
/** A greeting hop, in milliseconds. */
const HOP_MS = 420;
/** Walking and jogging paces, in units per second, and the breath a pacing figure takes at each end. */
const PATROL_SPEED = 1, JOG_SPEED = 2.4, PACE_PAUSE = 1.6;
/** Townsfolk are drawn in towns this close; the nearest one in talking range speaks. */
const NPC_DRAW_RANGE = 46, TALK_RANGE = 6.5;
const LINE_MS = 4500;

export function useNpcModel(url: string): GLTF | null {
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

function TownNpcFigure({ npc, y, player, lines, talking, quiet, sampleWorld, positions }: {
  npc: TownNpc; y: number; player: { x: number; z: number }; lines: readonly string[]; talking: boolean; quiet: boolean;
  sampleWorld: (x: number, z: number) => WorldSample; positions: Map<string, { x: number; z: number }>;
}) {
  const gltf = useNpcModel(npc.model);
  const root = useRef<Group>(null), body = useRef<Group>(null);
  const figure = useMemo(() => {
    if (!gltf) return null;
    const object = cloneSkinned(gltf.scene);
    object.traverse(child => { if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; } });
    shadeFigure(object);
    object.scale.setScalar(NPC_HEIGHT / (new Box3().setFromObject(object).getSize(new Vector3()).y || 1));
    return object;
  }, [gltf]);
  const clips = useMemo(() => {
    const all = gltf?.animations ?? [];
    return { idle: all.find(clip => /^idle/i.test(clip.name)), walk: all.find(clip => /^walk/i.test(clip.name)),
      run: all.find(clip => /^run/i.test(clip.name)), waves: all.filter(clip => /wave/i.test(clip.name)) };
  }, [gltf]);
  const moves = Boolean(npc.patrol || npc.route);
  const mixer = useRef<AnimationMixer | null>(null), current = useRef<AnimationAction | undefined>(undefined);
  const standing = useRef<AnimationAction | undefined>(undefined), gait = useRef<AnimationAction | undefined>(undefined);
  /**
   * Blends into an action. A faded-out action is disabled, so it is always re-enabled from the start first; a held pose
   * stays paused on its first frame. Every blend keeps the total weight at one, so the rig never drops to its T rest pose.
   */
  const blendTo = (next: AnimationAction | undefined, hold = false, seconds = .25) => {
    if (!next || next === current.current) return;
    next.reset(); next.play();
    if (hold) { next.paused = true; next.time = 0; }
    if (current.current) next.crossFadeFrom(current.current, seconds, false);
    current.current = next;
  };
  useEffect(() => {
    if (!figure || !gltf) return;
    const next = new AnimationMixer(figure);
    mixer.current = next; current.current = undefined;
    // The stance: an idle loop, or else the first frame of a wave or walk, which is the figure standing with its arms down
    // (their rest pose is a T). A pacing figure's gait is its walk, or its run when it jogs.
    const pose = clips.waves[0] ?? clips.walk;
    standing.current = clips.idle ? next.clipAction(clips.idle).setLoop(LoopRepeat, Infinity) : pose ? next.clipAction(pose.clone()) : undefined;
    const stride = npc.route?.gait === 'run' ? clips.run ?? clips.walk : clips.walk;
    gait.current = moves && stride ? next.clipAction(stride).setLoop(LoopRepeat, Infinity) : undefined;
    if (gait.current) blendTo(gait.current);
    else if (clips.idle && standing.current) { blendTo(standing.current); standing.current.time = (npc.x * 7.3 + npc.z * 3.1) % clips.idle.duration; }
    else blendTo(standing.current, true);
    // A finished wave hands back to the stance.
    const settle = (event: { action: AnimationAction }) => { if (event.action === current.current) blendTo(standing.current, !clips.idle, .3); };
    next.addEventListener('finished', settle);
    return () => {
      next.removeEventListener('finished', settle); next.stopAllAction(); next.uncacheRoot(figure);
      mixer.current = null; current.current = standing.current = gait.current = undefined;
    };
  }, [figure, gltf, clips]);
  useEffect(() => () => {
    if (!figure) return;
    const skeletons = new Set<SkinnedMesh['skeleton']>();
    figure.traverse(child => { if (child instanceof SkinnedMesh) skeletons.add(child.skeleton); });
    skeletons.forEach(skeleton => skeleton.dispose());
    releaseRenderObjects(figure);
  }, [figure]);
  const hop = useRef(-1);
  /** Plays a wave once; a standing figure without one hops instead. Moving figures just keep going. */
  const greet = (clip: AnimationClip | undefined) => {
    if (moves) return;
    if (!clip || !mixer.current) { hop.current = performance.now(); return; }
    blendTo(mixer.current.clipAction(clip).setLoop(LoopOnce, 1)); current.current!.clampWhenFinished = true;
  };
  const [line, setLine] = useState(0), [turn, setTurn] = useState(0);
  // Waves (or hops) when the player walks up.
  useEffect(() => { if (talking) greet(clips.waves.find(clip => /big/i.test(clip.name)) ?? clips.waves[0]); }, [talking, figure]);
  // A standing figure with no idle loop waves now and then while it waits, so it never stands frozen.
  useEffect(() => {
    if (talking || moves || !figure || !clips.waves.length || clips.idle) return;
    const timer = window.setInterval(() => greet(clips.waves[Math.floor(Math.random() * clips.waves.length)]), 9000 + (Math.abs(npc.x * 131 + npc.z * 71) % 7000));
    return () => window.clearInterval(timer);
  }, [talking, figure, clips]);
  useEffect(() => {
    if (!talking || lines.length < 2) return;
    const timer = window.setInterval(() => setLine(value => value + 1), LINE_MS);
    return () => window.clearInterval(timer);
  }, [talking, lines.length, turn]);
  const facing = useRef(npc.facing), target = useRef({ x: player.x, z: player.z });
  target.current = { x: player.x, z: player.z };
  const where = useRef({ x: npc.x, z: npc.z, angle: npc.patrol ? Math.atan2(npc.z - npc.patrol.z, npc.x - npc.patrol.x) : 0, clock: 0, heading: npc.facing });
  useFrame((_, delta) => {
    const step = Math.min(delta, .05), here = where.current;
    mixer.current?.update(step);
    if (!root.current) return;
    let walking = false;
    if (npc.patrol) {
      // Counter-clockwise round the square without stopping; the ground height follows the paving.
      here.angle += PATROL_SPEED / npc.patrol.radius * step;
      here.x = npc.patrol.x + Math.cos(here.angle) * npc.patrol.radius; here.z = npc.patrol.z + Math.sin(here.angle) * npc.patrol.radius;
      here.heading = Math.atan2(-Math.sin(here.angle), Math.cos(here.angle)); walking = true;
    } else if (npc.route) {
      // Out to the far end, a breath, back, a breath.
      const dx = npc.route.x - npc.x, dz = npc.route.z - npc.z, length = Math.hypot(dx, dz) || 1;
      const leg = length / (npc.route.gait === 'run' ? JOG_SPEED : PATROL_SPEED), cycle = 2 * leg + 2 * PACE_PAUSE;
      here.clock = (here.clock + step) % cycle;
      const t = here.clock, out = t < leg, back = t >= leg + PACE_PAUSE && t < 2 * leg + PACE_PAUSE;
      const progress = out ? t / leg : back ? 1 - (t - leg - PACE_PAUSE) / leg : t < leg + PACE_PAUSE ? 1 : 0;
      here.x = npc.x + dx * progress; here.z = npc.z + dz * progress;
      if (out || back) { here.heading = out ? Math.atan2(dx, dz) : Math.atan2(-dx, -dz); walking = true; }
    }
    if (moves) {
      body.current?.position.set(here.x, terrainSurfaceHeight(sampleWorld, here.x, here.z), here.z);
      positions.set(npc.id, { x: here.x, z: here.z });
      blendTo(walking ? gait.current : standing.current, !walking);
    }
    // Standing figures turn to the player who talks to them; moving ones look where they go.
    const goal = talking && !walking ? Math.atan2(target.current.x - here.x, target.current.z - here.z) : moves ? here.heading : npc.facing;
    const turnBy = Math.atan2(Math.sin(goal - facing.current), Math.cos(goal - facing.current));
    facing.current += turnBy * Math.min(1, step * 6);
    const hopT = hop.current < 0 ? 1 : (performance.now() - hop.current) / HOP_MS;
    root.current.position.y = hopT < 1 ? Math.sin(hopT * Math.PI) * .3 : 0;
    root.current.rotation.y = facing.current;
  });
  const next = (event?: { stopPropagation(): void; delta?: number }) => {
    event?.stopPropagation();
    if ((event?.delta ?? 0) > 5) return;
    setLine(value => value + 1); setTurn(value => value + 1);
    greet(clips.waves.find(clip => !/big/i.test(clip.name)) ?? clips.waves[0]);
  };
  const text = lines.length ? lines[line % lines.length] : '';
  return <group ref={body} position={[npc.x, y, npc.z]} name={`town-npc:${npc.id}`}>
    <group ref={root}>{figure && <primitive object={figure} dispose={null} />}</group>
    {/* An invisible column is the click target, so a tap anywhere on the figure talks. */}
    <mesh position={[0, NPC_HEIGHT / 2, 0]} onClick={(event: ThreeEvent<MouseEvent>) => next(event)}
      onPointerOver={event => { event.stopPropagation(); document.body.style.cursor = 'pointer'; }} onPointerOut={() => { document.body.style.cursor = ''; }}>
      <cylinderGeometry args={[.5, .5, NPC_HEIGHT, 10]} />
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
  // Where patrolling figures are now; the frame loop writes it and the next render picks the speaker from it.
  const positions = useMemo(() => new Map<string, { x: number; z: number }>(), [atlas]);
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
    const at = positions.get(npc.id) ?? npc, distance = Math.hypot(at.x - player.x, at.z - player.z);
    if (distance < closest) { closest = distance; speaker = npc.id; }
  }
  return <group name="town-npcs">
    {drawn.map(({ npc, town }) => {
      const context: NpcTalkContext = {
        regionId: atlas.id, regionName: atlas.name, town: { id: town.id, name: town.name },
        gym: gyms.find(gym => gym.locationId === town.id), badges, outbreak: news, partnerName, nearbyDungeon: plan(town).dungeon,
      };
      return <TownNpcFigure key={npc.id} npc={npc} y={terrainSurfaceHeight(sampleWorld, npc.x, npc.z)} player={player}
        lines={npcLines(npc.role, context)} talking={npc.id === speaker} quiet={busy} sampleWorld={sampleWorld} positions={positions} />;
    })}
  </group>;
});
