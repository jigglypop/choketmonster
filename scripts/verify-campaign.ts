import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { calculateDamage } from '../src/game/battle.ts';
import { getMove, getSpecies } from '../src/data/pokemon.ts';
import { ConnectomeController } from '../src/game/connectome.ts';
import {
  actBattle, availableEvolutions, buyItem, challengeChampion, challengeGym, createGame, depositMonster, evolve, explore, heal,
  ITEM_PRICES, serializeGame, useItem,
  withdrawMonster, type BallItem, type BattleAction, type GameState, type InventoryItem, type Monster,
} from '../src/game/engine.ts';
import { REGIONS, speciesEncounterSources } from '../src/game/regions.ts';
import { defaultView, packSave } from '../src/game/storage.ts';
import type { Graph } from '../src/core/brain.ts';

type Mode = 'smoke' | 'full';
type GymResult = { badge: number; regionId: string; attempts: number; outcome: 'won' | 'lost' };
type CampaignReport = {
  schema: 1; mode: Mode; seed: string; startedAt: string; elapsedMs: number;
  limits: { explorations: number; battleTurns: number; elapsedMs: number };
  counters: { explorations: number; battleTurns: number; externalBrainDecisions: number; captures: number; evolutions: number; rareCandiesUsed: number };
  graph: { id: string; nodes: number; edges: number };
  policy: string; encounteredSpecies: number[]; caughtSpecies: number[];
  evolutionMethods: string[]; gymResults: GymResult[]; championResult: 'won' | 'lost' | 'not-attempted'; championAttempts: number;
  completed: boolean; failReason?: string; finalCheckpoint: ReturnType<typeof packSave>;
};

const GYM_REGIONS = REGIONS.filter(region => region.gym);
const EVOLUTION_ITEMS = new Set<InventoryItem>(['fire-stone', 'water-stone', 'thunder-stone', 'leaf-stone', 'moon-stone', 'link-cable']);

function owned(state: GameState): Monster[] { return [...state.player.team, ...state.player.box]; }
function healthySwitch(state: GameState): number {
  return state.player.team.findIndex(monster => monster.hp > 0 && monster !== state.battle!.player.team[state.battle!.player.activeIndex]);
}
function activePlayer(state: GameState): Monster { return state.battle!.player.team[state.battle!.player.activeIndex]; }
function activeEnemy(state: GameState): Monster { return state.battle!.enemy.team[state.battle!.enemy.activeIndex]; }

function estimatedDamage(attacker: Monster, defender: Monster, moveIndex: number): number {
  const slot = attacker.moves[moveIndex];
  if (!slot || slot.pp <= 0) return 0;
  const move = getMove(slot.moveId);
  if (move.power <= 0) return 0;
  return calculateDamage(
    { level: attacker.level, hp: attacker.hp, stats: attacker.stats, types: getSpecies(attacker.speciesId).types, status: attacker.status },
    { level: defender.level, hp: defender.hp, stats: defender.stats, types: getSpecies(defender.speciesId).types, status: defender.status },
    move, 0.925,
  ).damage;
}

function strongestMove(attacker: Monster, defender: Monster): number {
  const candidates = attacker.moves.map((_slot, index) => ({ index, damage: estimatedDamage(attacker, defender, index) }));
  candidates.sort((a, b) => b.damage - a.damage || a.index - b.index);
  return candidates[0]?.index ?? 0;
}

function captureMove(attacker: Monster, defender: Monster): number | undefined {
  const margin = Math.max(1, defender.hp - Math.ceil(defender.stats.hp * 0.2));
  const candidates = attacker.moves.map((_slot, index) => ({ index, damage: estimatedDamage(attacker, defender, index) }))
    .filter(candidate => candidate.damage > 0 && candidate.damage < margin)
    .sort((a, b) => b.damage - a.damage || a.index - b.index);
  return candidates[0]?.index;
}

function bestBall(state: GameState): BallItem | undefined {
  return state.inventory['poke-ball'] > 0 ? 'poke-ball' : undefined;
}

function buySupplies(state: GameState, mode: Mode): void {
  const desiredBalls = mode === 'full' ? 30 : 12;
  const ball: BallItem = 'poke-ball';
  const current = state.inventory['poke-ball'] + state.inventory['great-ball'] + state.inventory['ultra-ball'];
  const affordable = Math.floor(state.player.money / ITEM_PRICES[ball]);
  const quantity = Math.min(Math.max(0, desiredBalls - current), Math.max(0, affordable - 1));
  if (quantity > 0) buyItem(state, ball, quantity);
  if (state.player.badges >= 3) {
    const needed = Math.max(0, 8 - state.inventory['super-potion']);
    const healing = Math.min(needed, Math.floor(state.player.money / ITEM_PRICES['super-potion']));
    if (healing > 0) buyItem(state, 'super-potion', healing);
  } else if (state.inventory.potion < 2 && state.player.money >= ITEM_PRICES.potion * 2) buyItem(state, 'potion', 2);
}

