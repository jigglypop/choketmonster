import { useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Color, DataTexture, EquirectangularReflectionMapping, FloatType, LinearFilter, LinearSRGBColorSpace, MeshStandardMaterial, PMREMGenerator, RepeatWrapping, RGBAFormat, SRGBColorSpace, Texture, TextureLoader } from 'three';
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu';
import {
  abs, attribute, color, cos, dot, float, floor, fract, instanceIndex, length, materialColor, materialRoughness, max, min, mix, normalMap, normalView, normalize,
  positionLocal, positionViewDirection, positionWorld, pow, sin, smoothstep, texture, time, vec2, vec3,
} from 'three/tsl';
import { distanceToWaterSurface, selectWaterLod, type WaterLod, type WaterLodPlayer } from './water-lod';
import type { WorldAtlas } from './atlas';
import type { WorldSample } from './types';
import { WORLD_MIN, WORLD_MAX, WORLD_SCALE } from './world-space';
import { prepareShorelinePixels, SHORELINE_RESOLUTION } from './shoreline-texture';
import { townStyle } from './town-style';
import { isTownPaved } from './world-details';

export const GRASS_TEXTURE_REPEAT = .28;

type Surface = 'ground' | 'rock' | 'path';
export type SurfaceTextures = { diffuse: Texture; normal: Texture; arm: Texture };
export type WaterMaterialOptions = { lake?: boolean; center?: readonly [number, number]; extent?: readonly [number, number]; radius?: number; waterNormals?: Texture };

const BIOME_COLORS: Record<Exclude<WorldSample['biome'], 'meadow' | 'lake'>, string> = {
  forest: '#5c9b4d', rock: '#9a9582',
};

/** Woodland floor: a deeper lawn under the trees rather than a dark band. */
export const forestFloorColor = (atlas: WorldAtlas) => new Color(BIOME_COLORS.forest).lerp(new Color(atlas.palette.ground), .4);

/** Lawn and woodland blade roots matching the terrain tint beneath the wind grass. */
export const fieldGrassColors = (atlas: WorldAtlas) => ({ lawn: new Color(atlas.palette.ground), forest: forestFloorColor(atlas) });

/** Vertex tint for the world map. Town and route tint stays atlas-specific; the field
 * reads as a painted pastel lawn with only a light trace of the shared PBR textures. */
export function worldSurfaceColor(atlas: WorldAtlas, sample: WorldSample, x: number, z: number): Color {
  if (sample.biome === 'lake') return new Color(atlas.palette.water);
  const nearest = atlas.locationAt(x, z);
  const landmarkDistance = Math.hypot(x - nearest.x, z - nearest.z);
  // Only the plaza under the paving keeps the town tint; the lawn, or a snowy town's snow, runs right up to its curb.
  if (nearest.kind === 'town' && landmarkDistance <= 8.5 * WORLD_SCALE && isTownPaved(x - nearest.x, z - nearest.z)) return new Color(townStyle(nearest.id).color).lerp(new Color('#e8dfc5'), .38);
  // Broad drifts and dunes: the same slow wave the lawn uses, stronger on snow and sand.
  const drift = Math.sin(x * .11 + Math.sin(z * .07) * 1.7) * Math.cos(z * .09 - x * .03);
  if (sample.surface === 'snow') return new Color('#f2f7f8').lerp(new Color('#bfd0da'), .16 + drift * .1);
  if (sample.surface === 'desert') return new Color('#e8cc92').lerp(new Color('#c9a468'), .22 + drift * .16);
  if (sample.surface === 'marsh') return new Color('#7c8a55').lerp(new Color('#4f5e3a'), .35 + drift * .2);
  if (sample.surface === 'mountain') return new Color('#a09a88').lerp(new Color(atlas.palette.ground), .12);
  if (sample.biome === 'rock') return new Color(atlas.id === 'sinnoh' || atlas.id === 'hisui' ? '#b4b8b0' : BIOME_COLORS.rock);
  if (sample.biome === 'forest') return forestFloorColor(atlas);
  // Bake broad variation once per terrain vertex instead of evaluating three
  // trigonometric functions for every grass fragment on every frame.
  const variation = Math.sin(x * .19 + Math.sin(z * .11)) * Math.cos(z * .17);
  const grass = new Color(atlas.palette.ground).multiplyScalar(1 + variation * .065);
  const pathDistance = atlas.distanceToPath(x, z);
  if (pathDistance <= 4 * WORLD_SCALE) {
    // The feathered trail ribbon draws the dirt itself. Terrain vertices are metres apart, so soil
    // tint here would smear across the verge; the lawn only warms faintly where feet wear it.
    const worn = 1 - Math.max(0, Math.min(1, (pathDistance - 1.6 * WORLD_SCALE) / (2.4 * WORLD_SCALE)));
    return grass.lerp(new Color(regionTrailColor(atlas)).lerp(new Color(atlas.palette.ground), .6), worn * worn * (3 - 2 * worn) * .35);
  }
  return grass;
}

