import { Brain, type BrainState, type Graph } from '../core/brain';
import { BREEDING_SPECIES, BREEDING_DATA_SOURCE } from '../data/breeding.generated';
import { getMove, getSpecies, POKEMON } from '../data/pokemon';
import { getVersionSpeciesIds } from '../data/pokemon-versions';
import type { GameState, Monster } from './engine';
import { initialEvolutionProgress } from './evolution-progress';

export type MonsterGender = 'male' | 'female' | 'genderless';
export type Egg = {
  eggId: string;
  speciesId: number;
  parentIds: [string, string];
  steps: number;
  requiredSteps: number;
  brain: BrainState;
  createdAtStep: number;
};

export const MAX_NURSERY_EGGS = 6;
export const EGG_STEP_FACTOR = 256;
export { BREEDING_DATA_SOURCE };

function hash(text: string): number {
  let value = 2166136261;
  for (const character of text) { value ^= character.charCodeAt(0); value = Math.imul(value, 16777619); }
  return value >>> 0;
}

export function genderFor(speciesId: number, instanceId: string): MonsterGender {
  const rate = BREEDING_SPECIES[speciesId]?.genderRate;
  if (rate === -1) return 'genderless';
  if (!Number.isInteger(rate) || rate < 0 || rate > 8) throw new Error('성별 원본 데이터가 올바르지 않습니다.');
  return hash(`${speciesId}:${instanceId}:gender`) % 8 < rate ? 'female' : 'male';
}

export function eggGroupsFor(speciesId: number): readonly number[] {
  return BREEDING_SPECIES[speciesId]?.eggGroups ?? [];
}

export function isValidGender(speciesId: number, gender: unknown): gender is MonsterGender {
  const rate = BREEDING_SPECIES[speciesId]?.genderRate;
  if (rate === -1) return gender === 'genderless';
  if (rate === 0) return gender === 'male';
  if (rate === 8) return gender === 'female';
  return gender === 'male' || gender === 'female';
}

export function validateEgg(value: unknown): Egg {
  const egg = value as Egg;
  const data = BREEDING_SPECIES[egg?.speciesId];
  if (!egg || !/^egg-[A-Za-z0-9_.-]+$/.test(egg.eggId) || !data || !Array.isArray(egg.parentIds) || egg.parentIds.length !== 2
    || egg.parentIds.some(id => typeof id !== 'string' || !id || id.length > 120) || egg.parentIds[0] === egg.parentIds[1]
    || !Number.isSafeInteger(egg.steps) || egg.steps < 0 || !Number.isSafeInteger(egg.requiredSteps)
    || egg.requiredSteps !== EGG_STEP_FACTOR * (data.hatchCounter + 1) || egg.steps > egg.requiredSteps
    || !Number.isSafeInteger(egg.createdAtStep) || egg.createdAtStep < 1) throw new Error('알 저장 데이터가 손상되었습니다.');
  Brain.restore(egg.brain);
  return egg;
}

function baseSpeciesId(speciesId: number): number {
  let current = speciesId;
  const visited = new Set<number>();
  while (!visited.has(current)) {
    visited.add(current);
    const parent = POKEMON.find(species => species.evolutions.some(evolution => evolution.target === current));
    if (!parent) break;
    current = parent.id;
  }
  return current;
}

export function breedingCompatibility(first: Monster, second: Monster): { compatible: boolean; offspringSpeciesId?: number; reason: string } {
  if (first.instanceId === second.instanceId) return { compatible: false, reason: '서로 다른 두 개체를 골라야 합니다.' };
  const dittoFirst = first.speciesId === 132, dittoSecond = second.speciesId === 132;
  if (dittoFirst && dittoSecond) return { compatible: false, reason: '메타몽끼리는 알을 만들 수 없습니다.' };
  const firstGroups = eggGroupsFor(first.speciesId), secondGroups = eggGroupsFor(second.speciesId);
  if (firstGroups.includes(15) || secondGroups.includes(15)) return { compatible: false, reason: '미발견 알그룹은 교배할 수 없습니다.' };
  if (dittoFirst || dittoSecond) {
    const parent = dittoFirst ? second : first;
    return { compatible: true, offspringSpeciesId: baseSpeciesId(parent.speciesId), reason: '메타몽과 교배할 수 있습니다.' };
  }
  if (first.gender === undefined) first.gender = genderFor(first.speciesId, first.instanceId);
  if (second.gender === undefined) second.gender = genderFor(second.speciesId, second.instanceId);
  if (first.gender === 'genderless' || second.gender === 'genderless') return { compatible: false, reason: '성별 없는 개체는 메타몽과만 교배할 수 있습니다.' };
  if (first.gender === second.gender) return { compatible: false, reason: '암컷과 수컷 한 마리씩 필요합니다.' };
  if (!firstGroups.some(group => secondGroups.includes(group))) return { compatible: false, reason: '공유하는 알그룹이 없습니다.' };
  const mother = first.gender === 'female' ? first : second;
  return { compatible: true, offspringSpeciesId: baseSpeciesId(mother.speciesId), reason: '함께 알을 만들 수 있습니다.' };
}

