import { describe, expect, it } from 'vitest';
import {
  AnimationClip, Bone, Box3, BoxGeometry, BufferAttribute, Group, Mesh, MeshStandardMaterial, Object3D, Quaternion,
  QuaternionKeyframeTrack, Skeleton, SkinnedMesh, Vector3, VectorKeyframeTrack,
} from 'three';
import { STATIC_MOTION_CLIP, clipGroundSpeed, selectPokemonMotionClip } from '../src/data/model-motion';
import { CLIP_MOTION_THRESHOLDS, isMovingClipMotion, missingMotionKinds, summarizeClipMotion } from '../src/three/clip-motion';
import { REGIONAL_RIG_VERSION, boneMotionRole, boneSide, prepareRegionalRig } from '../src/three/johto-rig';

const turn = (degrees: number, axis = new Vector3(1, 0, 0)) => new Quaternion().setFromAxisAngle(axis, degrees * Math.PI / 180).toArray();
const rotation = (bone: string, ...degrees: number[]) => new QuaternionKeyframeTrack(`${bone}.quaternion`, degrees.map((_, i) => i), degrees.flatMap(value => turn(value)));
const clip = (name: string, ...tracks: Array<QuaternionKeyframeTrack | VectorKeyframeTrack>) => new AnimationClip(name, -1, tracks);

/** A small humanoid skin: Hips > Spine > Neck > Head > Jaw, arms from the spine, two-segment legs. */
function skinnedModel() {
  const bone = (name: string, parent: Bone | undefined, x: number, y: number, z = 0) => {
    const value = new Bone(); value.name = name; value.position.set(x, y, z); parent?.add(value); return value;
  };
  const hips = bone('Hips', undefined, 0, .9), spine = bone('Spine', hips, 0, .3), neck = bone('Neck', spine, 0, .4);
  const head = bone('Head', neck, 0, .2), jaw = bone('Jaw', head, 0, .05, .1);
  const bones = [hips, spine, neck, head, jaw,
    bone('LArm', spine, -.3, .3), bone('RArm', spine, .3, .3),
    bone('LThigh', hips, -.15, 0), bone('RThigh', hips, .15, 0)];
  bones.push(bone('LLeg', bones[7], 0, -.45), bone('RLeg', bones[8], 0, -.45));
  const geometry = new BoxGeometry(.8, 1.8, .4, 2, 6, 2).translate(0, .9, 0);
  const count = geometry.getAttribute('position').count, indices = new Uint16Array(count * 4), weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const y = geometry.getAttribute('position').getY(i), x = geometry.getAttribute('position').getX(i);
    indices[i * 4] = y < .5 ? (x < 0 ? 9 : 10) : y < 1.1 ? 1 : 3; weights[i * 4] = 1;
  }
  geometry.setAttribute('skinIndex', new BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(weights, 4));
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial()); mesh.name = 'Body';
  const scene = new Group(); scene.add(hips, mesh);
  scene.updateMatrixWorld(true);
  mesh.bind(new Skeleton(bones));
  return { scene, bones: Object.fromEntries(bones.map(value => [value.name, value])) as Record<string, Bone> };
}

