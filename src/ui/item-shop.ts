import { evolutionItemUses, HEALING_ITEM_HP, HELD_TOOLS, HELD_TOOL_DESCRIPTIONS, ITEM_LABELS, ITEM_PRICES, SHOP_ITEMS, type GameState, type HeldTool, type InventoryItem } from '../game/engine';

export type ShopCategory = 'all' | 'recovery' | 'growth' | 'evolution' | 'held';
const categories: Record<ShopCategory, string> = { all: '전체', recovery: '회복', growth: '성장', evolution: '진화', held: '배틀 도구' };
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
export function itemCategory(item: InventoryItem): ShopCategory {
  if (HELD_TOOLS.includes(item as HeldTool)) return 'held';
  if (item === 'potion' || item === 'super-potion') return 'recovery';
  if (item === 'rare-candy' || item.endsWith('-treat')) return 'growth';
  return 'evolution';
}
export function itemShopHtml(game: GameState, category: ShopCategory): string {
  const items = SHOP_ITEMS.filter(item => category === 'all' || itemCategory(item) === category);
  return `<div class="page shop-page"><section class="section-heading"><h1>모험 상점</h1><strong class="wallet">₩${game.player.money.toLocaleString('ko-KR')}</strong></section>
    <nav class="shop-categories" aria-label="물품 분류">${Object.entries(categories).map(([id, label]) => `<button data-shop-category="${id}" class="${category === id ? 'active' : ''}" aria-pressed="${category === id}">${label}</button>`).join('')}</nav>
    <div class="shop-grid">${items.map(item => {
      const kind = itemCategory(item), max = Math.min(99, Math.floor(game.player.money / ITEM_PRICES[item]));
      const description = kind === 'held' ? HELD_TOOL_DESCRIPTIONS[item as HeldTool] : item === 'potion' || item === 'super-potion' ? `HP +${HEALING_ITEM_HP[item]}` : item === 'rare-candy' ? '레벨 +1' : evolutionItemUses(item);
      return `<article class="shop-card" data-shop-item="${item}"><div><strong>${ITEM_LABELS[item]}</strong><small>보유 ${game.inventory[item]}개</small></div><b>₩${ITEM_PRICES[item].toLocaleString('ko-KR')}</b>${description ? `<details class="item-detail"><summary>${kind === 'evolution' ? '사용 대상' : '효과'}</summary><small>${escape(description)}</small></details>` : ''}<div class="shop-purchase"><input data-buy-quantity="${item}" aria-label="${ITEM_LABELS[item]} 구매 수량" type="number" min="1" max="${Math.max(1, max)}" value="1" ${!max ? 'disabled' : ''}><button data-buy="${item}" ${!max ? 'disabled' : ''}>구매</button></div></article>`;
    }).join('')}</div><section class="center-banner"><h2>무료 회복</h2><button id="shop-heal" class="primary" ${game.battle ? 'disabled' : ''}>팀 회복</button></section></div>`;
}
