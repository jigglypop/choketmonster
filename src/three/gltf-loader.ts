import { LoadingManager } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { holdUnkeyedTracks, prepareRegionalRig } from './johto-rig';
import { preparePokemonModel } from '../openworld/model-normalization';
import { preparePokemonNormals } from './pokemon-normals';
import { getPokemonFormModelByUrl } from '../data/pokemon-form-models';
import { prepareFormTextures } from './form-textures';

class PokemonGLTFLoader extends GLTFLoader {
  constructor(private readonly smoothNormals = true, private readonly signal?: AbortSignal, manager?: LoadingManager) { super(manager); }
  override async loadAsync(url: string, onProgress?: (event: ProgressEvent) => void) {
    const gltf = await super.loadAsync(url, onProgress);
    const signal = this.signal;
    // An aborted load stops between preparation steps instead of finishing work nobody will use.
    const check = () => { if (signal?.aborted) throw signal.reason ?? new Error('Model load aborted'); };
    check();
    const formSource = getPokemonFormModelByUrl(url);
    const match = url.match(/\/(?:regular|alolan|pokemon)\/(\d+)(?:-[A-Za-z0-9]+)?\.glb(?:[?#]|$)/)
      ?? url.match(/\/models\/(\d+)\/model\.glb(?:[?#]|$)/)
      ?? url.match(/\/pm(\d{4})_[^/]+\.glb(?:[?#]|$)/);
    const speciesId = formSource?.speciesId ?? (match ? Number(match[1]) : undefined);
    if (speciesId) {
      if (formSource) {
        gltf.scene.userData.pokemonFormIdentifier = formSource.identifier;
        await prepareFormTextures(gltf.scene, formSource.identifier);
        check();
      }
      if (this.smoothNormals) preparePokemonNormals(gltf.scene, speciesId);
      check();
      prepareRegionalRig(gltf, speciesId);
      holdUnkeyedTracks(gltf.scene, gltf.animations);
      check();
      await preparePokemonModel(gltf.scene, gltf.animations, signal);
    }
    return gltf;
  }
}

// Lazy decoder initialization: WebAssembly and workers are requested only by a
// visible compressed model. All loaders share at most two decoder workers.
let decoder: DRACOLoader | undefined;
export function createGLTFLoader({ smoothNormals = true, signal }: { smoothNormals?: boolean; signal?: AbortSignal } = {}): GLTFLoader {
  decoder ??= new DRACOLoader().setDecoderPath('/draco/').setWorkerLimit(2);
  // A load with its own manager can cancel its download and external images without touching other loads.
  const manager = signal ? new LoadingManager() : undefined;
  if (signal && manager) signal.addEventListener('abort', () => manager.abort(), { once: true });
  return new PokemonGLTFLoader(smoothNormals, signal, manager).setDRACOLoader(decoder);
}
