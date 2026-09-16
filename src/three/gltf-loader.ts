import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { prepareRegionalRig } from './johto-rig';
import { preparePokemonModel } from '../openworld/model-normalization';

class PokemonGLTFLoader extends GLTFLoader {
  override async loadAsync(url: string, onProgress?: (event: ProgressEvent) => void) {
    const gltf = await super.loadAsync(url, onProgress);
    const match = url.match(/\/(?:regular|pokemon)\/(\d+)(?:-[A-Za-z0-9]+)?\.glb(?:[?#]|$)/)
      ?? url.match(/\/models\/(\d+)\/model\.glb(?:[?#]|$)/)
      ?? url.match(/\/pm(\d{4})_[^/]+\.glb(?:[?#]|$)/);
    if (match) {
      prepareRegionalRig(gltf, Number(match[1]));
      await preparePokemonModel(gltf.scene, gltf.animations);
    }
    return gltf;
  }
}

// Lazy decoder initialization: WebAssembly and workers are requested only by a
// visible compressed model. All loaders share at most two decoder workers.
let decoder: DRACOLoader | undefined;
export function createGLTFLoader(): GLTFLoader {
  decoder ??= new DRACOLoader().setDecoderPath('/draco/').setWorkerLimit(2);
  return new PokemonGLTFLoader().setDRACOLoader(decoder);
}