/** Warm, light tan dirt paths. */
export function regionTrailColor(atlas: WorldAtlas): string {
  return `#${new Color('#d8ae78').lerp(new Color(atlas.palette.town), .22).getHexString()}`;
}

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
        owUv *= ${surface === 'ground' ? GRASS_TEXTURE_REPEAT.toFixed(3) : surface === 'path' ? '0.28' : '0.45'};
        vec3 owTexel = texture2D(owAlbedo, owUv).rgb;
        vec2 owArmValue = texture2D(owArm, owUv).rg;
        float owLuma = dot(owTexel, vec3(0.2126, 0.7152, 0.0722));
        float owMacro = ${surface === 'ground' ? '0.0' : 'sin(owWorld.x * 0.19 + sin(owWorld.z * 0.11)) * cos(owWorld.z * 0.17)'};
        diffuseColor.rgb *= clamp(0.72 + owLuma * 1.35, 0.68, 1.32) * (1.0 + owMacro * 0.065);
        ${surface === 'ground' ? 'diffuseColor.rgb = mix(diffuseColor.rgb, owTexel * 0.72, 0.22);' : ''}
        ${surface === 'path' ? 'diffuseColor.rgb = mix(diffuseColor.rgb, owTexel * vec3(1.05, 0.94, 0.78), 0.5);' : ''}
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(owArmValue.g * roughness, ${surface === 'rock' ? '0.82' : '0.88'}, 1.0);
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
  material.customProgramCacheKey = () => `ow-surface-${surface}-v3`;
  material.needsUpdate = true;
}

/** Sine-free hash (Hoskins) so grit stays stable at large world coordinates on every GPU. */
function gritHash(cell: Node<'vec2'>): Node<'float'> {
  const p = fract(vec3(cell.x, cell.y, cell.x).mul(.1031));
  const q = p.add(dot(p, vec3(p.y, p.z, p.x).add(33.33)));
  return fract(q.x.add(q.y).mul(q.z));
}

/** Clean, warm packed dirt: a soft painted mottle, fine grit and scattered pebbles over the trail tint. */
function pathDirt(base: Node<'vec3'>, luma: Node<'float'>): Node<'vec3'> {
  const ground = positionWorld.xz;
  const mottle = sin(ground.x.mul(.61).add(sin(ground.y.mul(.43)).mul(1.4))).mul(cos(ground.y.mul(.57).sub(ground.x.mul(.19))));
  const fine = ground.mul(6), cell = floor(fine), blend = smoothstep(0, 1, fract(fine));
  const grit = mix(mix(gritHash(cell), gritHash(cell.add(vec2(1, 0))), blend.x), mix(gritHash(cell.add(vec2(0, 1))), gritHash(cell.add(1)), blend.x), blend.y);
  // Round pebbles: one jittered dot in a few of the 45 cm cells.
  const coarse = ground.mul(2.2), stone = floor(coarse), spot = vec2(gritHash(stone.add(17)), gritHash(stone.add(29))).mul(.6).add(.2);
  const pebble = float(1).sub(smoothstep(.07, .11, length(fract(coarse).sub(spot)))).mul(smoothstep(.8, .83, gritHash(stone.add(41))));
  const warm = mix(vec3(1), vec3(1.05, .98, .88), smoothstep(-.4, .9, mottle));
  return base.mul(warm).mul(mottle.mul(.045).add(1)).mul(mix(float(.955), float(1.03), grit)).mul(float(1).sub(pebble.mul(.16)))
    .mul(luma.mul(.22).add(.93).clamp(.95, 1.05));
}

