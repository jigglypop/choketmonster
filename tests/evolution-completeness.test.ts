import { describe, expect, it } from 'vitest';
import { Brain } from '../src/core/brain';
import { EVOLUTION_CONDITION_NAMES, EVOLUTION_SOURCE_RULES } from '../src/data/evolution-rules';
import { getMove, getSpecies, POKEMON } from '../src/data/pokemon';
import {
  actBattle, createGame, createMonster, evolve, evolutionItemsFor, evolutionRoute,
  restoreGame, serializeGame, SHOP_ITEMS, statsFor, useItem, type GameState, type InventoryItem,
} from '../src/game/engine';
import {
  nativeEvolutionReady, naturalEvolution, needsSpecialEvolution, sourceEvolutionRules,
} from '../src/game/evolution-conditions';
import { evolutionProgress } from '../src/game/evolution-progress';

const evolutionEdges = POKEMON.flatMap(species => species.evolutions.map(evolution => ({ species, evolution })));

function ownedFixture(speciesId: number, level = 100): ReturnType<typeof createGame> {
  const game = createGame(1, `all-evolutions-${speciesId}`);
  const monster = createMonster(game, speciesId, level);
  game.player.team = [monster];
  game.player.money = 1_000_000_000;
  game.dex.seen = [...new Set([1, speciesId])].sort((a, b) => a - b);
  game.dex.caught = [...game.dex.seen];
  for (const item of Object.keys(game.inventory) as InventoryItem[]) game.inventory[item] = 1;
  return game;
}

function evolutionOf(from: number, to: number) {
  const evolution = getSpecies(from).evolutions.find(candidate => candidate.target === to);
  expect(evolution, `${from}>${to} must be authored`).toBeDefined();
  return evolution!;
}

