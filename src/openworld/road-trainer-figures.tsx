import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { AnimationMixer, Box3, LoopOnce, LoopRepeat, Mesh, SkinnedMesh, Vector3, type AnimationAction, type Group } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { releaseRenderObjects } from '../three/render-objects';
import { shadeFigure } from './figure-shading';
import { terrainSurfaceHeight } from './grounding';
import { NPC_HEIGHT, useNpcModel } from './town-npcs';
import type { WorldSample, WorldTrainer } from './types';

/** A trainer at the roadside sees a partner on the road and challenges it; it looks toward it from a little further. */
const SIGHT = 6, NOTICE = 9, LABEL_RANGE = 16;
type Point = { x: number; z: number };

/**
 * One trainer. The partner's position arrives through a ref and is read every frame, so a step of the partner does not
 * re-render the figure; only crossing the label or call-out range changes its state.
 */
const RoadTrainerFigure = memo(function RoadTrainerFigure({ trainer, sampleWorld, player, busy, onChallenge }: {
  trainer: WorldTrainer; sampleWorld: (x: number, z: number) => WorldSample; player: MutableRefObject<Point>; busy: boolean;
  onChallenge: MutableRefObject<((id: string) => void) | undefined>;
}) {
  const gltf = useNpcModel(trainer.model ?? '');
  const root = useRef<Group>(null);
  const y = useMemo(() => terrainSurfaceHeight(sampleWorld, trainer.x, trainer.z), [sampleWorld, trainer.x, trainer.z]);
  const figure = useMemo(() => {
    if (!gltf) return null;
    const object = cloneSkinned(gltf.scene);
    object.traverse(child => { if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; } });
    shadeFigure(object);
    object.scale.setScalar(NPC_HEIGHT / (new Box3().setFromObject(object).getSize(new Vector3()).y || 1));
    return object;
  }, [gltf]);
  const mixer = useRef<AnimationMixer | null>(null), idle = useRef<AnimationAction | undefined>(undefined), wave = useRef<AnimationAction | undefined>(undefined);
  useEffect(() => {
    if (!figure || !gltf) return;
    const next = new AnimationMixer(figure), clips = gltf.animations;
    const idleClip = clips.find(clip => /^idle/i.test(clip.name)), waveClip = clips.find(clip => /wave/i.test(clip.name));
    if (idleClip) {
      // Neighbours stand out of step: each starts its loop at its own moment and breathes at its own pace.
      const action = next.clipAction(idleClip).setLoop(LoopRepeat, Infinity).play();
      action.time = Math.abs(trainer.x * 7.3 + trainer.z * 3.1) % idleClip.duration;
      action.setEffectiveTimeScale(.9 + Math.abs(Math.sin(trainer.x * 12.9 + trainer.z * 78.2)) * .2);
      idle.current = action;
    } else {
      // Standing: the walk's first frame, feet together and arms down (the rest pose is a T).
      const walk = clips.find(clip => /^walk/i.test(clip.name));
      if (walk) { const hold = next.clipAction(walk.clone()).play(); hold.paused = true; hold.time = 0; }
    }
    wave.current = idle.current && waveClip ? next.clipAction(waveClip).setLoop(LoopOnce, 1) : undefined;
    if (wave.current) wave.current.clampWhenFinished = true;
    // A finished wave hands back to the idle; the incoming action always restarts before the blend, so no bone drops to the T.
    const settle = (event: { action: AnimationAction }) => {
      if (event.action !== wave.current || !idle.current) return;
      idle.current.reset().play(); idle.current.crossFadeFrom(wave.current, .3, false);
    };
    next.addEventListener('finished', settle);
    next.update(0);
    mixer.current = next;
    return () => {
      next.removeEventListener('finished', settle); next.stopAllAction(); next.uncacheRoot(figure);
      mixer.current = null; idle.current = wave.current = undefined;
    };
  }, [figure, gltf, trainer.x, trainer.z]);
  useEffect(() => () => {
    if (!figure) return;
    const skeletons = new Set<SkinnedMesh['skeleton']>();
    figure.traverse(child => { if (child instanceof SkinnedMesh) skeletons.add(child.skeleton); });
    skeletons.forEach(skeleton => skeleton.dispose());
    releaseRenderObjects(figure);
  }, [figure]);
  const [labelled, setLabelled] = useState(false), [alert, setAlert] = useState(false);
  // Eyes meet: a trainer not yet beaten calls out once, then challenges; walking away lets it call again. A beaten one
  // waves as the partner passes. The call-out timer lives apart from the distance, so it always fires.
  const called = useRef(false), greeted = useRef(false), timer = useRef(0), state = useRef({ busy, defeated: trainer.defeated });
  state.current = { busy, defeated: trainer.defeated };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const facing = useRef(trainer.facing ?? 0);
  useFrame((frame, delta) => {
    mixer.current?.update(Math.min(delta, .05));
    if (!root.current) return;
    const distance = Math.hypot(player.current.x - trainer.x, player.current.z - trainer.z);
    if (distance < LABEL_RANGE !== labelled) setLabelled(distance < LABEL_RANGE);
    if (distance > NOTICE) { called.current = greeted.current = false; }
    else if (state.current.defeated) {
      if (!greeted.current && wave.current && idle.current) {
        greeted.current = true;
        wave.current.reset().play(); wave.current.crossFadeFrom(idle.current, .25, false);
      }
    } else if (!state.current.busy && !called.current && distance <= SIGHT) {
      called.current = true; setAlert(true);
      timer.current = window.setTimeout(() => { setAlert(false); onChallenge.current?.(trainer.id); }, 500);
    }
    // Looks the road up and down while waiting, and turns to a partner who comes near.
    const base = trainer.facing ?? 0, sway = Math.sin(frame.clock.elapsedTime * .35 + trainer.x);
    const goal = distance < NOTICE ? Math.atan2(player.current.x - trainer.x, player.current.z - trainer.z) : base + (sway > .55 ? .9 : sway < -.55 ? -.9 : 0);
    facing.current += Math.atan2(Math.sin(goal - facing.current), Math.cos(goal - facing.current)) * Math.min(1, delta * 5);
    root.current.rotation.y = facing.current;
  });
  return <group position={[trainer.x, y, trainer.z]} name={`road-trainer:${trainer.id}`}>
    <group ref={root}>{figure && <primitive object={figure} dispose={null} />}</group>
    {labelled && <Html center position={[0, NPC_HEIGHT + .45, 0]} zIndexRange={[4, 3]} style={{ pointerEvents: 'none' }}>
      <span className={`ow-trainer-label${trainer.defeated ? ' is-defeated' : ''}`}>{alert && <b className="ow-trainer-alert">!</b>}<small>{trainer.trainerClass}</small>{trainer.name}</span>
    </Html>}
  </group>;
}, (before, after) => before.busy === after.busy && before.sampleWorld === after.sampleWorld && before.player === after.player && before.onChallenge === after.onChallenge
  && before.trainer.id === after.trainer.id && before.trainer.x === after.trainer.x && before.trainer.z === after.trainer.z && before.trainer.facing === after.trainer.facing
  && before.trainer.model === after.trainer.model && before.trainer.defeated === after.trainer.defeated && before.trainer.name === after.trainer.name
  && before.trainer.trainerClass === after.trainer.trainerClass);

/** Trainers by the roads near the partner: they idle, look about, and challenge it when it walks up. */
export const RoadTrainers = memo(function RoadTrainers({ trainers, sampleWorld, player, busy, onChallenge }: {
  trainers: readonly WorldTrainer[]; sampleWorld: (x: number, z: number) => WorldSample; player: Point; busy: boolean; onChallenge?: (id: string) => void;
}) {
  const where = useRef(player), challenge = useRef(onChallenge);
  where.current = player; challenge.current = onChallenge;
  return <group name="road-trainers">
    {trainers.filter(trainer => trainer.model).map(trainer => <RoadTrainerFigure key={trainer.id} trainer={trainer} sampleWorld={sampleWorld}
      player={where} busy={busy} onChallenge={challenge} />)}
  </group>;
});
