import './game.css';
import './three/scene.css';
import { detachPokemonScene, getPokemonScene } from './three/scene';
import { OpenWorldPanel } from './openworld/panel';
import type { OpenWorldSnapshot } from './openworld/simulation';
import { movementSpeed } from './openworld/simulation';
import { KANTO_MAP_VERSION, kantoSpeciesSources } from './openworld/kanto';
import { createFieldRuntime } from './three/field-runtime';
import type { FieldPolicy } from './game/field';
import { getMove, getSpecies, POKEMON } from './data/pokemon';
import { drawBrain } from './render';
import {
  actBattle, availableEvolutions, buyItem, challengeChampion, challengeGym, createGame,
  depositMonster, evolve, explore, heal, ITEM_LABELS, ITEM_PRICES, useItem, withdrawMonster,
  type BallItem, type BattleAction, type GameState, type InventoryItem, type Monster,
} from './game/engine';
import { BRAIN_ASSUMPTIONS, ConnectomeController } from './game/connectome';
import { tileAt, walk } from './game/map';
import { REGIONS, getRegion } from './game/regions';
import { defaultView, packSave, readSave, unpackSave, writeSave, type ViewState } from './game/storage';

type Tab = 'map' | 'team' | 'dex' | 'shop' | 'lab';
type PersistentView = ViewState & { rewards?: Record<string, number>; openWorld?: OpenWorldSnapshot };
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const app = $('#app');
const escapeHtml = (value: unknown) => String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]!);
const typeLabel: Record<string, string> = { normal: '노말', fire: '불꽃', water: '물', electric: '전기', grass: '풀', ice: '얼음', fighting: '격투', poison: '독', ground: '땅', flying: '비행', psychic: '에스퍼', bug: '벌레', rock: '바위', ghost: '고스트', dragon: '드래곤', dark: '악', steel: '강철', fairy: '페어리' };
const itemKeys = Object.keys(ITEM_PRICES) as InventoryItem[];
const ballKeys: BallItem[] = ['poke-ball', 'great-ball', 'ultra-ball'];

let controller: ConnectomeController;
let worldPanel: OpenWorldPanel | undefined;
let fieldPolicy: FieldPolicy;
let originalFieldPolicy: FieldPolicy;
let legacyOpenWorldPolicy: FieldPolicy;
let game: GameState | undefined;
let view: PersistentView = { ...defaultView(), rewards: {} };
let tab: Tab = 'map', selectedMonsterId = '', dexQuery = '';
let dexMode: 'all' | 'seen' | 'caught' = 'all';
let grassSteps = 0, toastTimer = 0, autosaveTimer = 0;
let autoBattle = false, brainTurnPending = false, lastDecision = '회로 대기 중';

app.innerHTML = `
  <header class="topbar"><a class="brand" href="#"><span class="brand-ball"></span><span>초켓몬스터</span><small>OPEN WORLD ADVENTURE</small></a>
    <nav aria-label="주 메뉴"><button data-tab="map" class="active">모험</button><button data-tab="team">팀 · 박스</button><button data-tab="dex">도감</button><button data-tab="shop">상점</button><button data-tab="lab">연구실</button></nav>
    <div class="trainer-summary"><span id="money">₩0</span><span id="badges">도감 0/151</span><button id="save-now" class="quiet">저장</button></div></header>
  <main id="screen" tabindex="-1"><section class="loading"><span class="spinner"></span><h1>실제 커넥톰을 불러오는 중</h1><p>Male CNS 부분 회로를 확인하고 있습니다.</p></section></main>
  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div><input id="import-file" type="file" accept="application/json" hidden>
  <dialog id="starter-dialog" class="starter-dialog"><div class="starter-copy"><span class="kicker">PALLET LAB · 첫 파트너</span><h1>함께 떠날 포켓몬을<br>선택하세요</h1><p>선택한 한 마리만 처음 팀에 들어옵니다. 각 개체는 서로 다른 회로 상태와 학습 기록을 가집니다.</p></div><div class="starter-grid">
    ${[1, 4, 7].map(id => { const s = getSpecies(id); return `<button data-starter="${id}" class="starter-card"><span>No.${String(id).padStart(3, '0')}</span><img src="${s.frontSprite}" alt="${s.name}"><strong>${s.name}</strong><small>${s.types.map(type => typeLabel[type]).join(' · ')}</small><em>이 파트너로 시작</em></button>`; }).join('')}</div></dialog>`;

