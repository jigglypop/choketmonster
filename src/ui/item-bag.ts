import { dungeonReward } from '../data/dungeon-rewards';
import { getSpecies } from '../data/pokemon';
import { TOWN_SHOPS } from '../data/town-shops';
import {
  assignHeldTool, evolutionItemsFor, evolutionItemUses, evolve, HEALING_ITEM_HP, HELD_TOOL_DESCRIPTIONS, HELD_TOOLS, ITEM_LABELS, ITEM_PRICES,
  MEGA_STONES, SHOP_ITEMS, townStock, useItem, type EquippableItem, type GameState, type HeldTool, type InventoryItem, type Monster,
} from '../game/engine';
import { getWorldAtlas } from '../openworld/atlas';
import { DUNGEON_PLANS } from '../openworld/dungeons';
import { getFieldItemSources } from '../openworld/item-sources';
import { particle } from '../openworld/town-npc-plan';
import { pokemonPresentation } from './pokemon-presentation';
import './item-bag.css';

type BagGroup = 'held' | 'mega' | 'recovery' | 'growth' | 'evolution';
type BagFilter = 'owned' | 'all' | BagGroup;
const GROUPS: Record<BagGroup, string> = { held: '지니는 도구', mega: '메가스톤', recovery: '회복', growth: '성장', evolution: '진화' };
const FILTERS: Record<BagFilter, string> = { owned: '보유', all: '전체', ...GROUPS };
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const won = (price: number) => `₩${price.toLocaleString('ko-KR')}`;
const percent = (chance: number) => `${Number((chance * 100).toFixed(2))}%`;
const isHeld = (item: string): item is HeldTool => (HELD_TOOLS as readonly string[]).includes(item);
/** 로 after a vowel or ㄹ, 으로 after any other final consonant. */
const toward = (word: string) => { const code = word.charCodeAt(word.length - 1) - 0xac00, last = code >= 0 && code < 11172 ? code % 28 : 0; return `${word}${last && last !== 8 ? '으로' : '로'}`; };

/** Basic balls are unlimited, so the bag leaves them out. */
function groupOf(item: InventoryItem): BagGroup | undefined {
  if (item.endsWith('-ball')) return undefined;
  if (item.startsWith('mega-stone:')) return 'mega';
  if (isHeld(item)) return 'held';
  if (item === 'potion' || item === 'super-potion') return 'recovery';
  if (item === 'rare-candy' || item.endsWith('-treat')) return 'growth';
  return 'evolution';
}
const BAG_ITEMS = (Object.keys(ITEM_PRICES) as InventoryItem[]).filter(item => groupOf(item));

let filter: BagFilter = 'owned', selected: InventoryItem | undefined;

function effectText(item: InventoryItem): string {
  if (isHeld(item)) return HELD_TOOL_DESCRIPTIONS[item];
  const stone = MEGA_STONES.find(candidate => candidate.id === item);
  if (stone) return `${getSpecies(stone.speciesId).name} 메가진화`;
  if (item === 'potion' || item === 'super-potion') return `HP +${HEALING_ITEM_HP[item]}`;
  if (item === 'rare-candy') return '레벨 +1';
  return evolutionItemUses(item);
}

