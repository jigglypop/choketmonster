import { Brain, validateGraph, type Graph } from '../core/brain';
import { clamp } from '../core/random';
import { getMove, getSpecies } from '../data/pokemon';
import { typeMultiplier } from './battle';

export type NeuralMonster = { instanceId: string; speciesId: number; level: number; hp: number; stats: { hp: number; speed: number }; moves: { pp: number; moveId?: number }[]; status?: string; brain?: ReturnType<Brain['snapshot']> };
export type Decision = { rawAction: number; action: number; updates: number; graphId: string; activity: number };
export const BRAIN_MODEL = 'pokemon-recurrent-v1';
export const BRAIN_ASSUMPTIONS = '실제 신경 연결 일부를 사용합니다. HP·레벨·속도·상태와 기술별 PP 준비도·방어 타입 상성을 합친 12개 배틀 감각의 투영, tanh 동역학, 4회 순환 계산, 기술 4개·대기 출력, 보상 학습은 게임용 설계입니다. 감각에서 출력으로 가는 우회 연결은 껐습니다.';

export class ConnectomeController {
  readonly graph: Graph;
  constructor(graph: Graph) {
    validateGraph(graph);
    if (graph.kind !== 'connectome-subset') throw new Error('게임은 실제 커넥톰 부분 회로가 필요합니다.');
    this.graph = structuredClone(graph);
  }
  static async load() {
    const response = await fetch('/data/connectome.json');
    if (!response.ok) throw new Error(`실제 커넥톰을 읽을 수 없습니다 (${response.status}).`);
    return new ConnectomeController(await response.json());
  }
  ensure(monster: NeuralMonster): Brain {
    if (monster.brain) {
      if (monster.brain.graph.id !== this.graph.id || monster.brain.sensoryBypass !== false) throw new Error('저장된 회로 모델이 현재 데이터와 다릅니다.');
      return Brain.restore(monster.brain);
    }
    let seed = 2166136261;
    for (const char of monster.instanceId) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
    const brain = new Brain(seed, this.graph);
    brain.state.sensoryBypass = false;
    monster.brain = brain.snapshot();
    return brain;
  }
  observe(self: NeuralMonster, other: NeuralMonster, turn: number): number[] {
    const defenderTypes = getSpecies(other.speciesId).types;
    const moveSense = Array.from({ length: 4 }, (_, index) => {
      const slot = self.moves[index];
      const legacyPp = Math.min((slot?.pp ?? 0) / 40, 1);
      if (slot?.moveId === undefined) return legacyPp;
      const move = getMove(slot.moveId);
      if (move.damageClass === 'status' || move.power <= 0) return legacyPp;
      const multiplier = typeMultiplier(move.type, defenderTypes);
      const matchup = multiplier === 0 ? -1 : clamp(Math.log2(multiplier) / 2, -1, 1);
      return clamp(legacyPp * (1 + .25 * matchup), 0, 1);
    });
    return [1, self.hp / self.stats.hp, other.hp / other.stats.hp,
      clamp((self.level - other.level) / 30, -1, 1), clamp((self.stats.speed - other.stats.speed) / 100, -1, 1),
      Math.min(turn / 50, 1), self.status ? 1 : 0, other.status ? 1 : 0,
      ...moveSense];
  }
  choose(self: NeuralMonster, other: NeuralMonster, turn: number, reward: number | null = null, learning = false): Decision {
    const brain = this.ensure(self);
    const rawAction = brain.act(this.observe(self, other, turn), reward, learning, learning ? .12 : 0, 4);
    let action: number = rawAction;
    if (rawAction < 4 && !(self.moves[rawAction]?.pp > 0)) {
      const available = self.moves.map((move, i) => move.pp > 0 ? i : -1).filter(i => i >= 0);
      action = available.find(i => i >= rawAction) ?? available[0] ?? 0;
    }
    brain.state.action = action as 0 | 1 | 2 | 3 | 4;
    if (action !== rawAction) brain.state.previous = null;
    self.brain = brain.snapshot();
    return { rawAction, action, graphId: this.graph.id, updates: brain.state.updates,
      activity: brain.state.activity.reduce((sum, v) => sum + Math.abs(v), 0) / brain.state.activity.length };
  }
  finish(monster: NeuralMonster, reward: number, learning: boolean) {
    const brain = this.ensure(monster); brain.finish(reward, learning); monster.brain = brain.snapshot();
  }
  reset(monster: NeuralMonster, seed: number) {
    const brain = this.ensure(monster); brain.resetEpisode(seed); monster.brain = brain.snapshot();
  }
}
