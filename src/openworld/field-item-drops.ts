import fieldItemsJson from '../data/field-items.json' with { type: 'json' };

export type FieldItemTier = 'common' | 'uncommon' | 'rare';
export type FieldItemCategory = 'battle' | 'berry' | 'support';
export type FieldItem = { id: string; name: string; kind: 'held-tool' | 'mega-stone'; tier?: FieldItemTier; category?: FieldItemCategory; formIdentifier?: string; speciesId?: number };
export type FieldItemDrop = FieldItem & { quantity: 1 };

/** Per-capture chance of one held tool, by its catalog tier. */
export const HELD_TOOL_CAPTURE_RATES: Readonly<Record<FieldItemTier, number>> = { common: .15, uncommon: .08, rare: .04 };
/** Roadside pickup weight of one held tool, by its catalog tier. */
export const HELD_TOOL_PICKUP_WEIGHTS: Readonly<Record<FieldItemTier, number>> = { common: 4, uncommon: 2, rare: 1 };
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
  charcoal: [58, 59, 77, 78],
  'mystic-water': [54, 55, 183, 184],
  'miracle-seed': [43, 44, 102],
  magnet: [81, 82, 462],
  'never-melt-ice': [220, 221, 361, 87],
  'black-belt': [56, 57, 106],
  'poison-barb': [13, 14, 15, 211],
  'soft-sand': [27, 28, 50, 51],
  'sharp-beak': [21, 22, 84, 85],
  'twisted-spoon': [96, 97, 280],
  'silver-powder': [12, 48, 49],
  'hard-stone': [95, 213, 299, 524],
  'spell-tag': [92, 93, 200],
  'dragon-fang': [147, 148, 371],
  'black-glasses': [198, 228, 229],
  'iron-plate': [208, 227, 304, 374],
  'silk-scarf': [19, 20, 161, 263],
  'fairy-feather': [35, 36, 175, 209],
  'expert-belt': [447, 448, 237],
  'muscle-band': [107, 236],
  'wise-glasses': [177, 178],
  'shell-bell': [90, 91],
  'black-sludge': [88, 89, 568, 569],
  'rocky-helmet': [597, 598],
  'assault-vest': [111, 112, 464],
  eviolite: [133, 137, 233],
  'big-root': [69, 70, 71],
  'white-herb': [420, 421],
  'bright-powder': [267, 269],
  'wide-lens': [193, 469],
  'quick-claw': [215, 461],
  'focus-band': [296, 297],
  'air-balloon': [425, 426],
  'weakness-policy': [246, 247, 248],
  'oran-berry': [10, 11, 16, 17],
  'sitrus-berry': [46, 47, 357],
  'lum-berry': [163, 164],
  'amulet-coin': [52, 53, 999, 1000],
  'lucky-egg': [113, 242, 440],
  everstone: [74, 75],
  'smoke-ball': [109, 110],
};

for (const item of catalog) {
  if (item.kind !== 'held-tool') continue;
  if (!item.tier || !HELD_TOOL_CAPTURE_RATES[item.tier] || !HELD_TOOL_SOURCE_FAMILIES[item.id]?.length) throw new Error(`Held tool is missing tier or sources: ${item.id}`);
}

export function fieldItemCatalog(): readonly FieldItem[] { return catalog; }
export function getFieldItem(itemId: string): FieldItem | undefined { return byId.get(itemId); }
export function heldToolCaptureRate(item: FieldItem): number { return item.kind === 'held-tool' && item.tier ? HELD_TOOL_CAPTURE_RATES[item.tier] : 0; }
export function heldToolPickupWeight(item: FieldItem): number { return item.kind === 'held-tool' && item.tier ? HELD_TOOL_PICKUP_WEIGHTS[item.tier] : 1; }

/** Held tools keep their own tier rate; Mega forms of one species split the Mega rate. */
export function captureItemChances(speciesId: number): Array<FieldItem & { chance: number }> {
  if (!Number.isInteger(speciesId) || speciesId < 1) return [];
  const held = catalog.filter(item => item.kind === 'held-tool' && HELD_TOOL_SOURCE_FAMILIES[item.id]?.includes(speciesId));
  const stones = catalog.filter(item => item.kind === 'mega-stone' && item.speciesId === speciesId);
  return [
    ...held.map(item => ({ ...item, chance: heldToolCaptureRate(item) })),
    ...stones.map(item => ({ ...item, chance: MEGA_STONE_CAPTURE_RATE / stones.length })),
  ];
}

/** Rolls only after a successful capture and can award at most one of that species' declared items. */
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
