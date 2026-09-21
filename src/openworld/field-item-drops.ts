import fieldItemsJson from '../data/field-items.json' with { type: 'json' };

export type FieldItem = {
  id: string;
  name: string;
  kind: 'held-tool' | 'mega-stone';
  speciesId?: number;
};

export type FieldItemDrop = FieldItem & { quantity: 1 };

export const HELD_TOOL_DROP_RATE = .05;
export const MEGA_STONE_DROP_RATE = .01;
const TOTAL_DROP_RATE = .06;
export const FIELD_ITEM_STOCK_LIMIT = 1_000_000_000;
const PREFERRED_MEGA_RATE = .6;

const catalog = fieldItemsJson as FieldItem[];
const heldTools = catalog.filter(item => item.kind === 'held-tool');
const megaStones = catalog.filter(item => item.kind === 'mega-stone');

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
}

/** Rolls exactly once per defeated wild Pokemon. Selection consumes the saved world RNG. */
export function rollFieldItemDrop(
  random: () => number,
  wildSpeciesId: number,
  regionalSpeciesIds: readonly number[],
): FieldItemDrop | undefined {
  const roll = random();
  if (roll >= TOTAL_DROP_RATE) return undefined;
  if (roll >= MEGA_STONE_DROP_RATE) return { ...pick(heldTools, random), quantity: 1 };

  const wildMatches = megaStones.filter(item => item.speciesId === wildSpeciesId);
  const regional = new Set(regionalSpeciesIds);
  const regionMatches = megaStones.filter(item => item.speciesId !== undefined && regional.has(item.speciesId));
  const preferred = wildMatches.length ? wildMatches : regionMatches;
  const pool = preferred.length && random() < PREFERRED_MEGA_RATE ? preferred : megaStones;
  return { ...pick(pool, random), quantity: 1 };
}

export function grantFieldItem(inventory: Record<string, number>, drop: FieldItemDrop): boolean {
  const stock = inventory[drop.id] ?? 0;
  if (!Number.isSafeInteger(stock) || stock < 0 || stock >= FIELD_ITEM_STOCK_LIMIT) return false;
  inventory[drop.id] = stock + drop.quantity;
  return true;
}

export function fieldItemCatalogCounts(): { heldTools: number; megaStones: number } {
  return { heldTools: heldTools.length, megaStones: megaStones.length };
}
