import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { InstancedMesh, Mesh, type Object3D, type Scene } from 'three';

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
  const { gl, scene, camera } = useThree();
  const samples = useRef<Array<Record<string, number>>>([]);
  useEffect(() => {
    const context = gl.getContext(), debug = context.getExtension('WEBGL_debug_renderer_info');
    const target = window as unknown as { __renderProbe?: { read(): unknown; reset(): void } };
    target.__renderProbe = {
      read: () => ({ samples: [...samples.current], dpr: gl.getPixelRatio(),
        camera: camera.position.toArray(), objects: scene.children.length,
        creatures: scene.getObjectsByProperty('type', 'Group')
          .filter(object => object.name.startsWith('creature:'))
          .map(object => ({ id: object.name.slice('creature:'.length), position: object.position.toArray(), yaw: object.rotation.y })),
        nameplates: scene.getObjectsByProperty('name', 'creature-nameplate').length,
        renderables: renderableInventory(scene),
        detailAssets: ['moss-boulder', 'moss-stone', 'fern'].map(id => {
          const group = scene.getObjectByName(`nature:${id}.glb`);
          return { id, instances: group?.children.reduce((sum, mesh) => sum + Number('count' in mesh ? mesh.count : 0), 0) ?? 0 };
        }),
        daylightEnvironment: Boolean(scene.environment),
        textures: gl.info.memory.textures, geometries: gl.info.memory.geometries,
        programs: gl.info.programs?.length, renderer: debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER) }),
      reset: () => { samples.current = []; },
    };
    return () => { delete target.__renderProbe; };
  }, [gl, scene, camera]);
  useFrame((_, delta) => {
    samples.current.push({ frameMs: delta * 1000, calls: gl.info.render.calls, triangles: gl.info.render.triangles });
    if (samples.current.length > 180) samples.current.shift();
  });
  return null;
}
