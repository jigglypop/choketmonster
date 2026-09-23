import { describe, expect, it } from 'vitest';
import { getMove } from '../src/data/pokemon';
import { calculateDamage, TYPE_BOOST_TOOLS, turnOrder, type Combatant } from '../src/game/battle';
import {
  actBattle, availableEvolutions, CONSUMABLE_HELD_TOOLS, createGame, createMonster, evolve, experienceAtLevel, HELD_TOOL_CATEGORIES, HELD_TOOL_DESCRIPTIONS,
  HELD_TOOL_LABELS, HELD_TOOL_PRICES, HELD_TOOL_TIERS, HELD_TOOLS, restoreGame, serializeGame, SHOP_ITEMS, type GameState, type HeldTool, type Monster,
} from '../src/game/engine';
import { getSpecies } from '../src/data/pokemon';
import { PLAYABLE_WORLDS } from '../src/openworld/availability';
import { captureItemChances, getFieldItem, HELD_TOOL_CAPTURE_RATES, HELD_TOOL_SOURCE_FAMILIES, rollCapturedSpeciesItem } from '../src/openworld/field-item-drops';
import { activeFieldItemPickups, getFieldItemSources, validateFieldItemPickupStates } from '../src/openworld/item-sources';

function duel(seed: string, playerSpecies: number, enemySpecies: number, options: { level?: number; enemyLevel?: number; tool?: HeldTool; enemyTool?: HeldTool } = {}) {
  const game = createGame(1, seed);
  const player = createMonster(game, playerSpecies, options.level ?? 50), enemy = createMonster(game, enemySpecies, options.enemyLevel ?? options.level ?? 50);
  game.player.team = [player];
  if (options.tool) player.heldTool = options.tool;
  if (options.enemyTool) enemy.heldTool = options.enemyTool;
  game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
  return { game, player, enemy };
}
const teach = (monster: Monster, ...moveIds: number[]) => { monster.moves = moveIds.map(moveId => ({ moveId, pp: getMove(moveId).pp })); };
const texts = (game: GameState) => game.logs.join('\n');
const stats = { hp: 200, attack: 200, defense: 100, specialAttack: 200, specialDefense: 100, speed: 100 };
const fighter = (types: Combatant['types'], heldTool?: Combatant['heldTool']): Combatant => ({ level: 50, hp: 200, stats, types, heldTool });
const damage = (move: number, attacker: Combatant, defender: Combatant) => calculateDamage(attacker, defender, { ...getMove(move), power: 100 }, 1).damage;

