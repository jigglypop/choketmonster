import { campaignTravelReason, getCampaignGyms, getNextCampaignTrainer, getRegionalBadges } from '../game/campaign';
import type { GameState } from '../game/engine';
import type { WorldAtlas } from './atlas';
import { getCaveScene } from './caves';
import { findWorldPath } from './navigation';
import type { WorldPoint, WorldSample } from './types';

export type DestinationGuide = {
  title: string; detail: string; destinationId?: string; destinationName?: string;
  nextName?: string; recommendedLevel?: number; points: WorldPoint[];
  status: 'route' | 'arrived' | 'unreachable' | 'complete';
};

const onwardRegions: Partial<Record<WorldAtlas['id'], readonly [string, string]>> = {
  johto: ['kanto', '관동'], kanto: ['hoenn', '호연'], hoenn: ['sinnoh', '신오'],
  sinnoh: ['unova', '하나'], unova: ['kalos', '칼로스'], kalos: ['alola', '알로라'],
  alola: ['galar', '가라르'], galar: ['hisui', '히스이'], hisui: ['paldea', '팔데아'],
};

/** Authored campaign guidance, independent of the neural policy and its random stream. */
export function regionalItinerary(atlas: WorldAtlas, from: string, to: string, badges: number): string[] {
  const locations = new Map(atlas.locations.map(item => [item.id, item]));
  if (!locations.has(from) || !locations.has(to)) return [];
  const costs = new Map<string, number>([[from, 0]]), previous = new Map<string, string>(), open = new Set([from]);
  while (open.size) {
    const current = [...open].sort((a, b) => costs.get(a)! - costs.get(b)!)[0]; open.delete(current);
    if (current === to) {
      const route = [to]; while (previous.has(route[0])) route.unshift(previous.get(route[0])!); return route;
    }
    for (const edge of atlas.connections) {
      const next = edge[0] === current ? edge[1] : edge[1] === current ? edge[0] : undefined;
      if (!next) continue;
      const point = locations.get(next)!, origin = locations.get(current)!;
      if (point.requiredBadges > badges || atlas.gates.some(gate => !gate.terrainBoundary && gate.requiredBadges > badges &&
        ((gate.from === current && gate.to === next) || (gate.to === current && gate.from === next)))) continue;
      const cost = costs.get(current)! + Math.hypot(point.x - origin.x, point.z - origin.z);
      if (cost >= (costs.get(next) ?? Infinity)) continue;
      costs.set(next, cost); previous.set(next, current); open.add(next);
    }
  }
  return [];
}

export function nextDestinationGuide(game: GameState, atlas: WorldAtlas, sceneId: string, player: WorldPoint): DestinationGuide {
  const badges = getRegionalBadges(game, atlas.id);
  const gym = getCampaignGyms(game, atlas.id).find(item => item.badge === badges + 1);
  const trainer = badges >= 8 ? getNextCampaignTrainer(game, atlas.id) : undefined;
  const destinationId = gym?.locationId ?? trainer?.locationId;
  const destination = atlas.locations.find(item => item.id === destinationId);
  if (!destination) {
    const onward = onwardRegions[atlas.id];
    return { title: `${atlas.name} 주요 도전 완료`, detail: onward && !campaignTravelReason(game, onward[0]) ? `지도에서 ${onward[1]} 여행을 선택하세요.` : '지도에서 수집할 지역을 확인하세요.', points: [], status: 'complete' };
  }
  const recommendedLevel = gym?.level ?? Math.max(...trainer!.team.map(([, level]) => level));
  const base = { title: `${destination.name} · ${gym?.name ?? trainer!.name}`, destinationId, destinationName: destination.name, recommendedLevel };
  const cave = getCaveScene(sceneId);
  let next: WorldPoint | undefined, nextName: string | undefined;
  let sample: (x: number, z: number) => WorldSample = atlas.sample;
  if (cave) {
    const exits = cave.portals.map(portal => {
      const route = regionalItinerary(atlas, portal.surfaceLocationId, destination.id, badges);
      const cost = route.slice(1).reduce((sum, id, index) => {
        const a = atlas.locations.find(item => item.id === route[index])!, b = atlas.locations.find(item => item.id === id)!;
        return sum + Math.hypot(a.x - b.x, a.z - b.z);
      }, 0);
      return { portal, route, cost };
    }).filter(exit => exit.route.length).sort((a, b) => a.cost - b.cost);
    const exit = exits[0]; sample = cave.sample;
    next = exit?.portal.interiorArrival;
    nextName = exit ? `${atlas.locations.find(item => item.id === exit.portal.surfaceLocationId)?.name ?? '지상'} 출구` : undefined;
  } else {
    const current = atlas.locationAt(player.x, player.z), route = regionalItinerary(atlas, current.id, destination.id, badges);
    if (current.id === destination.id && Math.hypot(player.x - destination.x, player.z - destination.z) < 12)
      return { ...base, detail: `목적지 도착 · 탐험 설정에서 ${atlas.id === 'hisui' ? gym ? '조사' : '조사대 결승' : gym ? '체육관' : '리그'}에 도전하세요.`, points: [], status: 'arrived' };
    const nextId = route[1] ?? (route.length ? destination.id : undefined);
    const location = atlas.locations.find(item => item.id === nextId);
    if (location) {
      const edgeOnSurface = atlas.surfaceConnections.some(([a, b]) => (a === current.id && b === location.id) || (b === current.id && a === location.id));
      const passage = atlas.caves.find(item => item.id === location.id || item.id === current.id
        || item.portals.some(portal => portal.surfaceLocationId === current.id || portal.surfaceLocationId === location.id));
      const portal = passage && !edgeOnSurface ? [...passage.portals].sort((a, b) => Math.hypot(a.surface.x - player.x, a.surface.z - player.z) - Math.hypot(b.surface.x - player.x, b.surface.z - player.z))[0] : undefined;
      next = portal?.surface ?? atlas.safeArrival(location.id, badges);
      nextName = portal ? `${passage!.name} 입구` : location.name;
    }
    // Respect locked terrain while drawing directions as well as while moving.
    sample = (x, z) => {
      const terrain = atlas.sample(x, z);
      return terrain.blocked || !atlas.evaluateTraversal(player, { x, z }, badges).allowed ? { ...terrain, blocked: true } : terrain;
    };
  }
  if (!next) return { ...base, detail: '먼저 배지로 열리는 길을 확인하세요.', points: [], status: 'unreachable' };
  const points = findWorldPath(player, next, sample);
  if (!points.length && Math.hypot(next.x - player.x, next.z - player.z) > 2)
    return { ...base, nextName, detail: `${nextName} 방향 · 지도에서 연결된 길을 확인하세요.`, points: [], status: 'unreachable' };
  return { ...base, nextName, detail: `${nextName} ${cave ? '쪽 출구로' : '방향으로'} 이동하세요.`, points, status: 'route' };
}
