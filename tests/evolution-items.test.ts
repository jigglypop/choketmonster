import { describe, expect, it } from 'vitest';
import { Brain } from '../src/core/brain';
import { getSpecies } from '../src/data/pokemon';
import { assignAlolaForm, availableEvolutions, buyItem, buyTownStock, createGame, createMonster, evolve, evolutionItemUses, HELD_TOOLS, ITEM_PRICES, restoreGame, serializeGame, SHOP_ITEMS, useItem, validateGame } from '../src/game/engine';
import { EXTRA_EVOLUTION_ITEM_IDS, ITEM_EVOLUTION_RULES } from '../src/game/evolution-items';
import { EVOLUTION_TREAT_EFFECTS } from '../src/game/evolution-conditions';
import { evolutionProgress } from '../src/game/evolution-progress';
import { TOWN_SHOPS } from '../src/data/town-shops';
import type { InventoryItem } from '../src/game/engine';

/** Buys an evolution item where it is sold: the general shop, or else the first town that stocks it. */
function purchase(game: ReturnType<typeof createGame>, item: InventoryItem, quantity = 1) {
  if (SHOP_ITEMS.includes(item)) return buyItem(game, item, quantity);
  for (const [region, towns] of Object.entries(TOWN_SHOPS)) for (const [town, shops] of Object.entries(towns))
    if (shops.some(shop => shop.items?.includes(item))) return buyTownStock(game, region, town, 'item', item, quantity);
  throw new Error(`${item} is sold nowhere`);
}

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
    purchase(game, item);
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
    const { game, mon } = fixture(from); purchase(game, item); evolve(game, mon.instanceId, { targetId: to });
    expect(mon.speciesId).toBe(to); expect(game.inventory[item]).toBe(0);
  });

  it('rejects missing stock, the wrong item, and battle use without consuming anything', () => {
    const { game, mon } = fixture(95), before = serializeGame(game);
    expect(() => evolve(game, mon.instanceId, { targetId: 208 })).toThrow(); expect(serializeGame(game)).toBe(before);
    purchase(game, 'link-cable'); purchase(game, 'metal-coat');
    const bought = serializeGame(game);
    expect(() => evolve(game, mon.instanceId, { targetId: 208, item: 'link-cable' })).toThrow(); expect(serializeGame(game)).toBe(bought);
    game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [createMonster(game, 19, 5)], activeIndex: 0 }, turn: 1, canRun: true };
    expect(() => evolve(game, mon.instanceId, { targetId: 208 })).toThrow(/전투 중/);
    expect(game.inventory['metal-coat']).toBe(1); expect(mon.speciesId).toBe(95);
  });

  it('consumes only the selected branch item and leaves unsupported special forms locked', () => {
    const { game, mon } = fixture(366); purchase(game, 'deep-sea-tooth'); purchase(game, 'deep-sea-scale');
    evolve(game, mon.instanceId, { targetId: 368 });
    expect(game.inventory['deep-sea-scale']).toBe(0); expect(game.inventory['deep-sea-tooth']).toBe(1);
    const sneasel = fixture(215); purchase(sneasel.game, 'razor-claw');
    expect(availableEvolutions(sneasel.game, sneasel.mon.instanceId).map(evolution => evolution.target)).toEqual([461]);
  });

  it('restores old 12-item inventories and preserves new purchases across saves', () => {
    const { game } = fixture(95), old = JSON.parse(serializeGame(game));
    for (const id of EXTRA_EVOLUTION_ITEM_IDS) delete old.inventory[id];
    for (const id of HELD_TOOLS) delete old.inventory[id];
    const restored = restoreGame(JSON.stringify(old));
    for (const id of EXTRA_EVOLUTION_ITEM_IDS) expect(restored.inventory[id]).toBe(0);
    for (const id of HELD_TOOLS) expect(restored.inventory[id]).toBe(0);
    purchase(restored, 'metal-coat', 2);
    expect(restoreGame(serializeGame(restored)).inventory['metal-coat']).toBe(2);
    for (const bad of [-1, null, .5, 1_000_000_001]) {
      const broken = structuredClone(old); broken.inventory['metal-coat'] = bad;
      expect(() => restoreGame(JSON.stringify(broken))).toThrow(/가방/);
    }
    const missing = structuredClone(old); delete missing.inventory.potion;
    expect(() => restoreGame(JSON.stringify(missing))).toThrow(/가방/);
  });

  it('uses distinct exported treat effects and charges the balanced catalyst price', () => {
    const { game, mon } = fixture(133), progress = evolutionProgress(mon);
    game.inventory['friendship-treat'] = 1; game.inventory['beauty-treat'] = 1; game.inventory['affection-treat'] = 1;
    const before = { friendship: progress.friendship, beauty: progress.beauty, affection: progress.affection };
    useItem(game, 'friendship-treat', mon.instanceId);
    useItem(game, 'beauty-treat', mon.instanceId);
    useItem(game, 'affection-treat', mon.instanceId);
    expect(progress.friendship).toBe(before.friendship + EVOLUTION_TREAT_EFFECTS['friendship-treat'].amount);
    expect(progress.beauty).toBe(before.beauty + EVOLUTION_TREAT_EFFECTS['beauty-treat'].amount);
    expect(progress.affection).toBe(before.affection + EVOLUTION_TREAT_EFFECTS['affection-treat'].amount);
    expect(EVOLUTION_TREAT_EFFECTS['affection-treat'].amount).toBe(1);
    expect(ITEM_PRICES['evolution-catalyst']).toBe(8000);
  });

  it('blocks items and the catalyst from unsupported regional-form evolutions', () => {
    const cases = [
      [79, 80, 'galarica-cuff'], [79, 199, 'galarica-wreath'], [554, 555, 'ice-stone'],
      [215, 903, 'razor-claw'], [100, 101, 'leaf-stone'],
    ] as const;
    for (const [from, to, item] of cases) {
      const { game, mon } = fixture(from); mon.level = 50; game.inventory[item] = 1;
      expect(() => evolve(game, mon.instanceId, { targetId: to, item })).toThrow();
      game.inventory['evolution-catalyst'] = 1;
      if (from === 215) expect(() => evolve(game, mon.instanceId, { targetId: to, item: 'evolution-catalyst' })).toThrow();
      expect(mon.speciesId).toBe(from); expect(game.inventory[item]).toBe(1);
    }
    expect(SHOP_ITEMS).not.toContain('galarica-cuff'); expect(SHOP_ITEMS).not.toContain('galarica-wreath');
  });

  it('preserves supported Alola form IDs through Diglett and Geodude evolution chains', () => {
    const diglett = fixture(50); diglett.mon.level = 30; assignAlolaForm(diglett.game, diglett.mon.instanceId, true);
    evolve(diglett.game, diglett.mon.instanceId, { targetId: 51 });
    expect(diglett.mon.regionalForm).toBe('dugtrio-alola');

    const geodude = fixture(74); geodude.mon.level = 30; assignAlolaForm(geodude.game, geodude.mon.instanceId, true);
    evolve(geodude.game, geodude.mon.instanceId, { targetId: 75 });
    expect(geodude.mon.regionalForm).toBe('graveler-alola');
    geodude.game.inventory['link-cable'] = 1; evolve(geodude.game, geodude.mon.instanceId, { targetId: 76, item: 'link-cable' });
    expect(geodude.mon.regionalForm).toBe('golem-alola');
  });
});
