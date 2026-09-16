import { getSpecies } from '../data/pokemon';
import type { Evolution } from './contracts';
import { evolutionItemsFor, evolutionRoute, isMonsterInBattle, ITEM_LABELS, type GameState, type InventoryItem, type Monster } from './engine';
import { evolutionGrowthSummary, needsSpecialEvolution, sourceEvolutionDescriptions, specialEvolutionLevel } from './evolution-conditions';
import { initialEvolutionProgress } from './evolution-progress';

const escapeHtml = (value: unknown) => String(value).replace(/[&<>'"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
})[character]!);

function routeButton(state: GameState, monster: Monster, evolution: Evolution, item?: InventoryItem): string {
  const target = getSpecies(evolution.target), route = evolutionRoute(state, monster, evolution, item);
  const requirement = item ? `${ITEM_LABELS[item]} ×1 · 보유 ${state.inventory[item]}개`
    : route?.shed ? `빈 팀 자리 · 몬스터볼 ×1 · 보유 ${state.inventory['poke-ball']}개`
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

const treats = [
  ['friendship-treat', 'friendship', '친밀도'],
  ['beauty-treat', 'beauty', '아름다움'],
  ['affection-treat', 'affection', '애정'],
] as const;

export function evolutionSectionHtml(state: GameState, monster: Monster): string {
  const species = getSpecies(monster.speciesId), progress = monster.evolutionProgress ?? initialEvolutionProgress(monster);
  const growthDisabled = Boolean(state.battle), evolutionBlocked = isMonsterInBattle(state, monster.instanceId);
  const growth = treats.map(([item, key, label]) => {
    const maximum = Math.min(state.inventory[item], Math.ceil((255 - progress[key]) / 20));
    return `<div class="evolution-treat"><label for="treat-${item}">${label} 간식 수량</label><input id="treat-${item}" data-treat-quantity="${item}" type="number" min="1" max="${Math.max(1, maximum)}" value="1" ${maximum && !growthDisabled ? '' : 'disabled'}><button data-use-treat="${item}" ${maximum && !growthDisabled ? '' : 'disabled'}>${ITEM_LABELS[item]} 먹이기 · 최대 ${maximum}개</button><small>보유 ${state.inventory[item]}개 · 1개당 +20${progress[key] >= 255 ? ' · 최대치' : ''}</small></div>`;
  }).join('');
  return `<section class="evolution-panel"><div class="evolution-growth"><h3>진화 성장</h3><p>${escapeHtml(evolutionGrowthSummary(monster))}</p><div class="evolution-treats">${growth}</div>${growthDisabled ? `<small class="evolution-help">전투 중에는 간식을 먹일 수 없습니다.${evolutionBlocked ? ' 이 포켓몬은 전투에 참가 중이라 진화도 마친 뒤 가능합니다.' : ' 박스의 비참가 포켓몬은 진화할 수 있습니다.'}</small>` : ''}</div><h3>진화</h3><p class="evolution-help">팀과 박스의 포켓몬 모두 같은 진화 조건을 적용합니다. 준비 상태와 소비할 도구를 확인하세요. 여러 원본 도구가 가능한 진화는 원하는 도구를 선택할 수 있습니다.</p><div class="evolution-list">${species.evolutions.map(evolution => evolutionCard(state, monster, evolution)).join('') || '<p class="empty">더 이상 진화하지 않습니다.</p>'}</div></section>`;
}
