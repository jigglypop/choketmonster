import { Brain, type BrainState } from './brain';
import { train } from './episode';
import { parseJson } from './json';

export const SPECIES = [
  { name: '모스', latin: 'D. viridis', type: '풀빛', color: '#92b66d', eye: '#e9a077', personality: '호기심 많은 탐험가', seed: 42 },
  { name: '앰버', latin: 'D. aurora', type: '햇살', color: '#e8b264', eye: '#a6745f', personality: '지치지 않는 모험가', seed: 137 },
  { name: '루미', latin: 'D. lumina', type: '이슬', color: '#99b9dc', eye: '#9a84b1', personality: '차분한 관찰자', seed: 271 },
] as const;
export type Creature = { species: number; name: string; brain: BrainState; episodes: number; food: number; wins: number; losses: number };
export type Collection = { schema: 1; selected: number; creatures: Creature[] };
export function starterCollection(): Collection {
  return { schema: 1, selected: 0, creatures: SPECIES.map((s, species) => {
    const brain = new Brain(s.seed);
    // A small reproducible warm-up makes the first habitat immediately watchable.
    // These episodes are visible in the UI and never used as an experimental baseline.
    const results = train(brain, 24, 1000 + species * 10000);
    brain.resetEpisode(s.seed);
    return { species, name: s.name, brain: brain.snapshot(), episodes: 24, food: results.reduce((n, r) => n + r.food, 0), wins: 0, losses: 0 };
  }) };
}
export function parseCollection(text: string): Collection {
  if (text.length > 8_000_000) throw new Error('저장 파일은 8 MB 이하여야 합니다.');
  const c = parseJson(text) as Collection;
  if (!c || c.schema !== 1 || !Array.isArray(c.creatures) || c.creatures.length !== 3 || !Number.isInteger(c.selected) || c.selected < 0 || c.selected >= 3) throw new Error('지원하지 않는 저장 파일입니다.');
  for (const [i, creature] of c.creatures.entries()) {
    if (!creature || creature.species !== i || typeof creature.name !== 'string' || !creature.name.trim() || creature.name.length > 24 || ![creature.episodes, creature.food, creature.wins, creature.losses].every(x => Number.isSafeInteger(x) && x >= 0 && x < 1_000_000_000)) throw new Error('개체 정보가 올바르지 않습니다.');
    Brain.restore(creature.brain);
  }
  return c;
}