function notify(message: string, error = false) { const toast = $('#toast'); toast.textContent = message; toast.classList.toggle('error', error); toast.hidden = false; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3500); }
const active = (side: { team: Monster[]; activeIndex: number }) => side.team[side.activeIndex];
const owned = () => game ? [...game.player.team, ...game.player.box] : [];
const hpPercent = (monster: Monster) => Math.max(0, Math.round(monster.hp / monster.stats.hp * 100));
const typesHtml = (id: number) => getSpecies(id).types.map(type => `<span class="type type-${type}">${typeLabel[type]}</span>`).join('');
function effective(battle: NonNullable<GameState['battle']>, monster: Monster) {
  const transformed = battle.transformations?.[monster.instanceId];
  return { speciesId: transformed?.speciesId ?? monster.speciesId, stats: transformed?.stats ?? monster.stats, moves: transformed?.moves ?? monster.moves };
}
function graphChoose(monster: Monster, other: Monster, battle: NonNullable<GameState['battle']>, reward: number | null, learning: boolean) {
  const self = effective(battle, monster), foe = effective(battle, other);
  const selfProxy = { ...monster, ...self, brain: monster.brain }, foeProxy = { ...other, ...foe, brain: other.brain };
  const decision = controller.choose(selfProxy, foeProxy, battle.turn, reward, learning);
  monster.brain = selfProxy.brain;
  return decision;
}
function clearPendingLearning(monster: Monster) {
  view.rewards ??= {}; delete view.rewards[monster.instanceId];
  const brain = controller.ensure(monster); brain.state.previous = null; monster.brain = brain.snapshot();
}
function monsterCard(monster: Monster, action = '') { const species = getSpecies(monster.speciesId); return `<article class="monster-card ${monster.instanceId === selectedMonsterId ? 'selected' : ''}" data-monster="${monster.instanceId}"><img src="${species.frontSprite}" alt=""><div class="monster-card-copy"><span>No.${String(species.id).padStart(3, '0')} · Lv.${monster.level}</span><strong>${escapeHtml(monster.nickname)}</strong><div>${typesHtml(species.id)}</div><small>HP ${monster.hp}/${monster.stats.hp}</small></div>${action}</article>`; }
async function saveNow(announce = false) { if (!game || !controller) return; try { captureWorld(); await writeSave(packSave(game, controller.graph, view)); if (announce) notify('이 기기에 모험을 저장했습니다.'); } catch (error) { notify(`저장하지 못했습니다: ${error instanceof Error ? error.message : error}`, true); } }
function queueSave() { clearTimeout(autosaveTimer); autosaveTimer = window.setTimeout(() => void saveNow(), 220); }
function shellStats() { if (!game) return; $('#money').textContent = `₩${game.player.money.toLocaleString('ko-KR')}`; $('#badges').textContent = `도감 ${game.dex.caught.length}/151`; document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab)); }
function captureWorld() { if (worldPanel) { view.openWorld = worldPanel.simulation.snapshot(); view.openWorldPaused = worldPanel.paused; } }
function prepareWorld() {
  worldPanel?.unmount(); worldPanel = undefined;
  if (!game || (game.battle && !view.openWorld)) return;
  if (view.openWorld && view.openWorld.mapVersion !== KANTO_MAP_VERSION) {
    void writeSave(packSave(game, controller.graph, view), `backup-before-kanto-${Date.now()}`).catch(error => notify(String(error), true));
  }
  if (view.openWorld && originalFieldPolicy) {
    const checkpoint = structuredClone(view.openWorld);
    const originalInput = JSON.stringify(originalFieldPolicy.inputWeights), originalReadout = JSON.stringify(originalFieldPolicy.readout);
    const legacyInput = JSON.stringify(legacyOpenWorldPolicy.inputWeights), legacyReadout = JSON.stringify(legacyOpenWorldPolicy.readout);
    let migrated = false;
    for (const entity of [...checkpoint.entities, ...(checkpoint.companionMemories ?? [])]) {
      const input = JSON.stringify(entity.brain.inputWeights), readout = JSON.stringify(entity.brain.readout);
      if (entity.brain.updates === 0 && ((input === originalInput && readout === originalReadout) || (input === legacyInput && readout === legacyReadout))) {
        entity.brain.inputWeights = structuredClone(fieldPolicy.inputWeights); entity.brain.readout = structuredClone(fieldPolicy.readout); entity.brain.previous = null; migrated = true;
      }
    }
    if (migrated) {
      void writeSave(packSave(game, controller.graph, view), `backup-before-world-policy-${Date.now()}`).catch(error => notify(String(error), true));
      view.openWorld = checkpoint;
    }
  }
  worldPanel = new OpenWorldPanel({ game, graph: controller.graph, policy: fieldPolicy, checkpoint: view.openWorld,
    learning: () => view.learning, setLearning: value => { view.learning = value; }, notify,
    changed: () => { shellStats(); queueSave(); } });
  worldPanel.paused = view.openWorldPaused ?? false;
}
function render() {
  shellStats(); if (!game) return;
  if (game.battle && !worldPanel) { renderBattle(); return; }
  if (tab === 'map') renderMap();
  else { worldPanel?.unmount(); if (tab === 'team') renderTeam(); else if (tab === 'dex') renderDex(); else if (tab === 'shop') renderShop(); else renderLab(); }
}

