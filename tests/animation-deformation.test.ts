import { describe, expect, it } from 'vitest';
import { AnimationClip, Bone, BoxGeometry, BufferAttribute, MeshBasicMaterial, NumberKeyframeTrack, Skeleton, SkinnedMesh } from 'three';
import { inspectAnimationDeformation } from '../scripts/animation-deformation';

describe('inspectAnimationDeformation', () => {
  function createSkin() {
    const geometry = new BoxGeometry(1, 1, 1);
    const vertices = geometry.getAttribute('position').count;
    geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(vertices * 4), 4));
    const weights = new Float32Array(vertices * 4);
    for (let vertex = 0; vertex < vertices; vertex++) weights[vertex * 4] = 1;
    geometry.setAttribute('skinWeight', new BufferAttribute(weights, 4));
    const joint = new Bone();
    joint.name = 'joint';
    const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
    mesh.add(joint);
    mesh.bind(new Skeleton([joint]));
    return mesh;
  }

  it('detects finite skinned vertex movement from a native bone track', () => {
    const mesh = createSkin();
    const clip = new AnimationClip('native-walk', 1, [new NumberKeyframeTrack('joint.position[x]', [0, .5, 1], [0, 1, 0])]);

    const result = inspectAnimationDeformation(mesh, clip, Math.sqrt(3));

    expect(result.finitePose).toBe(true);
    expect(result.nonFiniteSamples).toBe(0);
    expect(result.sampledVertices).toBeGreaterThan(0);
    expect(result.changedSamples).toBeGreaterThan(0);
    expect(result.relativeMaxDelta).toBeGreaterThan(0);
  });

  it('does not claim deformation for a static source clip', () => {
    const mesh = createSkin();
    const clip = new AnimationClip('native-static', 1, [new NumberKeyframeTrack('joint.position[x]', [0, 1], [0, 0])]);

    const result = inspectAnimationDeformation(mesh, clip, Math.sqrt(3));

    expect(result.finitePose).toBe(true);
    expect(result.changedSamples).toBe(0);
  });

  it('does not count rigid root motion as skin deformation', () => {
    const mesh = createSkin();
    const clip = new AnimationClip('native-root-motion', 1, [new NumberKeyframeTrack('.position[x]', [0, .5, 1], [0, 1, 0])]);

    const result = inspectAnimationDeformation(mesh, clip, Math.sqrt(3));

    expect(result.finitePose).toBe(true);
    expect(result.changedSamples).toBe(0);
  });

  it('rejects a non-finite animated pose', () => {
    const mesh = createSkin();
    const clip = new AnimationClip('native-invalid', 1, [new NumberKeyframeTrack('joint.position[x]', [0, 1], [0, Number.NaN])]);

    const result = inspectAnimationDeformation(mesh, clip, Math.sqrt(3));

    expect(result.finitePose).toBe(false);
    expect(result.nonFiniteSamples).toBeGreaterThan(0);
  });
});