function tryEvolutions(state: GameState, methods: Set<string>): number {
  let count = 0;
  for (const monster of owned(state)) {
    const species = getSpecies(monster.speciesId);
    for (const candidate of species.evolutions) {
      let item: InventoryItem | undefined;
      if (candidate.method === 'trade') item = 'link-cable';
      else if (candidate.method === 'stone') item = candidate.item?.replaceAll('_', '-').replaceAll(' ', '-') as InventoryItem;
      if (item && EVOLUTION_ITEMS.has(item) && state.inventory[item] <= 0 && state.player.money >= ITEM_PRICES[item]) buyItem(state, item, 1);
      const ready = availableEvolutions(state, monster.instanceId).find(entry => entry.target === candidate.target);
      if (!ready) continue;
      evolve(state, monster.instanceId, { targetId: candidate.target, item });
      methods.add(candidate.method); count++;
      break;
    }
  }
  return count;
}

function prepareChampionTeam(state: GameState): void {
  while (state.player.team.length > 1) depositMonster(state, 1);
  while (state.player.team.length < 6 && state.player.box.length) {
    const best = state.player.box.reduce((bestIndex, monster, index, box) => {
      const score = monster.level * 10_000 + monster.stats.hp * 10 + monster.stats.specialDefense + monster.stats.defense;
      const prior = box[bestIndex];
      const priorScore = prior.level * 10_000 + prior.stats.hp * 10 + prior.stats.specialDefense + prior.stats.defense;
      return score > priorScore ? index : bestIndex;
    }, 0);
    withdrawMonster(state, best);
  }
}

function choosePlayerAction(state: GameState, wantCapture: boolean): BattleAction {
  const battle = state.battle!;
  if (battle.awaitingSwitch) {
    const index = state.player.team.findIndex(monster => monster.hp > 0);
    return { type: 'switch', index };
  }
  const player = activePlayer(state), enemy = activeEnemy(state);
  if (player.hp / player.stats.hp < 0.2) {
    if (state.inventory['super-potion'] > 0) return { type: 'item', item: 'super-potion', targetInstanceId: player.instanceId };
    if (state.inventory.potion > 0) return { type: 'item', item: 'potion', targetInstanceId: player.instanceId };
    const replacement = healthySwitch(state);
    if (replacement >= 0) return { type: 'switch', index: replacement };
  }
  if (wantCapture) {
    const ball = bestBall(state);
    if (!ball) return { type: 'run' };
    if (enemy.hp / enemy.stats.hp <= 0.25 || player.hp / player.stats.hp < 0.35) return { type: 'catch', ball };
    const move = captureMove(player, enemy);
    if (move !== undefined) return { type: 'move', index: move };
    return { type: 'catch', ball };
  }
  return { type: 'move', index: strongestMove(player, enemy) };
}

