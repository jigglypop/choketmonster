/** Item IDs and evolution pairs from the pinned PokéAPI source (see docs/evolution-shop.md).
 * These game rules consume the named item directly; source trade/time/gender data stays intact.
 */
export const EXTRA_EVOLUTION_ITEMS = {
  'sun-stone': { name: '태양의돌', price: 3000, sourceId: 80 },
  'shiny-stone': { name: '빛의돌', price: 3000, sourceId: 107 },
  'dusk-stone': { name: '어둠의돌', price: 3000, sourceId: 108 },
  'dawn-stone': { name: '각성의돌', price: 3000, sourceId: 109 },
  'ice-stone': { name: '얼음의돌', price: 3000, sourceId: 885 },
  'metal-coat': { name: '금속코트', price: 4000, sourceId: 210 },
  'kings-rock': { name: '왕의징표석', price: 4000, sourceId: 198 },
  'dragon-scale': { name: '용의비늘', price: 4000, sourceId: 212 },
  'up-grade': { name: '업그레이드', price: 4000, sourceId: 229 },
  protector: { name: '프로텍터', price: 4000, sourceId: 298 },
  electirizer: { name: '에레키부스터', price: 4000, sourceId: 299 },
  magmarizer: { name: '마그마부스터', price: 4000, sourceId: 300 },
  'dubious-disc': { name: '괴상한패치', price: 4000, sourceId: 301 },
  'reaper-cloth': { name: '영계의천', price: 4000, sourceId: 302 },
  'deep-sea-tooth': { name: '심해의이빨', price: 4000, sourceId: 203 },
  'deep-sea-scale': { name: '심해의비늘', price: 4000, sourceId: 204 },
  'prism-scale': { name: '고운비늘', price: 4000, sourceId: 580 },
  'razor-claw': { name: '예리한손톱', price: 4000, sourceId: 303 },
  'razor-fang': { name: '예리한이빨', price: 4000, sourceId: 304 },
  'oval-stone': { name: '동글동글돌', price: 3000, sourceId: 110 },
  'galarica-cuff': { name: '가라두구팔찌', price: 4000, sourceId: 1633 },
  'galarica-wreath': { name: '가라두구머리장식', price: 4000, sourceId: 1643 },
  'black-augurite': { name: '검은휘석', price: 4000, sourceId: 2230 },
  'peat-block': { name: '피트블록', price: 4000, sourceId: 2231 },
  sachet: { name: '향기주머니', price: 4000, sourceId: 687 },
  'whipped-dream': { name: '휘핑팝', price: 4000, sourceId: 686 },
  'tart-apple': { name: '새콤한사과', price: 3000, sourceId: 1175 },
  'sweet-apple': { name: '달콤한사과', price: 3000, sourceId: 1174 },
  'syrupy-apple': { name: '꿀맛사과', price: 3000, sourceId: 2109 },
  'cracked-pot': { name: '깨진포트', price: 3000, sourceId: 1311 },
  'chipped-pot': { name: '이빠진포트', price: 3000, sourceId: 1312 },
  'metal-alloy': { name: '복합금속', price: 4000, sourceId: 2232 },
  'scroll-of-darkness': { name: '악의 족자', price: 4000, sourceId: 1675 },
  'scroll-of-waters': { name: '물의 족자', price: 4000, sourceId: 1676 },
  'auspicious-armor': { name: '축복받은갑옷', price: 4000, sourceId: 2045 },
  'malicious-armor': { name: '저주받은갑옷', price: 4000, sourceId: 1677 },
  'unremarkable-teacup': { name: '범작찻잔', price: 3000, sourceId: 2110 },
  'masterpiece-teacup': { name: '걸작찻잔', price: 3000, sourceId: 2111 },
  'evolution-catalyst': { name: '특수진화 캡슐', price: 5000, sourceId: 0 },
  'friendship-treat': { name: '친밀도 간식', price: 500, sourceId: 0 },
  'beauty-treat': { name: '아름다움 간식', price: 500, sourceId: 0 },
  'affection-treat': { name: '애정 간식', price: 500, sourceId: 0 },
} as const;
export type ExtraEvolutionItem = keyof typeof EXTRA_EVOLUTION_ITEMS;
export const EXTRA_EVOLUTION_ITEM_IDS = Object.keys(EXTRA_EVOLUTION_ITEMS) as ExtraEvolutionItem[];
export const EXTRA_EVOLUTION_PRICES = Object.fromEntries(EXTRA_EVOLUTION_ITEM_IDS.map(id => [id, EXTRA_EVOLUTION_ITEMS[id].price])) as Record<ExtraEvolutionItem, number>;
export const EXTRA_EVOLUTION_LABELS = Object.fromEntries(EXTRA_EVOLUTION_ITEM_IDS.map(id => [id, EXTRA_EVOLUTION_ITEMS[id].name])) as Record<ExtraEvolutionItem, string>;
export const emptyExtraEvolutionInventory = () => Object.fromEntries(EXTRA_EVOLUTION_ITEM_IDS.map(id => [id, 0])) as Record<ExtraEvolutionItem, number>;

// Explicit pairs avoid admitting unrelated special evolutions or alternate regional forms.
export const ITEM_EVOLUTION_RULES: readonly { from: number; to: number; item: ExtraEvolutionItem | 'link-cable' }[] = [
  { from: 95, to: 208, item: 'metal-coat' }, { from: 123, to: 212, item: 'metal-coat' },
  { from: 61, to: 186, item: 'kings-rock' }, { from: 79, to: 199, item: 'kings-rock' },
  { from: 117, to: 230, item: 'dragon-scale' }, { from: 137, to: 233, item: 'up-grade' },
  { from: 112, to: 464, item: 'protector' }, { from: 125, to: 466, item: 'electirizer' },
  { from: 126, to: 467, item: 'magmarizer' }, { from: 233, to: 474, item: 'dubious-disc' },
  { from: 356, to: 477, item: 'reaper-cloth' }, { from: 349, to: 350, item: 'prism-scale' },
  { from: 366, to: 367, item: 'deep-sea-tooth' }, { from: 366, to: 368, item: 'deep-sea-scale' },
  { from: 207, to: 472, item: 'razor-fang' }, { from: 215, to: 461, item: 'razor-claw' },
  { from: 440, to: 113, item: 'oval-stone' },
  { from: 281, to: 475, item: 'dawn-stone' }, { from: 361, to: 478, item: 'dawn-stone' },
  { from: 588, to: 589, item: 'link-cable' }, { from: 616, to: 617, item: 'link-cable' },
];