describe('complete source-backed evolution reachability', () => {
  it('retains every source row, edge, and meaningful numeric-zero condition', () => {
    expect(EVOLUTION_SOURCE_RULES).toHaveLength(553);
    expect(new Set(EVOLUTION_SOURCE_RULES.map(rule => `${rule.from}>${rule.to}`)).size).toBe(483);
    expect(evolutionEdges).toHaveLength(483);
    expect(new Set(evolutionEdges.map(({ species, evolution }) => `${species.id}>${evolution.target}`)).size).toBe(483);
    expect(EVOLUTION_SOURCE_RULES.filter(rule => Object.values(rule.conditions).includes('0'))).toEqual([
      expect.objectContaining({ from: 236, to: 237, conditions: expect.objectContaining({ relative_physical_stats: '0' }) }),
    ]);
  });

  it('can execute and restore all 483 authored edges through a native, direct-item, or labelled fallback route', () => {
    for (const { species, evolution } of evolutionEdges) {
      const edge = `${species.id}>${evolution.target}`;
      const game = ownedFixture(species.id), monster = game.player.team[0];
      const fallback = needsSpecialEvolution(species.id, evolution) ? 'evolution-catalyst' : undefined;
      const route = evolutionRoute(game, monster, evolution, fallback);
      expect(route, `${edge} has no executable evolution route`).toBeDefined();
      if (!fallback && route?.item) expect(evolutionItemsFor(species.id, evolution), edge).toContain(route.item);
      const stockItem = route?.item;
      const stockBefore = stockItem ? game.inventory[stockItem] : undefined;
      const instanceId = monster.instanceId;
      const result = evolve(game, instanceId, { targetId: evolution.target, item: fallback });

      // The aggregate uses the capsule for Nincada>Shedinja, which is the direct-transform fallback.
      expect(result, edge).toBe(monster);
      expect(monster.speciesId, edge).toBe(evolution.target);
      expect(monster.instanceId, edge).toBe(instanceId);
      if (stockItem) expect(game.inventory[stockItem], edge).toBe(stockBefore! - 1);

      let restored: GameState;
      try { restored = restoreGame(serializeGame(game)); }
      catch (error) { throw new Error(`${edge} cannot be restored after evolution: ${(error as Error).message}`); }
      const restoredMonster = [...restored.player.team, ...restored.player.box].find(candidate => candidate.instanceId === instanceId);
      expect(restoredMonster?.speciesId, `${edge} save/restore`).toBe(evolution.target);
      if (stockItem) expect(restored.inventory[stockItem], `${edge} restored inventory`).toBe(stockBefore! - 1);
    }
  });

  it('keeps friendship values compatible but removes friendship evolution from play', () => {
    const game = ownedFixture(172, 20), monster = game.player.team[0], evolution = evolutionOf(172, 25);
    game.inventory['friendship-treat'] = 8;
    expect(naturalEvolution(game, monster, evolution)).toBeUndefined();
    useItem(game, 'friendship-treat', monster.instanceId, 8);
    expect(evolutionProgress(monster).friendship).toBeGreaterThanOrEqual(220);
    expect(naturalEvolution(game, monster, evolution)).toBeUndefined();
    expect(SHOP_ITEMS).not.toContain('friendship-treat');
    game.inventory['evolution-catalyst'] = 1;
    evolve(game, monster.instanceId, { targetId: 25, item: 'evolution-catalyst' });
    expect(monster.speciesId).toBe(25);
    expect(game.inventory['friendship-treat']).toBe(0); // legacy stock remains readable/consumable.
  });

  it('normalizes fixed-gender evolution species while preserving individual identity and brain', () => {
    const game = ownedFixture(281), kirlia = game.player.team[0], instanceId = kirlia.instanceId, brain = kirlia.brain;
    kirlia.gender = 'female'; evolutionProgress(kirlia).gender = 'female';
    game.inventory['evolution-catalyst'] = 1;
    evolve(game, instanceId, { targetId: 475, item: 'evolution-catalyst' });
    expect(kirlia).toMatchObject({ instanceId, speciesId: 475, gender: 'male' });
    expect(evolutionProgress(kirlia).gender).toBe('male');
    expect(kirlia.brain).toBe(brain);
    expect(restoreGame(serializeGame(game)).player.team[0]).toMatchObject({ instanceId, speciesId: 475, gender: 'male' });
  });

  it('enforces known move, gender, equal Tyrogue stats, party, and walking predicates', () => {
    const tangela = ownedFixture(114), tangelaMon = tangela.player.team[0], ancientPower = sourceEvolutionRules(114, 465)[0];
    tangelaMon.moves = tangelaMon.moves.filter(move => move.moveId !== 246);
    expect(nativeEvolutionReady(tangela, tangelaMon, ancientPower)).toBe(false);
    tangelaMon.moves = [{ moveId: 246, pp: getMove(246).pp }];
    expect(nativeEvolutionReady(tangela, tangelaMon, ancientPower)).toBe(true);

    const burmy = ownedFixture(412), burmyMon = burmy.player.team[0], female = sourceEvolutionRules(412, 413)[0];
    evolutionProgress(burmyMon).gender = 'male';
    expect(nativeEvolutionReady(burmy, burmyMon, female)).toBe(false);
    evolutionProgress(burmyMon).gender = 'female';
    expect(nativeEvolutionReady(burmy, burmyMon, female)).toBe(true);

    const tyrogue = ownedFixture(236), tyrogueMon = tyrogue.player.team[0], equal = sourceEvolutionRules(236, 237)[0];
    // Hitmontop's equal-stat fixture must also have equal individual values.
    tyrogueMon.ivs!.attack = tyrogueMon.ivs!.defense;
    tyrogueMon.stats = statsFor(getSpecies(236), tyrogueMon.level, tyrogueMon.ivs);
    expect(tyrogueMon.stats.attack).toBe(tyrogueMon.stats.defense);
    expect(nativeEvolutionReady(tyrogue, tyrogueMon, equal)).toBe(true);
    tyrogueMon.stats.attack++;
    expect(nativeEvolutionReady(tyrogue, tyrogueMon, equal)).toBe(false);

    const mantyke = ownedFixture(458), mantykeMon = mantyke.player.team[0], withRemoraid = sourceEvolutionRules(458, 226)[0];
    expect(nativeEvolutionReady(mantyke, mantykeMon, withRemoraid)).toBe(false);
    mantyke.player.team.push(createMonster(mantyke, 223, 20));
    expect(nativeEvolutionReady(mantyke, mantykeMon, withRemoraid)).toBe(true);

    const pawmo = ownedFixture(922), pawmoMon = pawmo.player.team[0], walked = sourceEvolutionRules(922, 923)[0];
    evolutionProgress(pawmoMon).steps = 999;
    expect(nativeEvolutionReady(pawmo, pawmoMon, walked)).toBe(false);
    evolutionProgress(pawmoMon).steps = 1000;
    expect(nativeEvolutionReady(pawmo, pawmoMon, walked)).toBe(true);
  });

  it('rejects non-default source forms and selects only a satisfied native alternative', () => {
    const sandshrew = ownedFixture(27), sandshrewMon = sandshrew.player.team[0];
    const alolanRule = sourceEvolutionRules(27, 28).find(rule => rule.conditions.base_form_id === '10101')!;
    expect(nativeEvolutionReady(sandshrew, sandshrewMon, alolanRule)).toBe(false);

    const rockruff = ownedFixture(744), rockruffMon = rockruff.player.team[0], lycanroc = evolutionOf(744, 745);
    rockruff.evolutionContext = { period: 'night', regionId: 'alola', locationId: 'route-1', raining: false, multiplayer: false };
    expect(naturalEvolution(rockruff, rockruffMon, lycanroc)).toBeUndefined();
    rockruff.evolutionContext.period = 'day';
    expect(naturalEvolution(rockruff, rockruffMon, lycanroc)?.conditions.time_of_day).toBe('day');

    const magneton = ownedFixture(82), magnetonMon = magneton.player.team[0];
    const coronetRule = sourceEvolutionRules(82, 462).find(rule => rule.conditions.location_id === '10')!;
    expect(EVOLUTION_CONDITION_NAMES.location_id['10']).toBe('mt-coronet');
    magneton.evolutionContext = { period: 'day', regionId: 'sinnoh', locationId: 'mt-coronet', raining: false, multiplayer: false };
    expect(nativeEvolutionReady(magneton, magnetonMon, coronetRule)).toBe(true);
  });

  it('applies native Shedinja as a second individual while the fallback directly transforms Nincada', () => {
    const native = ownedFixture(290, 20), nincada = native.player.team[0], shell = evolutionOf(290, 292);
    native.inventory['poke-ball'] = 1;
    expect(evolutionRoute(native, nincada, shell)).toEqual({ shed: true });
    const shedinja = evolve(native, nincada.instanceId, { targetId: 292 });
    expect(nincada.speciesId).toBe(291);
    expect(shedinja).not.toBe(nincada);
    expect(shedinja.speciesId).toBe(292);
    expect(native.player.team).toHaveLength(2);
    expect(native.inventory['poke-ball']).toBe(1);

    const fallback = ownedFixture(290, 20), direct = fallback.player.team[0];
    fallback.inventory['evolution-catalyst'] = 1;
    expect(evolve(fallback, direct.instanceId, { targetId: 292, item: 'evolution-catalyst' })).toBe(direct);
    expect(direct.speciesId).toBe(292);
    expect(fallback.player.team).toHaveLength(1);
    expect(fallback.inventory['evolution-catalyst']).toBe(0);
  });

  it('applies the native Nincada evolution from the box without replacing its identity or memory', () => {
    const game = ownedFixture(290, 20), nincada = game.player.team[0];
    const partner = createMonster(game, 1, 5), memory = new Brain(290).state;
    nincada.brain = memory;
    const instanceId = nincada.instanceId, ivs = nincada.ivs, abilitySlot = nincada.ability && { slot: nincada.ability.slot, hidden: nincada.ability.hidden };
    game.player.team = [partner]; game.player.box = [nincada]; game.inventory['poke-ball'] = 1;
    const shell = evolutionOf(290, 292);

    expect(evolutionRoute(game, nincada, shell)).toEqual({ shed: true });
    const shedinja = evolve(game, instanceId, { targetId: 292 });

    expect(game.player.box[0]).toBe(nincada);
    expect(nincada).toMatchObject({ instanceId, speciesId: 291 });
    expect(nincada.brain).toBe(memory); expect(nincada.ivs).toBe(ivs); expect(nincada.ability).toMatchObject(abilitySlot!);
    expect(game.player.team).toEqual([partner, shedinja]);
    expect(shedinja.speciesId).toBe(292); expect(game.inventory['poke-ball']).toBe(1);
    const restored = restoreGame(serializeGame(game));
    expect(restored.player.box[0]).toMatchObject({ instanceId, speciesId: 291, brain: memory });
    expect(restored.player.team[1].speciesId).toBe(292);
  });

  it('evolves a non-participating box individual during battle without changing the battle roster', () => {
    const game = createGame(1, 'boxed-evolution-during-battle');
    const boxed = createMonster(game, 1, 16), enemy = createMonster(game, 10, 2);
    boxed.brain = new Brain(1).state;
    game.player.box = [boxed]; game.dex.seen = [1, 10]; game.dex.caught = [1];
    enemy.hp = 1; enemy.status = 'sleep'; enemy.statusTurns = 3;
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
    const battlePartnerId = game.battle.player.team[0].instanceId, instanceId = boxed.instanceId, memory = boxed.brain;

    expect(() => evolve(game, game.player.team[0].instanceId, { targetId: 2 })).toThrow();
    expect(evolutionRoute(game, boxed, evolutionOf(1, 2))).toEqual({});
    evolve(game, instanceId, { targetId: 2 });
    expect(boxed).toMatchObject({ instanceId, speciesId: 2 }); expect(boxed.brain).toBe(memory);
    expect(game.battle.player.team.map(monster => monster.instanceId)).toEqual([battlePartnerId]);

    expect(actBattle(game, { type: 'move', index: 0 }, 4).outcome).toBe('won');
    expect(game.player.box[0]).toMatchObject({ instanceId, speciesId: 2, brain: memory });
    expect(restoreGame(serializeGame(game)).player.box[0]).toMatchObject({ instanceId, speciesId: 2, brain: memory });
  });

  it('keeps missing growth profiles migratable and invalid inventory or battle attempts atomic', () => {
    const legacy = ownedFixture(172, 20), legacyJson = JSON.parse(serializeGame(legacy)) as GameState;
    delete legacyJson.player.team[0].evolutionProgress;
    const restored = restoreGame(JSON.stringify(legacyJson));
    expect(evolutionProgress(restored.player.team[0])).toMatchObject({ steps: 0, moveUses: {} });

    const wrong = ownedFixture(95), onix = wrong.player.team[0], steelix = evolutionOf(95, 208);
    wrong.inventory['metal-coat'] = 0; wrong.inventory['link-cable'] = 1;
    const beforeWrong = serializeGame(wrong);
    expect(() => evolve(wrong, onix.instanceId, { targetId: 208, item: 'link-cable' })).toThrow();
    expect(serializeGame(wrong)).toBe(beforeWrong);
    expect(evolutionRoute(wrong, onix, steelix, 'link-cable')).toBeUndefined();

    wrong.inventory['metal-coat'] = 1;
    wrong.battle = { kind: 'wild', regionId: wrong.regionId, player: { team: wrong.player.team, activeIndex: 0 },
      enemy: { team: [createMonster(wrong, 19, 5)], activeIndex: 0 }, turn: 1, canRun: true };
    const beforeBattle = serializeGame(wrong);
    expect(() => evolve(wrong, onix.instanceId, { targetId: 208, item: 'metal-coat' })).toThrow();
    expect(serializeGame(wrong)).toBe(beforeBattle);
  });
});