function applySurfaceNodes(material: MeshStandardNodeMaterial, textures: SurfaceTextures, surface: Surface) {
  const detailUv = positionWorld.xz.mul(surface === 'ground' ? GRASS_TEXTURE_REPEAT : surface === 'path' ? .28 : .45);
  const albedo = texture(textures.diffuse, detailUv);
  const arm = texture(textures.arm, detailUv);
  const luma = dot(albedo.rgb, vec3(.2126, .7152, .0722));
  const macro = surface === 'ground' ? float(0) : sin(positionWorld.x.mul(.19).add(sin(positionWorld.z.mul(.11))))
    .mul(cos(positionWorld.z.mul(.17)));
  // Lawn and dirt keep only a soft painted grain of the photo textures; rock stays fully textured.
  const contrast = surface === 'rock' ? luma.mul(1.35).add(.72).clamp(.68, 1.32)
    : luma.mul(surface === 'ground' ? .55 : .75).add(surface === 'ground' ? .86 : .8).clamp(.88, 1.13).mul(macro.mul(.04).add(1));
  const tint = surface === 'ground' ? mix(vec3(1), albedo.rgb.mul(.72), .06)
    : surface === 'path' ? mix(vec3(1), albedo.rgb.mul(vec3(1.05, .94, .78)), .16)
      : vec3(1);
  material.colorNode = surface === 'path' ? pathDirt(materialColor.rgb, luma) : materialColor.rgb.mul(contrast).mul(tint);
  material.roughnessNode = arm.g.mul(materialRoughness).clamp(surface === 'rock' ? .82 : .88, 1);
  if (surface !== 'rock') material.normalNode = normalMap(texture(textures.normal, detailUv).rgb, vec2(.07, .07));
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
  material.envMapIntensity = Math.min(material.envMapIntensity, .35);
  if (options.surface && options.textures) applySurfaceNodes(material, options.textures, options.surface);
  else if (options.canopy) {
    const crown = smoothstep(1, 5.5, positionLocal.y);
    material.colorNode = materialColor.rgb.mul(crown.mul(.3).add(.77));
    material.userData.openWorldNodeEffect = 'canopy';
  }
  if (options.wind) {
    const tip = smoothstep(.04, .7, positionLocal.y);
    const phase = positionLocal.x.mul(2.1).add(positionLocal.z.mul(1.7)).add(instanceIndex.mul(.618));
    const clock = time;
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
  waterNormals,
}: WaterMaterialOptions = {}): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({
    color: '#237f9c', roughness: .44, metalness: 0, envMapIntensity: .45,
  });
  const clock = time;
  const waveA = sin(positionWorld.x.mul(.23).add(positionWorld.z.mul(.17)).add(clock.mul(.35)));
  const waveB = cos(positionWorld.x.mul(.19).sub(positionWorld.z.mul(.21)).sub(clock.mul(.28)));
  // Two slowly crossing normal-map samples avoid the old high-frequency grid
  // and use Three's tangent-space normal mapping on both GPU backends.
  const flowA = positionWorld.xz.mul(.045).add(vec2(clock.mul(.007), clock.mul(.004)));
  const flowB = positionWorld.zx.mul(.061).sub(vec2(clock.mul(.003), clock.mul(.006)));
  // NormalMapNode's r185 declaration omits its known vec3 result type.
  const waveNormal = waterNormals
    ? normalMap(texture(waterNormals, flowA).rgb.add(texture(waterNormals, flowB).rgb).mul(.5), vec2(.18, .18)) as unknown as Node<'vec3'>
    : normalize(normalView.add(vec3(waveA.mul(.025), 0, waveB.mul(.025))));
  const delta = positionWorld.xz.sub(vec2(center[0], center[1]));
  const shore = lake
    ? float(radius).sub(length(delta))
    : min(float(extent[0]).sub(abs(delta.x)), float(extent[1]).sub(abs(delta.y)));
  const shallow = float(1).sub(smoothstep(0, 3.5, shore));
  const fresnel = pow(float(1).sub(max(dot(waveNormal, positionViewDirection), 0)), 3);
  const foam = float(1).sub(smoothstep(.08, .65, shore)).mul(smoothstep(-.3, .7, waveA.add(waveB.mul(.35))));
  let waterColor = mix(color('#237f9c'), color('#5faeaf'), shallow.mul(.55));
  waterColor = mix(waterColor, color('#b1d5e0'), fresnel.mul(.24));
  waterColor = mix(waterColor, color('#d3eae2'), foam.mul(.4));
  material.colorNode = waterColor;
  material.normalNode = waveNormal;
  material.userData.openWorldNodeEffect = lake ? 'water:radial' : 'water:rectangular';
  material.userData.openWorldWaterBounds = { center: [...center], extent: [...extent], radius };
  material.userData.openWorldWaterNormals = Boolean(waterNormals);
  return material;
}

