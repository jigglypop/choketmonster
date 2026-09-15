import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/core/brain';
import { createGame, createMonster } from '../src/game/engine';
import { getLegacyExpansionAtlas, getWorldAtlas, type LegacyExpansionRegion, type WorldAtlas } from '../src/openworld/atlas';
import { OpenWorldSimulation, restoreOpenWorld, serializeOpenWorld, type OpenWorldSnapshot } from '../src/openworld/simulation';
import { surfaceSceneId } from '../src/openworld/world-space';

const graph = JSON.parse(readFileSync('public/data/connectome.json', 'utf8')) as Graph;

function walkablePoints(atlas: WorldAtlas, count: number): Array<{ x: number; z: number }> {
  const points: Array<{ x: number; z: number }> = [];
  for (const location of atlas.locations) {
    for (let dx = -4; dx <= 4 && points.length < count; dx += .5) for (let dz = -4; dz <= 4 && points.length < count; dz += .5) {
      const point = { x: location.x + dx, z: location.z + dz };
      if (!atlas.sample(point.x, point.z).blocked && !points.some(other => other.x === point.x && other.z === point.z)) points.push(point);
    }
    if (points.length === count) break;
  }
  if (points.length !== count) throw new Error(`Legacy ${atlas.id} fixture needs ${count} walkable points`);
  return points;
}

function moveToLegacyAtlas(snapshot: OpenWorldSnapshot, regionId: LegacyExpansionRegion, version: 1 | 2): OpenWorldSnapshot {
  const atlas = getLegacyExpansionAtlas(regionId, `${regionId}-atlas-v${version}`)!;
  const points = walkablePoints(atlas, snapshot.entities.length + snapshot.foods.length + (snapshot.respawnQueue?.length ?? 0) + 2);
  snapshot.regionId = regionId; snapshot.mapVersion = atlas.mapVersion; snapshot.sceneId = surfaceSceneId(regionId);
  snapshot.player = { ...points[0], heading: snapshot.player.heading }; snapshot.spawnAnchor = { ...points[1] };
  snapshot.entities.forEach((entity, index) => Object.assign(entity, points[index + 2]));
  snapshot.foods.forEach((food, index) => Object.assign(food, points[index + snapshot.entities.length + 2]));
  snapshot.respawnQueue?.forEach((pending, index) => {
    const point = points[index + snapshot.entities.length + snapshot.foods.length + 2];
    pending.originX = point.x; pending.originZ = point.z;
  });
  return snapshot;
}

