import { getSpecies } from '../data/pokemon';
import type { Evolution } from './contracts';
import { evolutionItemsFor, evolutionRoute, ITEM_LABELS, type GameState, type InventoryItem, type Monster } from './engine';
import { needsSpecialEvolution, sourceEvolutionDescriptions, specialEvolutionLevel } from './evolution-conditions';

const escapeHtml = (value: unknown) => String(value).replace(/[&<>'"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
})[character]!);

function routeButton(state: GameState, monster: Monster, evolution: Evolution, item?: InventoryItem): string {
  const target = getSpecies(evolution.target), route = evolutionRoute(state, monster, evolution, item);
  const requirement = item ? `${ITEM_LABELS[item]} ×1 · 보유 ${state.inventory[item]}개`
    : route?.shed ? '빈 팀 자리 · 몬스터볼 ∞'
      : evolution.method === 'level' ? `Lv.${evolution.level ?? 1} · 도구 소비 없음` : '원본 진화 조건 · 도구 소비 없음';
  return `<button data-evolve="${evolution.target}"${item ? ` data-evolution-item="${item}"` : ''} ${route ? '' : 'disabled'}><img src="${target.frontSprite}" alt=""><span><b>${escapeHtml(target.name)}</b><small>${escapeHtml(requirement)}</small><em>${route ? '준비 완료' : '조건 부족'}</em></span></button>`;
}

function evolutionCard(state: GameState, monster: Monster, evolution: Evolution): string {
  const items = evolutionItemsFor(monster.speciesId, evolution), defaultRoute = evolutionRoute(state, monster, evolution);
  const buttons = [
    ...(!items.length || (defaultRoute && !defaultRoute.item) ? [routeButton(state, monster, evolution)] : []),
    ...items.map(item => routeButton(state, monster, evolution, item)),
  ];
  if (!buttons.length) buttons.push(routeButton(state, monster, evolution));
  const descriptions = sourceEvolutionDescriptions(monster.speciesId, evolution.target);
  if (needsSpecialEvolution(monster.speciesId, evolution)) {
    const item = 'evolution-catalyst' as const, route = evolutionRoute(state, monster, evolution, item);
    const level = specialEvolutionLevel(monster.speciesId, evolution.target), target = getSpecies(evolution.target);
    buttons.push(`<button class="capsule-evolution" data-capsule-evolve="${evolution.target}" ${route ? '' : 'disabled'}><img src="${target.frontSprite}" alt=""><span><b>${escapeHtml(target.name)} · 캡슐 대체</b><small>${ITEM_LABELS[item]} ×1 · 보유 ${state.inventory[item]}개 · 필요 Lv.${level}</small><em>${route ? '준비 완료' : monster.level < level ? `Lv.${level} 필요` : '캡슐 부족'}</em></span></button>`);
  }
  return `<article class="evolution-route">${buttons.join('')}<details class="evolution-source"><summary>원본 진화 조건 ${descriptions.length}가지</summary>${descriptions.length ? `<ul>${descriptions.map(description => `<li>${escapeHtml(description)}</li>`).join('')}</ul>` : '<p>원본 데이터에 별도 조건 설명이 없습니다.</p>'}<p>게임에서는 전용 진화 도구로 교환 조건을 대신할 수 있습니다. 특수진화 캡슐은 필요한 레벨을 유지하면서 성별·시간·장소·동료·특수 행동 조건을 대신합니다.</p></details></article>`;
}

export function evolutionSectionHtml(state: GameState, monster: Monster): string {
  const species = getSpecies(monster.speciesId);
  if (!species.evolutions.length) return '';
  return `<details class="evolution-panel collection-fold"><summary>진화 선택</summary><div class="evolution-list">${species.evolutions.map(evolution => evolutionCard(state, monster, evolution)).join('')}</div></details>`;
}
