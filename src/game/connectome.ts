import { Brain, validateGraph, type Graph } from '../core/brain';
import { clamp } from '../core/random';
import { getMove, getSpecies } from '../data/pokemon';
import { typeMultiplier } from './battle';

export type NeuralMonster = { instanceId: string; speciesId: number; level: number; hp: number; stats: { hp: number; speed: number }; moves: { pp: number; moveId?: number }[]; status?: string; brain?: ReturnType<Brain['snapshot']> };
export type BattleSenseContext = {
  selfStatStages?: Readonly<Record<string, number>>;
  otherStatStages?: Readonly<Record<string, number>>;
  automatic?: boolean;
};
export type Decision = { rawAction: number; action: number; updates: number; graphId: string; activity: number };
export const BRAIN_MODEL = 'pokemon-recurrent-v1';
export const BRAIN_ASSUMPTIONS = '실제 신경 연결 일부를 사용합니다. HP·레벨·속도·상태와 기술별 공격 상성·면역, 회복 필요, 능력 단계 여유, 상태이상 적용 가능성을 합친 12개 배틀 감각의 투영, tanh 동역학, 4회 순환 계산, 기술 4개·대기 출력, 보상 학습은 게임용 설계입니다. 자동 전투는 유효 공격이 있으면 매 턴 공격 기술만 허용하고, 공격이 없을 때 효과 있는 변화 기술을 허용합니다. 이 제한과 효과 없는 기술 제외는 학습과 분리된 게임 규칙입니다. 감각에서 출력으로 가는 우회 연결은 껐습니다.';

const SELF_TARGETS = new Set([4, 7, 13, 15]);

export function availableMoveMask(monster: NeuralMonster): [boolean, boolean, boolean, boolean, boolean] {
  return [0, 1, 2, 3].map(index => !!monster.moves[index]).concat(true) as [boolean, boolean, boolean, boolean, boolean];
}

const FIXED_DAMAGE_MOVES = new Set([12, 32, 49, 69, 82, 90, 101, 149, 162]);

/** Game-only action guard for unattended battles; it does not change observations or learning weights. */
export function automatedMoveMask(self: NeuralMonster, other: NeuralMonster, _turn: number, context: BattleSenseContext = {}): [boolean, boolean, boolean, boolean, boolean] {
  const moveMask = availableMoveMask(self), defenderTypes = getSpecies(other.speciesId).types;
  // Slot zero is the engine's Struggle fallback when no move slots exist.
  if (!moveMask.slice(0, 4).some(Boolean)) return [true, false, false, false, false];
  const attacks = [0, 1, 2, 3].map(index => {
    const slot = self.moves[index]; if (!slot || slot.moveId === undefined) return false;
    const move = getMove(slot.moveId);
    return move.damageClass !== 'status' && (move.power > 0 || FIXED_DAMAGE_MOVES.has(move.id)) && typeMultiplier(move.type, defenderTypes) > 0;
  });
  const strategic = [0, 1, 2, 3].map(index => {
    const slot = self.moves[index]; if (!slot || slot.moveId === undefined) return false;
    const move = getMove(slot.moveId);
    if (move.damageClass !== 'status') return false;
    const healing = ((move.healing ?? 0) > 0 || move.id === 156) && self.hp < self.stats.hp;
    const selfTarget = move.metaCategory === 8 || (move.metaCategory !== 7 && SELF_TARGETS.has(move.targetId ?? 10));
    const stages = selfTarget ? context.selfStatStages : context.otherStatStages;
    const stageChange = move.statChanges?.some(change => {
      const key = ({ 'special-attack': 'specialAttack', 'special-defense': 'specialDefense' } as Record<string, string>)[change.stat] ?? change.stat;
      const stage = stages?.[key] ?? 0;
      return change.change > 0 ? stage < 6 : stage > -6;
    }) ?? false;
    const statusTarget = SELF_TARGETS.has(move.targetId ?? 10) ? self : other;
    const ailment = !!move.ailment && move.ailment !== 'none' && !statusTarget.status
      && !ailmentImmune(move.ailment, getSpecies(statusTarget.speciesId).types);
    return healing || stageChange || ailment;
  });
  if (attacks.some(Boolean)) return attacks.concat(false) as [boolean, boolean, boolean, boolean, boolean];
  let allowed = moveMask.slice(0, 4).map((hasMove, index) => hasMove && strategic[index]);
  if (!allowed.some(Boolean)) allowed = moveMask.slice(0, 4);
  return allowed.concat(false) as [boolean, boolean, boolean, boolean, boolean];
}

