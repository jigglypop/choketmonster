import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Color, InstancedMesh, Light, Mesh, type LightShadow, type MeshStandardMaterial, type Object3D, type Scene } from 'three';
import { getOpenWorldRendererInfo } from './gpu-renderer';

function renderableInventory(scene: Scene) {
  const rows: Array<{ name: string; triangles: number; instances: number; castShadow: boolean }> = [];
  scene.traverse(object => {
    if (!(object instanceof Mesh) || !object.geometry.index && !object.geometry.attributes.position) return;
    const primitiveTriangles = object.geometry.index
      ? object.geometry.index.count / 3
      : (object.geometry.attributes.position?.count ?? 0) / 3;
    const instances = object instanceof InstancedMesh ? object.count : 1;
    let owner: Object3D = object;
    while (!owner.name && owner.parent && owner !== scene) owner = owner.parent;
    rows.push({ name: owner.name || object.type, triangles: primitiveTriangles * instances, instances, castShadow: object.castShadow });
  });
  return rows.sort((left, right) => right.triangles - left.triangles).slice(0, 30);
}

/** Opt-in, read-only renderer counters. Never reads or advances simulation RNG. */
export function RenderProbe() {
  const { gl, scene, camera, get } = useThree();
  const samples = useRef<Array<Record<string, number>>>([]);
  useEffect(() => {
    const backend = getOpenWorldRendererInfo(gl);
    const context = backend ? undefined : gl.getContext(), debug = context?.getExtension('WEBGL_debug_renderer_info');
    const target = window as unknown as { __renderProbe?: { read(): unknown; reset(): void } };
    target.__renderProbe = {
      read: () => ({ samples: [...samples.current], dpr: gl.getPixelRatio(),
        streaming: scene.userData.streaming, camera: camera.position.toArray(),
        cameraTarget: (get().controls as unknown as { target?: { toArray(): number[] } } | null)?.target?.toArray(), objects: scene.children.length,
        background: scene.background instanceof Color ? scene.background.getHexString() : null,
        fog: scene.fog?.color.getHexString() ?? null, clearAlpha: gl.getClearAlpha(),
        lights: scene.getObjectsByProperty('isLight', true).map(object => {
          const light = object as Light;
          const shadow = (light as Light & { shadow?: LightShadow }).shadow;
          return { id: light.uuid, type: light.type, intensity: light.intensity, castsShadow: light.castShadow,
            shadowSize: shadow?.mapSize.toArray(), shadowAutoUpdate: shadow?.autoUpdate };
        }),
        creatures: scene.getObjectsByProperty('type', 'Group')
          .filter(object => object.name.startsWith('creature:'))
          .map(object => ({ id: object.name.slice('creature:'.length), position: object.position.toArray(), yaw: object.rotation.y })),
        nameplates: scene.getObjectsByProperty('name', 'creature-nameplate').length,
        targetRoutes: scene.getObjectsByProperty('name', 'world-target-route').length,
        loadedPokemon: scene.getObjectsByProperty('type', 'Group').filter(object => object.name.startsWith('pokemon-model:')).map(object => Number(object.name.slice('pokemon-model:'.length))),
        modelStatuses: scene.getObjectsByProperty('type', 'Group').filter(object => object.name.startsWith('pokemon-model-status:')).map(object => object.name.slice('pokemon-model-status:'.length)),
        townBuildings: scene.getObjectsByProperty('type', 'Group').filter(object => object.name.startsWith('town-building:')).map(object => object.name),
        renderables: renderableInventory(scene),
        // Cave surfaces have few triangles, so they can fall outside the top-30 inventory.
        caveSurfaces: scene.getObjectsByProperty('type', 'Mesh')
          .filter(object => object.name === 'cave-floor' || object.name.startsWith('cave-wall:'))
          .map(object => {
            const mesh = object as Mesh, material = mesh.material as MeshStandardMaterial;
            const uv = mesh.geometry.attributes.uv;
            return { name: mesh.name, material: material.uuid, albedoLoaded: !!material.map?.image,
              normalLoaded: !!material.normalMap?.image, roughnessLoaded: !!material.roughnessMap?.image,
              tiled: !!uv && Array.from(uv.array).some(value => Math.abs(value) > 1) };
          }),
        caveGeology: scene.getObjectsByProperty('isInstancedMesh', true)
          .filter(object => object.name.startsWith('cave-'))
          .map(object => ({ name: object.name, count: (object as InstancedMesh).count })),
        landmarks: scene.getObjectsByProperty('type', 'Group')
          .filter(object => object.name.startsWith('landmark:league:') || object.name === 'campaign-destination-pointer')
          .map(object => object.name),
        detailAssets: ['moss-boulder', 'moss-stone', 'fern'].map(id => {
          const group = scene.getObjectByName(`nature:${id}.glb`);
          return { id, instances: group?.children.reduce((sum, mesh) => sum + Number('count' in mesh ? mesh.count : 0), 0) ?? 0 };
        }),
        daylightEnvironment: Boolean(scene.environment),
        shadowsEnabled: gl.shadowMap.enabled,
        water: scene.getObjectsByProperty('type', 'Mesh').flatMap(object => {
          const mesh = object as Mesh, materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          return materials.filter(material => material.userData.openWorldWaterLod).map(material => ({
            id: material.uuid, lod: material.userData.openWorldWaterLod, effect: material.userData.openWorldNodeEffect,
          }));
        }),
        terrainMaterials: [...new Map(scene.getObjectsByProperty('type', 'Mesh')
          .filter(object => object.name.startsWith('terrain-chunk:'))
          .flatMap(object => {
            const mesh = object as Mesh;
            return (Array.isArray(mesh.material) ? mesh.material : [mesh.material])
              .map(material => [material.uuid, { id: material.uuid, effect: material.userData.openWorldNodeEffect }] as const);
          })).values()],
        textures: gl.info.memory.textures, geometries: gl.info.memory.geometries,
        trainers: scene.getObjectsByProperty('type', 'Group').filter(object => object.name.startsWith('field-trainer:')).map(object => object.name),
        programs: gl.info.programs?.length, backend: backend?.backend ?? 'webgl', renderer: backend?.backend ?? (debug ? context?.getParameter(debug.UNMASKED_RENDERER_WEBGL) : context?.getParameter(context!.RENDERER)) }),
      reset: () => { samples.current = []; },
    };
    const owner = target.__renderProbe;
    return () => { if (target.__renderProbe === owner) delete target.__renderProbe; };
  }, [gl, scene, camera]);
  useFrame((_, delta) => {
    const counters = getOpenWorldRendererInfo(gl)?.render ?? gl.info.render;
    samples.current.push({ frameMs: delta * 1000, calls: counters.calls, triangles: counters.triangles });
    if (samples.current.length > 900) samples.current.shift();
  });
  return null;
}
