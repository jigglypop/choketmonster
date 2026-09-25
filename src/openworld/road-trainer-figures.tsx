import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AnimationMixer, Box3, Mesh, SkinnedMesh, Vector3, type Group } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { releaseRenderObjects } from '../three/render-objects';
import { shadeFigure } from './figure-shading';
import { terrainSurfaceHeight } from './grounding';
import { NPC_HEIGHT, useNpcModel } from './town-npcs';
import type { WorldSample, WorldTrainer } from './types';

/** A trainer at the roadside sees a partner on the road and challenges it; it looks toward it from a little further. */
const SIGHT = 6, NOTICE = 9, LABEL_RANGE = 16;

function RoadTrainerFigure({ trainer, y, player, busy, onChallenge }: {
  trainer: WorldTrainer; y: number; player: { x: number; z: number }; busy: boolean; onChallenge?: (id: string) => void;
}) {
  const gltf = useNpcModel(trainer.model ?? '');
  const root = useRef<Group>(null);
  const figure = useMemo(() => {
    if (!gltf) return null;
    const object = cloneSkinned(gltf.scene);
    object.traverse(child => { if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; } });
    shadeFigure(object);
    object.scale.setScalar(NPC_HEIGHT / (new Box3().setFromObject(object).getSize(new Vector3()).y || 1));
    return object;
  }, [gltf]);
  const mixer = useRef<AnimationMixer | null>(null);
  useEffect(() => {
    if (!figure || !gltf) return;
    // Standing: the walk's first frame, feet together and arms down (the rest pose is a T).
    const next = new AnimationMixer(figure), walk = gltf.animations.find(clip => /^walk/i.test(clip.name));
    if (walk) { const hold = next.clipAction(walk.clone()).play(); hold.paused = true; hold.time = 0; }
    mixer.current = next;
    return () => { next.stopAllAction(); next.uncacheRoot(figure); mixer.current = null; };
  }, [figure, gltf]);
  useEffect(() => () => {
    if (!figure) return;
    const skeletons = new Set<SkinnedMesh['skeleton']>();
    figure.traverse(child => { if (child instanceof SkinnedMesh) skeletons.add(child.skeleton); });
    skeletons.forEach(skeleton => skeleton.dispose());
    releaseRenderObjects(figure);
  }, [figure]);
  const distance = Math.hypot(player.x - trainer.x, player.z - trainer.z);
  // Eyes meet: a trainer not yet beaten calls out once, then challenges; walking away lets it call again.
  // The call-out timer lives apart from the distance, which changes every step the partner takes, so it always fires.
  const [alert, setAlert] = useState(false), called = useRef(false), timer = useRef(0), challenge = useRef(onChallenge);
  challenge.current = onChallenge;
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (distance > NOTICE) { called.current = false; return; }
    if (trainer.defeated || busy || called.current || distance > SIGHT) return;
    called.current = true; setAlert(true);
    timer.current = window.setTimeout(() => { setAlert(false); challenge.current?.(trainer.id); }, 500);
  }, [distance, trainer.defeated, trainer.id, busy]);
  const facing = useRef(trainer.facing ?? 0), target = useRef(player);
  target.current = player;
  useFrame((state, delta) => {
    mixer.current?.update(Math.min(delta, .05));
    if (!root.current) return;
    // Looks the road up and down while waiting, and turns to a partner who comes near.
    const near = Math.hypot(target.current.x - trainer.x, target.current.z - trainer.z) < NOTICE;
    const base = trainer.facing ?? 0, glance = Math.sin(state.clock.elapsedTime * .35 + trainer.x) > .55 ? .9 : Math.sin(state.clock.elapsedTime * .35 + trainer.x) < -.55 ? -.9 : 0;
    const goal = near ? Math.atan2(target.current.x - trainer.x, target.current.z - trainer.z) : base + glance;
    facing.current += Math.atan2(Math.sin(goal - facing.current), Math.cos(goal - facing.current)) * Math.min(1, delta * 5);
    root.current.rotation.y = facing.current;
  });
  return <group position={[trainer.x, y, trainer.z]} name={`road-trainer:${trainer.id}`}>
    <group ref={root}>{figure && <primitive object={figure} dispose={null} />}</group>
    {distance < LABEL_RANGE && <Html center position={[0, NPC_HEIGHT + .45, 0]} zIndexRange={[4, 3]} style={{ pointerEvents: 'none' }}>
      <span className={`ow-trainer-label${trainer.defeated ? ' is-defeated' : ''}`}>{alert && <b className="ow-trainer-alert">!</b>}<small>{trainer.trainerClass}</small>{trainer.name}</span>
    </Html>}
  </group>;
}

/** Trainers by the roads near the partner: they stand, look about, and challenge it when it walks up. */
export const RoadTrainers = memo(function RoadTrainers({ trainers, sampleWorld, player, busy, onChallenge }: {
  trainers: readonly WorldTrainer[]; sampleWorld: (x: number, z: number) => WorldSample; player: { x: number; z: number }; busy: boolean; onChallenge?: (id: string) => void;
}) {
  return <group name="road-trainers">
    {trainers.filter(trainer => trainer.model).map(trainer => <RoadTrainerFigure key={trainer.id} trainer={trainer} y={terrainSurfaceHeight(sampleWorld, trainer.x, trainer.z)}
      player={player} busy={busy} onChallenge={onChallenge} />)}
  </group>;
});