type SurfaceMaterialOptions = { surface: Surface; color?: string; vertexColors?: boolean; visible?: boolean };

/** One owner shares its textures and material across streamed terrain chunks. */
export function useSurfaceMaterial({ surface, color, vertexColors = false, visible = true }: SurfaceMaterialOptions) {
  const textures = useSurfaceTextures(surface);
  const material = useMemo(() => {
    // Trail ribbons feather into the lawn through their vertex alpha.
    const result = new MeshStandardNodeMaterial({ color, vertexColors, roughness: .94, metalness: 0,
      polygonOffset: surface === 'path', polygonOffsetFactor: -1, transparent: surface === 'path', visible });
    applySurfaceNodes(result, textures, surface);
    return result;
  }, [color, vertexColors, textures, surface, visible]);
  useEffect(() => () => material.dispose(), [material]);
  return material;
}

export function SurfaceMaterial(options: SurfaceMaterialOptions) {
  return <primitive object={useSurfaceMaterial(options)} attach="material" />;
}

/** A continuous shore field replaces per-triangle water/land material switches. */
export function createTerrainMaterial(textures: SurfaceTextures, waterNormals: Texture, waterColor: string, detailed = true, shoreline?: Texture) {
  const material = new MeshStandardNodeMaterial({ roughness: .94, metalness: 0, envMapIntensity: .4 });
  applySurfaceNodes(material, textures, 'ground');
  const groundColor = (material.colorNode as Node<'vec3'>).mul(attribute<'vec3'>('color', 'vec3'));
  const groundRoughness = material.roughnessNode as Node<'float'>;
  const groundNormal = material.normalNode as Node<'vec3'>;
  const coast = shoreline ? texture(shoreline, positionWorld.xz.sub(WORLD_MIN).div(WORLD_MAX - WORLD_MIN)) : undefined;
  const coverage = coast ? mix(attribute<'float'>('waterCoverage', 'float'), coast.r, coast.a) : attribute<'float'>('waterCoverage', 'float');
  const irregular = sin(positionWorld.x.mul(.35).add(sin(positionWorld.z.mul(.23))))
    .mul(cos(positionWorld.z.mul(.31))).mul(.012);
  const edge = coverage.add(irregular);
  const wet = smoothstep(.28, .74, edge);
  const shallows = float(1).sub(smoothstep(.62, .98, coverage));
  const bank = smoothstep(.05, .42, coverage).mul(float(1).sub(wet));
  const earth = mix(groundColor, color('#d7c893'), bank.mul(.55));
  let water = mix(color(waterColor).mul(.84), color('#8ad6cb'), shallows.mul(.65));
  const clock = time;
  const a = positionWorld.xz.mul(.07).add(vec2(clock.mul(.003), clock.mul(.002)));
  const b = positionWorld.zx.mul(.093).sub(vec2(clock.mul(.002), clock.mul(.003)));
  const waterSample = texture(waterNormals, a).rgb.add(texture(waterNormals, b).rgb).mul(.5);
  const waterNormal = detailed
    ? normalMap(waterSample, vec2(.22, .22)) as unknown as Node<'vec3'>
    : normalView;
  if (detailed) {
    const ripple = sin(positionWorld.x.mul(.7).add(positionWorld.z.mul(.5)).sub(clock.mul(.55)));
    const reflection = pow(float(1).sub(max(dot(waterNormal, positionViewDirection), 0)), 3);
    water = mix(water.mul(waterSample.r.sub(.5).mul(.16).add(1)), color('#cdeef2'), reflection.mul(.18));
    const foam = smoothstep(.38, .5, edge).mul(float(1).sub(smoothstep(.58, .75, edge)))
      .mul(smoothstep(.1, .85, ripple)).mul(.22);
    water = mix(water, color('#f1faf4'), foam);
  }
  material.colorNode = mix(earth, water, wet);
  material.roughnessNode = mix(groundRoughness, float(detailed ? .48 : .58), wet);
  material.normalNode = normalize(mix(groundNormal, waterNormal, wet));
  material.userData.openWorldNodeEffect = 'terrain:continuous-shore';
  material.userData.openWorldWaterLod = detailed ? 'detailed' : 'simple';
  return material;
}

