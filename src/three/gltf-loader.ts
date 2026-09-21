import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { prepareRegionalRig } from './johto-rig';
import { preparePokemonModel } from '../openworld/model-normalization';
import { preparePokemonNormals } from './pokemon-normals';
import { getPokemonFormModelByUrl } from '../data/pokemon-form-models';
import { prepareFormTextures } from './form-textures';

class PokemonGLTFLoader extends GLTFLoader {
  constructor(private readonly smoothNormals = true) { super(); }
  override async loadAsync(url: string, onProgress?: (event: ProgressEvent) => void) {
    const gltf = await super.loadAsync(url, onProgress);
    const formSource = getPokemonFormModelByUrl(url);
    const match = url.match(/\/(?:regular|alolan|pokemon)\/(\d+)(?:-[A-Za-z0-9]+)?\.glb(?:[?#]|$)/)
      ?? url.match(/\/models\/(\d+)\/model\.glb(?:[?#]|$)/)
      ?? url.match(/\/pm(\d{4})_[^/]+\.glb(?:[?#]|$)/);
    const speciesId = formSource?.speciesId ?? (match ? Number(match[1]) : undefined);
    if (speciesId) {
      if (formSource) {
        gltf.scene.userData.pokemonFormIdentifier = formSource.identifier;
        await prepareFormTextures(gltf.scene, formSource.identifier);
      }
      if (this.smoothNormals) preparePokemonNormals(gltf.scene, speciesId);
      prepareRegionalRig(gltf, speciesId);
      await preparePokemonModel(gltf.scene, gltf.animations);
    }
    return gltf;
  }
}

// Lazy decoder initialization: WebAssembly and workers are requested only by a
// visible compressed model. All loaders share at most two decoder workers.
let decoder: DRACOLoader | undefined;
export function createGLTFLoader({ smoothNormals = true }: { smoothNormals?: boolean } = {}): GLTFLoader {
  decoder ??= new DRACOLoader().setDecoderPath('/draco/').setWorkerLimit(2);
  return new PokemonGLTFLoader(smoothNormals).setDRACOLoader(decoder);
}
