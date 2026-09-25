import { evolutionItemUses, HEALING_ITEM_HP, ITEM_LABELS, ITEM_PRICES, SHOP_ITEMS, townStock, type GameState, type InventoryItem } from '../game/engine';

export type ShopCategory = 'all' | 'recovery' | 'growth' | 'evolution';
const categories: Record<ShopCategory, string> = { all: '전체', recovery: '회복', growth: '성장', evolution: '진화' };
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
export function itemCategory(item: InventoryItem): ShopCategory {
  if (item === 'potion' || item === 'super-potion') return 'recovery';
  if (item === 'rare-candy' || item.endsWith('-treat')) return 'growth';
  return 'evolution';
}
/** The town the player stands in: its own counters, each with what only it sells. */
export type ShopTown = { regionId: string; townId: string; name: string; badges: number };
function townShopHtml(game: GameState, town: ShopTown): string {
  const stock = townStock(town.regionId, town.townId);
  if (!stock.length) return '';
  const counters = [...new Set(stock.map(entry => entry.shop))];
  return `<section class="town-shop" aria-label="${escape(town.name)}"><h2>${escape(town.name)}</h2>${counters.map(counter => `<div class="town-shop-counter"><h3>${escape(counter)}</h3><div class="shop-grid">${stock.filter(entry => entry.shop === counter).map(entry => {
    const owned = entry.kind === 'machine' ? game.technicalMachines?.[String(entry.id)] ?? 0 : game.inventory[entry.id as InventoryItem] ?? 0;
    const locked = town.badges < entry.requiredBadges, max = entry.kind === 'machine' ? 1 : Math.min(99, Math.floor(game.player.money / entry.price));
    const key = `${entry.kind}:${entry.id}`, affordable = game.player.money >= entry.price;
    return `<article class="shop-card town-shop-card"><div><strong>${escape(entry.name)}</strong><small>보유 ${owned}개${locked ? ` · 배지 ${entry.requiredBadges}개` : ''}</small></div><b>₩${entry.price.toLocaleString('ko-KR')}</b><div class="shop-purchase">${entry.kind === 'item' ? `<input data-town-quantity="${escape(key)}" aria-label="${escape(entry.name)} 구매 수량" type="number" min="1" max="${Math.max(1, max)}" value="1" ${locked || !affordable ? 'disabled' : ''}>` : ''}<button data-town-buy="${escape(key)}" ${locked || !affordable ? 'disabled' : ''}>구매</button></div></article>`;
  }).join('')}</div></div>`).join('')}</section>`;
}

export function itemShopHtml(game: GameState, category: ShopCategory, town?: ShopTown): string {
  const items = SHOP_ITEMS.filter(item => category === 'all' || itemCategory(item) === category);
  return `<div class="page shop-page"><section class="section-heading"><h1>모험 상점</h1><strong class="wallet">₩${game.player.money.toLocaleString('ko-KR')}</strong></section>${town ? townShopHtml(game, town) : ''}
    <nav class="shop-categories" aria-label="물품 분류">${Object.entries(categories).map(([id, label]) => `<button data-shop-category="${id}" class="${category === id ? 'active' : ''}" aria-pressed="${category === id}">${label}</button>`).join('')}</nav>
    <div class="shop-grid">${items.map(item => {
      const kind = itemCategory(item), max = Math.min(99, Math.floor(game.player.money / ITEM_PRICES[item]));
      const description = item === 'potion' || item === 'super-potion' ? `HP +${HEALING_ITEM_HP[item]}` : item === 'rare-candy' ? '레벨 +1' : evolutionItemUses(item);
      return `<article class="shop-card" data-shop-item="${item}"><div><strong>${ITEM_LABELS[item]}</strong><small>보유 ${game.inventory[item]}개</small></div><b>₩${ITEM_PRICES[item].toLocaleString('ko-KR')}</b>${description ? `<details class="item-detail"><summary>${kind === 'evolution' ? '사용 대상' : '효과'}</summary><small>${escape(description)}</small></details>` : ''}<div class="shop-purchase"><input data-buy-quantity="${item}" aria-label="${ITEM_LABELS[item]} 구매 수량" type="number" min="1" max="${Math.max(1, max)}" value="1" ${!max ? 'disabled' : ''}><button data-buy="${item}" ${!max ? 'disabled' : ''}>구매</button></div></article>`;
    }).join('')}</div><section class="center-banner"><h2>무료 회복</h2><button id="shop-heal" class="primary" ${game.battle ? 'disabled' : ''}>팀 회복</button></section></div>`;
}
