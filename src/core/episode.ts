import { Brain } from './brain';
import { Random } from './random';
import { createWorld, heuristicAction, observe, stepWorld, type Action, type World } from './world';

export type Policy = 'brain' | 'random' | 'heuristic';
export type EpisodeResult = { seed: number; steps: number; food: number; hits: number; reward: number; energy: number };
export function runEpisode(brain: Brain, seed: number, options: { learning?: boolean; policy?: Policy; steps?: number; trace?: World[] } = {}): EpisodeResult {
  const { learning = false, policy = 'brain', steps = 240, trace } = options;
  let world = createWorld(seed, steps);
  const rng = new Random(seed ^ 0x123456);
  brain.resetEpisode(seed ^ 0xffbb);
  trace?.push(structuredClone(world));
  while (!world.done) {
    const action: Action = policy === 'random' ? rng.int(5) as Action : policy === 'heuristic' ? heuristicAction(world) : brain.act(observe(world), world.tick > 0 ? world.lastReward : null, learning, learning ? 0.15 : 0);
    world = stepWorld(world, action);
    trace?.push(structuredClone(world));
  }
  if (policy === 'brain') brain.finish(world.lastReward, learning);
  return { seed, steps: world.tick, food: world.eaten, hits: world.hits, reward: world.reward, energy: world.energy };
}
export function train(brain: Brain, episodes: number, startSeed: number): EpisodeResult[] {
  return Array.from({ length: episodes }, (_, i) => runEpisode(brain, startSeed + i, { learning: true }));
}
