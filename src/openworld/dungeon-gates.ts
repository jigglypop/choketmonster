import { getWorldAtlas, type WorldAtlas } from './atlas';
import { dungeonExits, getCaveScene, type CavePortal, type CaveScene } from './caves';

const reachCache = new WeakMap<WorldAtlas, Map<string, number>>();

/**
 * Fewest badges with which the region's own roads, gates and gated places reach a location from its start.
 * A dungeon doorway that opens there needs as many, so no passage underground skips a gate above it.
 */
export function surfaceBadges(atlas: WorldAtlas, locationId: string): number {
  let reach = reachCache.get(atlas);
  if (!reach) {
    reach = new Map();
    const byId = new Map(atlas.locations.map(location => [location.id, location]));
    const start = atlas.locationAt(atlas.start.x, atlas.start.z).id;
    for (let badges = 0; badges <= 8; badges++) {
      const open = (from: string, to: string) => (byId.get(to)?.requiredBadges ?? 0) <= badges
        && !atlas.gates.some(gate => gate.requiredBadges > badges && ((gate.from === from && gate.to === to) || (gate.from === to && gate.to === from)));
      const seen = new Set([start]), queue = [start];
      for (let head = 0; head < queue.length; head++) for (const [a, b] of atlas.connections) {
        const next = a === queue[head] ? b : b === queue[head] ? a : undefined;
        if (next && !seen.has(next) && open(queue[head], next)) { seen.add(next); queue.push(next); }
      }
      for (const id of seen) if (!reach.has(id)) reach.set(id, badges);
    }
    reachCache.set(atlas, reach);
  }
  // Places the roads never reach stay behind the last badge.
  return reach.get(locationId) ?? 8;
}

/** Badges needed to use a dungeon's surface doorway, in either direction. */
export function portalBadges(scene: Pick<CaveScene, 'regionId' | 'encounterLocationId'>, portal: Pick<CavePortal, 'surfaceLocationId'>): number {
  const atlas = getWorldAtlas(scene.regionId), place = atlas.locations.find(location => location.id === scene.encounterLocationId);
  return Math.max(surfaceBadges(atlas, portal.surfaceLocationId), place?.requiredBadges ?? 0);
}

/** Exits of the player's dungeon that their badges open; an entrance used earlier always stays open. */
export function openDungeonExits(sceneId: string, badges: number): Array<{ scene: CaveScene; portal: CavePortal }> {
  const cave = getCaveScene(sceneId); if (!cave) return [];
  const exits = dungeonExits(cave);
  const open = exits.filter(exit => portalBadges(exit.scene, exit.portal) <= badges);
  // Never trap a partner: an older save inside a gated dungeon still has its first entrance.
  return open.length ? open : exits.slice(0, 1);
}
