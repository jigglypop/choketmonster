import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { createGame, restoreGame, serializeGame, validateGame } from '../src/game/engine';
import { getWorldAtlas } from '../src/openworld/atlas';
import { OpenWorldSimulation } from '../src/openworld/simulation';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;
const badges = [1, 2, 3, 4, 5, 6, 7, 8];

function gameBeforeFinalAlolaTrial() {
  const game = createGame(1, 'alola-final-trial');
  game.defeatedGyms = [...badges];
  game.player.badges = 8;
  game.championDefeated = true;
  game.campaign = {
    startRegion: 'kanto', johtoBadges: [], johtoLeague: 0, kantoLeague: 5, redDefeated: false,
    expansion: {
      hoenn: { badges: [...badges], league: 5 },
      sinnoh: { badges: [...badges], league: 5 },
      unova: { badges: [...badges], league: 5 },
      kalos: { badges: [...badges], league: 5 },
      alola: { badges: badges.slice(0, 7), league: 0 },
    },
  };
  game.claimedRegionalStarters = ['kanto', 'johto', 'hoenn', 'sinnoh', 'unova', 'kalos', 'alola'];
  return game;
}

describe('Alola final trial progression', () => {
  it('lets a seven-trial player enter Vast Poni Canyon and start the eighth trial', () => {
    const game = gameBeforeFinalAlolaTrial();
    const world = new OpenWorldSimulation(graph, game, 76_003);
    world.changeRegion('alola');
    const atlas = getWorldAtlas('alola');
    const path = atlas.locations.find(location => location.id === 'ancient-poni-path')!;
    const canyon = atlas.locations.find(location => location.id === 'vast-poni-canyon')!;

    expect(atlas.evaluateTraversal(path, canyon, 7)).toMatchObject({ allowed: true, location: canyon });
    expect(atlas.safeArrival(canyon.id, 7)).toEqual({ x: canyon.x, z: canyon.z });

    world.player = { x: canyon.x, z: canyon.z, heading: 0 };
    Object.assign(world.entities.find(entity => entity.kind === 'companion')!, world.player);
    expect(world.locationAt(world.player.x, world.player.z).id).toBe('vast-poni-canyon');
    expect(world.challengeLocalGym()).toBe(true);
    expect(game.battle).toMatchObject({ kind: 'gym', campaignRegion: 'alola', gymBadge: 8 });
    expect(() => validateGame(game)).not.toThrow();
    expect(restoreGame(serializeGame(game)).battle).toMatchObject({ kind: 'gym', campaignRegion: 'alola', gymBadge: 8 });
  });
});
