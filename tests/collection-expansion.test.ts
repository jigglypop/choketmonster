import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { ConnectomeController } from '../src/game/connectome';
import { ITEM_PRICES, captureDefeatedWild, createGame, createMonster, experienceAtLevel, mergeDuplicateMonster, mergeDuplicateMonsters, previewDuplicateMerge, releaseMonster, replenishBalls, validateGame } from '../src/game/engine';
import { POKEMON } from '../src/data/pokemon';
import { hasPokemonModel } from '../src/data/pokemon-models';
import { KANTO_LOCATIONS } from '../src/openworld/kanto';
import { OpenWorldSimulation, restoreOpenWorld, serializeOpenWorld, versionEncounters } from '../src/openworld/simulation';
import { getPlayableSpeciesIds } from '../src/openworld/availability';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const controller = new ConnectomeController(graph);

describe('expanded collection and individual lifecycle', () => {
  it('limits national and Kanto version encounters to species whose region map is playable', () => {
    for (const version of ['red', 'blue', 'yellow'].map(id => ({ id, speciesIds: getPlayableSpeciesIds(id) }))) {
      const encounters = new Set(KANTO_LOCATIONS.flatMap(location => versionEncounters(location.id, version.id, 8)));
      // The original Kanto campaign obtains evolved forms through its supported evolution rules.
      for (let pass = 0; pass < 3; pass++) for (const species of POKEMON) if (encounters.has(species.id)) for (const evolution of species.evolutions) {
        if (version.speciesIds.includes(evolution.target) && (evolution.method === 'level' || evolution.method === 'trade' || (evolution.method === 'stone' && Object.hasOwn(ITEM_PRICES, evolution.item ?? '')))) encounters.add(evolution.target);
      }
      expect([...encounters].sort((a, b) => a - b), version.id).toEqual([...version.speciesIds].sort((a, b) => a - b));
    }
    expect(versionEncounters('pallet', 'gold', 8)).toEqual(versionEncounters('pallet', 'red', 8));
    expect(getPlayableSpeciesIds('national')).toHaveLength(1025);
  });

  it('limits playable collection changes while retaining the partner and separate collection records', () => {
    const game = createGame(1, 'versions');
    const world = new OpenWorldSimulation(graph, game, 818);
    const partner = world.entities.find(entity => entity.kind === 'companion')!;
    const memory = structuredClone(partner.brain);
    world.changeVersion('scarlet');
    expect(game.adventureVersion).toBe('scarlet');
    world.changeVersion('national');
    expect(world.entities.find(entity => entity.kind === 'companion')!.brain).toEqual(memory);
    expect(world.entities.filter(entity => entity.kind === 'wild').every(entity => getPlayableSpeciesIds('national').includes(entity.speciesId) && hasPokemonModel(entity.speciesId))).toBe(true);
    const wild = createMonster(game, 906, 5); wild.hp = 0;
    game.dex.seen.push(906); game.captureOffer = wild;
    expect(captureDefeatedWild(game, 'poke-ball')).toBe(true);
    expect(game.versionCaught?.national).toEqual([906]);
    expect(game.versionCaught?.red).toEqual([1]);
    expect(() => validateGame(game)).not.toThrow();
  });

  it('uses the highest participant as baseline plus a 5% bonus once, learns moves, and preserves recipient memory', () => {
    const game = createGame(1, 'merge');
    const target = game.player.team[0], donor = createMonster(game, 1, 30);
    game.player.box.push(donor); controller.ensure(target); controller.ensure(donor);
    const before = structuredClone(target.brain), plan = previewDuplicateMerge(game, target.instanceId, [donor.instanceId]);
    const world = new OpenWorldSimulation(graph, game, 88);
    expect(mergeDuplicateMonster(game, target.instanceId, donor.instanceId)).toBe(plan.gainedXp);
    expect(target.level).toBe(31); expect(plan).toMatchObject({ donorLevels: 30, highestDonorLevel: 30, baselineLevel: 30, bonusLevels: 1, totalLevels: 26, gainedLevels: 26, toLevel: 31 });
    expect(target.brain).toEqual(before);
    expect(game.player.box).toHaveLength(0);
    expect(() => mergeDuplicateMonster(game, target.instanceId, donor.instanceId)).toThrow();
    expect(() => restoreOpenWorld(graph, serializeOpenWorld(game, world))).not.toThrow();
  });

  it('refuses unsafe removals and keeps historical collection on release', () => {
    const game = createGame(1, 'release'), only = game.player.team[0];
    expect(() => releaseMonster(game, only.instanceId)).toThrow();
    const duplicate = createMonster(game, 1, 5); game.player.box.push(duplicate);
    const before = JSON.stringify(game);
    expect(() => mergeDuplicateMonster(game, only.instanceId, only.instanceId)).toThrow();
    expect(JSON.stringify(game)).toBe(before);
    releaseMonster(game, duplicate.instanceId);
    expect(game.dex.caught).toContain(1);
    expect(game.versionCaught?.red).toEqual([1]);
  });

  it('merges a whole species once across team and box while preserving the chosen brain and records', () => {
    const game = createGame(1, 'batch-merge'), target = game.player.team[0];
    const controller = new ConnectomeController(graph); controller.ensure(target);
    target.moveLearning = { '33': { choices: 4, executed: 4, effective: 3, reward: 2 } };
    const brain = target.brain, memory = structuredClone(brain), learning = structuredClone(target.moveLearning);
    const a = createMonster(game, 1, 12), b = createMonster(game, 1, 20), other = createMonster(game, 25, 8);
    game.player.team.push(a); game.player.box.push(b, other);
    game.dex.seen.push(25); game.dex.caught.push(25);
    const plan = previewDuplicateMerge(game, target.instanceId, [a.instanceId, b.instanceId]), dex = structuredClone(game.dex);
    const result = mergeDuplicateMonsters(game, target.instanceId, [a.instanceId, b.instanceId]);
    expect(result).toEqual(plan); expect(result).toMatchObject({ count: 2, donorLevels: 32, highestDonorLevel: 20, baselineLevel: 20, bonusLevels: 1, gainedLevels: 16, toLevel: 21, movesToTeam: false });
    expect(game.player.team).toEqual([target]); expect(game.player.box).toEqual([other]);
    expect(target.level).toBe(21); expect(target.xp).toBe(target.level < 100 ? experienceAtLevel(21, 'medium-slow') : target.xp); expect(target.brain).toBe(brain); expect(target.brain).toEqual(memory);
    expect(target.moveLearning).toEqual(learning); expect(game.dex).toEqual(dex);
    expect(() => validateGame(game)).not.toThrow();
    expect(() => mergeDuplicateMonsters(game, target.instanceId, [a.instanceId, b.instanceId])).toThrow();
    expect(target.xp).toBe(experienceAtLevel(21, 'medium-slow'));
  });

  it('moves a boxed survivor into the team and commits every donor even when XP hits the cap', () => {
    const game = createGame(1, 'batch-cap'), target = createMonster(game, 1, 99), donor = createMonster(game, 1, 100);
    game.player.box.push(target, donor);
    const ids = [game.player.team[0].instanceId, donor.instanceId];
    const before = JSON.stringify(game), plan = previewDuplicateMerge(game, target.instanceId, ids);
    expect(JSON.stringify(game)).toBe(before); expect(plan.movesToTeam).toBe(true); expect(plan.excessLevels).toBeGreaterThan(0);
    expect(mergeDuplicateMonsters(game, target.instanceId, ids)).toEqual(plan);
    expect(game.player.team).toEqual([target]); expect(game.player.box).toEqual([]);
    expect(target.level).toBe(100); expect(target.xp).toBe(experienceAtLevel(100, 'medium-slow'));
    expect(() => validateGame(game)).not.toThrow();
  });

  it('rejects the entire batch before changing XP or removing any donor', () => {
    const game = createGame(1, 'batch-invalid'), target = game.player.team[0];
    const donor = createMonster(game, 1, 20), other = createMonster(game, 25, 8);
    game.player.box.push(donor, other);
    for (const ids of [[], [donor.instanceId, 'missing'], [donor.instanceId, donor.instanceId], [donor.instanceId, other.instanceId], [target.instanceId]]) {
      const before = JSON.stringify(game);
      expect(() => mergeDuplicateMonsters(game, target.instanceId, ids)).toThrow();
      expect(JSON.stringify(game)).toBe(before);
    }
    game.captureOffer = createMonster(game, 19, 3);
    const before = JSON.stringify(game);
    expect(() => mergeDuplicateMonsters(game, target.instanceId, [donor.instanceId])).toThrow(/포획/);
    expect(JSON.stringify(game)).toBe(before);
  });

  it('honors a single-donor preview when the chosen survivor is boxed and the donor is the only teammate', () => {
    const game = createGame(1, 'single-boxed-survivor'), donor = game.player.team[0], target = createMonster(game, 1, 8);
    game.player.box.push(target); controller.ensure(target);
    const brain = target.brain, plan = previewDuplicateMerge(game, target.instanceId, [donor.instanceId]);
    expect(plan.movesToTeam).toBe(true);
    expect(mergeDuplicateMonster(game, target.instanceId, donor.instanceId)).toBe(plan.gainedXp);
    expect(game.player.team).toEqual([target]); expect(game.player.box).toEqual([]); expect(target.brain).toBe(brain);
    validateGame(game);
  });

  it('normalizes the unlimited ball to a finite save token without a refill timer', () => {
    const game = createGame(1, 'balls'); game.inventory['poke-ball'] = 0;
    for (let i = 0; i < 5; i++) replenishBalls(game, 5);
    expect(game.inventory['poke-ball']).toBe(1);
    const restored = validateGame(structuredClone(game)), rng = game.rngState;
    expect(replenishBalls(restored, 5)).toBe(0);
    expect(replenishBalls(game, 5)).toBe(0);
    expect(restored).toEqual(game); expect(game.rngState).toBe(rng);
    game.inventory['poke-ball'] = 20;
    for (let i = 0; i < 12; i++) replenishBalls(game, 5);
    expect(game.inventory['poke-ball']).toBe(20); expect(game.ballRefillSeconds).toBe(0);
    expect(() => replenishBalls(game, Number.NaN)).toThrow();
  });

  it('uses all six original growth curves and caps merged XP at level 100', () => {
    expect(experienceAtLevel(100, 'slow-then-very-fast')).toBe(600000);
    expect(experienceAtLevel(100, 'fast-then-very-slow')).toBe(1640000);
    const game = createGame(1, 'cap');
    const target = createMonster(game, 1, 99), donor = createMonster(game, 1, 100); game.player.box.push(target, donor);
    mergeDuplicateMonster(game, target.instanceId, donor.instanceId);
    expect(target.level).toBe(100); expect(target.xp).toBe(experienceAtLevel(100, 'medium-slow'));
    expect(() => validateGame(game)).not.toThrow();
  });
});
