import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { DataTexture, EquirectangularReflectionMapping, FloatType, LinearSRGBColorSpace, MeshStandardMaterial, PMREMGenerator, RepeatWrapping, RGBAFormat, SRGBColorSpace, Texture, TextureLoader } from 'three';

type Surface = 'ground' | 'rock' | 'path';
export type SurfaceTextures = { diffuse: Texture; normal: Texture; arm: Texture };

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
      texture.anisotropy = Math.min(4, gl.capabilities.getMaxAnisotropy());
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

export function SurfaceMaterial({ surface, color, vertexColors = false, visible = true }: { surface: Surface; color?: string; vertexColors?: boolean; visible?: boolean }) {
  const textures = useSurfaceTextures(surface);
  const material = useMemo(() => {
    const result = new MeshStandardMaterial({ color, vertexColors, roughness: .94, metalness: 0,
      polygonOffset: surface === 'path', polygonOffsetFactor: -1, visible });
    detailSurface(result, textures, surface);
    return result;
  }, [color, vertexColors, textures, surface, visible]);
  useEffect(() => () => material.dispose(), [material]);
  return <primitive object={material} attach="material" />;
}

/** Analytic wave normals, sky reflections and shoreline foam in one material. */
export function WaterMaterial({ lake = false }: { lake?: boolean }) {
  const material = useMemo(() => {
    const result = new MeshStandardMaterial({ color: '#247e85', roughness: .19, metalness: 0, transparent: true, opacity: .88, depthWrite: false, envMapIntensity: 1.3 });
    const time = { value: 0 }; result.userData.time = time;
    result.onBeforeCompile = shader => {
      shader.uniforms.owWaterTime = time;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 owWaterWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nowWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 owWaterWorld;\nuniform float owWaterTime;')
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          float owWaveA = sin(owWaterWorld.x * 1.9 + owWaterWorld.z * 1.3 + owWaterTime * 1.15);
          float owWaveB = cos(owWaterWorld.x * 0.85 - owWaterWorld.z * 1.7 - owWaterTime * 0.8);
          float owRipple = sin(owWaterWorld.x * 5.1 + owWaterWorld.z * 3.2 - owWaterTime * 1.7);
          normal = normalize(normal + mat3(viewMatrix) * vec3(owWaveA * 0.12 + owRipple * 0.025, 0.0, owWaveB * 0.095));
          float owFresnel = pow(1.0 - max(dot(normal, normalize(vViewPosition)), 0.0), 3.0);
          float owShore = ${lake ? '12.0 - length(owWaterWorld.xz - vec2(61.0, -25.0))' : 'min(45.5 - abs(owWaterWorld.x + 34.0), 16.5 - abs(owWaterWorld.z - 101.0))'};
          float owShallow = 1.0 - smoothstep(0.0, 3.5, owShore);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.11, 0.42, 0.35), owShallow * 0.6);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.43, 0.66, 0.72), owFresnel * 0.5);
          float owFoam = (1.0 - smoothstep(0.08, 0.65, owShore)) * smoothstep(-0.3, 0.7, owWaveA + owWaveB * 0.35);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72, 0.84, 0.76), owFoam * 0.72);
          diffuseColor.rgb += vec3(0.1, 0.16, 0.13) * pow(max(0.0, owWaveA * owWaveB), 14.0);
        `);
    };
    result.customProgramCacheKey = () => `ow-water-v2-${lake}`;
    return result;
  }, [lake]);
  useFrame(({ clock }) => { material.userData.time.value = clock.elapsedTime; });
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
    const generator = new PMREMGenerator(gl), environment = generator.fromEquirectangular(source);
    const previous = scene.environment, intensity = scene.environmentIntensity;
    scene.environment = environment.texture; scene.environmentIntensity = .32;
    source.dispose(); generator.dispose();
    return () => { scene.environment = previous; scene.environmentIntensity = intensity; environment.dispose(); };
  }, [gl, scene]);
  return null;
}
