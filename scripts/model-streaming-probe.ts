import { AnimationMixer, Box3, Group, SkinnedMesh } from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { pokemonModelUrl } from '../src/game/assets';
import { acquireModel, modelCacheStats } from '../src/three/model-cache';
import { normalizePokemonModel } from '../src/openworld/model-normalization';
import { createGrounding } from '../src/openworld/grounding';
import { selectPokemonMotionClip } from '../src/data/model-motion';

/** Browser probe with real GLBs: shared cache, clone independence and exact-floor comparison. */
export async function inspectModelStreaming() {
  const rows = [];
  for (const id of [1, 130, 152, 208, 445, 727]) {
    const url = pokemonModelUrl(id), start = performance.now();
    const field = acquireModel(url), box = acquireModel(url);
    const [asset, second] = await Promise.all([field.promise, box.promise]);
    if (asset !== second) throw new Error(`Duplicate decoded asset ${id}`);
    const loadingMs = performance.now() - start, normalizeMs: number[] = [];
    let frameMs = 0, maxGap = 0, supportVertices = 0;
    for (let pass = 0; pass < 3; pass++) {
      const before = performance.now();
      const normalized = normalizePokemonModel(clone(asset.scene), asset.animations, 1.5, { speciesId: id }, asset.scene);
      normalizeMs.push(performance.now() - before);
      supportVertices = [...normalized.grounding.values()].reduce((sum, indices) => sum + indices.length, 0);
      const parent = new Group(), offset = new Group(); parent.add(offset); offset.add(normalized.visual);
      const ground = createGrounding(normalized.visual, offset, normalized.grounding);
      const mixer = new AnimationMixer(normalized.animatedRoot), bounds = new Box3();
      let cost = 0, frames = 0;
      for (const kind of ['idle', 'walk', 'attack'] as const) {
        const clip = selectPokemonMotionClip(asset.animations, kind).clip;
        if (!clip) continue;
        mixer.stopAllAction(); mixer.clipAction(clip).play();
        for (let frame = 0; frame < 24; frame++) {
          mixer.setTime(clip.duration * (frame + .37) / 24);
          parent.position.set(frame * .13, frame * .03, frame * -.11); parent.rotation.y = frame * .14;
          const beforeGround = performance.now(); ground(parent.position.y); cost += performance.now() - beforeGround; frames++;
          // Independent full-vertex result, excluded from the timing above.
          bounds.setFromObject(normalized.visual, true);
          maxGap = Math.max(maxGap, Math.abs(bounds.min.y - parent.position.y));
        }
      }
      frameMs += cost / Math.max(1, frames) / 3;
      mixer.stopAllAction(); mixer.uncacheRoot(normalized.animatedRoot);
      const skeletons = new Set<SkinnedMesh['skeleton']>();
      normalized.animatedRoot.traverse(object => { if (object instanceof SkinnedMesh) skeletons.add(object.skeleton); });
      skeletons.forEach(skeleton => skeleton.dispose());
    }
    field.release(); box.release();
    const revisit = acquireModel(url), revisitStart = performance.now();
    if (await revisit.promise !== asset) throw new Error(`Cache lost ${id}`);
    const revisitMs = performance.now() - revisitStart; revisit.release();
    rows.push({ id, loadingMs, normalizeMs, frameMs, maxGap, supportVertices, revisitMs });
  }
  if (rows.some(row => row.maxGap > .01)) throw new Error(`Ground contact regression: ${JSON.stringify(rows)}`);
  return { rows, cache: modelCacheStats() };
}