export function mapToAvailableMove(rawAction: number, mask: readonly boolean[]): number {
  if (!Number.isInteger(rawAction) || rawAction < 0 || rawAction > 4 || mask.length !== 5) throw new Error('Invalid battle action mask');
  if (mask[rawAction]) return rawAction;
  for (let offset = 1; offset <= 4; offset++) {
    const candidate = (rawAction + offset) % 4;
    if (mask[candidate]) return candidate;
  }
  return 4;
}

function ailmentImmune(ailment: string | undefined, types: readonly string[]): boolean {
  return (ailment === 'poison' && (types.includes('poison') || types.includes('steel')))
    || (ailment === 'burn' && types.includes('fire')) || (ailment === 'freeze' && types.includes('ice'))
    || (ailment === 'paralysis' && types.includes('electric'));
}

/** Four fixed-width move signals; preserves schema-1 brains with 12 input columns. */
export function battleMoveSenses(self: NeuralMonster, other: NeuralMonster, context: BattleSenseContext = {}): [number, number, number, number] {
  const defenderTypes = getSpecies(other.speciesId).types;
  const missingHp = clamp((self.stats.hp - self.hp) / Math.max(1, self.stats.hp), 0, 1);
  return [0, 1, 2, 3].map(index => {
    const slot = self.moves[index];
    if (!slot) return -1;
    if (slot.moveId === undefined) return 1;
    const move = getMove(slot.moveId);
    const signals: number[] = [];
    if (move.damageClass !== 'status' && move.power > 0) {
      const multiplier = typeMultiplier(move.type, defenderTypes);
      signals.push(multiplier === 0 ? -1 : clamp(Math.log2(multiplier) / 2 + move.power / 240, -.75, 1));
      if ((move.drain ?? 0) > 0) signals.push(missingHp);
    }
    if ((move.healing ?? 0) > 0 || move.id === 156) signals.push(missingHp > .05 ? missingHp : -.8);
    if (move.statChanges?.length) {
      const selfTarget = move.metaCategory === 8 || (move.metaCategory !== 7 && SELF_TARGETS.has(move.targetId ?? 10));
      const stages = selfTarget ? context.selfStatStages : context.otherStatStages;
      const useful = move.statChanges.map(change => {
        const key = ({ 'special-attack': 'specialAttack', 'special-defense': 'specialDefense' } as Record<string, string>)[change.stat] ?? change.stat;
        const stage = stages?.[key] ?? 0;
        return change.change > 0 ? (6 - stage) / 6 : (stage + 6) / 6;
      });
      signals.push(useful.reduce((sum, value) => sum + value, 0) / useful.length);
    }
    if (move.ailment && move.ailment !== 'none') {
      const targetSelf = SELF_TARGETS.has(move.targetId ?? 10), target = targetSelf ? self : other;
      const types = getSpecies(target.speciesId).types;
      signals.push(target.status || ailmentImmune(move.ailment, types) ? -.9 : .55);
    }
    if (!signals.length) signals.push(move.damageClass === 'status' ? -.35 : 0);
    // Keep the original full-use input scale for existing 12-column checkpoints.
    return clamp(.25 + signals.reduce((sum, value) => sum + value, 0) / signals.length * .75, -1, 1);
  }) as [number, number, number, number];
}

export class ConnectomeController {
  readonly graph: Graph;
  constructor(graph: Graph) {
    validateGraph(graph);
    if (graph.kind !== 'connectome-subset') throw new Error('게임은 실제 커넥톰 부분 회로가 필요합니다.');
    this.graph = structuredClone(graph);
  }
  static async load() {
    const response = await fetch('/data/connectome.json', { signal: AbortSignal.timeout(20_000) });
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
  observe(self: NeuralMonster, other: NeuralMonster, turn: number, context: BattleSenseContext = {}): number[] {
    const moveSense = battleMoveSenses(self, other, context);
    return [1, self.hp / self.stats.hp, other.hp / other.stats.hp,
      clamp((self.level - other.level) / 30, -1, 1), clamp((self.stats.speed - other.stats.speed) / 100, -1, 1),
      Math.min(turn / 50, 1), self.status ? 1 : 0, other.status ? 1 : 0,
      ...moveSense];
  }
  choose(self: NeuralMonster, other: NeuralMonster, turn: number, reward: number | null = null, learning = false, context: BattleSenseContext = {}): Decision {
    const brain = this.ensure(self);
    const rawAction = brain.act(this.observe(self, other, turn, context), reward, learning, learning ? .12 : 0, 4);
    const action = mapToAvailableMove(rawAction, context.automatic ? automatedMoveMask(self, other, turn, context) : availableMoveMask(self));
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
