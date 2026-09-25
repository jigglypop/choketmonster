import { getSpecies } from '../data/pokemon';
import type { Evolution } from './contracts';
import { monsterEvolutionItemsFor, evolutionPurchaseQuote, evolutionRoute, ITEM_LABELS, type GameState, type InventoryItem, type Monster } from './engine';
import { evolutionFormSupported, needsSpecialEvolution, sourceEvolutionDescriptions, specialEvolutionLevel } from './evolution-conditions';

const escapeHtml = (value: unknown) => String(value).replace(/[&<>'"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
})[character]!);

function routeButton(state: GameState, monster: Monster, evolution: Evolution, item?: InventoryItem): string {
  const target = getSpecies(evolution.target), route = evolutionRoute(state, monster, evolution, item);
  const quote = evolutionPurchaseQuote(state, monster, evolution, item);
  const requirement = item ? `${ITEM_LABELS[item]} ×1 · 보유 ${state.inventory[item]}개`
    : route?.shed ? '빈 팀 자리 · 몬스터볼 ∞'
      : evolution.method === 'level' ? `Lv.${evolution.level ?? 1} · 도구 소비 없음` : '원본 진화 조건 · 도구 소비 없음';
  const purchase = !route && quote.requiredItem && quote.missing ? ` · 자동 구매 ₩${quote.cost.toLocaleString('ko-KR')}` : '';
  return `<button data-evolve="${evolution.target}"${item ? ` data-evolution-item="${item}"` : ''}${quote.affordable ? ' data-auto-buy="true"' : ''} ${route || quote.affordable ? '' : 'disabled'}><img src="${target.frontSprite}" alt=""><span><b>${escapeHtml(target.name)}</b><small>${escapeHtml(requirement + purchase)}</small><em>${route ? '준비 완료' : quote.affordable ? '구매 후 진화' : quote.cost > state.player.money ? '돈 부족' : '조건 부족'}</em></span></button>`;
}

function evolutionCard(state: GameState, monster: Monster, evolution: Evolution): string {
  const items = monsterEvolutionItemsFor(monster, evolution, state), defaultRoute = evolutionRoute(state, monster, evolution);
  const buttons = [
    ...(!items.length || (defaultRoute && !defaultRoute.item) ? [routeButton(state, monster, evolution)] : []),
    ...items.map(item => routeButton(state, monster, evolution, item)),
  ];
  if (!buttons.length) buttons.push(routeButton(state, monster, evolution));
  const descriptions = monster.regionalForm ? [] : sourceEvolutionDescriptions(monster.speciesId, evolution.target);
  if (needsSpecialEvolution(monster.speciesId, evolution)) {
    const item = 'evolution-catalyst' as const, route = evolutionRoute(state, monster, evolution, item);
    const level = specialEvolutionLevel(monster.speciesId, evolution.target), target = getSpecies(evolution.target);
    const quote = evolutionPurchaseQuote(state, monster, evolution, item), purchase = quote.affordable ? ` · 자동 구매 ₩${quote.cost.toLocaleString('ko-KR')}` : '';
    buttons.push(`<button class="capsule-evolution" data-capsule-evolve="${evolution.target}"${quote.affordable ? ' data-auto-buy="true"' : ''} ${route || quote.affordable ? '' : 'disabled'}><img src="${target.frontSprite}" alt=""><span><b>${escapeHtml(target.name)} · 캡슐 대체</b><small>${ITEM_LABELS[item]} ×1 · 보유 ${state.inventory[item]}개 · 필요 Lv.${level}${purchase}</small><em>${route ? '준비 완료' : quote.affordable ? '구매 후 진화' : monster.level < level ? `Lv.${level} 필요` : '돈 부족'}</em></span></button>`);
  }
  return `<article class="evolution-route">${buttons.join('')}<details class="evolution-source"><summary>원본 진화 조건 ${descriptions.length}가지</summary>${descriptions.length ? `<ul>${descriptions.map(description => `<li>${escapeHtml(description)}</li>`).join('')}</ul>` : ''}</details></article>`;
}

/** Evolutions this Pokémon can take right now without buying anything; `capsule` marks one only the special-evolution capsule opens. */
export function readyEvolutions(state: GameState, monster: Monster): Array<{ target: number; capsule: boolean }> {
  const ready = new Map<number, boolean>();
  for (const evolution of getSpecies(monster.speciesId).evolutions) {
    if (!evolutionFormSupported(state, monster, evolution)) continue;
    if (evolutionRoute(state, monster, evolution)) ready.set(evolution.target, false);
    else if (!ready.has(evolution.target) && needsSpecialEvolution(monster.speciesId, evolution) && evolutionRoute(state, monster, evolution, 'evolution-catalyst')) ready.set(evolution.target, true);
  }
  return [...ready].map(([target, capsule]) => ({ target, capsule }));
}

export function evolutionSectionHtml(state: GameState, monster: Monster): string {
  const evolutions = getSpecies(monster.speciesId).evolutions.filter(evolution => evolutionFormSupported(state, monster, evolution));
  if (!evolutions.length) return '';
  const ready = evolutions.some(evolution => evolutionRoute(state, monster, evolution));
  return `<details class="evolution-panel collection-fold"${ready ? ' open' : ''}><summary>진화 선택</summary><div class="evolution-list">${evolutions.map(evolution => evolutionCard(state, monster, evolution)).join('')}</div></details>`;
}
