import { clamp } from '../core/random';
import type { PokemonType } from './contracts';
import { typeMultiplier } from './battle';

export type RewardDecisionSource = 'connectome' | 'manual' | 'fallback';
export type RewardOutcome = 'won' | 'lost' | 'caught' | 'escaped';

export type RewardBreakdown = {
  engagement: number;
  damageDealt: number;
  damageReceived: number;
  typeChoice: number;
  outcome: number;
  growth: number;
  evolution: number;
};

export type EngineeredReward = {
  individualId: string;
  total: number;
  learningEligible: boolean;
  /** Game-designed components. This is not a biological dopamine measurement. */
  breakdown: RewardBreakdown;
};

type RewardCredit = {
  individualId: string;
  decisionSource: RewardDecisionSource;
  learningEnabled: boolean;
};

export type EncounterRewardInput = RewardCredit & {
  /** True only on the single movement transition that starts an encounter. */
  movementLedToEncounter: boolean;
};

export type BattleTurnRewardInput = RewardCredit & {
  selfHpBefore: number;
  selfHpAfter: number;
  selfMaxHp: number;
  opponentHpBefore: number;
  opponentHpAfter: number;
  opponentMaxHp: number;
  /** Resolved type of the damaging move chosen for this turn. Omit for non-move actions. */
  chosenAttackType?: PokemonType;
  defenderTypes?: readonly PokemonType[];
  /** Actual matchup recorded by the engine, including transformations during the turn. */
  typeEffectiveness?: number;
  damagingMove?: boolean;
  /** False when the actor fainted, was fully prevented, or otherwise did not execute the move. */
  actionExecuted?: boolean;
  /** True only when the executed move reached its target; misses receive no type credit. */
  attackHit?: boolean;
  outcome?: RewardOutcome;
  levelsGained?: number;
  evolved?: boolean;
};

const ZERO: RewardBreakdown = {
  engagement: 0,
  damageDealt: 0,
  damageReceived: 0,
  typeChoice: 0,
  outcome: 0,
  growth: 0,
  evolution: 0,
};

function credit(input: RewardCredit, breakdown: RewardBreakdown): EngineeredReward {
  if (!input.individualId) throw new Error('Reward needs an individual ID');
  const values = Object.values(breakdown);
  if (!values.every(Number.isFinite)) throw new Error('Reward components must be finite');
  return {
    individualId: input.individualId,
    total: clamp(values.reduce((sum, value) => sum + value, 0), -2, 2),
    learningEligible: input.learningEnabled && input.decisionSource === 'connectome',
    breakdown,
  };
}

function normalizedLoss(before: number, after: number, maximum: number): number {
  if (![before, after, maximum].every(Number.isFinite) || maximum <= 0 || before < 0 || after < 0 || before > maximum || after > maximum) {
    throw new Error('Reward HP values are invalid');
  }
  return clamp((before - after) / maximum, 0, 1);
}

/** One-shot participation credit. Repeated wait/tick calls return zero. */
export function rewardEncounter(input: EncounterRewardInput): EngineeredReward {
  return credit(input, { ...ZERO, engagement: input.movementLedToEncounter ? 0.12 : 0 });
}

/**
 * Bounded, event-based game reward for one resolved battle turn.
 * Callers must only feed the result into Brain when learningEligible is true.
 */
export function rewardBattleTurn(input: BattleTurnRewardInput): EngineeredReward {
  if (input.levelsGained !== undefined && (!Number.isInteger(input.levelsGained) || input.levelsGained < 0)) {
    throw new Error('Levels gained must be a non-negative integer');
  }
  const dealt = normalizedLoss(input.opponentHpBefore, input.opponentHpAfter, input.opponentMaxHp);
  const received = normalizedLoss(input.selfHpBefore, input.selfHpAfter, input.selfMaxHp);
  let typeChoice = 0;
  if (input.damagingMove && input.actionExecuted && input.attackHit && input.chosenAttackType && input.defenderTypes?.length) {
    const multiplier = input.typeEffectiveness ?? typeMultiplier(input.chosenAttackType, input.defenderTypes);
    if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 4) throw new Error('Invalid executed move matchup');
    typeChoice = multiplier > 1 ? 0.18 : multiplier < 1 ? -0.12 : 0;
  }
  const outcome = input.outcome === 'won' ? 1 : input.outcome === 'lost' ? -0.8 : 0;
  return credit(input, {
    ...ZERO,
    damageDealt: dealt * 0.9,
    damageReceived: received ? received * -0.75 : 0,
    typeChoice,
    outcome,
    growth: Math.min(input.levelsGained ?? 0, 2) * 0.25,
    evolution: input.evolved ? 0.45 : 0,
  });
}

export const REWARD_MODEL = 'kanto-engineered-reward-v1' as const;
export type RewardEvent = 'engagement' | 'battle';
export type RewardComponentCounts = Record<keyof RewardBreakdown, number>;
export type RewardLedgerEntry = {
  event: RewardEvent;
  tick: number;
  source: RewardDecisionSource;
  learningEligible: boolean;
  total: number;
  breakdown: RewardBreakdown;
};
export type RewardLedger = {
  rewardModel: typeof REWARD_MODEL;
  individualId: string;
  latest: RewardLedgerEntry[];
  lifetime: {
    events: number;
    eventCounts: Record<RewardEvent, number>;
    total: number;
    componentTotals: RewardBreakdown;
    componentCounts: RewardComponentCounts;
  };
};