describe('held tool catalog and acquisition balance', () => {
  it('ships 47 held tools with tier, category, label, description, price and playable capture sources', () => {
    expect(HELD_TOOLS).toHaveLength(47);
    const counts = { common: 0, uncommon: 0, rare: 0 };
    for (const tool of HELD_TOOLS) {
      const tier = HELD_TOOL_TIERS[tool];
      counts[tier]++;
      expect(HELD_TOOL_LABELS[tool]).toBe(getFieldItem(tool)!.name);
      expect(HELD_TOOL_DESCRIPTIONS[tool].length, tool).toBeGreaterThan(8);
      expect(HELD_TOOL_PRICES[tool]).toBe(tool === 'life-orb' ? 8000 : { common: 2000, uncommon: 4000, rare: 6000 }[tier]);
      expect(SHOP_ITEMS).not.toContain(tool);
      const source = getFieldItemSources(tool)!;
      expect(source.captures.map(capture => capture.speciesIds[0]), tool).toEqual(HELD_TOOL_SOURCE_FAMILIES[tool]);
      expect(source.captures.every(capture => capture.chance === HELD_TOOL_CAPTURE_RATES[tier] && capture.locations.length > 0), tool).toBe(true);
      expect(source.roadside.length, tool).toBeGreaterThan(0);
    }
    expect(counts).toEqual({ common: 21, uncommon: 15, rare: 11 });
    expect(Object.values(TYPE_BOOST_TOOLS).map(tool => HELD_TOOL_TIERS[tool as HeldTool])).toEqual(Array(18).fill('common'));
    for (const tool of ['leftovers', 'choice-band', 'choice-specs', 'choice-scarf', 'life-orb', 'focus-sash', 'assault-vest', 'weakness-policy', 'lucky-egg', 'amulet-coin'] as const) expect(HELD_TOOL_TIERS[tool]).toBe('rare');
    expect(HELD_TOOLS.filter(tool => HELD_TOOL_CATEGORIES[tool] === 'berry')).toEqual(['oran-berry', 'sitrus-berry', 'lum-berry']);
    expect(HELD_TOOLS.filter(tool => HELD_TOOL_CATEGORIES[tool] === 'support')).toEqual(['amulet-coin', 'lucky-egg', 'everstone', 'smoke-ball']);
  });

  it('awards at most one item per real capture at the tier rate', () => {
    expect(captureItemChances(58)).toEqual([expect.objectContaining({ id: 'charcoal', chance: .15 })]);
    expect(captureItemChances(425)).toEqual([expect.objectContaining({ id: 'air-balloon', chance: .08 })]);
    expect(captureItemChances(113)).toEqual([expect.objectContaining({ id: 'lucky-egg', chance: .04 })]);
    expect(rollCapturedSpeciesItem(() => .1499, 58)?.id).toBe('charcoal');
    expect(rollCapturedSpeciesItem(() => .15, 58)).toBeUndefined();
    expect(rollCapturedSpeciesItem(() => .0799, 425)?.id).toBe('air-balloon');
    expect(rollCapturedSpeciesItem(() => .08, 425)).toBeUndefined();
    expect(captureItemChances(52).map(item => [item.id, item.chance])).toEqual([['choice-scarf', .04], ['amulet-coin', .04]]);
    expect(rollCapturedSpeciesItem(() => .03, 52)?.id).toBe('choice-scarf');
    expect(rollCapturedSpeciesItem(() => .05, 52)?.id).toBe('amulet-coin');
    expect(rollCapturedSpeciesItem(() => .08, 52)).toBeUndefined();
    let calls = 0; rollCapturedSpeciesItem(() => { calls++; return .5; }, 52); expect(calls).toBe(1);
  });

  it('weights roadside held tools by tier while keeping the saved slot format', () => {
    const tally = { common: 0, uncommon: 0, rare: 0, mega: 0, machine: 0 };
    for (const region of PLAYABLE_WORLDS) for (let cycle = 0; cycle < 240; cycle++) {
      const states = { [`field-item:${region.id}:0`]: { remainingSeconds: 0, collectedCount: cycle } };
      const pickup = activeFieldItemPickups(region.id, 517, validateFieldItemPickupStates(states), 8).find(item => item.id === `field-item:${region.id}:0`);
      if (!pickup) continue;
      if (pickup.kind === 'mega-stone') tally.mega++; else if (pickup.kind === 'technical-machine') tally.machine++; else tally[HELD_TOOL_TIERS[pickup.itemId as HeldTool]]++;
    }
    const perItem = { common: tally.common / 21, uncommon: tally.uncommon / 15, rare: tally.rare / 11 };
    expect(perItem.common).toBeGreaterThan(perItem.uncommon * 1.4);
    expect(perItem.uncommon).toBeGreaterThan(perItem.rare * 1.4);
    expect(tally.rare).toBeGreaterThan(0);
    const total = tally.common + tally.uncommon + tally.rare + tally.mega + tally.machine;
    expect(tally.mega / total).toBeGreaterThan(.25); expect(tally.mega / total).toBeLessThan(.5);
    expect(tally.machine / total).toBeGreaterThan(.12);
    expect(activeFieldItemPickups('kanto', 517, {}, 8)).toEqual(activeFieldItemPickups('kanto', 517, {}, 8));
  });

  it('backfills new tool stock for saves made before the expansion without touching equipped tools', () => {
    const game = createGame(1, 'legacy-new-tools'); game.player.team[0].heldTool = 'leftovers';
    const legacy = JSON.parse(serializeGame(game));
    for (const tool of HELD_TOOLS.slice(6)) delete legacy.inventory[tool];
    const restored = restoreGame(JSON.stringify(legacy));
    for (const tool of HELD_TOOLS) expect(restored.inventory[tool]).toBe(0);
    expect(restored.player.team[0].heldTool).toBe('leftovers');
  });
});

