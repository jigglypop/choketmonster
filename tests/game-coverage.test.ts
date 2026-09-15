import { describe, expect, it } from 'vitest';
import { POKEMON, TYPE_EFFECTIVENESS } from '../src/data/pokemon';
import { createGame, createMonster, actBattle, restoreGame, serializeGame } from '../src/game/engine';
import { typeMultiplier } from '../src/game/battle';
import type { PokemonType } from '../src/game/contracts';

describe('full species and evolution coverage (controlled fixtures)', () => {
  it('publishes one distinct runtime edge for every authored species evolution', () => {
    const edges = POKEMON.flatMap(species => species.evolutions.map(evolution => `${species.id}>${evolution.target}`));
    expect(edges).toHaveLength(483);
    expect(new Set(edges).size).toBe(edges.length);
    for (const species of POKEMON) for (const evolution of species.evolutions) expect(POKEMON[evolution.target - 1]?.id).toBe(evolution.target);
  });
  it('can catch every species through the real probability and storage path', () => {
    // Fixtures provide low HP, sleep, and sufficient balls. Natural resource/progression
    // reachability is checked separately by scripts/verify-campaign.ts.
    for (const species of POKEMON) {
      const game = createGame(7, `capture-${species.id}`), enemy = createMonster(game, species.id, 35);
      enemy.hp = 1; enemy.status = 'sleep'; enemy.statusTurns = 3;
      game.inventory['ultra-ball'] = 1000;
      game.dex.seen.push(species.id);
      game.battle = { kind: 'wild', regionId: game.regionId, player: { team: game.player.team, activeIndex: 0 }, enemy: { team: [enemy], activeIndex: 0 }, turn: 1, canRun: true };
      for (let n = 0; n < 1000 && game.battle; n++) actBattle(game, { type: 'catch', ball: 'ultra-ball' }, 4);
      expect(game.battle, species.name).toBeUndefined();
      expect(game.player.team.some(mon => mon.instanceId === enemy.instanceId && mon.speciesId === species.id), species.name).toBe(true);
      expect(game.dex.caught).toContain(species.id);
      expect(restoreGame(serializeGame(game)).player.team[1].speciesId).toBe(species.id);
    }
  });
  it('uses the verified effectiveness data for every pair of modern types', () => {
    const types = Object.keys(TYPE_EFFECTIVENESS) as PokemonType[];
    for (const attacking of types) for (const defending of types) expect(typeMultiplier(attacking, [defending])).toBe(TYPE_EFFECTIVENESS[attacking][defending]);
  });
});
