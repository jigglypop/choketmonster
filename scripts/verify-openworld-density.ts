import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Graph } from '../src/core/brain.ts';
import { createGame, createMonster } from '../src/game/engine.ts';
import type { FieldPolicy } from '../src/game/field.ts';
import { OpenWorldSimulation, biomeForSpecies, nextSpeciesInBiome, restoreOpenWorld, sampleWorld, serializeOpenWorld, speciesForSpawn, type WorldBiome } from '../src/openworld/simulation.ts';

const SEEDS = [4_401, 4_501, 4_601];
const distance = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const weights = (entity: { brain: { inputWeights: number[][]; readout: number[][]; updates: number } }) => ({
  inputWeights: entity.brain.inputWeights,
  readout: entity.brain.readout,
  updates: entity.brain.updates,
});

async function main() {
  const graph = JSON.parse(await readFile(resolve('public/data/connectome.json'), 'utf8')) as Graph;
  const policy = JSON.parse(await readFile(resolve('public/data/openworld-policy.json'), 'utf8')) as FieldPolicy;

  const perSeed = SEEDS.map(seed => {
    const game = createGame(1, `density-${seed}`), world = new OpenWorldSimulation(graph, game, seed, undefined, policy); world.setAutoHunt(false);
    const initial = { radius18: world.nearbyWildCount(18), radius25: world.nearbyWildCount(25) };
    const initialWeights = new Map(world.entities.map(entity => [entity.id, structuredClone(weights(entity))]));
    const journeys = [{ x: 0, z: -60, heading: 2 }, { x: 0, z: 0, heading: 2 }, { x: 24, z: 28, heading: 1 }].map(anchor => {
      if (!world.movePlayer(anchor)) throw new Error(`Seed ${seed} rejected travel anchor`);
      for (let tick = 0; tick < 7; tick++) world.step({ deltaSeconds: .5, learning: false });
      const nearby = world.entities.filter(entity => entity.kind === 'wild' && distance(entity, world.player) <= 25);
      return {
        anchor,
        radius18: world.nearbyWildCount(18),
        radius25: nearby.length,
        safe: nearby.every(entity => !sampleWorld(entity.x, entity.z).blocked && sampleWorld(entity.x, entity.z).biome === biomeForSpecies(entity.speciesId)),
        minimumDistance: Math.min(...nearby.map(entity => distance(entity, world.player))),
        maximumDistance: Math.max(...nearby.map(entity => distance(entity, world.player))),
      };
    });
    const frozenWeights = world.entities.every(entity => {
      const expected = initialWeights.get(entity.id) ?? { inputWeights: policy.inputWeights, readout: policy.readout, updates: 0 };
      return JSON.stringify(weights(entity)) === JSON.stringify(expected);
    });
    const checkpoint = serializeOpenWorld(game, world), a = restoreOpenWorld(graph, checkpoint, policy), b = restoreOpenWorld(graph, checkpoint, policy);
    const traceA = Array.from({ length: 12 }, () => a.simulation.step({ deltaSeconds: .4, learning: false }));
    const traceB = Array.from({ length: 12 }, () => b.simulation.step({ deltaSeconds: .4, learning: false }));
    return {
      seed,
      initial,
      journeys,
      roster: world.rosterStatus(),
      frozenWeights,
      exactReplay: JSON.stringify(traceA) === JSON.stringify(traceB) && serializeOpenWorld(a.game, a.simulation) === serializeOpenWorld(b.game, b.simulation),
      checkpoint,
      trace: traceA,
    };
  });

  // Emulate a schema-1 checkpoint made before the density timer existed and before
  // the initial roster was grouped by biome. Restore must rebalance on its first tick.
  const legacyGame = createGame(1, 'density-legacy-save'), source = new OpenWorldSimulation(graph, legacyGame, 5_501, undefined, policy); source.setAutoHunt(false);
  const legacy = source.snapshot(); delete legacy.densityRemaining;
  legacy.entities.filter(entity => entity.kind === 'wild').forEach((entity, index) => { entity.speciesId = speciesForSpawn(index + 1); });
  legacy.player = { x: 0, z: -60, heading: 2 };
  const restoredLegacy = new OpenWorldSimulation(graph, legacyGame, 5_501, legacy, policy);
  restoredLegacy.step({ deltaSeconds: .1, learning: false });
  const legacyNearby = restoredLegacy.entities.filter(entity => entity.kind === 'wild' && distance(entity, restoredLegacy.player) <= 25);

  const respawnGame = createGame(1, 'density-close-respawn'); respawnGame.player.team = [createMonster(respawnGame, 1, 50)];
  const respawnWorld = new OpenWorldSimulation(graph, respawnGame, 6_501, undefined, policy); respawnWorld.setAutoHunt(false);
  const target = respawnWorld.entities.find(entity => entity.kind === 'wild' && entity.level <= 3)!;
  const idsBefore = new Set(respawnWorld.entities.map(entity => entity.id)); respawnWorld.startEncounter(target.id);
  for (let turn = 0; turn < 500 && respawnGame.battle; turn++) respawnWorld.step({ deltaSeconds: 1, learning: false });
  const queued = respawnWorld.rosterStatus().pending;
  for (let tick = 0; tick < 70 && respawnWorld.rosterStatus().pending > 0; tick++) respawnWorld.step({ deltaSeconds: .1, learning: false });
  const replacement = respawnWorld.entities.find(entity => entity.kind === 'wild' && !idsBefore.has(entity.id));

  const biomeReachability = (['meadow', 'forest', 'lake', 'rock'] as WorldBiome[]).map(biome => {
    const species = Array.from({ length: 151 }, (_, index) => index + 1).filter(speciesId => biomeForSpecies(speciesId) === biome);
    const reached = new Set<number>(); let cursor = species[0];
    for (let count = 0; count < species.length; count++) { reached.add(cursor); cursor = nextSpeciesInBiome(cursor); }
    return { biome, species: species.length, reached: reached.size, fullCycle: reached.size === species.length && cursor === species[0] };
  });

  const checks = {
    initialDensity: perSeed.every(row => row.initial.radius18 >= 7),
    travelDensity: perSeed.every(row => row.journeys.every(journey => journey.radius25 >= 4 && journey.safe)),
    safeMinimum: perSeed.every(row => row.journeys.every(journey => journey.minimumDistance >= 3)),
    frozenWeights: perSeed.every(row => row.frozenWeights),
    exactReplay: perSeed.every(row => row.exactReplay),
    oldSaveImmediateDensity: legacyNearby.length >= 4,
    oldSaveRosterBound: restoredLegacy.rosterStatus().total === 15,
    closeRespawn: !!replacement && distance(replacement, respawnWorld.player) >= 5 && distance(replacement, respawnWorld.player) <= 15,
    all151Reachable: biomeReachability.every(row => row.fullCycle),
  };
  if (Object.values(checks).some(value => !value)) throw new Error(`Density validation failed: ${JSON.stringify(checks)}`);

  const report = {
    schema: 1,
    model: 'pokemon-open-world-density-v1',
    generatedAt: new Date().toISOString(),
    protocol: { seeds: SEEDS, learning: false, autoHunt: false, wildCount: 15, cadenceSeconds: '2..3', initialRadius: 18, sustainedRadius: 25 },
    perSeed: perSeed.map(({ checkpoint: _checkpoint, trace: _trace, ...row }) => row),
    oldSave: { nearbyWithin25: legacyNearby.length, roster: restoredLegacy.rosterStatus(), safe: legacyNearby.every(entity => !sampleWorld(entity.x, entity.z).blocked) },
    respawn: { queued, replacementId: replacement?.id, speciesId: replacement?.speciesId, distance: replacement ? distance(replacement, respawnWorld.player) : null },
    biomeReachability,
    checks,
    limitations: 'Density relocation and donor replacement are engineered streaming rules. A relocation clears pending learning credit. Frozen evaluation does not claim biological learning.',
  };
  const outIndex = process.argv.indexOf('--out'), outPath = resolve(outIndex >= 0 ? process.argv[outIndex + 1] : 'artifacts/openworld-density-validation-2026-09-11/report.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');
  await writeFile(resolve(dirname(outPath), 'checkpoint.json'), perSeed[0].checkpoint + '\n');
  await writeFile(resolve(dirname(outPath), 'replay-trace.json'), JSON.stringify(perSeed[0].trace, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

await main();
