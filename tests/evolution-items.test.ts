import { describe, expect, it } from 'vitest';
import { Brain } from '../src/core/brain';
import { getSpecies } from '../src/data/pokemon';
import { availableEvolutions, buyItem, createGame, createMonster, evolve, evolutionItemUses, ITEM_PRICES, restoreGame, serializeGame, validateGame } from '../src/game/engine';
import { EXTRA_EVOLUTION_ITEM_IDS, ITEM_EVOLUTION_RULES } from '../src/game/evolution-items';

function fixture(speciesId: number) {
  const game = createGame(152, `item-evolution-${speciesId}`), mon = createMonster(game, speciesId, 25);
  game.player.team = [mon]; game.player.money = 100_000;
  game.dex.caught = [...new Set([152, speciesId])].sort((a, b) => a - b); game.dex.seen = [...game.dex.caught];
  mon.brain = new Brain(speciesId).snapshot();
  return { game, mon };
}

describe('purchasable evolution tools', () => {
  it.each(ITEM_EVOLUTION_RULES)('$from evolves to $to with one $item while keeping individual memory', ({ from, to, item }) => {
    const { game, mon } = fixture(from), memory = mon.brain, xp = mon.xp, instanceId = mon.instanceId;
    const serializedMemory = structuredClone(memory);
    expect(availableEvolutions(game, instanceId).some(evolution => evolution.target === to)).toBe(false);
    buyItem(game, item);
    expect(game.player.money).toBe(100_000 - ITEM_PRICES[item]);
    expect(evolutionItemUses(item)).toContain(getSpecies(to).name);
    const evolved = evolve(game, instanceId, { targetId: to, item });
    expect(evolved).toBe(mon); expect(mon.speciesId).toBe(to); expect(mon.instanceId).toBe(instanceId);
    expect(mon.xp).toBe(xp); expect(mon.brain).toBe(memory); expect(mon.brain).toEqual(serializedMemory);
    expect(game.inventory[item]).toBe(0); expect(game.dex.caught).toContain(to);
    expect(() => validateGame(game)).not.toThrow();
    const restored = restoreGame(serializeGame(game));
    expect(restored.player.team[0]).toMatchObject({ speciesId: to, instanceId, brain: serializedMemory });
    expect(restored.inventory[item]).toBe(0);
  });

  it.each([[44,182,'sun-stone'],[176,468,'shiny-stone'],[198,430,'dusk-stone'],[133,471,'ice-stone']] as const)
  ('uses the source stone rule for %i → %i', (from, to, item) => {
    const { game, mon } = fixture(from); buyItem(game, item); evolve(game, mon.instanceId, { targetId: to });
    expect(mon.speciesId).toBe(to); expect(game.inventory[item]).toBe(0);
  });

  it('rejects missing stock, the wrong item, and battle use without consuming anything', () => {
    const { game, mon } = fixture(95), before = serializeGame(game);
    expect(() => evolve(game, mon.instanceId, { targetId: 208 })).toThrow(); expect(serializeGame(game)).toBe(before);
    buyItem(game, 'link-cable'); buyItem(game, 'metal-coat');
    const bought = serializeGame(game);
    expect(() => evolve(game, mon.instanceId, { targetId: 208, item: 'link-cable' })).toThrow(); expect(serializeGame(game)).toBe(bought);
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [createMonster(game, 19, 5)], activeIndex: 0 }, turn: 1, canRun: true };
    expect(() => evolve(game, mon.instanceId, { targetId: 208 })).toThrow(/전투 중/);
    expect(game.inventory['metal-coat']).toBe(1); expect(mon.speciesId).toBe(95);
  });

  it('consumes only the selected branch item and leaves unsupported special forms locked', () => {
    const { game, mon } = fixture(366); buyItem(game, 'deep-sea-tooth'); buyItem(game, 'deep-sea-scale');
    evolve(game, mon.instanceId, { targetId: 368 });
    expect(game.inventory['deep-sea-scale']).toBe(0); expect(game.inventory['deep-sea-tooth']).toBe(1);
    const sneasel = fixture(215); buyItem(sneasel.game, 'razor-claw');
    expect(availableEvolutions(sneasel.game, sneasel.mon.instanceId).map(evolution => evolution.target)).toEqual([461, 903]);
  });

  it('restores old 12-item inventories and preserves new purchases across saves', () => {
    const { game } = fixture(95), old = JSON.parse(serializeGame(game));
    for (const id of EXTRA_EVOLUTION_ITEM_IDS) delete old.inventory[id];
    const restored = restoreGame(JSON.stringify(old));
    for (const id of EXTRA_EVOLUTION_ITEM_IDS) expect(restored.inventory[id]).toBe(0);
    buyItem(restored, 'metal-coat', 2);
    expect(restoreGame(serializeGame(restored)).inventory['metal-coat']).toBe(2);
    for (const bad of [-1, null, .5, 1_000_000_001]) {
      const broken = structuredClone(old); broken.inventory['metal-coat'] = bad;
      expect(() => restoreGame(JSON.stringify(broken))).toThrow(/가방/);
    }
    const missing = structuredClone(old); delete missing.inventory.potion;
    expect(() => restoreGame(JSON.stringify(missing))).toThrow(/가방/);
  });
});
