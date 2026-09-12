import type { WorldCreature, WorldPoint } from './types';

export const TERRAIN_CHUNK_SIZE = 40;
export type TerrainChunk = { key: string; x: number; z: number; segments: number; distance: number };
export type VisibilityTest = (x: number, y: number, z: number, radius: number) => boolean;

/** Rendering budgets only. These functions never read or advance simulation state. */
export function terrainChunks(player: WorldPoint, visible: VisibilityTest): TerrainChunk[] {
  const chunks: TerrainChunk[] = [];
  for (let ix = 0; ix < 6; ix++) for (let iz = 0; iz < 6; iz++) {
    const x = -100 + ix * 40, z = -100 + iz * 40;
    const distance = Math.hypot(Math.max(0, Math.abs(x - player.x) - 20), Math.max(0, Math.abs(z - player.z) - 20));
    if (distance > 100 || (distance > 8 && !visible(x, 0, z, 31))) continue;
    // 12 segments align exactly with the existing 72-segment ground contract.
    chunks.push({ key: `${ix}:${iz}`, x, z, segments: distance <= 44 ? 12 : 4, distance });
  }
  return chunks;
}

export function creatureLods(entities: readonly WorldCreature[], player: WorldPoint, visible: VisibilityTest, mobile: boolean, selected?: string | null) {
  const modelRadius = mobile ? 22 : 32, viewRadius = mobile ? 52 : 72;
  let models = mobile ? 4 : 8;
  return entities.map(creature => ({ creature, distance: Math.hypot(creature.x - player.x, creature.z - player.z) }))
    .filter(({ creature: c, distance }) => distance <= viewRadius && (c.id.startsWith('companion:') || visible(c.x, (c.y ?? 0) + 2, c.z, Math.max(3, c.displayHeight ?? 1))))
    .sort((a, b) => Number(b.creature.id.startsWith('companion:') || b.creature.inBattle || b.creature.id === selected)
      - Number(a.creature.id.startsWith('companion:') || a.creature.inBattle || a.creature.id === selected) || a.distance - b.distance || a.creature.id.localeCompare(b.creature.id))
    .slice(0, mobile ? 10 : 16)
    .map(item => ({ ...item, model: item.distance <= modelRadius && models-- > 0 }));
}
