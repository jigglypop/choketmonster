import type { PokemonMove, PokemonType } from './contracts';
import { abilityImmunity, hasSturdy, lowHpPowerMultiplier, type MonsterAbility } from './individual-traits';

export type Combatant = {
  level: number;
  hp: number;
  stats: { hp: number; attack: number; defense: number; specialAttack: number; specialDefense: number; speed: number };
  types: readonly PokemonType[];
  originalTypes?: readonly PokemonType[];
  teraType?: PokemonType;
  status?: string;
  ability?: MonsterAbility;
  heldTool?: 'leftovers' | 'choice-band' | 'choice-specs' | 'choice-scarf' | 'life-orb' | 'focus-sash';
};

const effectiveness: Partial<Record<PokemonType, Partial<Record<PokemonType, number>>>> = {
  normal: { rock: .5, ghost: 0, steel: .5 },
  fire: { fire: .5, water: .5, grass: 2, ice: 2, bug: 2, rock: .5, dragon: .5, steel: 2 },
  water: { fire: 2, water: .5, grass: .5, ground: 2, rock: 2, dragon: .5 },
  electric: { water: 2, electric: .5, grass: .5, ground: 0, flying: 2, dragon: .5 },
  grass: { fire: .5, water: 2, grass: .5, poison: .5, ground: 2, flying: .5, bug: .5, rock: 2, dragon: .5, steel: .5 },
  ice: { fire: .5, water: .5, grass: 2, ice: .5, ground: 2, flying: 2, dragon: 2, steel: .5 },
  fighting: { normal: 2, ice: 2, poison: .5, flying: .5, psychic: .5, bug: .5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: .5 },
  poison: { grass: 2, poison: .5, ground: .5, rock: .5, ghost: .5, steel: 0, fairy: 2 },
  ground: { fire: 2, electric: 2, grass: .5, poison: 2, flying: 0, bug: .5, rock: 2, steel: 2 },
  flying: { electric: .5, grass: 2, fighting: 2, bug: 2, rock: .5, steel: .5 },
  psychic: { fighting: 2, poison: 2, psychic: .5, dark: 0, steel: .5 },
  bug: { fire: .5, grass: 2, fighting: .5, poison: .5, flying: .5, psychic: 2, ghost: .5, dark: 2, steel: .5, fairy: .5 },
  rock: { fire: 2, ice: 2, fighting: .5, ground: .5, flying: 2, bug: 2, steel: .5 },
  ghost: { normal: 0, psychic: 2, ghost: 2, dark: .5 },
  dragon: { dragon: 2, steel: .5, fairy: 0 },
  dark: { fighting: .5, psychic: 2, ghost: 2, dark: .5, fairy: .5 },
  steel: { fire: .5, water: .5, electric: .5, ice: 2, rock: 2, steel: .5, fairy: 2 },
  fairy: { fire: .5, fighting: 2, poison: .5, dragon: 2, dark: 2, steel: .5 },
};

export function typeMultiplier(attack: PokemonType, defenders: readonly PokemonType[]): number {
  return defenders.reduce((total, defense) => total * (effectiveness[attack]?.[defense] ?? 1), 1);
}

export function resolveTeraMove(attacker: Combatant, source: PokemonMove): PokemonMove {
  if (!attacker.teraType) return source;
  const type = source.id === 851 ? attacker.teraType : source.type;
  const damageClass = source.id === 851 && attacker.stats.attack > attacker.stats.specialAttack ? 'physical' : source.damageClass;
  const multiHit = (source.minHits ?? 0) > 0 && (source.maxHits ?? 0) > 0;
  const power = type === attacker.teraType && source.power > 0 && source.power < 60 && source.priority <= 0 && !multiHit ? 60 : source.power;
  return type === source.type && damageClass === source.damageClass && power === source.power
    ? source : { ...source, type, damageClass, power };
}

export function calculateDamage(attacker: Combatant, defender: Combatant, move: PokemonMove, randomFactor = 1): {
  damage: number; multiplier: number; abilityActivation?: 'immunity' | 'absorb' | 'sturdy' | 'focus-sash';
} {
  move = resolveTeraMove(attacker, move);
  if (move.damageClass === 'status' || move.power <= 0) return { damage: 0, multiplier: 1 };
  const immunity = abilityImmunity(defender.ability, move.type);
  if (immunity) return { damage: 0, multiplier: 0, abilityActivation: immunity.heal ? 'absorb' : 'immunity' };
  const rawAttack = move.damageClass === 'physical' ? attacker.stats.attack : attacker.stats.specialAttack;
  const attack = move.damageClass === 'physical' && attacker.status === 'burn' ? Math.max(1, Math.floor(rawAttack / 2)) : rawAttack;
  const defense = Math.max(1, move.damageClass === 'physical' ? defender.stats.defense : defender.stats.specialDefense);
  const stab = attacker.teraType === move.type ? (attacker.originalTypes?.includes(move.type) ? 2 : 1.5)
    : attacker.teraType ? (attacker.originalTypes?.includes(move.type) ? 1.5 : 1)
      : attacker.types.includes(move.type) ? 1.5 : 1;
  const multiplier = typeMultiplier(move.type, defender.types);
  if (multiplier === 0) return { damage: 0, multiplier };
  const abilityPower = lowHpPowerMultiplier(attacker.ability, attacker.hp, attacker.stats.hp, move.type);
  const base = (((2 * attacker.level / 5 + 2) * move.power * attack / defense) / 50) + 2;
  const toolPower = attacker.heldTool === 'life-orb' ? 1.3 : 1;
  const damage = Math.max(1, Math.floor(base * stab * multiplier * abilityPower * toolPower * randomFactor));
  if ((hasSturdy(defender.ability) || defender.heldTool === 'focus-sash') && defender.hp === defender.stats.hp && damage >= defender.hp) {
    return { damage: Math.max(0, defender.hp - 1), multiplier, abilityActivation: defender.heldTool === 'focus-sash' && !hasSturdy(defender.ability) ? 'focus-sash' : 'sturdy' };
  }
  return { damage, multiplier };
}

export function turnOrder(
  player: Combatant,
  playerMove: PokemonMove,
  enemy: Combatant,
  enemyMove: PokemonMove,
  tieBreaker: number,
): 'player' | 'enemy' {
  if (playerMove.priority !== enemyMove.priority) return playerMove.priority > enemyMove.priority ? 'player' : 'enemy';
  const playerSpeed = player.status === 'paralysis' ? Math.floor(player.stats.speed / 2) : player.stats.speed;
  const enemySpeed = enemy.status === 'paralysis' ? Math.floor(enemy.stats.speed / 2) : enemy.stats.speed;
  if (playerSpeed !== enemySpeed) return playerSpeed > enemySpeed ? 'player' : 'enemy';
  return tieBreaker < .5 ? 'player' : 'enemy';
}

export function catchProbability(maxHp: number, hp: number, catchRate: number, ballMultiplier: number, status?: string): number {
  const healthFactor = Math.max(1, 3 * maxHp - 2 * Math.max(0, hp)) / (3 * Math.max(1, maxHp));
  const statusMultiplier = status === 'sleep' || status === 'freeze' ? 2 : status ? 1.5 : 1;
  return Math.min(.98, Math.max(.01, healthFactor * catchRate / 255 * ballMultiplier * statusMultiplier));
}
