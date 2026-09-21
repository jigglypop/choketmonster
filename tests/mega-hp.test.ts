import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { getMove, getSpecies } from '../src/data/pokemon';
import { actBattle, activateBattleTransformation, assignPreferredTransformation, battleMonsterMaxHp, battleMonsterView, createGame, createMonster, experienceAtLevel, restoreGame, serializeGame, useItem } from '../src/game/engine';
import { OpenWorldSimulation } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const forms = [[670, 'floette-mega'], [718, 'zygarde-mega']] as const;
function setup(speciesId: number, formIdentifier: string, level = 50) {
  const game = createGame(1, `mega-hp-${speciesId}`), monster = createMonster(game, speciesId, level), enemy = createMonster(game, 143, 100);
  monster.moves = [{ moveId: 851, pp: getMove(851).pp }];
  game.player.team = [monster]; game.dex.seen = [...new Set([1, speciesId, 143])].sort((a, b) => a - b); game.dex.caught = [1, speciesId];
  game.inventory[`mega-stone:${formIdentifier}`] = 1;
  assignPreferredTransformation(game, monster.instanceId, { kind: 'mega', formIdentifier });
  game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
  return { game, monster, enemy, activate: () => activateBattleTransformation(game, 'mega', { formIdentifier }) };
}

