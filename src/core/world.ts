import { Random, clamp } from './random';

export const WIDTH = 16;
export const HEIGHT = 10;
export const ACTIONS = ['위로', '오른쪽', '아래로', '왼쪽', '쉬기'] as const;
export type Action = 0 | 1 | 2 | 3 | 4;
export type Point = { x: number; y: number };
export type World = {
  seed: number; rng: number; tick: number; limit: number; position: Point;
  food: Point; hazards: Point[]; energy: number; eaten: number; hits: number;
  reward: number; lastReward: number; lastAction: Action; done: boolean;
};
export const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const moves: Point[] = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: 0 }];
export function destination(p: Point, action: Action): Point {
  return { x: clamp(p.x + moves[action].x, 0, WIDTH - 1), y: clamp(p.y + moves[action].y, 0, HEIGHT - 1) };
}
function freePoint(rng: Random, taken: Point[]): Point {
  const free: Point[] = [];
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    if (!taken.some(p => p.x === x && p.y === y)) free.push({ x, y });
  }
  return free[rng.int(free.length)];
}
export function createWorld(seed: number, limit = 240): World {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isInteger(limit) || limit < 1 || limit > 100000) throw new Error('Invalid world seed or limit');
  const rng = new Random(seed);
  const position = freePoint(rng, []);
  const hazards: Point[] = [];
  for (let i = 0; i < 5; i++) hazards.push(freePoint(rng, [position, ...hazards]));
  const food = freePoint(rng, [position, ...hazards]);
  return { seed, rng: rng.state, tick: 0, limit, position, hazards, food, energy: 100, eaten: 0, hits: 0, reward: 0, lastReward: 0, lastAction: 4, done: false };
}
/** Engineered directional smell + adjacent hazard sensors, not biological retinal data. */
export function observe(w: World): number[] {
  const dx = (w.food.x - w.position.x) / WIDTH;
  const dy = (w.food.y - w.position.y) / HEIGHT;
  const danger = moves.slice(0, 4).map((_, a) => {
    const p = destination(w.position, a as Action);
    return same(p, w.position) || w.hazards.some(h => same(h, p)) ? 1 : 0;
  });
  return [1, dx, dy, Math.sign(dx), Math.sign(dy), Math.abs(dx), Math.abs(dy), ...danger, w.energy / 100];
}
export function stepWorld(w: World, action: Action): World {
  if (w.done) throw new Error('Episode is complete');
  if (!Number.isInteger(action) || action < 0 || action >= ACTIONS.length) throw new Error('Invalid action');
  const position = destination(w.position, action);
  const blocked = action !== 4 && same(position, w.position);
  const hit = action !== 4 && w.hazards.some(h => same(h, position));
  const ate = same(position, w.food);
  // Distance shaping is explicit: success here does not establish unshaped learning.
  let reward = -0.04 + 0.12 * (distance(w.position, w.food) - distance(position, w.food));
  if (blocked) reward -= 0.25;
  if (hit) reward -= 1.5;
  if (ate) reward += 3;
  const rng = new Random(w.rng);
  const energy = clamp(w.energy - 0.28 - (hit ? 8 : 0) + (ate ? 20 : 0), 0, 100);
  const tick = w.tick + 1;
  return { ...w, position, food: ate ? freePoint(rng, [position, ...w.hazards]) : w.food,
    rng: rng.state, energy, tick, eaten: w.eaten + Number(ate), hits: w.hits + Number(hit),
    reward: w.reward + reward, lastReward: reward, lastAction: action,
    done: tick >= w.limit || energy <= 0 };
}
export function heuristicAction(w: World): Action {
  let best = -Infinity;
  let choice: Action = 4;
  for (let a = 0; a < 4; a++) {
    const p = destination(w.position, a as Action);
    const score = -distance(p, w.food) - (same(p, w.position) ? 10 : 0) - (w.hazards.some(h => same(h, p)) ? 5 : 0);
    if (score > best) { best = score; choice = a as Action; }
  }
  return choice;
}