describe('held tool damage and turn order rules', () => {
  it('applies type boosters, Expert Belt, Muscle Band and Wise Glasses', () => {
    const plain = damage(52, fighter(['normal']), fighter(['normal']));
    expect(damage(52, fighter(['normal'], 'charcoal'), fighter(['normal'])) / plain).toBeCloseTo(1.2, 1);
    expect(damage(52, fighter(['normal'], 'mystic-water'), fighter(['normal']))).toBe(plain);
    const superEffective = damage(52, fighter(['normal']), fighter(['grass']));
    expect(damage(52, fighter(['normal'], 'expert-belt'), fighter(['grass'])) / superEffective).toBeCloseTo(1.2, 1);
    expect(damage(52, fighter(['normal'], 'expert-belt'), fighter(['normal']))).toBe(plain);
    const physical = damage(33, fighter(['fire']), fighter(['fire']));
    expect(damage(33, fighter(['fire'], 'muscle-band'), fighter(['fire'])) / physical).toBeCloseTo(1.1, 1);
    expect(damage(52, fighter(['normal'], 'muscle-band'), fighter(['normal']))).toBe(plain);
    expect(damage(52, fighter(['normal'], 'wise-glasses'), fighter(['normal'])) / plain).toBeCloseTo(1.1, 1);
  });

  it('makes Air Balloon block ground damage and lets Quick Claw win same-priority order', () => {
    expect(calculateDamage(fighter(['normal']), fighter(['fire'], 'air-balloon'), getMove(89), 1)).toMatchObject({ damage: 0, multiplier: 0, abilityActivation: 'air-balloon' });
    const slow = { ...fighter(['normal']), stats: { ...stats, speed: 10 } }, tackle = getMove(33), quick = getMove(98);
    expect(turnOrder(slow, tackle, fighter(['normal']), tackle, .1)).toBe('enemy');
    expect(turnOrder(slow, tackle, fighter(['normal']), tackle, .1, { player: true })).toBe('player');
    expect(turnOrder(slow, tackle, fighter(['normal']), tackle, .1, { player: true, enemy: true })).toBe('enemy');
    expect(turnOrder(slow, tackle, fighter(['normal']), quick, .1, { player: true })).toBe('enemy');
  });
});