function renderMap() {
  if (!game) return;
  detachPokemonScene();
  if (!worldPanel) prepareWorld();
  worldPanel?.mount($('#screen'));
}

function renderBattle() {
  if (!game?.battle) return; const battle = game.battle, player = active(battle.player), enemy = active(battle.enemy), pView = effective(battle, player), eView = effective(battle, enemy), pSpecies = getSpecies(pView.speciesId), eSpecies = getSpecies(eView.speciesId), pHp = Math.max(0, Math.round(player.hp / pView.stats.hp * 100)), eHp = Math.max(0, Math.round(enemy.hp / eView.stats.hp * 100));
  $('#screen').innerHTML = `<div class="battle-page page"><div class="battle-top"><div><span class="kicker">${battle.kind.toUpperCase()} BATTLE · TURN ${battle.turn}</span><h1>${battle.kind === 'wild' ? '야생 포켓몬과 조우' : battle.kind === 'gym' ? '체육관 승부' : '챔피언 결정전'}</h1></div><div class="brain-controls"><label><input id="learning" type="checkbox" ${view.learning ? 'checked' : ''}> 보상 학습</label><label class="switch"><input id="auto" type="checkbox" ${autoBattle ? 'checked' : ''}><span></span> 커넥톰 자동 배틀</label><button id="brain-turn" class="primary">회로로 한 턴</button></div></div>
    <section class="battle-stage panel"><div class="opponent combatant"><div class="battle-info"><span>Lv.${enemy.level} ${typesHtml(eView.speciesId)}</span><h2>${escapeHtml(enemy.nickname)}</h2><div class="hp"><i style="width:${eHp}%"></i></div><small>HP ${enemy.hp}/${eView.stats.hp}${enemy.status ? ` · ${enemy.status}` : ''}</small></div><img src="${eSpecies.frontSprite}" alt="${eSpecies.name}"></div><div class="battle-ground"></div><div class="player combatant"><img src="${pSpecies.backSprite}" alt="${pSpecies.name} 뒷모습"><div class="battle-info"><span>Lv.${player.level} ${typesHtml(pView.speciesId)}</span><h2>${escapeHtml(player.nickname)}</h2><div class="hp"><i style="width:${pHp}%"></i></div><small>HP ${player.hp}/${pView.stats.hp}${player.status ? ` · ${player.status}` : ''}</small></div></div></section>
    <div class="battle-console"><section class="move-grid">${pView.moves.map((slot, index) => { const move = getMove(slot.moveId); return `<button data-battle-move="${index}" ${slot.pp <= 0 || brainTurnPending ? 'disabled' : ''}><span>${typeLabel[move.type]} · ${move.damageClass === 'status' ? '변화' : move.power}</span><strong>${move.name}</strong><small>PP ${slot.pp}/${move.pp}</small></button>`; }).join('') || '<button data-battle-wait="1"><strong>기다리기</strong></button>'}</section>
      <aside class="battle-menu"><div class="ball-row"><select id="ball-select">${ballKeys.map(ball => `<option value="${ball}" ${game!.inventory[ball] <= 0 ? 'disabled' : ''}>${ITEM_LABELS[ball]} ×${game!.inventory[ball]}</option>`).join('')}</select><button id="catch" ${battle.kind !== 'wild' ? 'disabled' : ''}>잡기</button></div><button id="battle-heal">상처약 사용 ×${game.inventory.potion}</button><button id="switch-mon">포켓몬 교체</button><button id="run" ${!battle.canRun ? 'disabled' : ''}>도망치기</button><p><b>회로:</b> ${escapeHtml(lastDecision)}</p></aside></div>
    <section class="battle-log panel">${game.logs.slice(-5).reverse().map(log => `<p>${escapeHtml(log)}</p>`).join('')}</section></div>`;
  document.querySelectorAll<HTMLButtonElement>('[data-battle-move]').forEach(b => b.onclick = () => performTurn({ type: 'move', index: Number(b.dataset.battleMove) }, false)); const wait = document.querySelector<HTMLButtonElement>('[data-battle-wait]'); if (wait) wait.onclick = () => performTurn({ type: 'wait' }, false);
  $('#learning').onchange = e => { view.learning = (e.target as HTMLInputElement).checked; queueSave(); }; $('#auto').onchange = e => { autoBattle = (e.target as HTMLInputElement).checked; if (autoBattle) scheduleAutoTurn(); }; $('#brain-turn').onclick = performBrainTurn;
  $('#catch').onclick = () => performTurn({ type: 'catch', ball: $<HTMLSelectElement>('#ball-select').value as BallItem }, false); $('#battle-heal').onclick = () => performTurn({ type: 'item', item: game!.inventory.potion > 0 ? 'potion' : 'super-potion' }, false); $('#run').onclick = () => performTurn({ type: 'run' }, false); $('#switch-mon').onclick = showSwitchMenu;
  controller.ensure(player); controller.ensure(enemy);
  getPokemonScene().showBattle($('.battle-stage'), game);
}
function chooseAction(monster: Monster, other: Monster, battle: NonNullable<GameState['battle']>, reward: number | null, learning: boolean): BattleAction { const decision = graphChoose(monster, other, battle, reward, learning); lastDecision = `출력 ${decision.rawAction} → ${decision.action === 4 ? '대기' : `${decision.action + 1}번 기술`} · 활성도 ${(decision.activity * 100).toFixed(1)}%`; return decision.action === 4 ? { type: 'wait' } : { type: 'move', index: decision.action }; }
function performBrainTurn() { if (!game?.battle || brainTurnPending) return; const b = game.battle, player = active(b.player); performTurn(chooseAction(player, active(b.enemy), b, view.rewards?.[player.instanceId] ?? null, view.learning), true); }
function performTurn(playerAction: BattleAction, learnedChoice: boolean) {
  if (!game?.battle || brainTurnPending) return; brainTurnPending = true; const battle = game.battle, player = active(battle.player), enemy = active(battle.enemy), turn = battle.turn, playerBefore = player.hp / player.stats.hp, enemyBefore = enemy.hp / enemy.stats.hp;
  const enemyBrainBefore = enemy.brain ? structuredClone(enemy.brain) : undefined, playerBrainBefore = player.brain ? structuredClone(player.brain) : undefined;
  try { if (!learnedChoice) clearPendingLearning(player); const enemyDecision = graphChoose(enemy, player, battle, null, false); const result = actBattle(game, playerAction, enemyDecision.action); const playerAfter = result.outcome === 'lost' ? 0 : player.hp / player.stats.hp, enemyAfter = enemy.hp / enemy.stats.hp; const reward = (enemyBefore - enemyAfter) - (playerBefore - playerAfter) + (result.outcome === 'won' ? 1 : result.outcome === 'lost' ? -1 : 0); view.rewards ??= {}; if (learnedChoice && !result.battleEnded) view.rewards[player.instanceId] = reward; else delete view.rewards[player.instanceId]; if (learnedChoice && result.battleEnded) controller.finish(player, reward, view.learning); if (result.battleEnded) { autoBattle = false; view.rewards = {}; } queueSave(); }
  catch (error) { enemy.brain = enemyBrainBefore; player.brain = playerBrainBefore; notify(error instanceof Error ? error.message : '행동을 처리하지 못했습니다.', true); } finally { brainTurnPending = false; render(); if (autoBattle && game?.battle) scheduleAutoTurn(); }
}
function scheduleAutoTurn() { window.setTimeout(() => { if (autoBattle && game?.battle && !brainTurnPending) performBrainTurn(); }, 650); }
function showSwitchMenu() { if (!game?.battle) return; const menu = document.createElement('div'); menu.className = 'modal-shade'; menu.innerHTML = `<section class="choice-modal"><span class="eyebrow">TEAM SWITCH</span><h2>교체할 포켓몬</h2><div>${game.battle.player.team.map((monster, index) => `<button data-switch="${index}" ${monster.hp <= 0 || index === game!.battle!.player.activeIndex ? 'disabled' : ''}>${monsterCard(monster)}</button>`).join('')}</div><button class="quiet close-choice">취소</button></section>`; document.body.append(menu); menu.querySelectorAll<HTMLButtonElement>('[data-switch]').forEach(b => b.onclick = () => { menu.remove(); performTurn({ type: 'switch', index: Number(b.dataset.switch) }, false); }); menu.querySelector<HTMLButtonElement>('.close-choice')!.onclick = () => menu.remove(); }

