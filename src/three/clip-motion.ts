import { matchesPokemonMotionKind, POKEMON_MOTION_KINDS, type PokemonMotionKind } from '../data/model-motion';

/** Keyframe data shared by three.js KeyframeTracks and raw glTF animation channels. */
export type KeyframeSample = { name: string; times: ArrayLike<number>; values: ArrayLike<number> };
export type ClipMotionSummary = {
  /** Largest keyed rotation away from the first key, radians. */
  rotation: number;
  /** Largest keyed translation away from the first key, as a fraction of model height. */
  translation: number;
  /** Largest keyed scale component change. */
  scale: number;
  /** Largest morph-target weight change. */
  weights: number;
  tracks: number;
  movingTracks: number;
};

/** Visible-motion floor. Source clips below it replay their bind pose (seen as a frozen model). */
export const CLIP_MOTION_THRESHOLDS = { rotation: 1.5 * Math.PI / 180, translation: .004, scale: .01, weights: .02 } as const;
const PROPERTY = /\.(quaternion|position|scale|morphTargetInfluences)(?:\[[^\]]*\])?$/;

/**
 * `translationScale(trackName)` converts a raw translation delta into model-height units
 * (parent world scale / model height). Returning 0 or NaN ignores that track's translation.
 */
export function summarizeClipMotion(tracks: readonly KeyframeSample[], translationScale: (trackName: string) => number = () => 0): ClipMotionSummary {
  const summary: ClipMotionSummary = { rotation: 0, translation: 0, scale: 0, weights: 0, tracks: tracks.length, movingTracks: 0 };
  for (const track of tracks) {
    const property = track.name.match(PROPERTY)?.[1], keys = track.times.length, values = track.values;
    if (!property || keys < 2 || values.length < keys) continue;
    const stride = Math.max(1, Math.floor(values.length / keys));
    let delta = 0;
    if (property === 'quaternion' && stride === 4) {
      const n0 = Math.hypot(values[0], values[1], values[2], values[3]) || 1;
      for (let k = 1; k < keys; k++) {
        const o = k * 4, n = Math.hypot(values[o], values[o + 1], values[o + 2], values[o + 3]) || 1;
        const dot = Math.abs(values[0] * values[o] + values[1] * values[o + 1] + values[2] * values[o + 2] + values[3] * values[o + 3]) / (n0 * n);
        delta = Math.max(delta, 2 * Math.acos(Math.min(1, dot)));
      }
      summary.rotation = Math.max(summary.rotation, delta);
      if (delta >= CLIP_MOTION_THRESHOLDS.rotation) summary.movingTracks++;
      continue;
    }
    for (let k = 1; k < keys; k++) {
      let squared = 0, largest = 0;
      for (let c = 0; c < stride; c++) {
        const d = values[k * stride + c] - values[c];
        squared += d * d; largest = Math.max(largest, Math.abs(d));
      }
      delta = Math.max(delta, property === 'position' ? Math.sqrt(squared) : largest);
    }
    if (property === 'position') {
      const scale = translationScale(track.name), relative = Number.isFinite(scale) && scale > 0 ? delta * scale : 0;
      summary.translation = Math.max(summary.translation, relative);
      if (relative >= CLIP_MOTION_THRESHOLDS.translation) summary.movingTracks++;
    } else if (property === 'scale') {
      summary.scale = Math.max(summary.scale, delta);
      if (delta >= CLIP_MOTION_THRESHOLDS.scale) summary.movingTracks++;
    } else {
      summary.weights = Math.max(summary.weights, delta);
      if (delta >= CLIP_MOTION_THRESHOLDS.weights) summary.movingTracks++;
    }
  }
  return summary;
}

export function isMovingClipMotion(summary: ClipMotionSummary): boolean {
  return summary.rotation >= CLIP_MOTION_THRESHOLDS.rotation || summary.translation >= CLIP_MOTION_THRESHOLDS.translation
    || summary.scale >= CLIP_MOTION_THRESHOLDS.scale || summary.weights >= CLIP_MOTION_THRESHOLDS.weights;
}

/**
 * Motion kinds that need an authored clip because no source clip both matches the kind's
 * name and visibly moves. A moving source clip with a generic name ("Take 001") already
 * serves as idle through the selection fallback, so it suppresses only the authored idle.
 */
export function missingMotionKinds(native: ReadonlyArray<{ name: string; moving: boolean }>): PokemonMotionKind[] {
  const moving = native.filter(clip => clip.moving);
  const generic = moving.some(clip => POKEMON_MOTION_KINDS.every(kind => !matchesPokemonMotionKind(clip.name, kind)));
  return POKEMON_MOTION_KINDS.filter(kind => !moving.some(clip => matchesPokemonMotionKind(clip.name, kind)) && !(kind === 'idle' && generic));
}