describe('legacy expansion atlas saves', () => {
  it('restores a Hoenn atlas-v1 save into the authored map while preserving individuals and collection records', () => {
    const game = createGame(1, 'legacy-hoenn-v1');
    const owned = createMonster(game, 280, 18); game.player.box.push(owned);
    game.player.badges = 8; game.defeatedGyms = [1,2,3,4,5,6,7,8]; game.championDefeated = true;
    game.campaign = { startRegion: 'kanto', johtoBadges: [], johtoLeague: 0, kantoLeague: 5, redDefeated: false };
    game.dex.seen = [...new Set([...game.dex.seen, 280])]; game.dex.caught = [...new Set([...game.dex.caught, 280])];
    game.versionCaught ??= {}; game.versionCaught.emerald = [280];
    const source = new OpenWorldSimulation(graph, game, 81_001);
    const snapshot = moveToLegacyAtlas(source.snapshot(), 'hoenn', 1);
    expect(getLegacyExpansionAtlas('hoenn', snapshot.mapVersion)!.sample(snapshot.player.x, snapshot.player.z).blocked).toBe(false);
    expect(getWorldAtlas('hoenn').sample(snapshot.player.x, snapshot.player.z).blocked).toBe(true);
    snapshot.visitedTownIds = ['littleroot', 'rustboro'];
    snapshot.visitedTownsByRegion = { kanto: ['pallet'], hoenn: ['littleroot', 'rustboro'], sinnoh: ['twinleaf', 'jubilife-city'] };
    const brains = new Map(snapshot.entities.map(entity => [entity.id, structuredClone(entity.brain)]));
    const packed = JSON.parse(serializeOpenWorld(game, source)); packed.world = snapshot;

    const restored = restoreOpenWorld(graph, JSON.stringify(packed));
    const current = restored.simulation.snapshot();
    expect(restored.simulation.regionId).toBe('hoenn');
    expect(current.mapVersion).toBe(getWorldAtlas('hoenn').mapVersion);
    expect(current.visitedTownIds).toEqual(['littleroot-town', 'rustboro-city']);
    expect(current.visitedTownsByRegion).toMatchObject({
      hoenn: ['littleroot-town', 'rustboro-city'], sinnoh: ['twinleaf-town', 'jubilife-city'],
    });
    expect(current.entities.map(entity => entity.id)).toEqual(snapshot.entities.map(entity => entity.id));
    for (const entity of current.entities) expect(entity.brain, entity.id).toEqual(brains.get(entity.id));
    expect(restored.game.player.box.some(monster => monster.instanceId === owned.instanceId && monster.speciesId === 280)).toBe(true);
    expect(restored.game.dex.caught).toContain(280); expect(restored.game.versionCaught?.emerald).toEqual([280]);
    expect(getWorldAtlas('hoenn').sample(current.player.x, current.player.z).blocked).toBe(false);
  });

  it('validates a locked Sinnoh atlas-v2 save, then returns it to Johto without losing its active battle or records', () => {
    const game = createGame(1, 'legacy-sinnoh-v2');
    game.campaign = { startRegion: 'johto', johtoBadges: [], johtoLeague: 0, kantoLeague: 0, redDefeated: false };
    const owned = createMonster(game, 393, 20); game.player.box.push(owned);
    game.dex.seen = [...new Set([...game.dex.seen, 393])]; game.dex.caught = [...new Set([...game.dex.caught, 393])];
    game.versionCaught ??= {}; game.versionCaught.platinum = [393];
    const source = new OpenWorldSimulation(graph, game, 81_002);
    const wild = source.entities.find(entity => entity.kind === 'wild')!;
    expect(source.startEncounter(wild.id)).toBe(true);
    const snapshot = moveToLegacyAtlas(source.snapshot(), 'sinnoh', 2);
    snapshot.visitedTownIds = ['twinleaf', 'oreburgh'];
    snapshot.visitedTownsByRegion = { johto: ['new-bark'], sinnoh: ['twinleaf', 'oreburgh'], unova: ['nuvema', 'nuvema-town'] };
    const battle = structuredClone(game.battle), brains = new Map(snapshot.entities.map(entity => [entity.id, structuredClone(entity.brain)]));
    const packed = JSON.parse(serializeOpenWorld(game, source)); packed.world = snapshot;

    const restored = restoreOpenWorld(graph, JSON.stringify(packed));
    const current = restored.simulation.snapshot();
    expect(restored.simulation.regionId).toBe('johto');
    expect(current.mapVersion).toBe(getWorldAtlas('johto').mapVersion);
    expect(current.player).toEqual({ ...getWorldAtlas('johto').start, heading: 0 });
    expect(current.visitedTownsByRegion).toMatchObject({
      sinnoh: ['twinleaf-town', 'oreburgh-city'], unova: ['nuvema-town'], johto: ['new-bark'],
    });
    expect(restored.game.battle).toEqual(battle); expect(current.battleWildId).toBe(wild.id);
    expect(current.entities.map(entity => entity.id)).toEqual(snapshot.entities.map(entity => entity.id));
    for (const entity of current.entities) expect(entity.brain, entity.id).toEqual(brains.get(entity.id));
    expect(restored.game.player.box.some(monster => monster.instanceId === owned.instanceId && monster.speciesId === 393)).toBe(true);
    expect(restored.game.dex.caught).toContain(393); expect(restored.game.versionCaught?.platinum).toEqual([393]);
  });

  it('does not accept an unknown town disguised as a legacy expansion visit', () => {
    const game = createGame(1, 'legacy-town-validation');
    const source = new OpenWorldSimulation(graph, game, 81_003);
    const snapshot = source.snapshot(); snapshot.visitedTownsByRegion = { hoenn: ['not-a-real-town'] };
    const packed = JSON.parse(serializeOpenWorld(game, source)); packed.world = snapshot;
    expect(() => restoreOpenWorld(graph, JSON.stringify(packed))).toThrow(/regional visited towns/);
  });
});
