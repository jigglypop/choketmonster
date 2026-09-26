import type { WorldCreature, WorldPoint } from './types';
import { hasPokemonModel } from '../data/pokemon-models';
import { WORLD_MIN, WORLD_MAX } from './world-space';

export const TERRAIN_CHUNK_SIZE = 40;
export type TerrainChunk = { key: string; x: number; z: number; segments: number; distance: number };
export type VisibilityTest = (x: number, y: number, z: number, radius: number) => boolean;

/**
 * Rendering budgets only. These functions never read or advance simulation state.
 * Chunks in `retained` stay in the list while in range even when off screen: the renderer culls them anyway,
 * and turning the camera then never unmounts and rebuilds ground.
 */
export function terrainChunks(player: WorldPoint, visible: VisibilityTest, retained?: ReadonlySet<string>): TerrainChunk[] {
  const chunks: TerrainChunk[] = [];
  const cells = (WORLD_MAX - WORLD_MIN) / TERRAIN_CHUNK_SIZE;
  for (let ix = 0; ix < cells; ix++) for (let iz = 0; iz < cells; iz++) {
    const x = WORLD_MIN + TERRAIN_CHUNK_SIZE / 2 + ix * TERRAIN_CHUNK_SIZE, z = WORLD_MIN + TERRAIN_CHUNK_SIZE / 2 + iz * TERRAIN_CHUNK_SIZE;
    const distance = Math.hypot(Math.max(0, Math.abs(x - player.x) - 20), Math.max(0, Math.abs(z - player.z) - 20));
    const key = `${ix}:${iz}`;
    if (distance > 100 || (distance > 8 && !retained?.has(key) && !visible(x, 0, z, 31))) continue;
    // 12 segments align exactly with the existing 72-segment ground contract.
    chunks.push({ key, x, z, segments: distance <= 44 ? 12 : 4, distance });
  }
  return chunks;
}

let shortTouchScreen: MediaQueryList | undefined;
/** Phone budgets: a narrow canvas, or a touch screen held sideways (the CSS phone HUD's short touch screen). */
export function isPhoneCanvas(width: number): boolean {
  shortTouchScreen ??= typeof matchMedia === 'function' ? matchMedia('(pointer: coarse) and (max-height: 600px)') : undefined;
  return width <= 720 || !!shortTouchScreen?.matches;
}

/** Companions and both sides of a battle are always drawn: the battle waits on their models. */
const alwaysDrawn = (creature: WorldCreature) => creature.id.startsWith('companion:') || !!creature.inBattle;

export function creatureLods(entities: readonly WorldCreature[], player: WorldPoint, visible: VisibilityTest, mobile: boolean, selected?: string | null) {
  const modelRadius = mobile ? 22 : 32;
  return entities.map(creature => ({ creature, distance: Math.hypot(creature.x - player.x, creature.z - player.z) }))
    .filter(({ creature: c, distance }) => (distance <= modelRadius || c.inBattle)
      && (hasPokemonModel(c.speciesId) || alwaysDrawn(c))
      && (alwaysDrawn(c) || visible(c.x, (c.y ?? 0) + 2, c.z, Math.max(3, c.displayHeight ?? 1))))
    .sort((a, b) => Number(alwaysDrawn(b.creature) || b.creature.id === selected)
      - Number(alwaysDrawn(a.creature) || a.creature.id === selected) || a.distance - b.distance || a.creature.id.localeCompare(b.creature.id))
    .slice(0, mobile ? 4 : 8)
    .map(item => ({ ...item, model: hasPokemonModel(item.creature.speciesId) }));
}