describe('Mega HP units and persistence', () => {
  it.each(forms)('%s starts at full form HP and preserves damage through reload and switching', (speciesId, identifier) => {
    const { game, monster, activate } = setup(speciesId, identifier), base = structuredClone(monster.stats);
    const form = activate();
    expect(form.stats.hp).toBeGreaterThan(base.hp);
    expect(monster.hp).toBe(form.stats.hp);
    expect(monster.stats).toEqual(base);
    expect(battleMonsterView(game.battle!, monster).hp).toBe(form.stats.hp);
    monster.hp -= 12;
    const loaded = restoreGame(serializeGame(game)), saved = loaded.player.team[0];
    expect(saved.hp).toBe(form.stats.hp - 12);
    const reserve = createMonster(loaded, 25, 50); loaded.player.team.push(reserve);
    actBattle(loaded, { type: 'switch', index: 1 }, 4);
    actBattle(loaded, { type: 'switch', index: 0 }, 4);
    expect(saved.hp).toBe(form.stats.hp - 12);
    expect(saved.stats).toEqual(base);
  });

  it.each(forms)('%s migrates a legacy Mega once, without changing canonical base stats', (speciesId, identifier) => {
    const { game, monster, activate } = setup(speciesId, identifier), baseHp = monster.stats.hp;
    const form = activate();
    monster.hp = Math.floor(baseHp / 2); delete form.hpAdjusted;
    const loaded = restoreGame(serializeGame(game)), expected = Math.ceil(monster.hp * form.stats.hp / baseHp);
    expect(loaded.player.team[0].hp).toBe(expected);
    expect(loaded.battle!.transformations![monster.instanceId].hpAdjusted).toBe(true);
    expect(restoreGame(serializeGame(loaded)).player.team[0].hp).toBe(expected);
  });

  it('uses form HP for items, Rest, leftovers, poison and Life Orb', () => {
    const { game, monster, activate } = setup(718, 'zygarde-mega'), max = activate().stats.hp;
    monster.hp = max - 70; game.inventory['super-potion'] = 1;
    expect(monster.hp).toBeGreaterThan(monster.stats.hp);
    useItem(game, 'super-potion', monster.instanceId);
    expect(monster.hp).toBe(max - 10);
    monster.moves = [{ moveId: 156, pp: getMove(156).pp }]; game.battle!.transformations![monster.instanceId].moves = structuredClone(monster.moves);
    const rest = actBattle(game, { type: 'move', index: 0 }, 4);
    expect(monster.hp).toBe(max); expect(rest.executedMoves[0].hpRecovered).toBe(10);
    delete monster.status; delete monster.statusTurns;
    monster.heldTool = 'leftovers'; monster.hp = max - 50;
    actBattle(game, { type: 'wait' }, 4); expect(monster.hp).toBe(max - 50 + Math.floor(max / 16));
    delete monster.heldTool; monster.status = 'poison'; const beforePoison = monster.hp;
    actBattle(game, { type: 'wait' }, 4); expect(monster.hp).toBe(beforePoison - Math.floor(max / 8));
    delete monster.status; monster.heldTool = 'life-orb'; monster.hp = max;
    monster.moves = [{ moveId: 851, pp: getMove(851).pp }]; game.battle!.transformations![monster.instanceId].moves = structuredClone(monster.moves);
    actBattle(game, { type: 'move', index: 0 }, 4); expect(monster.hp).toBe(max - Math.floor(max / 10));
  });

  it('updates Mega HP on level-up, then reverts proportionally after victory', () => {
    const { game, monster, enemy, activate } = setup(718, 'zygarde-mega'), beforeMax = activate().stats.hp;
    monster.xp = experienceAtLevel(51, getSpecies(718).growthRate) - 1;
    monster.hp = beforeMax - 12; enemy.hp = 1;
    const result = actBattle(game, { type: 'move', index: 0 }, 4);
    expect(result.outcome).toBe('won'); expect(game.battle).toBeUndefined(); expect(monster.level).toBeGreaterThan(50);
    const ending = result.endingHp![monster.instanceId];
    expect(ending.maxHp).toBeGreaterThan(beforeMax); expect(ending.hp).toBe(ending.maxHp - 12);
    expect(monster.hp).toBe(Math.floor(ending.hp * monster.stats.hp / ending.maxHp));
    expect(() => restoreGame(serializeGame(game))).not.toThrow();
  });

  it('does not gain health from repeated entry/escape and heals a defeated team in base units', () => {
    const { game, monster, activate } = setup(670, 'floette-mega');
    monster.hp = Math.floor(monster.stats.hp / 2); const before = monster.hp;
    activate(); game.rngState = 1;
    // Search a deterministic successful escape without applying failed attempts to the original.
    let escaped = false;
    for (let seed = 1; seed < 50; seed++) {
      const loaded = restoreGame(serializeGame(game)); loaded.rngState = seed;
      const result = actBattle(loaded, { type: 'run' }, 4);
      if (result.outcome === 'escaped') { expect(loaded.player.team[0].hp).toBe(before); escaped = true; break; }
    }
    expect(escaped).toBe(true);
    monster.hp = 0;
    const result = actBattle(game, { type: 'wait' }, 4);
    expect(result.outcome).toBe('lost'); expect(result.endingHp![monster.instanceId].hp).toBe(0);
    expect(monster.hp).toBe(monster.stats.hp);
  });

  it('returns to base HP after capture without losing the configured form', () => {
    const { game, monster, enemy, activate } = setup(718, 'zygarde-mega');
    monster.hp -= 25; const originalHp = monster.hp;
    activate(); enemy.hp = 1; game.rngState = 1;
    const result = actBattle(game, { type: 'catch', ball: 'poke-ball' }, 4);
    expect(result.outcome).toBe('caught'); expect(game.battle).toBeUndefined();
    expect(monster.hp).toBe(originalHp);
    expect(monster.preferredTransformation).toEqual({ kind: 'mega', formIdentifier: 'zygarde-mega' });
    expect(() => restoreGame(serializeGame(game))).not.toThrow();
  });

  it('rejects HP inflation, wrong markers and boxed transformation references', () => {
    const { game, monster, activate } = setup(718, 'zygarde-mega'), form = activate();
    for (const mutate of [
      (copy: typeof game) => { copy.player.team[0].hp = form.stats.hp + 1; },
      (copy: typeof game) => { (copy.battle!.transformations![monster.instanceId] as any).hpAdjusted = false; },
      (copy: typeof game) => { const lead = copy.player.team.pop()!; copy.player.box.push(lead); copy.player.team.push(createMonster(copy, 1, 5)); },
    ]) { const copy = structuredClone(game); mutate(copy); expect(() => restoreGame(serializeGame(copy))).toThrow(); }
  });

  it('keeps winning reward HP in battle units after form reversion', () => {
    const { game, monster, enemy, activate } = setup(718, 'zygarde-mega');
    activate(); monster.hp -= 30; enemy.hp = 1; enemy.moves = [];
    const world = new OpenWorldSimulation(graph, game, 7019); world.setControlMode('manual'); world.setAutoHunt(false);
    world.battleWildId = world.entities.find(entity => entity.kind === 'wild')!.id;
    expect(world.requestAction({ type: 'move', index: 0 })).toBe(true);
    const event = world.step({ deltaSeconds: 1 }).events.find(entry => entry.type === 'battle-turn');
    expect(event?.type === 'battle-turn' && event.result.outcome).toBe('won');
    expect(world.rewardLedgers[monster.instanceId].latest.at(-1)?.breakdown.damageReceived).toBe(0);
    expect(battleMonsterMaxHp(game.battle, monster)).toBe(monster.stats.hp);
  });
});