describe('held tool battle effects', () => {
  it('fails status moves under Assault Vest and raises Special Defense', () => {
    const vest = duel('vest', 1, 4, { tool: 'assault-vest' }); teach(vest.player, 45);
    const result = actBattle(vest.game, { type: 'move', index: 0 }, 4);
    expect(result.executedMoves[0]).toMatchObject({ moveId: 45, result: 'failed', hit: false });
    expect(texts(vest.game)).toContain('돌격조끼');
    const taken = (tool?: HeldTool) => {
      const setup = duel('vest-special', 7, 4, { tool }); teach(setup.enemy, 53);
      const before = setup.player.hp; actBattle(setup.game, { type: 'wait' }, 0); return before - setup.player.hp;
    };
    expect(taken('assault-vest')).toBeLessThan(taken());
  });

  it('boosts both defenses with Eviolite only while the holder can still evolve', () => {
    const taken = (species: number, tool?: HeldTool, move = 33) => {
      const setup = duel(`eviolite-${species}-${move}`, species, 143, { tool }); teach(setup.enemy, move);
      const before = setup.player.hp; actBattle(setup.game, { type: 'wait' }, 0); return before - setup.player.hp;
    };
    expect(taken(1, 'eviolite')).toBeLessThan(taken(1));
    expect(taken(1, 'eviolite', 52)).toBeLessThan(taken(1, undefined, 52));
    expect(taken(3, 'eviolite')).toBe(taken(3));
  });

  it('heals with Shell Bell and Big Root and punishes physical attackers with Rocky Helmet', () => {
    const bell = duel('shell-bell', 4, 143, { tool: 'shell-bell' }); teach(bell.player, 33); bell.player.hp = 40;
    const hit = actBattle(bell.game, { type: 'move', index: 0 }, 4).executedMoves[0].damage;
    expect(bell.player.hp).toBe(40 + Math.max(1, Math.floor(hit / 8)));

    const drained = (tool?: HeldTool) => {
      const setup = duel('big-root', 1, 7, { tool }); teach(setup.player, 202); setup.player.hp = 1;
      const dealt = actBattle(setup.game, { type: 'move', index: 0 }, 4).executedMoves[0].damage;
      return { dealt, healed: setup.player.hp - 1 };
    };
    const normal = drained(), rooted = drained('big-root');
    expect(rooted.dealt).toBe(normal.dealt);
    expect(rooted.healed).toBe(Math.floor(Math.max(1, Math.floor(normal.dealt / 2)) * 1.3));

    const helmet = duel('rocky-helmet', 143, 4, { tool: 'rocky-helmet' }); teach(helmet.enemy, 33, 52);
    const enemyMax = helmet.enemy.stats.hp;
    actBattle(helmet.game, { type: 'wait' }, 0);
    expect(helmet.enemy.hp).toBe(enemyMax - Math.floor(enemyMax / 6));
    actBattle(helmet.game, { type: 'wait' }, 1);
    expect(helmet.enemy.hp).toBe(enemyMax - Math.floor(enemyMax / 6));
  });

  it('heals poison holders with Black Sludge and hurts other holders', () => {
    const grimer = duel('sludge-poison', 88, 143, { tool: 'black-sludge' }); grimer.player.hp = 10;
    actBattle(grimer.game, { type: 'wait' }, 4);
    expect(grimer.player.hp).toBe(10 + Math.floor(grimer.player.stats.hp / 16));
    const snorlax = duel('sludge-other', 143, 143, { tool: 'black-sludge' });
    actBattle(snorlax.game, { type: 'wait' }, 4);
    expect(snorlax.player.hp).toBe(snorlax.player.stats.hp - Math.floor(snorlax.player.stats.hp / 8));
  });

  it('restores lowered stages once with White Herb and keeps the use through a reload', () => {
    const { game, player, enemy } = duel('white-herb', 143, 4, { tool: 'white-herb' }); teach(enemy, 45);
    actBattle(game, { type: 'wait' }, 0);
    expect(game.battle!.statStages?.[player.instanceId]?.attack ?? 0).toBe(0);
    expect(game.battle!.consumedTools).toEqual([player.instanceId]);
    const loaded = restoreGame(serializeGame(game));
    actBattle(loaded, { type: 'wait' }, 0);
    expect(loaded.battle!.statStages?.[player.instanceId]?.attack).toBe(-1);
    expect(loaded.player.team[0].heldTool).toBe('white-herb');
  });

  it('changes accuracy with Wide Lens and Bright Powder without changing the RNG stream', () => {
    const hits = (options: { tool?: HeldTool; enemyTool?: HeldTool }) => {
      let count = 0;
      for (let seed = 0; seed < 160; seed++) {
        const setup = duel(`accuracy-${seed}`, 143, 143, options); teach(setup.player, 87);
        if (actBattle(setup.game, { type: 'move', index: 0 }, 4).executedMoves[0].hit) count++;
      }
      return count;
    };
    const base = hits({});
    expect(hits({ tool: 'wide-lens' })).toBeGreaterThan(base);
    expect(hits({ enemyTool: 'bright-powder' })).toBeLessThan(base);
  });

  it('lets a slower Quick Claw holder act first about one turn in five', () => {
    const first = (tool?: HeldTool) => {
      let count = 0;
      for (let seed = 0; seed < 200; seed++) {
        const setup = duel(`quick-${seed}`, 79, 101, { tool }); teach(setup.player, 33); teach(setup.enemy, 33);
        if (actBattle(setup.game, { type: 'move', index: 0 }, 0).executedMoves[0].actorInstanceId === setup.player.instanceId) count++;
      }
      return count;
    };
    expect(first()).toBe(0);
    const quick = first('quick-claw');
    expect(quick).toBeGreaterThan(20); expect(quick).toBeLessThan(70);
  });

  it('saves a fainting holder with Focus Band about one hit in ten', () => {
    const survived = (tool?: HeldTool) => {
      let count = 0;
      for (let seed = 0; seed < 200; seed++) {
        const setup = duel(`band-${seed}`, 1, 150, { level: 20, enemyLevel: 100, tool }); teach(setup.enemy, 94);
        actBattle(setup.game, { type: 'wait' }, 0);
        if (setup.player.hp === 1) count++;
      }
      return count;
    };
    expect(survived()).toBe(0);
    const band = survived('focus-band');
    expect(band).toBeGreaterThan(5); expect(band).toBeLessThan(40);
  });

  it('keeps Air Balloon until a damaging hit pops it for the rest of the battle', () => {
    const { game, player, enemy } = duel('balloon', 143, 143, { tool: 'air-balloon' }); teach(enemy, 89, 33);
    actBattle(game, { type: 'wait' }, 0);
    expect(player.hp).toBe(player.stats.hp); expect(texts(game)).toContain('풍선');
    actBattle(game, { type: 'wait' }, 1);
    expect(player.hp).toBeLessThan(player.stats.hp); expect(texts(game)).toContain('풍선이 터졌다');
    const loaded = restoreGame(serializeGame(game)), hp = loaded.player.team[0].hp;
    actBattle(loaded, { type: 'wait' }, 0);
    expect(loaded.player.team[0].hp).toBeLessThan(hp);
  });

  it('raises attacks once with Weakness Policy after surviving a super-effective hit', () => {
    const { game, player, enemy } = duel('policy', 248, 7, { tool: 'weakness-policy' }); teach(enemy, 55);
    actBattle(game, { type: 'wait' }, 0);
    expect(player.hp).toBeGreaterThan(0);
    expect(game.battle!.statStages?.[player.instanceId]).toMatchObject({ attack: 2, specialAttack: 2 });
    actBattle(game, { type: 'wait' }, 0);
    expect(game.battle!.statStages?.[player.instanceId]).toMatchObject({ attack: 2, specialAttack: 2 });
  });

  it('eats Oran, Sitrus and Lum berries once per battle', () => {
    for (const [tool, heal] of [['oran-berry', () => 10], ['sitrus-berry', (max: number) => Math.floor(max / 4)]] as const) {
      const { game, player } = duel(`berry-${tool}`, 143, 143, { tool }), max = player.stats.hp;
      player.hp = Math.floor(max / 2) - 1;
      actBattle(game, { type: 'wait' }, 4);
      expect(player.hp).toBe(Math.floor(max / 2) - 1 + heal(max));
      player.hp = 5; actBattle(game, { type: 'wait' }, 4);
      expect(player.hp).toBe(5);
      expect(player.heldTool).toBe(tool);
    }
    const { game, player } = duel('berry-lum', 143, 143, { tool: 'lum-berry' });
    player.status = 'paralysis'; actBattle(game, { type: 'wait' }, 4);
    expect(player.status).toBeUndefined();
    player.status = 'burn'; actBattle(game, { type: 'wait' }, 4);
    expect(player.status).toBe('burn');
    expect(() => restoreGame(serializeGame(game))).not.toThrow();
  });

  it('rejects consumed-tool records for tools that are not spent in battle', () => {
    const { game, player } = duel('consumed-validation', 143, 143, { tool: 'leftovers' });
    game.battle!.consumedTools = [player.instanceId];
    expect(() => restoreGame(serializeGame(game))).toThrow(/소모 도구/);
    for (const tool of CONSUMABLE_HELD_TOOLS) {
      player.heldTool = tool;
      expect(() => restoreGame(serializeGame(game)), tool).not.toThrow();
    }
  });
});

