import { describe, expect, it } from 'vitest';
import { appendReward, emptyRewardLedger, rewardBattleTurn, rewardEncounter, validateRewardLedger } from '../src/game/rewards';

const credit = { individualId: 'pokemon-7', decisionSource: 'connectome' as const, learningEnabled: true };

describe('engineered Kanto rewards', () => {
  it('credits only the movement transition that starts an encounter', () => {
    expect(rewardEncounter({ ...credit, movementLedToEncounter: true }).total).toBe(0.12);
    expect(rewardEncounter({ ...credit, movementLedToEncounter: false }).total).toBe(0);
  });

  it('uses the executed attack type rather than the attacker species type', () => {
    const base = {
      ...credit,
      selfHpBefore: 80, selfHpAfter: 80, selfMaxHp: 100,
      opponentHpBefore: 80, opponentHpAfter: 60, opponentMaxHp: 100,
      defenderTypes: ['grass'] as const,
      damagingMove: true, actionExecuted: true, attackHit: true,
    };
    const fire = rewardBattleTurn({ ...base, chosenAttackType: 'fire' });
    const water = rewardBattleTurn({ ...base, chosenAttackType: 'water' });
    expect(fire.breakdown.typeChoice).toBe(0.18);
    expect(water.breakdown.typeChoice).toBe(-0.12);
    expect(fire.total - water.total).toBeCloseTo(0.3);
  });

  it('does not reward a type choice when the move was not executed', () => {
    const result = rewardBattleTurn({
      ...credit,
      selfHpBefore: 50, selfHpAfter: 50, selfMaxHp: 100,
      opponentHpBefore: 50, opponentHpAfter: 50, opponentMaxHp: 100,
      chosenAttackType: 'electric', defenderTypes: ['water'], damagingMove: true, actionExecuted: false, attackHit: false,
    });
    expect(result.total).toBe(0);
  });

  it('credits useful recovery, buffs, and ailments while penalizing a resolved no-effect status move', () => {
    const base = { ...credit, selfHpBefore: 40, selfHpAfter: 70, selfMaxHp: 100, opponentHpBefore: 100, opponentHpAfter: 100, opponentMaxHp: 100, actionExecuted: true, attackHit: true };
    expect(rewardBattleTurn({ ...base, moveCategory: 'healing', hpRecovered: 30, strategicEffect: true }).breakdown.moveEffect).toBeCloseTo(.195);
    expect(rewardBattleTurn({ ...base, selfHpAfter: 40, moveCategory: 'buff', statStageDelta: 2, strategicEffect: true }).breakdown.moveEffect).toBe(.16);
    expect(rewardBattleTurn({ ...base, selfHpAfter: 40, moveCategory: 'status', ailmentApplied: true, strategicEffect: true }).breakdown.moveEffect).toBe(.18);
    expect(rewardBattleTurn({ ...base, selfHpAfter: 40, moveCategory: 'status', strategicEffect: false }).breakdown.moveEffect).toBe(-.12);
  });

  it('combines normalized HP, victory, level and evolution events within bounds', () => {
    const result = rewardBattleTurn({
      ...credit,
      selfHpBefore: 100, selfHpAfter: 75, selfMaxHp: 100,
      opponentHpBefore: 200, opponentHpAfter: 0, opponentMaxHp: 200,
      chosenAttackType: 'fire', defenderTypes: ['grass'], damagingMove: true, actionExecuted: true, attackHit: true,
      outcome: 'won', levelsGained: 3, evolved: true,
    });
    expect(result.breakdown.damageDealt).toBe(0.9);
    expect(result.breakdown.damageReceived).toBe(-0.1875);
    expect(result.breakdown.growth).toBe(0.5);
    expect(result.total).toBe(2);
  });

  it('exposes reward for metrics but blocks learning for evaluation and manual choices', () => {
    const turn = {
      selfHpBefore: 10, selfHpAfter: 10, selfMaxHp: 10,
      opponentHpBefore: 10, opponentHpAfter: 0, opponentMaxHp: 10,
      outcome: 'won' as const,
    };
    expect(rewardBattleTurn({ ...credit, ...turn, learningEnabled: false }).learningEligible).toBe(false);
    expect(rewardBattleTurn({ ...credit, ...turn, decisionSource: 'manual' }).learningEligible).toBe(false);
    expect(rewardBattleTurn({ ...credit, ...turn }).learningEligible).toBe(true);
  });

  it('gives an idle turn no farmable baseline reward and rejects invalid HP', () => {
    expect(rewardBattleTurn({
      ...credit,
      selfHpBefore: 30, selfHpAfter: 30, selfMaxHp: 30,
      opponentHpBefore: 40, opponentHpAfter: 40, opponentMaxHp: 40,
    }).total).toBe(0);
    expect(() => rewardBattleTurn({
      ...credit,
      selfHpBefore: 31, selfHpAfter: 30, selfMaxHp: 30,
      opponentHpBefore: 40, opponentHpAfter: 40, opponentMaxHp: 40,
    })).toThrow('Reward HP values are invalid');
  });

  it('keeps immutable graph-free histories bounded to the latest 32 entries', () => {
    const initial = emptyRewardLedger('pokemon-7');
    const initialJson = JSON.stringify(initial);
    let ledger = initial;
    const reward = rewardEncounter({ ...credit, movementLedToEncounter: true });
    for (let tick = 0; tick < 40; tick++) ledger = appendReward(ledger, { event: 'engagement', tick, source: 'connectome' }, reward);
    expect(JSON.stringify(initial)).toBe(initialJson);
    expect(ledger.latest).toHaveLength(32);
    expect(ledger.latest[0].tick).toBe(8);
    expect(ledger.lifetime.events).toBe(40);
    expect(ledger.lifetime.eventCounts.engagement).toBe(40);
    expect(ledger.lifetime.componentTotals.engagement).toBeCloseTo(4.8);
    expect(ledger.lifetime.componentCounts.engagement).toBe(40);
    expect(JSON.stringify(ledger)).not.toContain('graph');
    validateRewardLedger(JSON.parse(JSON.stringify(ledger)));
  });

  it('rejects cross-individual and malformed saved ledgers', () => {
    const ledger = emptyRewardLedger('pokemon-7');
    const other = rewardEncounter({ ...credit, individualId: 'pokemon-8', movementLedToEncounter: true });
    expect(() => appendReward(ledger, { event: 'engagement', tick: 1, source: 'connectome' }, other)).toThrow('different individual');
    expect(() => appendReward(ledger, { event: 'engagement', tick: 1, source: 'manual' }, rewardEncounter({ ...credit, movementLedToEncounter: true }))).toThrow('Only connectome');
    expect(() => validateRewardLedger({ ...ledger, latest: Array(33).fill({}) })).toThrow('Invalid reward ledger');
    expect(() => validateRewardLedger({ ...ledger, lifetime: { ...ledger.lifetime, total: Number.NaN } })).toThrow('Invalid reward ledger lifetime');
  });

  it('migrates pre-move-effect reward ledgers with a zero component', () => {
    const legacy = structuredClone(emptyRewardLedger('legacy')) as unknown as { lifetime: { componentTotals: Record<string, number>; componentCounts: Record<string, number> }; latest: Array<{ breakdown: Record<string, number> }> };
    delete legacy.lifetime.componentTotals.moveEffect; delete legacy.lifetime.componentCounts.moveEffect;
    validateRewardLedger(legacy);
    expect(legacy.lifetime.componentTotals.moveEffect).toBe(0);
    expect(legacy.lifetime.componentCounts.moveEffect).toBe(0);
  });
});