export async function runCampaign(mode: Mode, seed: string, graph: Graph): Promise<CampaignReport> {
  const limits = mode === 'full'
    ? { explorations: 30_000, battleTurns: 300_000, elapsedMs: 10 * 60_000 }
    : { explorations: 2_000, battleTurns: 20_000, elapsedMs: 2 * 60_000 };
  const started = Date.now();
  const state = createGame(7, seed);
  const controller = new ConnectomeController(graph);
  const counters = { explorations: 0, battleTurns: 0, externalBrainDecisions: 0, captures: 0, evolutions: 0, rareCandiesUsed: 0 };
  const methods = new Set<string>();
  const gymResults: GymResult[] = [];
  let championResult: CampaignReport['championResult'] = 'not-attempted';
  let championAttempts = 0;
  let failReason: string | undefined;

  const guard = () => {
    if (counters.explorations >= limits.explorations) throw new Error(`exploration limit ${limits.explorations}`);
    if (counters.battleTurns >= limits.battleTurns) throw new Error(`battle-turn limit ${limits.battleTurns}`);
    if (Date.now() - started >= limits.elapsedMs) throw new Error(`elapsed-time limit ${limits.elapsedMs}ms`);
  };
  const fight = (wantCapture: boolean): 'won' | 'lost' | 'caught' | 'escaped' => {
    while (state.battle) {
      guard();
      const enemy = activeEnemy(state), player = activePlayer(state);
      const decision = controller.choose(enemy, player, state.battle.turn, null, false);
      counters.externalBrainDecisions++;
      const result = actBattle(state, choosePlayerAction(state, wantCapture), decision.rawAction);
      counters.battleTurns++;
      if (result.outcome) {
        if (result.outcome === 'caught') counters.captures++;
        return result.outcome;
      }
    }
    throw new Error('battle ended without an outcome');
  };
  const exploreOnce = (regionId: string, captureNew = true) => {
    guard(); buySupplies(state, mode);
    const result = explore(state, regionId);
    counters.explorations++;
    if (result.kind === 'encounter') {
      const shouldCapture = captureNew && !state.dex.caught.includes(result.speciesId!);
      fight(shouldCapture);
      if (!state.battle) heal(state);
      counters.evolutions += tryEvolutions(state, methods);
    }
    while (!state.battle && state.inventory['rare-candy'] > 0 && state.player.team[0].level < 100) {
      useItem(state, 'rare-candy', state.player.team[0].instanceId); counters.rareCandiesUsed++;
      counters.evolutions += tryEvolutions(state, methods);
    }
  };

  try {
    const gymTarget = mode === 'full' ? 8 : 1;
    while (state.player.badges < gymTarget) {
      const region = GYM_REGIONS[state.player.badges];
      const targetLevel = region.gym!.level + 6;
      while (state.player.team[0].level < targetLevel) await exploreOnce(region.id);
      buySupplies(state, mode); heal(state);
      const badge = region.gym!.badge;
      const priorAttempts = gymResults.filter(result => result.badge === badge).length;
      challengeGym(state, region.id);
      const outcome = fight(false);
      gymResults.push({ badge, regionId: region.id, attempts: priorAttempts + 1, outcome: outcome === 'won' ? 'won' : 'lost' });
      if (outcome !== 'won') heal(state);
    }

    if (mode === 'full') {
      while (!state.championDefeated && championAttempts < 15) {
        const targetLevel = Math.min(100, 94 + championAttempts * 3);
        while (state.player.team[0].level < targetLevel) await exploreOnce(GYM_REGIONS[7].id);
        prepareChampionTeam(state); buySupplies(state, mode); heal(state); challengeChampion(state); championAttempts++;
        championResult = fight(false) === 'won' ? 'won' : 'lost';
        if (championResult === 'lost') heal(state);
      }
      if (!state.championDefeated) throw new Error(`champion battle lost after ${championAttempts} attempts`);

      while (state.dex.caught.length < 151) {
        const missing = Array.from({ length: 151 }, (_, index) => index + 1).filter(id => !state.dex.caught.includes(id));
        const sources = speciesEncounterSources(missing[0]);
        const source = sources.find(region => state.player.badges >= region.minBadges);
        if (!source) throw new Error(`no unlocked encounter source for species ${missing[0]}`);
        await exploreOnce(source.id, true);
      }
    } else {
      while (state.dex.caught.length < 2 || state.player.team[0].level < 16 || !methods.has('level')) await exploreOnce(GYM_REGIONS[0].id);
    }
  } catch (error) {
    failReason = error instanceof Error ? error.message : String(error);
  }

  const completeTarget = mode === 'full'
    ? state.player.badges === 8 && state.championDefeated && state.dex.caught.length === 151
    : state.player.badges >= 1 && state.dex.caught.length >= 2 && methods.has('level');
  if (!completeTarget && !failReason) failReason = 'target not reached';
  const finalCheckpoint = packSave(state, graph, defaultView());
  // Exercise the production serializer too; no campaign field is edited directly.
  serializeGame(state);
  return {
    schema: 1, mode, seed, startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started, limits, counters,
    graph: { id: graph.id, nodes: graph.nodes.length, edges: graph.edges.length },
    policy: 'Public-state heuristic: strongest estimated damage for wins; for a new wild species, prefer the strongest predicted non-KO hit then the cheapest suitable available ball; heal or switch at low HP; buy published-price balls/healing/evolution items; before the champion, use production PC functions to select the strongest legitimately caught party. Opponent action is ConnectomeController.choose on the real graph with learning disabled.',
    encounteredSpecies: state.dex.seen, caughtSpecies: state.dex.caught, evolutionMethods: [...methods].sort(),
    gymResults, championResult, championAttempts, completed: completeTarget, failReason, finalCheckpoint,
  };
}

async function main() {
  const modeIndex = process.argv.indexOf('--mode');
  const mode = (modeIndex >= 0 ? process.argv[modeIndex + 1] : 'smoke') as Mode;
  if (!['smoke', 'full'].includes(mode)) throw new Error('--mode must be smoke or full');
  const seedIndex = process.argv.indexOf('--seed');
  const seed = seedIndex >= 0 ? process.argv[seedIndex + 1] : 'campaign-fixed-v1';
  const outIndex = process.argv.indexOf('--out');
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  const output = resolve(outIndex >= 0 ? process.argv[outIndex + 1] : `artifacts/campaign-${mode}-${stamp}.json`);
  const graph = JSON.parse(await readFile(resolve('public/data/connectome.json'), 'utf8')) as Graph;
  const report = await runCampaign(mode, seed, graph);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, finalCheckpoint: '[archived in report]' }, null, 2));
  console.log(`wrote ${output}`);
  if (!report.completed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