function renderTeam() {
  if (!game) return; const all = owned(); if (!selectedMonsterId || !all.some(m => m.instanceId === selectedMonsterId)) selectedMonsterId = game.player.team[0].instanceId; const selected = all.find(m => m.instanceId === selectedMonsterId)!, species = getSpecies(selected.speciesId), ready = availableEvolutions(game, selected.instanceId);
  $('#screen').innerHTML = `<div class="page team-page"><section class="section-heading"><div><span class="kicker">INDIVIDUAL MEMORY</span><h1>팀과 박스</h1><p>각 포켓몬의 개체 ID와 회로 상태는 따로 저장됩니다.</p></div><span class="count-chip">팀 ${game.player.team.length}/6 · 박스 ${game.player.box.length}</span></section><div class="team-layout"><section><div class="subheading"><h2>함께 걷는 팀</h2></div><div class="card-grid">${game.player.team.map((m, i) => monsterCard(m, `<div class="card-actions"><button class="card-action" data-lead="${i}" ${i === 0 ? 'disabled' : ''}>선두</button><button class="card-action" data-deposit="${i}" ${game!.player.team.length <= 1 ? 'disabled' : ''}>맡기기</button></div>`)).join('')}</div><div class="subheading box-heading"><h2>보관 박스</h2></div><div class="card-grid box-grid">${game.player.box.map((m, i) => monsterCard(m, `<button class="card-action" data-withdraw="${i}" ${game!.player.team.length >= 6 ? 'disabled' : ''}>데려오기</button>`)).join('') || '<p class="empty">아직 박스가 비어 있습니다.</p>'}</div></section>
    <aside class="detail-card panel"><div class="detail-portrait"><span>No.${String(species.id).padStart(3, '0')}</span><img src="${species.frontSprite}" alt="${species.name}"></div><div class="detail-title"><div>${typesHtml(species.id)}</div><h2>${escapeHtml(selected.nickname)}</h2><p>Lv.${selected.level} · ${selected.instanceId}</p></div><div class="stat-list">${([['HP', `${selected.hp}/${selected.stats.hp}`], ['공격', selected.stats.attack], ['방어', selected.stats.defense], ['특공', selected.stats.specialAttack], ['특방', selected.stats.specialDefense], ['스피드', selected.stats.speed], ['이동 속도', `${movementSpeed(selected.speciesId, selected.level).toFixed(1)} m/s`]] as const).map(([label, value]) => `<span>${label}<b>${value}</b></span>`).join('')}</div><div class="detail-xp"><span>누적 경험치</span><strong>${selected.xp.toLocaleString()}</strong></div><h3>현재 기술</h3><div class="move-list">${selected.moves.map(slot => { const move = getMove(slot.moveId); return `<span><b>${move.name}</b><small>${typeLabel[move.type]} · 위력 ${move.power || '—'} · 명중 ${move.accuracy || '—'}<br>PP ${slot.pp}/${move.pp} · 우선도 ${move.priority}</small></span>`; }).join('')}</div><h3>다음 습득 기술</h3><div class="move-list">${species.moves.filter(entry => entry.level > selected.level).slice(0, 3).map(entry => `<span><b>${getMove(entry.moveId).name}</b><small>Lv.${entry.level}</small></span>`).join('') || '<p class="empty">레벨업 기술을 모두 익혔습니다.</p>'}</div><div class="item-use"><button id="use-potion">상처약 ×${game.inventory.potion}</button><button id="use-candy">이상한사탕 ×${game.inventory['rare-candy']}</button></div><h3>진화</h3><div class="evolution-list">${species.evolutions.map(evo => { const target = getSpecies(evo.target), available = ready.some(c => c.target === evo.target), requirement = evo.method === 'level' ? `Lv.${evo.level}` : evo.method === 'trade' ? '연결의끈' : ITEM_LABELS[evo.item as InventoryItem] ?? evo.item; return `<button data-evolve="${evo.target}" ${available ? '' : 'disabled'}><img src="${target.frontSprite}" alt=""><span><b>${target.name}</b><small>${requirement}</small></span></button>`; }).join('') || '<p class="empty">더 이상 진화하지 않습니다.</p>'}</div></aside></div></div>`;
  document.querySelectorAll<HTMLElement>('[data-monster]').forEach(card => card.onclick = e => { if ((e.target as HTMLElement).closest('.card-action')) return; selectedMonsterId = card.dataset.monster!; renderTeam(); }); document.querySelectorAll<HTMLButtonElement>('[data-lead]').forEach(b => b.onclick = () => action(() => { const index = Number(b.dataset.lead), [monster] = game!.player.team.splice(index, 1); game!.player.team.unshift(monster); }, '선두 포켓몬을 바꿨습니다.')); document.querySelectorAll<HTMLButtonElement>('[data-deposit]').forEach(b => b.onclick = () => action(() => depositMonster(game!, Number(b.dataset.deposit)))); document.querySelectorAll<HTMLButtonElement>('[data-withdraw]').forEach(b => b.onclick = () => action(() => withdrawMonster(game!, Number(b.dataset.withdraw)))); document.querySelectorAll<HTMLButtonElement>('[data-evolve]').forEach(b => b.onclick = () => action(() => evolve(game!, selected.instanceId, { targetId: Number(b.dataset.evolve) }), '진화가 완료됐습니다.')); $('#use-potion').onclick = () => action(() => useItem(game!, 'potion', selected.instanceId)); $('#use-candy').onclick = () => action(() => useItem(game!, 'rare-candy', selected.instanceId)); controller.ensure(selected);
  if (game.battle) document.querySelectorAll<HTMLButtonElement>('.card-action, .item-use button, .evolution-list button').forEach(button => { button.disabled = true; });
  getPokemonScene().showSpecimen($('.detail-portrait'), selected.speciesId);
}

