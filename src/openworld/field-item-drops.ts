import fieldItemsJson from '../data/field-items.json' with { type: 'json' };

export type FieldItem = { id: string; name: string; kind: 'held-tool' | 'mega-stone'; formIdentifier?: string; speciesId?: number };
export type FieldItemDrop = FieldItem & { quantity: 1 };

export const HELD_TOOL_CAPTURE_RATE = .12;
export const MEGA_STONE_CAPTURE_RATE = .04;
export const FIELD_ITEM_STOCK_LIMIT = 1_000_000_000;

const catalog = fieldItemsJson as FieldItem[];
const byId = new Map(catalog.map(item => [item.id, item]));

/** Explicit families keep every held tool tied to a recognizable Pokemon source. */
export const HELD_TOOL_SOURCE_FAMILIES: Readonly<Record<string, readonly number[]>> = {
  leftovers: [446, 143],
  'choice-band': [66, 67, 68],
  'choice-specs': [63, 64, 65],
  'choice-scarf': [52, 53, 863],
  'life-orb': [32, 33, 34],
  'focus-sash': [359],
};

export function fieldItemCatalog(): readonly FieldItem[] { return catalog; }
export function getFieldItem(itemId: string): FieldItem | undefined { return byId.get(itemId); }

export function captureItemChances(speciesId: number): Array<FieldItem & { chance: number }> {
  if (!Number.isInteger(speciesId) || speciesId < 1) return [];
  const held = catalog.filter(item => item.kind === 'held-tool' && HELD_TOOL_SOURCE_FAMILIES[item.id]?.includes(speciesId));
  const stones = catalog.filter(item => item.kind === 'mega-stone' && item.speciesId === speciesId);
  return [
    ...held.map(item => ({ ...item, chance: HELD_TOOL_CAPTURE_RATE / held.length })),
    ...stones.map(item => ({ ...item, chance: MEGA_STONE_CAPTURE_RATE / stones.length })),
  ];
}

/** Rolls only after a successful capture and can award only that species' declared items. */
export function rollCapturedSpeciesItem(random: () => number, speciesId: number): FieldItemDrop | undefined {
  const chances = captureItemChances(speciesId);
  let roll = random();
  for (const item of chances) {
    if (roll < item.chance) { const { chance: _chance, ...source } = item; return { ...source, quantity: 1 }; }
    roll -= item.chance;
  }
  return undefined;
}

export function grantFieldItem(inventory: Record<string, number>, drop: FieldItemDrop): boolean {
  const stock = inventory[drop.id] ?? 0;
  if (!Number.isSafeInteger(stock) || stock < 0 || stock >= FIELD_ITEM_STOCK_LIMIT) return false;
  inventory[drop.id] = stock + drop.quantity;
  return true;
}

export function fieldItemCatalogCounts(): { heldTools: number; megaStones: number } {
  return { heldTools: catalog.filter(item => item.kind === 'held-tool').length, megaStones: catalog.filter(item => item.kind === 'mega-stone').length };
}
