import type { WorldPoint, WorldSample } from './types';

export const NAVIGATION_GRID = .75;
const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

type Node = { x: number; z: number; cost: number; score: number; parent?: string };
const key = (x: number, z: number) => `${x}:${z}`;

/** Finds a deterministic walkable route without consuming simulation state or randomness. */
export function findWorldPath(
  start: WorldPoint,
  destination: WorldPoint,
  sampleWorld: (x: number, z: number) => WorldSample,
  maxVisited = 24_000,
): WorldPoint[] {
  if (![start.x, start.z, destination.x, destination.z].every(Number.isFinite) || maxVisited < 1) return [];
  const originX = Math.round(start.x / NAVIGATION_GRID), originZ = Math.round(start.z / NAVIGATION_GRID);
  let goalX = Math.round(destination.x / NAVIGATION_GRID), goalZ = Math.round(destination.z / NAVIGATION_GRID);
  const walkable = (x: number, z: number) => !sampleWorld(x * NAVIGATION_GRID, z * NAVIGATION_GRID).blocked;
  if (!walkable(goalX, goalZ)) {
    let replacement: [number, number] | undefined;
    for (let radius = 1; radius <= 16 && !replacement; radius += 1) {
      for (let x = goalX - radius; x <= goalX + radius && !replacement; x += 1) for (const z of [goalZ - radius, goalZ + radius]) if (walkable(x, z)) { replacement = [x, z]; break; }
      for (let z = goalZ - radius + 1; z < goalZ + radius && !replacement; z += 1) for (const x of [goalX - radius, goalX + radius]) if (walkable(x, z)) { replacement = [x, z]; break; }
    }
    if (!replacement) return [];
    [goalX, goalZ] = replacement;
  }

  const nodes = new Map<string, Node>();
  const open: Node[] = [];
  const push = (node: Node) => {
    open.push(node);
    for (let index = open.length - 1; index > 0;) {
      const parent = Math.floor((index - 1) / 2);
      if (open[parent].score <= node.score) break;
      open[index] = open[parent]; index = parent; open[index] = node;
    }
  };
  const pop = () => {
    const first = open[0], last = open.pop()!;
    if (open.length) {
      open[0] = last;
      for (let index = 0;;) {
        const left = index * 2 + 1, right = left + 1;
        if (left >= open.length) break;
        const child = right < open.length && open[right].score < open[left].score ? right : left;
        if (open[index].score <= open[child].score) break;
        [open[index], open[child]] = [open[child], open[index]]; index = child;
      }
    }
    return first;
  };
  const heuristic = (x: number, z: number) => Math.hypot(goalX - x, goalZ - z);
  const startNode: Node = { x: originX, z: originZ, cost: 0, score: heuristic(originX, originZ) };
  nodes.set(key(originX, originZ), startNode); push(startNode);
  let goal: Node | undefined;
  let visited = 0;
  while (open.length && visited < maxVisited) {
    const current = pop();
    if (nodes.get(key(current.x, current.z)) !== current) continue;
    if (current.x === goalX && current.z === goalZ) { goal = current; break; }
    visited += 1;
    for (const [dx, dz] of DIRECTIONS) {
      const x = current.x + dx, z = current.z + dz;
      if (!walkable(x, z)) continue;
      if (dx && dz && (!walkable(current.x + dx, current.z) || !walkable(current.x, current.z + dz))) continue;
      const nextCost = current.cost + (dx && dz ? Math.SQRT2 : 1);
      const nodeKey = key(x, z), previous = nodes.get(nodeKey);
      if (previous && previous.cost <= nextCost) continue;
      const next = { x, z, cost: nextCost, score: nextCost + heuristic(x, z), parent: key(current.x, current.z) };
      nodes.set(nodeKey, next); push(next);
    }
  }
  if (!goal) return [];
  const route: WorldPoint[] = [];
  for (let current: Node | undefined = goal; current?.parent; current = nodes.get(current.parent)) route.push({ x: current.x * NAVIGATION_GRID, z: current.z * NAVIGATION_GRID });
  route.reverse();
  if (route.length) route[route.length - 1] = { x: goalX * NAVIGATION_GRID, z: goalZ * NAVIGATION_GRID };
  return route;
}

export function headingForStep(dx: number, dz: number): 0 | 1 | 2 | 3 {
  return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 1 : 3) : (dz > 0 ? 2 : 0);
}
