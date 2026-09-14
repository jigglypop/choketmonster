import { useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { DataTexture, EquirectangularReflectionMapping, FloatType, LinearSRGBColorSpace, MeshStandardMaterial, PMREMGenerator, RepeatWrapping, RGBAFormat, SRGBColorSpace, Texture, TextureLoader } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  abs, color, cos, dot, float, instanceIndex, length, materialColor, materialRoughness, max, min, mix, normalView, normalize,
  positionLocal, positionViewDirection, positionWorld, pow, sin, smoothstep, texture, timerLocal, vec2, vec3,
} from 'three/tsl';

type Surface = 'ground' | 'rock' | 'path';
export type SurfaceTextures = { diffuse: Texture; normal: Texture; arm: Texture };
export type WaterMaterialOptions = { lake?: boolean; center?: readonly [number, number]; extent?: readonly [number, number]; radius?: number };

/** Palette meshes gain canopy depth and a restrained back-lit leaf response. */
export function detailCanopy(material: MeshStandardMaterial) {
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying float owCanopyHeight;\nvarying vec3 owCanopyNormal;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        owCanopyHeight = position.y;
        vec3 owLeafNormal = objectNormal;
        #ifdef USE_INSTANCING
          owLeafNormal = mat3(instanceMatrix) * owLeafNormal;
        #endif
        owCanopyNormal = normalize(mat3(modelMatrix) * owLeafNormal);`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float owCanopyHeight;\nvarying vec3 owCanopyNormal;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float owLeaf = smoothstep(0.015, 0.12, diffuseColor.g - diffuseColor.r);
        float owCrown = smoothstep(1.0, 5.5, owCanopyHeight);
        diffuseColor.rgb *= mix(0.77, 1.07, owCrown);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.11, 0.94, 0.86), owLeaf * 0.55);
      `)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float owTransmission = max(dot(-normalize(owCanopyNormal), normalize(vec3(28.0, 52.0, 22.0))), 0.0);
        totalEmissiveRadiance += diffuseColor.rgb * owLeaf * owTransmission * 0.22;
      `);
  };
  material.customProgramCacheKey = () => 'ow-canopy-v1';
  material.needsUpdate = true;
}
/** A local PBR texture set per material owner, shared by all its instances. */
export function useSurfaceTextures(surface: Surface) {
  const { gl } = useThree();
  const textures = useMemo(() => {
    const asset = surface === 'ground' ? 'aerial_grass_rock' : surface === 'path' ? 'brown_mud_03' : 'rock_boulder_dry';
    const load = (channel: string) => {
      const folder = channel === 'arm' || surface === 'path' ? 'nature-detail' : 'terrain';
      const texture = new TextureLoader().load(`/textures/${folder}/${asset}_${channel}.webp?v=20260911`);
      texture.wrapS = texture.wrapT = RepeatWrapping;
      const renderer = gl as unknown as { getMaxAnisotropy?: () => number; capabilities?: { getMaxAnisotropy(): number } };
      texture.anisotropy = Math.min(4, renderer.getMaxAnisotropy?.() ?? renderer.capabilities?.getMaxAnisotropy() ?? 1);
      if (channel === 'diff') texture.colorSpace = SRGBColorSpace;
      return texture;
    };
    return { diffuse: load('diff'), normal: load('nor_gl'), arm: load('arm') };
  }, [gl, surface]);
  useEffect(() => () => { Object.values(textures).forEach(texture => texture.dispose()); }, [textures]);
  return textures;
}

/** World-space projection keeps terrain/instanced rocks independent of palette UVs.
 * Geometry is unchanged; collision and feet still use the same height surface. */
export function detailSurface(material: MeshStandardMaterial, textures: SurfaceTextures, surface: Surface) {
  material.onBeforeCompile = shader => {
    shader.uniforms.owAlbedo = { value: textures.diffuse };
    shader.uniforms.owDetailNormal = { value: textures.normal };
    shader.uniforms.owArm = { value: textures.arm };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 owWorld;\nvarying vec3 owSurfaceNormal;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 owPoint = vec4(transformed, 1.0);
        vec3 owNormal = objectNormal;
        #ifdef USE_INSTANCING
          owPoint = instanceMatrix * owPoint;
          owNormal = mat3(instanceMatrix) * owNormal;
        #endif
        owWorld = (modelMatrix * owPoint).xyz;
        owSurfaceNormal = normalize(mat3(modelMatrix) * owNormal);`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      uniform sampler2D owAlbedo;
      uniform sampler2D owDetailNormal;
      uniform sampler2D owArm;
      varying vec3 owWorld;
      varying vec3 owSurfaceNormal;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 owN = normalize(owSurfaceNormal);
        vec3 owAxis = abs(owN);
        vec2 owUv = owWorld.xz;
        vec3 owU = vec3(1.0, 0.0, 0.0), owV = vec3(0.0, 0.0, 1.0);
        ${surface === 'rock' ? `
        if (owAxis.x > owAxis.y && owAxis.x > owAxis.z) { owUv = owWorld.zy; owU = vec3(0.0, 0.0, 1.0); owV = vec3(0.0, 1.0, 0.0); }
        else if (owAxis.z > owAxis.y) { owUv = owWorld.xy; owU = vec3(1.0, 0.0, 0.0); owV = vec3(0.0, 1.0, 0.0); }
        ` : ''}
        owUv *= ${surface === 'ground' ? '0.115' : surface === 'path' ? '0.28' : '0.45'};
        vec3 owTexel = texture2D(owAlbedo, owUv).rgb;
        vec2 owArmValue = texture2D(owArm, owUv).rg;
        float owLuma = dot(owTexel, vec3(0.2126, 0.7152, 0.0722));
        float owMacro = sin(owWorld.x * 0.19 + sin(owWorld.z * 0.11)) * cos(owWorld.z * 0.17);
        diffuseColor.rgb *= clamp(0.72 + owLuma * 1.35, 0.68, 1.32) * (1.0 + owMacro * 0.065);
        ${surface === 'ground' ? 'diffuseColor.rgb = mix(diffuseColor.rgb, owTexel * 0.72, 0.22);' : ''}
        ${surface === 'path' ? 'diffuseColor.rgb = mix(diffuseColor.rgb, owTexel * vec3(1.05, 0.94, 0.78), 0.5);' : ''}
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(owArmValue.g * roughness, 0.42, 1.0);
      `)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        vec3 owMapNormal = normalize(texture2D(owDetailNormal, owUv).xyz * 2.0 - 1.0);
        vec3 owPerturbation = owU * owMapNormal.x + owV * owMapNormal.y;
        owPerturbation -= owN * dot(owPerturbation, owN);
        normal = normalize(normal + mat3(viewMatrix) * owPerturbation * ${surface === 'ground' ? '0.26' : '0.38'});
      `)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= mix(1.0, owArmValue.r, 0.75);
      `);
  };
  material.customProgramCacheKey = () => `ow-surface-${surface}-v2`;
  material.needsUpdate = true;
}

function applySurfaceNodes(material: MeshStandardNodeMaterial, textures: SurfaceTextures, surface: Surface) {
  const detailUv = positionWorld.xz.mul(surface === 'ground' ? .115 : surface === 'path' ? .28 : .45);
  const albedo = texture(textures.diffuse, detailUv);
  const arm = texture(textures.arm, detailUv);
  const luma = dot(albedo.rgb, vec3(.2126, .7152, .0722));
  const macro = sin(positionWorld.x.mul(.19).add(sin(positionWorld.z.mul(.11))))
    .mul(cos(positionWorld.z.mul(.17)));
  const contrast = luma.mul(1.35).add(.72).clamp(.68, 1.32).mul(macro.mul(.065).add(1));
  const tint = surface === 'ground' ? mix(vec3(1), albedo.rgb.mul(.72), .22)
    : surface === 'path' ? mix(vec3(1), albedo.rgb.mul(vec3(1.05, .94, .78)), .5)
      : vec3(1);
  material.colorNode = materialColor.rgb.mul(contrast).mul(tint);
  material.roughnessNode = arm.g.mul(materialRoughness).clamp(.42, 1);
  material.userData.openWorldNodeEffect = `surface:${surface}`;
}

function copyStandardAppearance(source: MeshStandardMaterial): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({
    name: source.name, color: source.color, map: source.map, lightMap: source.lightMap, lightMapIntensity: source.lightMapIntensity,
    aoMap: source.aoMap, aoMapIntensity: source.aoMapIntensity, emissive: source.emissive, emissiveIntensity: source.emissiveIntensity,
    emissiveMap: source.emissiveMap, bumpMap: source.bumpMap, bumpScale: source.bumpScale, normalMap: source.normalMap,
    normalMapType: source.normalMapType, displacementMap: source.displacementMap, displacementScale: source.displacementScale,
    displacementBias: source.displacementBias, roughness: source.roughness, roughnessMap: source.roughnessMap,
    metalness: source.metalness, metalnessMap: source.metalnessMap, alphaMap: source.alphaMap, envMap: source.envMap,
    envMapRotation: source.envMapRotation, envMapIntensity: source.envMapIntensity, wireframe: source.wireframe,
    flatShading: source.flatShading, vertexColors: source.vertexColors, fog: source.fog, transparent: source.transparent,
    opacity: source.opacity, alphaTest: source.alphaTest, side: source.side, shadowSide: source.shadowSide, depthTest: source.depthTest,
    depthWrite: source.depthWrite, colorWrite: source.colorWrite, blending: source.blending, blendSrc: source.blendSrc,
    blendDst: source.blendDst, blendEquation: source.blendEquation, polygonOffset: source.polygonOffset,
    polygonOffsetFactor: source.polygonOffsetFactor, polygonOffsetUnits: source.polygonOffsetUnits, visible: source.visible,
  });
  material.normalScale.copy(source.normalScale);
  material.userData = structuredClone(source.userData);
  return material;
}

export type NormalizeMaterialOptions = { wind?: boolean; canopy?: boolean; surface?: Surface; textures?: SurfaceTextures };

/** Convert imported MeshStandard materials without losing their authored PBR maps. */
export function normalizeStandardMaterial(source: MeshStandardMaterial, options: NormalizeMaterialOptions = {}): MeshStandardNodeMaterial {
  const material = copyStandardAppearance(source);
  material.metalness = 0;
  if (!material.roughnessMap) material.roughness = .95;
  if (options.surface && options.textures) applySurfaceNodes(material, options.textures, options.surface);
  else if (options.canopy) {
    const crown = smoothstep(1, 5.5, positionLocal.y);
    material.colorNode = materialColor.rgb.mul(crown.mul(.3).add(.77));
    material.userData.openWorldNodeEffect = 'canopy';
  }
  if (options.wind) {
    const tip = smoothstep(.04, .7, positionLocal.y);
    const phase = positionLocal.x.mul(2.1).add(positionLocal.z.mul(1.7)).add(instanceIndex.mul(.618));
    const clock = timerLocal();
    const swayX = sin(clock.mul(1.35).add(phase)).mul(.035).mul(tip);
    const swayZ = cos(clock.mul(1.05).add(phase)).mul(.022).mul(tip);
    material.positionNode = positionLocal.add(vec3(swayX, 0, swayZ));
    material.userData.openWorldNodeEffect = `${material.userData.openWorldNodeEffect ?? 'standard'}+wind`;
  }
  material.needsUpdate = true;
  return material;
}

export function createWaterNodeMaterial({
  lake = false,
  center = lake ? [122, -50] : [-68, 202],
  extent = [91, 33],
  radius = 24,
}: WaterMaterialOptions = {}): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({
    color: '#247e85', roughness: .19, metalness: 0, transparent: true, opacity: .88, depthWrite: false, envMapIntensity: 1.3,
  });
  const clock = timerLocal();
  const waveA = sin(positionWorld.x.mul(1.9).add(positionWorld.z.mul(1.3)).add(clock.mul(1.15)));
  const waveB = cos(positionWorld.x.mul(.85).sub(positionWorld.z.mul(1.7)).sub(clock.mul(.8)));
  const ripple = sin(positionWorld.x.mul(5.1).add(positionWorld.z.mul(3.2)).sub(clock.mul(1.7)));
  const waveNormal = normalize(normalView.add(vec3(waveA.mul(.12).add(ripple.mul(.025)), 0, waveB.mul(.095))));
  const delta = positionWorld.xz.sub(vec2(center[0], center[1]));
  const shore = lake
    ? float(radius).sub(length(delta))
    : min(float(extent[0]).sub(abs(delta.x)), float(extent[1]).sub(abs(delta.y)));
  const shallow = float(1).sub(smoothstep(0, 3.5, shore));
  const fresnel = pow(float(1).sub(max(dot(waveNormal, positionViewDirection), 0)), 3);
  const foam = float(1).sub(smoothstep(.08, .65, shore)).mul(smoothstep(-.3, .7, waveA.add(waveB.mul(.35))));
  let waterColor = mix(color('#247e85'), color('#1c6b59'), shallow.mul(.6));
  waterColor = mix(waterColor, color('#6da8b8'), fresnel.mul(.5));
  waterColor = mix(waterColor, color('#b8d6c2'), foam.mul(.72));
  material.colorNode = waterColor.add(vec3(.1, .16, .13).mul(pow(max(waveA.mul(waveB), 0), 14)));
  material.normalNode = waveNormal;
  material.userData.openWorldNodeEffect = lake ? 'water:radial' : 'water:rectangular';
  material.userData.openWorldWaterBounds = { center: [...center], extent: [...extent], radius };
  return material;
}

export function SurfaceMaterial({ surface, color, vertexColors = false, visible = true }: { surface: Surface; color?: string; vertexColors?: boolean; visible?: boolean }) {
  const textures = useSurfaceTextures(surface);
  const material = useMemo(() => {
    const result = new MeshStandardNodeMaterial({ color, vertexColors, roughness: .94, metalness: 0,
      polygonOffset: surface === 'path', polygonOffsetFactor: -1, visible });
    applySurfaceNodes(result, textures, surface);
    return result;
  }, [color, vertexColors, textures, surface, visible]);
  useEffect(() => () => material.dispose(), [material]);
  return <primitive object={material} attach="material" />;
}

/** Analytic TSL waves and geometry-derived shoreline foam; no render target or noise texture. */
export function WaterMaterial({ lake = false, center, extent, radius }: WaterMaterialOptions) {
  const material = useMemo(() => createWaterNodeMaterial({ lake, center, extent, radius }), [center?.[0], center?.[1], extent?.[0], extent?.[1], lake, radius]);
  useEffect(() => () => material.dispose(), [material]);
  return <primitive object={material} attach="material" />;
}

/** Prefilter a small procedural daylight sky once, for PBR ambient reflections.
 * No screen-space effects, per-frame render targets or simulation random state. */
export function SkyLighting() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const width = 64, height = 32, pixels = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const elevation = Math.cos(Math.PI * (y + .5) / height);
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const sky = Math.max(0, elevation), horizon = Math.pow(1 - Math.abs(elevation), 3);
        pixels[i] = elevation >= 0 ? .38 + horizon * .7 - sky * .12 : .12;
        pixels[i + 1] = elevation >= 0 ? .56 + horizon * .49 - sky * .13 : .17;
        pixels[i + 2] = elevation >= 0 ? .8 + horizon * .18 - sky * .1 : .09;
        pixels[i + 3] = 1;
      }
    }
    const source = new DataTexture(pixels, width, height, RGBAFormat, FloatType);
    source.mapping = EquirectangularReflectionMapping;
    source.colorSpace = LinearSRGBColorSpace; source.needsUpdate = true;
    const previous = scene.environment, intensity = scene.environmentIntensity;
    scene.environmentIntensity = .32;
    if ((gl as unknown as { isWebGPURenderer?: boolean }).isWebGPURenderer) {
      // Node materials route raw equirectangular environments through the
      // common renderer PMREM cache. The legacy WebGL PMREMGenerator cannot
      // consume WebGPURenderer.
      scene.environment = source;
      return () => { scene.environment = previous; scene.environmentIntensity = intensity; source.dispose(); };
    }
    const generator = new PMREMGenerator(gl), environment = generator.fromEquirectangular(source);
    scene.environment = environment.texture;
    source.dispose(); generator.dispose();
    return () => { scene.environment = previous; scene.environmentIntensity = intensity; environment.dispose(); };
  }, [gl, scene]);
  return null;
}
