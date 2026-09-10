import { _roots } from '@react-three/fiber';
import { Box3, SkinnedMesh, Vector3 } from 'three';
import { mountOpenWorld } from '../src/openworld/view';
import { sampleWorld } from '../src/openworld/simulation';
import { angleDifference } from '../src/openworld/motion';
import { terrainSurfaceHeight } from '../src/openworld/grounding';
import type { OpenWorldRenderSnapshot } from '../src/openworld/types';

/** Checks actual React/Three transforms while snapshots change; no game state is modified. */
export async function verifyRenderedMotion() {
  document.querySelector<HTMLDialogElement>('#starter-dialog')?.close();
  const host = document.createElement('div');
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '999', background: '#172f22' });
  document.body.append(host);
  let snapshot: OpenWorldRenderSnapshot = {
    player: { x: 0, z: 0, heading: 2 }, entities: [{ id: 'companion:motion-probe', speciesId: 4, name: '파이리', level: 5,
      x: 0, z: 0, hp: 20, maxHp: 20, heading: 2, movementSpeed: 2.4, displayHeight: .75, action: 'idle' }],
  };
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const view = mountOpenWorld(host, { getSnapshot: () => snapshot, sampleWorld, onPlayerMove: () => false, onSelect: () => {}, onReady: ready });
  const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
  try {
    await started;
    const canvas = host.querySelector('canvas')!;
    const root = _roots.get(canvas)!.store;
    const actor = root.getState().scene.getObjectByName('creature:companion:motion-probe')!;
    const skins: SkinnedMesh[] = [];
    for (let attempts = 0; attempts < 600 && !skins.length; attempts++) {
      actor.traverse(object => { if (object instanceof SkinnedMesh) skins.push(object); });
      if (!skins.length) await frame();
    }
    if (!skins.length) throw new Error('Motion probe model did not load');
    const positions = [[2, 0, 1], [2, 2, 2], [0, 2, 3], [-.1, 0, 0], [.1, -2, 0]] as const;
    const records: { time: number; yaw: number; x: number; z: number; groundGap: number }[] = [];
    const bounds = new Box3(), point = new Vector3();
    for (const [x, z, heading] of positions) {
      snapshot = { ...snapshot, entities: [{ ...snapshot.entities[0], x, z, heading, action: 'walk' }] };
      view.update(snapshot);
      const begin = performance.now();
      while (performance.now() - begin < 650) {
        const time = await frame();
        actor.getWorldPosition(point);
        bounds.makeEmpty();
        for (const mesh of skins) bounds.expandByObject(mesh, true);
        records.push({ time, yaw: actor.rotation.y, x: point.x, z: point.z, groundGap: bounds.min.y - terrainSurfaceHeight(sampleWorld, point.x, point.z) });
      }
    }
    await new Promise(resolve => setTimeout(resolve, 450));
    const idleStartYaw = actor.rotation.y;
    snapshot = { ...snapshot, entities: [{ ...snapshot.entities[0], action: 'idle', heading: 4 }] };
    view.update(snapshot);
    await new Promise(resolve => setTimeout(resolve, 450));
    const steps = records.slice(1).map((row, index) => Math.abs(angleDifference(records[index].yaw, row.yaw)));
    const result = { frames: records.length, maxFrameTurn: Math.max(...steps), idleTurn: Math.abs(angleDifference(idleStartYaw, actor.rotation.y)),
      maxGroundGap: Math.max(...records.map(row => Math.abs(row.groundGap))), records };
    if (result.frames < 20 || result.maxFrameTurn > .315 || result.idleTurn > .02 || result.maxGroundGap > .003) throw new Error(JSON.stringify(result));
    return result;
  } finally { view.destroy(); host.remove(); }
}