/** All chunks share three materials and one texture set; no per-frame allocations. */
export function useTerrainMaterials(waterColor: string, sample?: (x: number, z: number) => WorldSample) {
  const textures = useSurfaceTextures('ground');
  const shoreline = useMemo(() => {
    // Alpha selects the existing vertex fallback until the asynchronously prepared coast is ready.
    const map = new DataTexture(new Uint8Array(SHORELINE_RESOLUTION * SHORELINE_RESOLUTION * 4), SHORELINE_RESOLUTION, SHORELINE_RESOLUTION, RGBAFormat);
    map.minFilter = map.magFilter = LinearFilter;
    map.needsUpdate = true;
    return map;
  }, [sample]);
  useEffect(() => {
    let active = true;
    if (sample) void prepareShorelinePixels(sample).then(data => {
      if (!active) return;
      shoreline.image.data = data;
      shoreline.needsUpdate = true;
      shoreline.userData.ready = true;
    });
    return () => { active = false; shoreline.dispose(); };
  }, [sample, shoreline]);
  const waterNormals = useMemo(() => {
    const texture = new TextureLoader().load('/textures/water/three-waternormals.jpg');
    texture.wrapS = texture.wrapT = RepeatWrapping;
    return texture;
  }, []);
  const materials = useMemo(() => {
    const ground = new MeshStandardNodeMaterial({ vertexColors: true, roughness: .94, metalness: 0, envMapIntensity: .35 });
    applySurfaceNodes(ground, textures, 'ground');
    return { ground, detailed: createTerrainMaterial(textures, waterNormals, waterColor, true, shoreline), simple: createTerrainMaterial(textures, waterNormals, waterColor, false, shoreline) };
  }, [textures, waterNormals, waterColor, shoreline]);
  useEffect(() => () => { Object.values(materials).forEach(material => material.dispose()); }, [materials]);
  useEffect(() => () => waterNormals.dispose(), [waterNormals]);
  return materials;
}

/** Detailed shoreline water nearby, with a stable simple material outside the LOD boundary. */
export function useWaterMaterials({
  lake = false,
  center = lake ? [122, -50] : [-68, 202],
  extent = [91, 33],
  radius = 24,
}: WaterMaterialOptions = {}) {
  const waterNormals = useMemo(() => {
    const texture = new TextureLoader().load('/textures/water/three-waternormals.jpg');
    texture.wrapS = texture.wrapT = RepeatWrapping;
    return texture;
  }, []);
  useEffect(() => () => waterNormals.dispose(), [waterNormals]);
  const materials = useMemo(() => {
    const detailed = createWaterNodeMaterial({ lake, center, extent, radius, waterNormals });
    detailed.userData.openWorldWaterLod = 'detailed';
    const simple = new MeshStandardMaterial({
      color: '#398fa4', roughness: .65, metalness: 0,
    });
    simple.userData.openWorldWaterLod = 'simple';
    return { detailed, simple };
  }, [center[0], center[1], extent[0], extent[1], lake, radius, waterNormals]);
  useEffect(() => () => {
    materials.detailed.dispose();
    materials.simple.dispose();
  }, [materials]);
  return materials;
}

export function WaterMaterial({ player, mobile = false, ...shape }: WaterMaterialOptions & { player?: WaterLodPlayer; mobile?: boolean }) {
  const materials = useWaterMaterials(shape);
  const shapeKey = JSON.stringify(shape);

  const previous = useRef<{ shapeKey: string; lod: WaterLod } | undefined>(undefined);
  const distance = player ? distanceToWaterSurface(player, shape) : 0;
  const lod = player
    ? selectWaterLod(previous.current?.shapeKey === shapeKey ? previous.current.lod : undefined, distance, mobile)
    : 'detailed';
  previous.current = { shapeKey, lod };
  return <primitive object={materials[lod]} attach="material" />;
}

/** Prefilter a small procedural daylight sky once, for PBR ambient reflections.
 * No screen-space effects, per-frame render targets or simulation random state. */
export function createDaylightEnvironment() {
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
    return source;
}

export function SkyLighting() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const source = createDaylightEnvironment();
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