const COMPONENTS = Object.keys(ZERO) as Array<keyof RewardBreakdown>;
const emptyComponentCounts = (): RewardComponentCounts => ({
  engagement: 0, damageDealt: 0, damageReceived: 0, typeChoice: 0,
  outcome: 0, growth: 0, evolution: 0,
});

export function emptyRewardLedger(individualId: string): RewardLedger {
  if (!individualId || individualId.length > 200) throw new Error('Reward ledger needs a valid individual ID');
  return {
    rewardModel: REWARD_MODEL,
    individualId,
    latest: [],
    lifetime: {
      events: 0,
      eventCounts: { engagement: 0, battle: 0 },
      total: 0,
      componentTotals: { ...ZERO },
      componentCounts: emptyComponentCounts(),
    },
  };
}

/** Graph-free, JSON-safe immutable append. The latest window is limited to 32 entries. */
export function appendReward(ledger: RewardLedger, context: { event: RewardEvent; tick: number; source: RewardDecisionSource }, reward: EngineeredReward): RewardLedger {
  validateRewardLedger(ledger);
  if (reward.individualId !== ledger.individualId) throw new Error('Reward belongs to a different individual');
  if (!Number.isSafeInteger(context.tick) || context.tick < 0 || !['engagement', 'battle'].includes(context.event) || !['connectome', 'manual', 'fallback'].includes(context.source)) throw new Error('Reward append context is invalid');
  if (reward.learningEligible && context.source !== 'connectome') throw new Error('Only connectome decisions can be learning eligible');
  const entry: RewardLedgerEntry = {
    event: context.event, tick: context.tick, source: context.source,
    learningEligible: reward.learningEligible, total: reward.total, breakdown: { ...reward.breakdown },
  };
  const componentTotals = { ...ledger.lifetime.componentTotals };
  const componentCounts = { ...ledger.lifetime.componentCounts };
  for (const component of COMPONENTS) {
    componentTotals[component] = clamp(componentTotals[component] + reward.breakdown[component], -1e9, 1e9);
    if (reward.breakdown[component] !== 0) componentCounts[component] = Math.min(1e9, componentCounts[component] + 1);
  }
  return {
    rewardModel: REWARD_MODEL,
    individualId: ledger.individualId,
    latest: [...ledger.latest, entry].slice(-32),
    lifetime: {
      events: ledger.lifetime.events + 1,
      eventCounts: { ...ledger.lifetime.eventCounts, [context.event]: Math.min(1e9, ledger.lifetime.eventCounts[context.event] + 1) },
      total: clamp(ledger.lifetime.total + reward.total, -1e9, 1e9),
      componentTotals,
      componentCounts,
    },
  };
}

export function validateRewardLedger(value: unknown): asserts value is RewardLedger {
  const ledger = value as RewardLedger;
  const finiteBounded = (number: unknown, bound: number) => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= bound;
  const count = (number: unknown, maximum = 1e9) => Number.isSafeInteger(number) && (number as number) >= 0 && (number as number) <= maximum;
  const breakdown = (item: unknown, bound: number) => !!item && typeof item === 'object' && COMPONENTS.every(component => finiteBounded((item as RewardBreakdown)[component], bound));
  if (!ledger || ledger.rewardModel !== REWARD_MODEL || typeof ledger.individualId !== 'string' || !ledger.individualId || ledger.individualId.length > 200 || !Array.isArray(ledger.latest) || ledger.latest.length > 32) throw new Error('Invalid reward ledger');
  if (!ledger.lifetime || !count(ledger.lifetime.events, 2e9) || !ledger.lifetime.eventCounts || !count(ledger.lifetime.eventCounts.engagement) || !count(ledger.lifetime.eventCounts.battle) || ledger.lifetime.eventCounts.engagement + ledger.lifetime.eventCounts.battle !== ledger.lifetime.events || !finiteBounded(ledger.lifetime.total, 1e9) || !breakdown(ledger.lifetime.componentTotals, 1e9) || !ledger.lifetime.componentCounts || !COMPONENTS.every(component => count(ledger.lifetime.componentCounts[component]))) throw new Error('Invalid reward ledger lifetime');
  for (const entry of ledger.latest) {
    if (!entry || !['engagement', 'battle'].includes(entry.event) || !Number.isSafeInteger(entry.tick) || entry.tick < 0 || !['connectome', 'manual', 'fallback'].includes(entry.source) || typeof entry.learningEligible !== 'boolean' || (entry.learningEligible && entry.source !== 'connectome') || !finiteBounded(entry.total, 2) || !breakdown(entry.breakdown, 2) || Math.abs(clamp(COMPONENTS.reduce((sum, component) => sum + entry.breakdown[component], 0), -2, 2) - entry.total) > 1e-9) throw new Error('Invalid reward ledger entry');
  }
}
