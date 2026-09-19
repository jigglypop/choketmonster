// gaesup-world 1.0.31 advertises Three r178 support but its snow export imports
// screenDPR (added later). Keep the existing renderer and provide its exact
// per-render pixel-ratio semantics. Remove this adapter after upgrading Three.
export * from 'three/src/Three.TSL.js';
import { uniform } from 'three/src/Three.TSL.js';

export const screenDPR = uniform(1).onRenderUpdate(({ renderer }) => renderer?.getPixelRatio() ?? 1);
