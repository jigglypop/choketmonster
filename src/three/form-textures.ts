import { ClampToEdgeWrapping, Mesh, MeshStandardMaterial, MirroredRepeatWrapping, Object3D, RepeatWrapping, SRGBColorSpace, TextureLoader } from 'three';
import manifest from '../data/pokemon-form-textures.json';

type TextureSource = { colorUrl: string; alphaMin: number; channel: number; repeat: { x: number; y: number }; offset: { x: number; y: number }; unityImport: { wrapU: number; wrapV: number }; shader: { blendMode: number; constantAlpha: number; zWrite: number } };
const forms: Record<string, { materials: Record<string, TextureSource> }> = manifest.forms;
const wrapMode = (mode: number) => mode === 2 ? MirroredRepeatWrapping : mode === 1 ? ClampToEdgeWrapping : RepeatWrapping;
const textureKey = (source: TextureSource) => JSON.stringify([source.colorUrl, source.repeat, source.offset, source.unityImport, source.channel]);

/** Restore original Unity color maps lost by the HOME GLB export, by exact material identity. */
export async function prepareFormTextures(root: Object3D, identifier: string): Promise<void> {
  const form = forms[identifier];
  if (!form) return;
  const materials = new Set<MeshStandardMaterial>();
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material instanceof MeshStandardMaterial) materials.add(material);
    }
  });
  const sources = [...materials].map(material => {
    const source = form.materials[material.name];
    if (!source) throw new Error(`Missing original texture: ${identifier}/${material.name}`);
    return { material, source };
  });
  const loader = new TextureLoader();
  const unique = new Map(sources.map(({ source }) => [textureKey(source), source]));
  const textures = new Map(await Promise.all([...unique].map(async ([key, source]) => {
    const texture = await loader.loadAsync(source.colorUrl);
    texture.colorSpace = SRGBColorSpace;
    texture.flipY = false;
    texture.channel = source.channel;
    texture.wrapS = wrapMode(source.unityImport.wrapU); texture.wrapT = wrapMode(source.unityImport.wrapV);
    texture.repeat.set(source.repeat.x, source.repeat.y);
    texture.offset.set(source.offset.x, source.offset.y);
    texture.needsUpdate = true;
    return [key, texture] as const;
  })));
  sources.forEach(({ material, source }) => {
    material.map = textures.get(textureKey(source))!;
    material.color.set(0xffffff);
    material.metalness = 0;
    material.roughness = /eye/i.test(material.name) ? .3 : .62;
    // Color-map alpha is also shader data (not body transparency). Follow the
    // original Unity material's blend mode; otherwise Muk loses most of its body.
    material.alphaTest = 0;
    material.transparent = source.shader.blendMode !== 0;
    material.opacity = material.transparent ? source.shader.constantAlpha : 1;
    material.depthWrite = source.shader.zWrite !== 0;
    material.userData.authoredFormTexture = source.colorUrl;
    material.needsUpdate = true;
  });
}