/** Every way to get an item: the adventure shop, town counters, captures, roadsides and first dungeon clears. */
function sourcesOf(item: InventoryItem): Array<[string, string[]]> {
  const groups: Array<[string, string[]]> = [];
  if (SHOP_ITEMS.includes(item)) groups.push(['모험 상점', [won(ITEM_PRICES[item])]]);
  const towns = Object.entries(TOWN_SHOPS).flatMap(([regionId, byTown]) => Object.keys(byTown).flatMap(townId => townStock(regionId, townId)
    .filter(entry => entry.kind === 'item' && entry.id === item).map(entry => {
      const atlas = getWorldAtlas(regionId), town = atlas.locations.find(place => place.id === townId);
      return `${atlas.name} · ${town?.name ?? townId} · ${entry.shop} · ${won(entry.price)}${entry.requiredBadges ? ` (배지 ${entry.requiredBadges})` : ''}`;
    })));
  if (towns.length) groups.push(['마을 상점', towns]);
  const field = getFieldItemSources(item);
  if (field?.captures.length) groups.push(['포획 보상', field.captures.map(capture => `${capture.speciesNames.join(' · ')} ${percent(capture.chance)}`)]);
  if (field?.roadside.length) {
    const byRegion = new Map<string, string[]>();
    for (const place of field.roadside) byRegion.set(place.regionId, [...byRegion.get(place.regionId) ?? [], `${place.name}${place.requiredBadges ? ` (배지 ${place.requiredBadges})` : ''}`]);
    groups.push(['길가에서 줍기', [...byRegion].map(([regionId, names]) => `${getWorldAtlas(regionId).name} · ${[...new Set(names)].join(' · ')}`)]);
  }
  const dungeons = DUNGEON_PLANS.filter(plan => dungeonReward(plan.regionId, plan.id, 0).items.includes(item)).map(plan => `${getWorldAtlas(plan.regionId).name} · ${plan.name}`);
  if (dungeons.length) groups.push(['던전 첫 돌파', dungeons]);
  return groups;
}

/** Hands an item to a Pokémon: held tools and stones are worn, medicine and treats are used, stones evolve. */
export function giveItem(game: GameState, item: InventoryItem, monster: Monster, region: Parameters<typeof useItem>[4]): string {
  const name = ITEM_LABELS[item], group = groupOf(item);
  if (group === 'held' || group === 'mega') {
    assignHeldTool(game, monster.instanceId, item as EquippableItem);
    return `${monster.nickname}에게 ${particle(name, '을', '를')} 지니게 했습니다.`;
  }
  if (group === 'recovery' || group === 'growth') {
    useItem(game, item, monster.instanceId, 1, item === 'rare-candy' ? region : undefined);
    return `${monster.nickname}에게 ${particle(name, '을', '를')} 썼습니다.`;
  }
  const evolution = getSpecies(monster.speciesId).evolutions.find(candidate => evolutionItemsFor(monster.speciesId, candidate).includes(item));
  if (!evolution) throw new Error(`${monster.nickname}에게는 ${particle(name, '을', '를')} 쓸 수 없습니다.`);
  const before = monster.nickname;
  evolve(game, monster.instanceId, { targetId: evolution.target, item });
  return `${particle(before, '이', '가')} ${toward(getSpecies(evolution.target).name)} 진화했습니다.`;
}

