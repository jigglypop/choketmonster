import { cavePassages, passageMouthArrival, type CavePassage } from '../../src/openworld/cave-passages';
import { findWorldPath } from '../../src/openworld/navigation';
import type { WorldPoint, WorldSample } from '../../src/openworld/types';

type RegionMap = { id: string; locations: readonly { id: string; x: number; z: number }[]; connections: ReadonlyArray<readonly [string, string]> };

/** Caves standing across a road on this map, whose hills the surface path cannot cross. */
export const passagesOf = (map: RegionMap): CavePassage[] => cavePassages(map.id, map.locations, map.connections);

/**
 * A walk that crosses sealed caves the way the player does: along the surface to one mouth's doorstep, through the
 * cave, and on from the far mouth's doorstep. Surface stretches come from the real path finder; a crossing is a jump
 * between the two doorsteps (the cave floors themselves are walked in the cave tests).
 */
export function walkThroughCaves(passages: readonly CavePassage[], from: WorldPoint, to: WorldPoint, sample: (x: number, z: number) => WorldSample, maxVisited = 60_000, reach = 1.5): WorldPoint[] {
  const doorsteps = passages.flatMap(passage => passage.mouths.map((_, index) => ({ passage, index, point: passageMouthArrival(passage, index) })));
  const arrives = (path: WorldPoint[], point: WorldPoint) => path.length > 0 && Math.hypot(path.at(-1)!.x - point.x, path.at(-1)!.z - point.z) < reach;
  const queue: Array<{ at: WorldPoint; path: WorldPoint[] }> = [{ at: from, path: [] }], used = new Set<string>();
  while (queue.length) {
    const leg = queue.shift()!;
    const direct = findWorldPath(leg.at, to, sample, maxVisited);
    if (arrives(direct, to)) return [...leg.path, ...direct];
    for (const step of doorsteps) {
      const key = `${step.passage.dungeonId}:${step.index}`;
      if (used.has(key)) continue;
      const approach = findWorldPath(leg.at, step.point, sample, maxVisited);
      if (!arrives(approach, step.point)) continue;
      step.passage.mouths.forEach((_, index) => used.add(`${step.passage.dungeonId}:${index}`));
      for (let index = 0; index < step.passage.mouths.length; index++) {
        if (index === step.index) continue;
        const exit = passageMouthArrival(step.passage, index);
        queue.push({ at: exit, path: [...leg.path, ...approach, exit] });
      }
    }
  }
  return [];
}
