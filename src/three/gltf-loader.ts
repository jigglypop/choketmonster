import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Lazy decoder initialization: WebAssembly and workers are requested only by a
// visible compressed model. All loaders share at most two decoder workers.
let decoder: DRACOLoader | undefined;
export function createGLTFLoader(): GLTFLoader {
  decoder ??= new DRACOLoader().setDecoderPath('/draco/').setWorkerLimit(2);
  return new GLTFLoader().setDRACOLoader(decoder);
}