describe('utility held tools', () => {
  it('doubles prize money with Amulet Coin and raises experience with Lucky Egg', () => {
    const win = (tool?: HeldTool) => {
      const setup = duel(`prize-${tool}`, 1, 16, { level: 10, enemyLevel: 20, tool });
      const partner = createMonster(setup.game, 1, 10); setup.game.player.team.push(partner);
      const money = setup.game.player.money; setup.enemy.hp = 0;
      const result = actBattle(setup.game, { type: 'wait' }, 4);
      return { money: setup.game.player.money - money, result, holder: setup.player, partner };
    };
    const plain = win(), coin = win('amulet-coin'), egg = win('lucky-egg');
    expect(plain.money).toBe(160); expect(coin.money).toBe(320);
    const gains = (outcome: typeof egg, id: string) => outcome.result.experienceGains.find(gain => gain.instanceId === id)!.amount;
    expect(gains(egg, egg.holder.instanceId)).toBe(Math.floor(gains(egg, egg.partner.instanceId) * 1.5));
    expect(gains(plain, plain.holder.instanceId)).toBe(gains(plain, plain.partner.instanceId));
  });

  it('stops level and manual evolution while Everstone is held', () => {
    const game = createGame(1, 'everstone'), bulbasaur = createMonster(game, 1, 20), eevee = createMonster(game, 133, 20);
    game.player.team = [bulbasaur]; game.player.box = [eevee]; game.inventory['fire-stone'] = 1;
    expect(availableEvolutions(game, bulbasaur.instanceId).map(evolution => evolution.target)).toContain(2);
    bulbasaur.heldTool = 'everstone'; eevee.heldTool = 'everstone';
    expect(availableEvolutions(game, bulbasaur.instanceId)).toEqual([]);
    expect(() => evolve(game, bulbasaur.instanceId, { targetId: 2 })).toThrow();
    expect(() => evolve(game, eevee.instanceId, { targetId: 136, item: 'fire-stone' })).toThrow();
    expect(game.inventory['fire-stone']).toBe(1); expect(bulbasaur.speciesId).toBe(1); expect(eevee.speciesId).toBe(133);
    delete bulbasaur.heldTool;
    expect(evolve(game, bulbasaur.instanceId, { targetId: 2 }).speciesId).toBe(2);
    expect(bulbasaur.xp).toBeGreaterThanOrEqual(experienceAtLevel(20, getSpecies(2).growthRate));
  });

  it('always escapes wild battles with Smoke Ball', () => {
    let failures = 0;
    for (let seed = 0; seed < 30; seed++) {
      const plain = duel(`run-${seed}`, 79, 101);
      if (actBattle(plain.game, { type: 'run' }, 4).outcome !== 'escaped') failures++;
      const smoke = duel(`run-${seed}`, 79, 101, { tool: 'smoke-ball' });
      const result = actBattle(smoke.game, { type: 'run' }, 4);
      expect(result.outcome).toBe('escaped'); expect(result.events.at(-1)?.text).toContain('연막탄');
    }
    expect(failures).toBeGreaterThan(0);
  });
});