describe('clip motion measurement', () => {
  it('treats repeated bind-pose keys as frozen and real rotation as motion', () => {
    const frozen = summarizeClipMotion([{ name: 'Hips.quaternion', times: [0, 1, 2], values: [...turn(0), ...turn(0), ...turn(.2)] }]);
    const moving = summarizeClipMotion([{ name: 'Hips.quaternion', times: [0, 1], values: [...turn(0), ...turn(20)] }]);
    expect(isMovingClipMotion(frozen)).toBe(false);
    expect(moving.rotation).toBeCloseTo(20 * Math.PI / 180, 5);
    expect(isMovingClipMotion(moving)).toBe(true);
  });

  it('measures translation relative to model height and ignores it without a scale', () => {
    const tracks = [{ name: 'Hips.position', times: [0, 1], values: [0, 0, 0, 0, .05, 0] }];
    expect(isMovingClipMotion(summarizeClipMotion(tracks))).toBe(false);
    expect(summarizeClipMotion(tracks, () => 1 / 2).translation).toBeCloseTo(.025, 6);
    expect(isMovingClipMotion(summarizeClipMotion(tracks, () => 1 / 2))).toBe(true);
    expect(isMovingClipMotion(summarizeClipMotion(tracks, () => CLIP_MOTION_THRESHOLDS.translation / 1000))).toBe(false);
  });

  it('reports only kinds without a moving, name-matched source clip', () => {
    expect(missingMotionKinds([{ name: 'idle', moving: true }, { name: 'walk', moving: false }])).toEqual(['walk', 'attack', 'damage']);
    // A moving generic clip already serves as idle through the selection fallback.
    expect(missingMotionKinds([{ name: 'ArmatureAction', moving: true }])).toEqual(['walk', 'attack', 'damage']);
    expect(missingMotionKinds([{ name: 'ArmatureAction', moving: false }])).toEqual(['idle', 'walk', 'attack', 'damage']);
    expect(missingMotionKinds(['Idol', 'Walking', 'Attack', 'Faint'].map(name => ({ name, moving: true })))).toEqual([]);
  });
});

describe('source bone roles', () => {
  it.each([
    ['LThigh_038', -1], ['left_leg_01', -1], ['Leg.L', -1], ['HindLegL_014', -1], ['trleft_arm_01', -1],
    ['RArm_023', 1], ['Leg.R.001', 1], ['ThingyR_010', 1], ['right_foot', 1],
    ['Root_00', 0], ['_rootJoint', 0], ['Luxio_80', 0], ['LowerJaw_050', 0], ['Tail1', 0],
  ] as const)('%s is on side %d', (name, side) => expect(boneSide(name)).toBe(side));

  it('ranks leg chains so the hip swings, the next segment bends and deeper segments follow', () => {
    expect(boneMotionRole('LThigh', ['Hips'])).toBe('leg');
    expect(boneMotionRole('LLeg', ['LThigh', 'Hips'])).toBe('foot');
    expect(boneMotionRole('LFoot', ['LLeg', 'LThigh', 'Hips'])).toBe('legTip');
    expect(boneMotionRole('left_leg_01_022', ['trleft_leg_01_021', 'left_crotch_011', 'trleft_crotch_010', 'hips_09'])).toBe('foot');
    expect(boneMotionRole('left_crotch_011', ['trleft_crotch_010', 'hips_09'])).toBe('leg');
    expect(boneMotionRole('trleft_leg_01_021', ['left_crotch_011'])).toBe('legHelper');
    expect(boneMotionRole('FrontLegL_020', ['Root_00'])).toBe('leg');
    expect(boneMotionRole('Leg Pole Target.R_18', ['Bone_20'])).not.toMatch(/^leg$|^foot$/);
    expect(boneMotionRole('LArm_019', ['LShoulder_018'])).toBe('arm');
    expect(boneMotionRole('Tail2', ['Tail1'])).toBe('tail');
  });
});