function renderDex() {
  getPokemonScene().detach();
  if (!game) return; const q = dexQuery.trim().toLowerCase(), filtered = POKEMON.filter(s => (!q || s.name.includes(q) || s.englishName.toLowerCase().includes(q) || String(s.id).includes(q) || s.types.some(type => type.includes(q) || typeLabel[type].includes(q))) && (dexMode === 'all' || game!.dex[dexMode].includes(s.id)));
  $('#screen').innerHTML = `<div class="page dex-page"><section class="section-heading"><div><span class="kicker">KANTO POKÉDEX</span><h1>도감 151</h1><p>발견 ${game.dex.seen.length}종 · 포획 ${game.dex.caught.length}종</p></div><div class="dex-tools"><input id="dex-search" value="${escapeHtml(dexQuery)}" placeholder="이름, 번호, 타입 검색"><div>${(['all', 'seen', 'caught'] as const).map(mode => `<button data-dex-mode="${mode}" class="${dexMode === mode ? 'active' : ''}">${mode === 'all' ? '전체' : mode === 'seen' ? '발견' : '포획'}</button>`).join('')}</div></div></section><div class="dex-grid">${filtered.map(s => { const seen = game!.dex.seen.includes(s.id), caught = game!.dex.caught.includes(s.id), regions = escapeHtml(kantoSpeciesSources(s.id).join(' / ')), evolutions = s.evolutions.map(evo => `${getSpecies(evo.target).name} (${evo.method === 'level' ? `Lv.${evo.level}` : evo.method === 'trade' ? '연결의끈' : ITEM_LABELS[evo.item as InventoryItem] ?? evo.item})`).join(', '); return `<article class="dex-card" data-species="${s.id}" tabindex="0" role="button" aria-label="${s.name} 3D 보기"><span>No.${String(s.id).padStart(3, '0')} · ${s.englishName}</span><img src="${s.frontSprite}" alt="${s.name}"><strong>${s.name}</strong><div>${typesHtml(s.id)}</div><small>${caught ? '● 포획' : seen ? '○ 발견' : '미발견'}</small><p><b>출현</b> ${escapeHtml(regions || '특수 지역')}</p><p><b>진화</b> ${escapeHtml(evolutions || '없음')}</p></article>`; }).join('')}</div></div>`;
  document.querySelectorAll<HTMLElement>('[data-species]').forEach(card => {
    card.onclick = () => showModel(Number(card.dataset.species));
    card.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.click(); } };
  });
  const search = $<HTMLInputElement>('#dex-search'); search.oninput = () => { dexQuery = search.value; renderDex(); $<HTMLInputElement>('#dex-search').focus(); }; document.querySelectorAll<HTMLButtonElement>('[data-dex-mode]').forEach(b => b.onclick = () => { dexMode = b.dataset.dexMode as typeof dexMode; renderDex(); });
}
function renderShop() { if (!game) return; getPokemonScene().detach(); $('#screen').innerHTML = `<div class="page shop-page"><section class="section-heading"><div><span class="kicker">ROUTE MARKET</span><h1>모험 상점</h1><p>포획, 회복, 진화에 필요한 12가지 도구입니다.</p></div><strong class="wallet">₩${game.player.money.toLocaleString()}</strong></section><div class="shop-grid">${itemKeys.map(item => `<article class="shop-card"><span class="item-icon">${item.includes('ball') ? '◉' : item.includes('stone') ? '◆' : item === 'link-cable' ? '∞' : '✦'}</span><div><strong>${ITEM_LABELS[item]}</strong><small>보유 ${game!.inventory[item]}개</small></div><b>₩${ITEM_PRICES[item].toLocaleString()}</b><button data-buy="${item}" ${game!.player.money < ITEM_PRICES[item] ? 'disabled' : ''}>1개 구매</button></article>`).join('')}</div><section class="center-banner"><div><span class="eyebrow">POKÉMON CENTER</span><h2>팀을 무료로 회복하세요</h2><p>HP와 모든 기술의 PP, 상태 이상을 한 번에 회복합니다.</p></div><button id="shop-heal" class="primary">무료 회복</button></section></div>`; document.querySelectorAll<HTMLButtonElement>('[data-buy]').forEach(b => b.onclick = () => action(() => buyItem(game!, b.dataset.buy as InventoryItem), `${ITEM_LABELS[b.dataset.buy as InventoryItem]}을(를) 샀습니다.`)); $('#shop-heal').onclick = () => action(() => heal(game!), '팀을 모두 회복했습니다.'); }