export function createEgg(state: GameState, firstId: string, secondId: string, graph: Graph): Egg {
  state.nursery ??= [];
  if (state.nursery.length >= MAX_NURSERY_EGGS) throw new Error(`알은 최대 ${MAX_NURSERY_EGGS}개까지 맡길 수 있습니다.`);
  const owned = [...state.player.team, ...state.player.box];
  const first = owned.find(monster => monster.instanceId === firstId), second = owned.find(monster => monster.instanceId === secondId);
  if (!first || !second) throw new Error('교배할 개체를 찾지 못했습니다.');
  const compatibility = breedingCompatibility(first, second);
  if (!compatibility.compatible || !compatibility.offspringSpeciesId) throw new Error(compatibility.reason);
  const eggId = `egg-${state.nextInstanceId++}`;
  const seed = hash(`${state.seed}:${eggId}:${firstId}:${secondId}`);
  let offspringSpeciesId = compatibility.offspringSpeciesId;
  // Canonical paired-species exceptions are not expressible by a simple evolution-root lookup.
  // Reference implementation: https://github.com/pret/pokeplatinum/blob/main/src/overlay005/daycare.c
  if ([489, 490].includes(offspringSpeciesId)) offspringSpeciesId = 489; // Manaphy/Phione -> Phione
  else if ([29, 32].includes(offspringSpeciesId)) offspringSpeciesId = seed % 2 ? 29 : 32; // Nidoran♀/♂
  else if ([313, 314].includes(offspringSpeciesId)) offspringSpeciesId = seed % 2 ? 313 : 314; // Volbeat/Illumise
  const speciesData = BREEDING_SPECIES[offspringSpeciesId];
  const requiredSteps = EGG_STEP_FACTOR * (speciesData.hatchCounter + 1);
  const offspringBrain = new Brain(seed, graph); offspringBrain.state.sensoryBypass = false;
  const egg: Egg = { eggId, speciesId: offspringSpeciesId, parentIds: [firstId, secondId], steps: 0, requiredSteps,
    brain: offspringBrain.snapshot(), createdAtStep: state.nextInstanceId };
  state.nursery.push(egg);
  state.logs.push(`${getSpecies(egg.speciesId).name}의 알을 받았습니다.`);
  return egg;
}

export function advanceEggProgress(state: GameState, steps: number): Egg[] {
  if (!Number.isSafeInteger(steps) || steps < 0 || steps > 100_000) throw new Error('알 걸음 수가 올바르지 않습니다.');
  if (!steps || !state.nursery?.length) return [];
  const ready: Egg[] = [];
  for (const egg of state.nursery) {
    const wasReady = egg.steps >= egg.requiredSteps;
    egg.steps = Math.min(egg.requiredSteps, egg.steps + steps);
    if (!wasReady && egg.steps >= egg.requiredSteps) ready.push(egg);
  }
  return ready;
}

export function hatchEgg(state: GameState, eggId: string): Monster {
  const index = state.nursery?.findIndex(egg => egg.eggId === eggId) ?? -1;
  if (index < 0) throw new Error('알을 찾지 못했습니다.');
  const egg = state.nursery![index];
  if (egg.steps < egg.requiredSteps) throw new Error('아직 부화할 만큼 걷지 않았습니다.');
  if (state.player.team.length >= 6 && state.player.box.length >= 10_000) throw new Error('팀과 박스에 빈자리가 필요합니다.');
  const species = getSpecies(egg.speciesId), stats = {
      hp: Math.floor(2 * species.baseStats.hp / 100) + 11,
      attack: Math.floor(2 * species.baseStats.attack / 100) + 5,
      defense: Math.floor(2 * species.baseStats.defense / 100) + 5,
      specialAttack: Math.floor(2 * species.baseStats.specialAttack / 100) + 5,
      specialDefense: Math.floor(2 * species.baseStats.specialDefense / 100) + 5,
      speed: Math.floor(2 * species.baseStats.speed / 100) + 5,
    };
  const moves = species.moves.filter(move => move.level <= 1)
    .filter((move, moveIndex, entries) => entries.findIndex(other => other.moveId === move.moveId) === moveIndex).slice(-4)
    .map(move => ({ moveId: move.moveId, pp: getMove(move.moveId).pp }));
  const monster: Monster = { instanceId: `mon-${state.nextInstanceId++}`, speciesId: egg.speciesId, nickname: species.name,
    gender: genderFor(egg.speciesId, egg.eggId), level: 1, xp: 0, hp: stats.hp, stats, moves, brain: egg.brain };
  monster.evolutionProgress = initialEvolutionProgress(monster);
  if (state.player.team.length < 6) state.player.team.push(monster); else state.player.box.push(monster);
  state.nursery!.splice(index, 1);
  state.dex.seen = [...new Set([...state.dex.seen, monster.speciesId])].sort((a, b) => a - b);
  state.dex.caught = [...new Set([...state.dex.caught, monster.speciesId])].sort((a, b) => a - b);
  const version = state.adventureVersion ?? 'red';
  state.versionCaught ??= {};
  if (getVersionSpeciesIds(version).includes(monster.speciesId)) state.versionCaught[version] = [...new Set([...(state.versionCaught[version] ?? []), monster.speciesId])].sort((a, b) => a - b);
  state.logs.push(`${monster.nickname}이(가) 알에서 태어났습니다. 개체별 새 회로 상태를 가집니다.`);
  return monster;
}
