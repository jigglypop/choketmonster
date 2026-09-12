import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { ConnectomeController } from '../src/game/connectome';
import { ITEM_PRICES, captureDefeatedWild, createGame, createMonster, experienceAtLevel, mergeDuplicateMonster, releaseMonster, replenishBalls, validateGame } from '../src/game/engine';
import { POKEMON } from '../src/data/pokemon';
import { hasPokemonModel } from '../src/data/pokemon-models';
import { VERSIONS, getVersionSpeciesIds } from '../src/data/pokemon-versions';
import { KANTO_LOCATIONS } from '../src/openworld/kanto';
import { OpenWorldSimulation, restoreOpenWorld, serializeOpenWorld, versionEncounters } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const controller = new ConnectomeController(graph);

describe('expanded collection and individual lifecycle', () => {
  it('provides an encounter for every species in every supported version without leaking another version', () => {
    for (const version of [...VERSIONS.filter(item => item.speciesIds.length), { id: 'national', speciesIds: POKEMON.map(item => item.id) }]) {
      const encounters = new Set(KANTO_LOCATIONS.flatMap(location => versionEncounters(location.id, version.id, 8)));
      // The original Kanto campaign obtains evolved forms through its supported evolution rules.
      if (['red', 'blue', 'yellow'].includes(version.id)) for (let pass = 0; pass < 3; pass++) for (const species of POKEMON) if (encounters.has(species.id)) for (const evolution of species.evolutions) {
        if (version.speciesIds.includes(evolution.target) && (evolution.method === 'level' || evolution.method === 'trade' || (evolution.method === 'stone' && Object.hasOwn(ITEM_PRICES, evolution.item ?? '')))) encounters.add(evolution.target);
      }
      expect([...encounters].sort((a, b) => a - b), version.id).toEqual([...version.speciesIds].sort((a, b) => a - b));
    }
  });

  it('limits playable collection changes while retaining the partner and separate collection records', () => {
    const game = createGame(1, 'versions');
    const world = new OpenWorldSimulation(graph, game, 818);
    const partner = world.entities.find(entity => entity.kind === 'companion')!;
    const memory = structuredClone(partner.brain);
    expect(() => world.changeVersion('scarlet')).toThrow(/3D 지역 지도/);
    world.changeVersion('national');
    expect(world.entities.find(entity => entity.kind === 'companion')!.brain).toEqual(memory);
    expect(world.entities.filter(entity => entity.kind === 'wild').every(entity => getVersionSpeciesIds('national').includes(entity.speciesId) && hasPokemonModel(entity.speciesId))).toBe(true);
    const wild = createMonster(game, 906, 5); wild.hp = 0;
    game.dex.seen.push(906); game.captureOffer = wild;
    expect(captureDefeatedWild(game, 'poke-ball')).toBe(true);
    expect(game.versionCaught?.national).toEqual([906]);
    expect(game.versionCaught?.red).toEqual([1]);
    expect(() => validateGame(game)).not.toThrow();
  });

  it('merges XP once, learns level-up moves, and preserves only the recipient memory', () => {
    const game = createGame(1, 'merge');
    const target = game.player.team[0], donor = createMonster(game, 1, 30);
    game.player.box.push(donor); controller.ensure(target); controller.ensure(donor);
    const before = structuredClone(target.brain), xp = target.xp + donor.xp;
    const world = new OpenWorldSimulation(graph, game, 88);
    expect(mergeDuplicateMonster(game, target.instanceId, donor.instanceId)).toBe(donor.xp);
    expect(target.xp).toBe(xp); expect(target.level).toBeGreaterThan(5);
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

  it('refills only on active elapsed time with a cap and a replayable partial timer', () => {
    const game = createGame(1, 'balls'); game.inventory['poke-ball'] = 0;
    for (let i = 0; i < 5; i++) replenishBalls(game, 5);
    expect(game.inventory['poke-ball']).toBe(0);
    const restored = validateGame(structuredClone(game)), rng = game.rngState;
    expect(replenishBalls(restored, 5)).toBe(1);
    expect(replenishBalls(game, 5)).toBe(1);
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
