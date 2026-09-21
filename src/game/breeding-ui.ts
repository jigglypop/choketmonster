import type { Graph } from '../core/brain';
import { getSpecies } from '../data/pokemon';
import type { GameState, Monster } from './engine';
import { breedingCompatibility, createEgg, hatchEgg, type MonsterGender } from './breeding';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const genderLabel: Record<MonsterGender, string> = { female: '암컷', male: '수컷', genderless: '성별 없음' };
const owned = (state: GameState) => [...state.player.team, ...state.player.box];
const option = (monster: Monster) => `<option value="${escapeHtml(monster.instanceId)}">${escapeHtml(monster.nickname)} · Lv.${monster.level} · ${genderLabel[monster.gender!]}</option>`;

export function breedingPanelHtml(state: GameState): string {
  const monsters = owned(state), first = monsters[0], compatible = first ? monsters.find(monster => monster.instanceId !== first.instanceId && breedingCompatibility(first, monster).compatible) : undefined;
  const eggs = state.nursery ?? [];
  return `<section class="breeding-panel panel" aria-labelledby="breeding-title"><div class="subheading"><div><h2 id="breeding-title">교배와 알</h2></div><span>${eggs.length}/6</span></div>

    <div class="breeding-form"><label>첫 번째 부모<select id="breeding-first">${monsters.map(option).join('')}</select></label><label>두 번째 부모<select id="breeding-second">${monsters.map(monster => `<option value="${escapeHtml(monster.instanceId)}" ${monster === compatible ? 'selected' : ''}>${escapeHtml(monster.nickname)} · Lv.${monster.level} · ${genderLabel[monster.gender!]}</option>`).join('')}</select></label><button id="create-egg" ${monsters.length < 2 || eggs.length >= 6 ? 'disabled' : ''}>알 받기</button><small id="breeding-compatibility" role="status"></small></div>
    <div class="egg-list">${eggs.map(egg => { const species = getSpecies(egg.speciesId), ready = egg.steps >= egg.requiredSteps, percent = Math.floor(egg.steps / egg.requiredSteps * 100); return `<article class="egg-card" data-egg="${escapeHtml(egg.eggId)}"><div class="egg-icon" aria-hidden="true">◉</div><div><strong>${escapeHtml(species.name)}의 알</strong><small>${ready ? '부화 준비 완료' : `${egg.steps.toLocaleString()} / ${egg.requiredSteps.toLocaleString()}걸음 · ${percent}%`}</small><progress max="${egg.requiredSteps}" value="${egg.steps}">${percent}%</progress></div><button data-hatch="${escapeHtml(egg.eggId)}" ${ready ? '' : 'disabled'}>부화하기</button></article>`; }).join('') || '<p class="empty">보관 중인 알이 없습니다.</p>'}</div>
    </section>`;
}

export function bindBreedingPanel(root: ParentNode, state: GameState, graph: Graph, onChanged: (message: string, monster?: Monster) => void, onError: (message: string) => void): void {
  const first = root.querySelector<HTMLSelectElement>('#breeding-first'), second = root.querySelector<HTMLSelectElement>('#breeding-second');
  const status = root.querySelector<HTMLElement>('#breeding-compatibility'), create = root.querySelector<HTMLButtonElement>('#create-egg');
  const update = () => {
    if (!first || !second || !status || !create) return;
    const parents = owned(state), a = parents.find(monster => monster.instanceId === first.value), b = parents.find(monster => monster.instanceId === second.value);
    const result = a && b ? breedingCompatibility(a, b) : { compatible: false, reason: '부모 두 마리를 선택하세요.' };
    status.textContent = result.reason; create.disabled = !result.compatible || (state.nursery?.length ?? 0) >= 6;
  };
  if (first && second && create) {
    first.onchange = update; second.onchange = update; update();
    create.onclick = () => { try { const egg = createEgg(state, first.value, second.value, graph); onChanged(`${getSpecies(egg.speciesId).name}의 알을 받았습니다.`); } catch (error) { onError(error instanceof Error ? error.message : String(error)); } };
  }
  root.querySelectorAll<HTMLButtonElement>('[data-hatch]').forEach(button => button.onclick = () => {
    try { const monster = hatchEgg(state, button.dataset.hatch!); onChanged(`${monster.nickname}이(가) 알에서 태어났습니다.`, monster); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  });
}