function renderLab() {
  getPokemonScene().detach();
  if (!game) return; const specimen = owned().find(m => m.instanceId === selectedMonsterId) ?? game.player.team[0], brain = controller.ensure(specimen);
  const provenance = controller.graph.provenance;
  $('#screen').innerHTML = `<div class="page lab-page"><section class="lab-hero"><div><span class="kicker">MALE CNS · CONNECTOME SUBSET</span><h1>실제 연결 지도,<br>게임용 동역학</h1><p>커넥톰은 신경 연결 지도이며 완성된 뇌가 아닙니다. 이 게임은 실제 연결 일부 위에 감각·행동·학습 규칙을 직접 설계했습니다.</p></div><div class="graph-numbers"><span><strong>${controller.graph.nodes.length}</strong>뉴런</span><span><strong>${controller.graph.edges.length.toLocaleString()}</strong>연결</span><span><strong>64</strong>화면 표시</span></div></section><div class="lab-layout"><section class="brain-card panel"><div class="panel-heading"><div><span class="eyebrow">LIVE ACTIVITY · ${escapeHtml(specimen.nickname)}</span><h2>회로 활성도</h2></div><span class="live-dot">LIVE</span></div><canvas id="brain-canvas" width="280" height="170"></canvas><p>${escapeHtml(lastDecision)}</p></section><section class="method-card panel"><span class="eyebrow">MODEL DISCLOSURE</span><h2>직접 설계한 부분</h2><p>${escapeHtml(BRAIN_ASSUMPTIONS)}</p><dl><div><dt>회로 범위</dt><dd>Male CNS v1.0, DNa02 이웃 128개 노드</dd></div><div><dt>행동 출력</dt><dd>0~3 기술, 4 기다리기</dd></div><div><dt>학습 보상</dt><dd>조우·피해·상성·승패·레벨 상승·진화 보상</dd></div><div><dt>평가 규칙</dt><dd>학습을 끄면 가중치를 고정</dd></div></dl></section></div><section class="source-card panel"><div><span class="eyebrow">SOURCE & LICENSE</span><h2>원본과 변환 근거</h2></div><div><p><b>버전</b> ${escapeHtml(provenance.version)}</p><p><b>그래프 ID</b> ${escapeHtml(controller.graph.id)}</p><p><b>원본 SHA-256</b> <code>${escapeHtml(provenance.sha256)}</code></p><p><b>라이선스</b> ${escapeHtml(provenance.license)}</p><p>${escapeHtml(provenance.note)}</p><a href="https://male-cns.janelia.org/download/" target="_blank" rel="noreferrer">HHMI Janelia Male CNS 다운로드 ↗</a><a href="${escapeHtml(provenance.source)}" target="_blank" rel="noreferrer">사용한 원본 파일 ↗</a></div></section><section class="data-actions panel"><div><h2>저장 데이터 관리</h2><p>진행 상황과 개체별 회로 상태는 이 브라우저에 자동 저장됩니다.</p></div><button id="export-save">내보내기</button><button id="import-save">불러오기</button><button id="new-game" class="danger">새 게임</button></section></div>`;
  drawBrain($<HTMLCanvasElement>('#brain-canvas'), brain.state); $('#export-save').onclick = exportSave; $('#import-save').onclick = () => $<HTMLInputElement>('#import-file').click(); $('#new-game').onclick = newGame;
}
function showModel(id: number) {
  const species = getSpecies(id), dialog = document.createElement('dialog');
  dialog.className = 'model-dialog';
  dialog.innerHTML = `<div class="model-dialog-top"><div><span class="eyebrow">No.${String(id).padStart(3, '0')} · ${species.englishName}</span><h2>${species.name}</h2><div>${typesHtml(id)}</div></div><button aria-label="닫기">×</button></div><div class="model-host"></div><div class="model-control-hint">드래그로 회전 · 휠 / 두 손가락으로 확대</div><p>출현 지역 · ${escapeHtml(kantoSpeciesSources(id).join(' / '))}</p>`;
  document.body.append(dialog); dialog.showModal();
  getPokemonScene().showSpecimen(dialog.querySelector<HTMLElement>('.model-host')!, id);
  dialog.querySelector('button')!.onclick = () => dialog.close();
  dialog.addEventListener('close', () => { getPokemonScene().detach(); dialog.remove(); render(); }, { once: true });
}
function action(operation: () => unknown, success?: string) { try { operation(); if (success) notify(success); render(); queueSave(); } catch (error) { notify(error instanceof Error ? error.message : '요청을 처리하지 못했습니다.', true); } }
function exportSave() { if (!game) return; captureWorld(); const blob = new Blob([JSON.stringify(packSave(game, controller.graph, view), null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `choketmon-151-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
async function newGame() { if (!game) return; captureWorld(); await writeSave(packSave(game, controller.graph, view), 'backup-before-new-game'); worldPanel?.unmount(); worldPanel = undefined; game = undefined; view = { ...defaultView(), rewards: {} }; selectedMonsterId = ''; $<HTMLDialogElement>('#starter-dialog').showModal(); notify('현재 모험을 백업했습니다. 새 파트너를 골라 주세요.'); }

document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.onclick = e => { e.preventDefault(); if (!game?.battle || worldPanel) { tab = b.dataset.tab as Tab; render(); } else notify('배틀을 마친 뒤 다른 화면으로 이동할 수 있습니다.'); }); $('#save-now').onclick = () => void saveNow(true);
document.querySelectorAll<HTMLButtonElement>('[data-starter]').forEach(b => b.onclick = () => { const id = Number(b.dataset.starter) as 1 | 4 | 7; game = createGame(id, `${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0]}`); view = { ...defaultView(), rewards: {} }; controller.ensure(game.player.team[0]); selectedMonsterId = game.player.team[0].instanceId; prepareWorld(); $<HTMLDialogElement>('#starter-dialog').close(); tab = 'map'; render(); queueSave(); });
$<HTMLInputElement>('#import-file').onchange = async e => { const input = e.target as HTMLInputElement, file = input.files?.[0]; if (!file) return; try { if (file.size > 20_000_000) throw new Error('저장 파일은 20MB 이하여야 합니다.'); const loaded = unpackSave(await file.text(), controller.graph); captureWorld(); if (game) await writeSave(packSave(game, controller.graph, view), 'backup-before-import'); game = loaded.game; view = { ...loaded.view, rewards: (loaded.view as PersistentView).rewards ?? {} }; selectedMonsterId = game.player.team[0].instanceId; prepareWorld(); tab = 'map'; render(); await saveNow(); notify('저장 파일을 불러왔습니다. 이전 모험은 백업했습니다.'); } catch (error) { notify(error instanceof Error ? error.message : '저장 파일을 읽지 못했습니다.', true); } finally { input.value = ''; } };
document.addEventListener('visibilitychange', () => { if (document.hidden) void saveNow(); });
window.addEventListener('pagehide', () => { void saveNow(); });
async function boot() { try { controller = await ConnectomeController.load();
  const policyResponse = await fetch('/data/openworld-policy.json');
  if (!policyResponse.ok) throw new Error('자율 필드의 신경 정책을 읽지 못했습니다.');
  fieldPolicy = await policyResponse.json() as FieldPolicy;
  const originalPolicyResponse = await fetch('/data/field-policy.json');
  if (!originalPolicyResponse.ok) throw new Error('기존 이동 정책을 확인하지 못했습니다.');
  originalFieldPolicy = await originalPolicyResponse.json() as FieldPolicy;
  const legacyPolicyResponse = await fetch('/data/openworld-policy-legacy.json');
  if (!legacyPolicyResponse.ok) throw new Error('기존 관동 이동 정책을 확인하지 못했습니다.');
  legacyOpenWorldPolicy = await legacyPolicyResponse.json() as FieldPolicy;
  const runtime = createFieldRuntime(() => { if (tab === 'map') { try { worldPanel?.tick(); } catch (error) { if (worldPanel) worldPanel.paused = true; notify(error instanceof Error ? error.message : '월드 실행 오류', true); } } }, 250);
  await runtime.start();
  const stored = await readSave();
  if (stored) {
    const loaded = unpackSave(stored, controller.graph); game = loaded.game; view = { ...loaded.view, rewards: (loaded.view as PersistentView).rewards ?? {} };
    selectedMonsterId = game.player.team[0].instanceId; prepareWorld(); render();
  } else $<HTMLDialogElement>('#starter-dialog').showModal();
} catch (error) { $('#screen').innerHTML = `<section class="fatal"><span>!</span><h1>게임을 시작할 수 없습니다</h1><p>${escapeHtml(error instanceof Error ? error.message : error)}</p><button onclick="location.reload()">다시 시도</button></section>`; } }
void boot();