describe('regional rig v5', () => {
  it('authors only the kinds a moving source idle lacks, starting from its first pose', () => {
    const { scene, bones } = skinnedModel();
    const idle = clip('Idle', rotation('Jaw', 12, 20, 12), rotation('Spine', 0, 6, 0));
    const gltf = { scene, animations: [idle] };
    const bindJaw = bones.Jaw.quaternion.clone();
    prepareRegionalRig(gltf, 25);
    expect(gltf.animations.map(value => value.name)).toEqual(['Idle', 'CM_walk', 'CM_attack', 'CM_damage']);
    expect(scene.userData.authoredRig).toMatchObject({ version: REGIONAL_RIG_VERSION, sourceSkeleton: true, authoredKinds: ['walk', 'attack', 'damage'], reason: 'missing-native-motion-kinds' });
    expect(selectPokemonMotionClip(gltf.animations, 'idle').clip).toBe(idle);
    expect(selectPokemonMotionClip(gltf.animations, 'walk')).toMatchObject({ clip: { name: 'CM_walk' }, matched: true });
    // Bones only the idle animates are held at its first key instead of snapping to bind.
    const walk = gltf.animations[1], jaw = walk.tracks.find(track => track.name === 'Jaw.quaternion')!;
    expect(Array.from(jaw.values.slice(0, 4))).toEqual(turn(12).map(value => Math.fround(value)));
    // Authored legs swing, and the template is restored to its bind pose.
    const leg = walk.tracks.find(track => track.name === 'LThigh.quaternion')!;
    expect(isMovingClipMotion(summarizeClipMotion([{ name: leg.name, times: leg.times, values: leg.values }]))).toBe(true);
    expect(bones.Jaw.quaternion.equals(bindJaw)).toBe(true);
  });

  it('flags a frozen source walk so the authored walk replaces it', () => {
    const { scene } = skinnedModel();
    const idle = clip('idle', rotation('Spine', 0, 8, 0)), walk = clip('walk', rotation('Spine', 0, 0, 0));
    const gltf = { scene, animations: [idle, walk] };
    prepareRegionalRig(gltf, 25);
    expect(walk.userData[STATIC_MOTION_CLIP]).toBe(true);
    expect(idle.userData[STATIC_MOTION_CLIP]).toBeUndefined();
    expect(selectPokemonMotionClip(gltf.animations, 'walk').clip?.name).toBe('CM_walk');
    expect(selectPokemonMotionClip(gltf.animations, 'idle').clip).toBe(idle);
  });

  it('leaves complete moving source motion untouched', () => {
    const { scene } = skinnedModel();
    const animations = ['idle', 'walk', 'attack', 'damage'].map(name => clip(name, rotation('Spine', 0, 15, 0)));
    const gltf = { scene, animations: [...animations] };
    prepareRegionalRig(gltf, 25);
    expect(gltf.animations).toEqual(animations);
    expect(scene.userData.authoredRig).toBeUndefined();
    expect(scene.userData.nativeMotion).toMatchObject({ reason: 'native-skinned-motion', frozenSourceClips: 0 });
  });

  it('replaces a listed source skeleton and never selects its detached clips', () => {
    const { scene } = skinnedModel();
    const walk = clip('walk', rotation('LThigh', 0, 30, 0)), idle = clip('idle', rotation('Spine', 0, 10, 0));
    const gltf = { scene, animations: [idle, walk] };
    prepareRegionalRig(gltf, 68);
    expect(scene.userData.authoredRig).toMatchObject({ sourceSkeleton: false, reason: 'replaced-source-skeleton', frozenSourceClips: 2 });
    for (const kind of ['idle', 'walk', 'attack', 'damage'] as const) expect(selectPokemonMotionClip(gltf.animations, kind).clip?.name).toBe(`CM_${kind}`);
  });

  it('keeps rigid transform animation on its source hierarchy when it walks', () => {
    const scene = new Group(), arm = new Object3D(); arm.name = 'Arm';
    const piece = new Mesh(new BoxGeometry(.2, 1, .2), new MeshStandardMaterial()); piece.name = 'Piece';
    arm.add(piece); scene.add(arm);
    const animations = [clip('Idol', rotation('Arm', 0, 10, 0)), clip('Walking', rotation('Arm', 0, 30, 0)), clip('Attack', rotation('Arm', 0, 60, 0))];
    const gltf = { scene, animations: [...animations] };
    prepareRegionalRig(gltf, 796);
    expect(gltf.animations).toEqual(animations);
    expect(piece.parent).toBe(arm);
    expect(scene.userData.nativeMotion).toMatchObject({ reason: 'native-transform-motion' });
    expect(selectPokemonMotionClip(gltf.animations, 'walk').clip?.name).toBe('Walking');
  });

  it('plays walk loops in place and keeps their root travel as ground speed', () => {
    const { scene } = skinnedModel();
    const times = [0, .25, .5, .75, 1];
    // Hips stride 0.9 forward per loop with a bob; the thigh below them carries the same drift.
    const stride = (bone: string, y: number) => new VectorKeyframeTrack(`${bone}.position`, times, times.flatMap((t, i) => [0, y + (i % 2) * .05, t * .9]));
    const swing = new QuaternionKeyframeTrack('LThigh.quaternion', times, [0, 25, 0, -25, 0].flatMap(degrees => turn(degrees)));
    const walk = clip('walk01_loop', stride('Hips', .9), stride('LThigh', 0), swing);
    const idle = clip('defaultwait01_loop', rotation('Spine', 0, 6, 0));
    const lunge = clip('attack01', new VectorKeyframeTrack('Hips.position', [0, 1], [0, .9, 0, 0, .9, .6]), rotation('Spine', 0, 20));
    const gltf = { scene, animations: [idle, walk, lunge] };
    prepareRegionalRig(gltf, 25);
    const hips = walk.tracks.find(track => track.name === 'Hips.position')!, thigh = walk.tracks.find(track => track.name === 'LThigh.position')!;
    // The loop now ends where it starts; the bob stays and the nested thigh is untouched.
    expect(hips.values[14]).toBeCloseTo(hips.values[2], 6);
    expect(hips.values[4] - hips.values[1]).toBeCloseTo(.05, 6);
    expect(thigh.values[14]).toBeCloseTo(.9, 6);
    // 0.9 per second over a 1.8 tall model.
    expect(clipGroundSpeed(walk)).toBeCloseTo(.5, 2);
    expect(clipGroundSpeed(idle)).toBeUndefined();
    // Attacks are one-shots; their lunge stays.
    expect(lunge.tracks[0].values[5]).toBeCloseTo(.6, 6);
    expect(selectPokemonMotionClip(gltf.animations, 'walk', .5).clip).toBe(walk);
  });

  it('turns a sideways source to face +Z before rigging', () => {
    // Basculin's source swims along +X: its head end is the wider +X half.
    const scene = new Group(), body = new Mesh(new BoxGeometry(2, .5, .5).translate(0, .25, 0), new MeshStandardMaterial());
    const head = new Mesh(new BoxGeometry(.3, .6, .6).translate(.9, .3, 0), new MeshStandardMaterial());
    scene.add(body, head);
    const gltf = { scene, animations: [] as AnimationClip[] };
    prepareRegionalRig(gltf, 550);
    scene.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(scene, true), size = bounds.getSize(new Vector3());
    expect(size.z).toBeCloseTo(2.05, 5); expect(size.x).toBeCloseTo(.6, 5);
    expect(bounds.max.z).toBeCloseTo(1.05, 5); // the head now leads along +Z
    expect(scene.userData.orientationFix).toMatchObject({ yaw: -Math.PI / 2 });
    expect(gltf.animations.map(value => value.name)).toEqual(['CM_idle', 'CM_walk', 'CM_attack', 'CM_damage']);
  });

  it('skins a static source and authors all four kinds', () => {
    const scene = new Group(); scene.add(new Mesh(new BoxGeometry(1, 1, 1).translate(0, .5, 0), new MeshStandardMaterial()));
    const gltf = { scene, animations: [] as AnimationClip[] };
    prepareRegionalRig(gltf, 25);
    expect(gltf.animations.map(value => value.name)).toEqual(['CM_idle', 'CM_walk', 'CM_attack', 'CM_damage']);
    let skinned = 0; scene.traverse(object => { if (object instanceof SkinnedMesh) skinned++; });
    expect(skinned).toBe(1);
  });
});
