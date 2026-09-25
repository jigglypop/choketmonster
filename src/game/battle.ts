import type { PokemonMove, PokemonType } from './contracts';
import type { EquippableItem } from './engine';
import { abilityImmunity, hasSturdy, lowHpPowerMultiplier, type MonsterAbility } from './individual-traits';

export type Combatant = {
  level: number;
  hp: number;
  stats: { hp: number; attack: number; defense: number; specialAttack: number; specialDefense: number; speed: number };
  types: readonly PokemonType[];
  status?: string;
  ability?: MonsterAbility;
  heldTool?: EquippableItem;
};

/** Type-boosting held tools: +20% power for moves of the matching type. */
export const TYPE_BOOST_TOOLS: Readonly<Record<PokemonType, EquippableItem>> = {
  normal: 'silk-scarf', fire: 'charcoal', water: 'mystic-water', electric: 'magnet', grass: 'miracle-seed', ice: 'never-melt-ice',
  fighting: 'black-belt', poison: 'poison-barb', ground: 'soft-sand', flying: 'sharp-beak', psychic: 'twisted-spoon', bug: 'silver-powder',
  rock: 'hard-stone', ghost: 'spell-tag', dragon: 'dragon-fang', dark: 'black-glasses', steel: 'iron-plate', fairy: 'fairy-feather',
};

/** Offensive held-tool multiplier after the type matchup is known. */
export function heldToolPowerMultiplier(tool: EquippableItem | undefined, move: Pick<PokemonMove, 'type' | 'damageClass'>, matchup: number): number {
  if (!tool) return 1;
  if (tool === 'life-orb') return 1.3;
  if (TYPE_BOOST_TOOLS[move.type] === tool) return 1.2;
  if (tool === 'expert-belt') return matchup > 1 ? 1.2 : 1;
  if (tool === 'muscle-band') return move.damageClass === 'physical' ? 1.1 : 1;
  if (tool === 'wise-glasses') return move.damageClass === 'special' ? 1.1 : 1;
  return 1;
}

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

/** Source ailments the engine resolves. Major ones persist; volatile ones end with a switch or the battle. */
export const MAJOR_AILMENTS: ReadonlySet<string> = new Set(['sleep', 'freeze', 'paralysis', 'poison', 'burn']);
export const VOLATILE_AILMENTS: ReadonlySet<string> = new Set(['confusion', 'trap', 'leech-seed']);
/** Other source ailments (Protect, Disable, Attract...) have no local effect and are never stored. */
export function implementedAilment(ailment: string | undefined): string | undefined {
  return ailment && (MAJOR_AILMENTS.has(ailment) || VOLATILE_AILMENTS.has(ailment)) ? ailment : undefined;
}

export function typeMultiplier(attack: PokemonType, defenders: readonly PokemonType[]): number {
  return defenders.reduce((total, defense) => total * (effectiveness[attack]?.[defense] ?? 1), 1);
}

export function calculateDamage(attacker: Combatant, defender: Combatant, move: PokemonMove, randomFactor = 1): {
  damage: number; multiplier: number; abilityActivation?: 'immunity' | 'absorb' | 'sturdy' | 'focus-sash' | 'air-balloon';
} {
  if (move.damageClass === 'status' || move.power <= 0) return { damage: 0, multiplier: 1 };
  const immunity = abilityImmunity(defender.ability, move.type);
  if (immunity) return { damage: 0, multiplier: 0, abilityActivation: immunity.heal ? 'absorb' : 'immunity' };
  if (move.type === 'ground' && defender.heldTool === 'air-balloon') return { damage: 0, multiplier: 0, abilityActivation: 'air-balloon' };
  const rawAttack = move.damageClass === 'physical' ? attacker.stats.attack : attacker.stats.specialAttack;
  const attack = move.damageClass === 'physical' && attacker.status === 'burn' ? Math.max(1, Math.floor(rawAttack / 2)) : rawAttack;
  const defense = Math.max(1, move.damageClass === 'physical' ? defender.stats.defense : defender.stats.specialDefense);
  const stab = attacker.types.includes(move.type) ? 1.5 : 1;
  const multiplier = typeMultiplier(move.type, defender.types);
  if (multiplier === 0) return { damage: 0, multiplier };
  const abilityPower = lowHpPowerMultiplier(attacker.ability, attacker.hp, attacker.stats.hp, move.type);
  const base = (((2 * attacker.level / 5 + 2) * move.power * attack / defense) / 50) + 2;
  const toolPower = heldToolPowerMultiplier(attacker.heldTool, move, multiplier);
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
  quickClaw: { player?: boolean; enemy?: boolean } = {},
): 'player' | 'enemy' {
  if (playerMove.priority !== enemyMove.priority) return playerMove.priority > enemyMove.priority ? 'player' : 'enemy';
  if (!!quickClaw.player !== !!quickClaw.enemy) return quickClaw.player ? 'player' : 'enemy';
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