export function itemBagHtml(game: GameState): string {
  const owned = (item: InventoryItem) => game.inventory[item] ?? 0;
  const visible = BAG_ITEMS.filter(item => filter === 'all' ? true : filter === 'owned' ? owned(item) > 0 : groupOf(item) === filter)
    .sort((a, b) => Number(owned(b) > 0) - Number(owned(a) > 0));
  if (!selected || !visible.includes(selected)) selected = visible[0];
  const sections = (Object.keys(GROUPS) as BagGroup[]).map(group => {
    const items = visible.filter(item => groupOf(item) === group);
    return items.length ? `<section class="bag-group"><h2>${GROUPS[group]}</h2><div class="bag-grid">${items.map(item => `<button type="button" class="bag-item bag-kind-${group}${owned(item) ? '' : ' is-empty'}${item === selected ? ' is-selected' : ''}" data-bag-item="${escape(item)}"><i aria-hidden="true"></i><strong>${escape(ITEM_LABELS[item])}</strong><span>${owned(item)}</span></button>`).join('')}</div></section>` : '';
  }).join('') || '<p class="bag-empty">없음</p>';
  const team = game.player.team.map(monster => {
    const presentation = pokemonPresentation(monster, game.battle), held = monster.heldTool;
    return `<div class="bag-target" data-bag-target="${escape(monster.instanceId)}" role="button" tabindex="0" aria-label="${escape(monster.nickname)}"><img src="${presentation.sprite}" alt=""><div><strong>${escape(presentation.name)}</strong><small>Lv.${monster.level} · HP ${monster.hp}/${presentation.stats.hp}</small>${held ? `<span class="bag-held"><em>${escape(ITEM_LABELS[held])}</em><button type="button" data-bag-unequip="${escape(monster.instanceId)}" aria-label="${escape(ITEM_LABELS[held])} 해제">×</button></span>` : ''}</div></div>`;
  }).join('');
  const detail = selected ? (() => {
    const sources = sourcesOf(selected), effect = effectText(selected);
    return `<header><span class="bag-dot bag-kind-${groupOf(selected)}" aria-hidden="true"></span><div><h2>${escape(ITEM_LABELS[selected])}</h2><small>${GROUPS[groupOf(selected)!]} · 보유 ${owned(selected)}개</small></div></header>`
      + (effect ? `<section><h3>효과</h3><p>${escape(effect)}</p></section>` : '')
      + `<section><h3>획득처</h3>${sources.length ? sources.map(([label, rows]) => `<div class="bag-source"><b>${label}</b>${rows.map(row => `<p>${escape(row)}</p>`).join('')}</div>`).join('') : '<p>없음</p>'}</section>`;
  })() : '';
  return `<div class="page bag-page"><section class="section-heading"><h1>물품</h1></section><div class="bag-layout">`
    + `<section class="bag-panel panel"><nav class="bag-filters" aria-label="물품 분류">${(Object.keys(FILTERS) as BagFilter[]).map(id => `<button type="button" data-bag-filter="${id}" aria-pressed="${filter === id}">${FILTERS[id]}</button>`).join('')}</nav>${sections}</section>`
    + `<aside class="bag-side"><section class="bag-team panel"><h2>팀</h2><div class="bag-team-list">${team}</div></section><section class="bag-detail panel" aria-live="polite">${detail}</section></aside></div></div>`;
}

export type ItemBagActions = { give(item: InventoryItem, instanceId: string): void; unequip(instanceId: string): void; rerender(): void };

/** Pick an item to read about it; drag it onto a team member, or pick it and then tap the member, to hand it over. */
export function bindItemBag(root: HTMLElement, actions: ItemBagActions): void {
  root.querySelectorAll<HTMLButtonElement>('[data-bag-filter]').forEach(button => button.onclick = () => { filter = button.dataset.bagFilter as BagFilter; actions.rerender(); });
  root.querySelectorAll<HTMLButtonElement>('[data-bag-unequip]').forEach(button => button.onclick = event => { event.stopPropagation(); actions.unequip(button.dataset.bagUnequip!); });
  root.querySelectorAll<HTMLElement>('[data-bag-target]').forEach(target => {
    const give = () => { if (selected) actions.give(selected, target.dataset.bagTarget!); };
    target.onclick = give;
    target.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); give(); } };
  });
  root.querySelectorAll<HTMLButtonElement>('[data-bag-item]').forEach(card => card.onpointerdown = down => {
    if (down.button !== 0) return;
    const item = card.dataset.bagItem as InventoryItem, start = { x: down.clientX, y: down.clientY };
    let ghost: HTMLElement | undefined, over: HTMLElement | undefined;
    const move = (event: PointerEvent) => {
      if (!ghost && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6 && !card.classList.contains('is-empty')) {
        ghost = card.cloneNode(true) as HTMLElement; ghost.classList.add('bag-ghost'); document.body.append(ghost); root.classList.add('bag-dragging');
      }
      if (!ghost) return;
      ghost.style.transform = `translate(${event.clientX}px, ${event.clientY}px) translate(-50%, -50%)`;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-bag-target]') ?? undefined;
      if (target !== over) { over?.classList.remove('is-over'); over = target; over?.classList.add('is-over'); }
    };
    const finish = (event: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish);
      over?.classList.remove('is-over'); root.classList.remove('bag-dragging');
      if (ghost) { ghost.remove(); if (event.type === 'pointerup' && over) actions.give(item, over.dataset.bagTarget!); return; }
      if (event.type === 'pointerup') { selected = item; actions.rerender(); }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
  });
}
