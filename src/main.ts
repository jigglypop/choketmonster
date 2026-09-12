import { hasPokemonModel } from './game/assets';
import { getWorldAtlas } from './openworld/atlas';
import './game.css';
import './team.css';
import { currentAccount } from './game/account';
import { mountAccountPanel } from './game/account-panel';
import { VERSIONS, getVersionSpecies, getPokemonVersion, getPokemonForms } from './data/pokemon-versions';
import './three/scene.css';
import { detachPokemonScene, getPokemonScene } from './three/scene';
import { OpenWorldPanel } from './openworld/panel';
import type { OpenWorldSnapshot } from './openworld/simulation';
import { movementSpeed } from './openworld/simulation';
import { kantoSpeciesSources } from './openworld/kanto';
import { createFieldRuntime } from './three/field-runtime';
import type { FieldPolicy } from './game/field';
import { getMove, getSpecies, POKEMON } from './data/pokemon';
import { pokemonSpriteUrl } from './game/assets';
import { drawBrain } from './render';
import {
  actBattle, availableEvolutions, buyItem, challengeChampion, challengeGym, createGame,
  depositMonster, evolve, explore, heal, mergeDuplicateMonster, releaseMonster, ITEM_LABELS, ITEM_PRICES, useItem, withdrawMonster,
  type BallItem, type BattleAction, type GameState, type InventoryItem, type Monster,
} from './game/engine';
import { BRAIN_ASSUMPTIONS, ConnectomeController } from './game/connectome';
import { chooseServerBrains, initializeServerBrain, lastServerDecision, setServerBrainScope, usesServerBrain } from './game/server-brain';
import { tileAt, walk } from './game/map';
import { REGIONS, getRegion } from './game/regions';
import { defaultView, getSaveStorageStatus, onSaveStorageStatus, packSave, readSave, unpackSave, writeSave, type ViewState } from './game/storage';

import './responsive.css';

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
let tab: Tab = 'map', selectedMonsterId = '', dexQuery = '', boxQuery = '';
let dexVersion = 'national', dexPage = 0;
let pausedBeforeAccountSwitch = false;
let accountPanel: ReturnType<typeof mountAccountPanel> | undefined;
let dexMode: 'all' | 'seen' | 'caught' = 'all';
let boxType = 'all', boxSort: 'number' | 'level' | 'name' | 'recent' = 'number', boxPage = 0;
let grassSteps = 0, toastTimer = 0, autosaveTimer = 0;
let autoBattle = false, brainTurnPending = false, lastDecision = '회로 대기 중';
let serverConnectome: { available: boolean; graphId?: string; kind?: string; nodes?: number; edges?: number; activeEdges?: number } | null = null;

app.innerHTML = `
  <header class="topbar"><a class="brand" href="#"><span class="brand-ball"></span><span>초켓몬스터</span><small>OPEN WORLD ADVENTURE</small></a>
    <nav aria-label="주 메뉴"><button data-tab="map" class="active">모험</button><button data-tab="team">팀 · 박스</button><button data-tab="dex">도감</button><button data-tab="shop">상점</button><button data-tab="lab">연구실</button></nav>
    <div class="trainer-summary"><span id="money">₩0</span><span id="badges">도감 0/${POKEMON.length}</span><span id="save-state" class="save-state" data-state="local" aria-live="polite"><i></i> 이 기기에 저장됨</span><button id="save-now" class="quiet">지금 저장</button><span class="device-storage">이 기기에 저장</span><span id="account-controls"></span></div></header>
  <main id="screen" tabindex="-1"><section class="loading"><span class="spinner"></span><h1>실제 커넥톰을 불러오는 중</h1><p>Male CNS 부분 회로를 확인하고 있습니다.</p></section></main>
  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div><input id="import-file" type="file" accept="application/json" hidden>
  <dialog id="starter-dialog" class="starter-dialog"><div class="starter-copy"><span class="kicker">PALLET LAB · 첫 파트너</span><h1>함께 떠날 포켓몬을<br>선택하세요</h1><p>선택한 한 마리만 처음 팀에 들어옵니다. 각 개체는 서로 다른 회로 상태와 학습 기록을 이 기기에 보관합니다.</p><div class="starter-account"><span>진행 상황은 이 브라우저의 IndexedDB에 자동 저장됩니다.</span></div></div><div class="starter-grid">
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
function graphChoose(monster: Monster, other: Monster, battle: NonNullable<GameState['battle']>, reward: number | null, learning: boolean, automatic = false) {
  const self = effective(battle, monster), foe = effective(battle, other);
  const selfProxy = { ...monster, ...self, brain: monster.brain }, foeProxy = { ...other, ...foe, brain: other.brain };
  const decision = controller.choose(selfProxy, foeProxy, battle.turn, reward, learning, { selfStatStages: battle.statStages?.[monster.instanceId], otherStatStages: battle.statStages?.[other.instanceId], automatic });
  monster.brain = selfProxy.brain;
  return decision;
}
function clearPendingLearning(monster: Monster) {
  view.rewards ??= {}; delete view.rewards[monster.instanceId];
  const brain = controller.ensure(monster); brain.state.previous = null; monster.brain = brain.snapshot();
}
function monsterCard(monster: Monster, action = '', variant = '') { const species = getSpecies(monster.speciesId), interactive = Boolean(variant); return `<article class="monster-card ${variant} ${monster.instanceId === selectedMonsterId ? 'selected' : ''}" data-monster="${monster.instanceId}"${interactive ? ` tabindex="0" role="button" aria-label="${escapeHtml(monster.nickname)}, 레벨 ${monster.level}, 개체 ${escapeHtml(monster.instanceId.slice(-8))} 상세 보기"` : ''}><img src="${species.frontSprite}" alt=""><div class="monster-card-copy"><span>No.${String(species.id).padStart(3, '0')} · Lv.${monster.level}</span><strong>${escapeHtml(monster.nickname)}</strong><div>${typesHtml(species.id)}</div><small>HP ${monster.hp}/${monster.stats.hp} · ID ${escapeHtml(monster.instanceId.slice(-8))}</small></div>${action}</article>`; }
function setSaveState(state: 'pending' | 'saving' | 'saved' | 'error' | 'local' | 'synced', message = '') { const badge = document.querySelector<HTMLElement>('#save-state'); if (!badge) return; badge.dataset.state = state; badge.title = message; badge.lastChild!.textContent = ` ${state === 'pending' ? '변경 있음' : state === 'saving' ? '저장 중' : state === 'error' ? '동기화 확인 필요' : state === 'synced' ? '서버 동기화 완료' : '이 기기에 저장됨'}`; }
async function saveNow(announce = false, throwOnError = false) { if (!game || !controller) return; if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = 0; } setSaveState('saving'); try { captureWorld(); await writeSave(packSave(game, controller.graph, view)); const status = getSaveStorageStatus(); setSaveState(status?.state ?? 'local', status?.message); if (announce) notify('이 기기에 저장했습니다.'); } catch (error) { setSaveState('error'); notify(`저장하지 못했습니다: ${error instanceof Error ? error.message : error}`, true); if (throwOnError) throw error; } }
function queueSave() { setSaveState('pending'); if (!autosaveTimer) autosaveTimer = window.setTimeout(() => { autosaveTimer = 0; void saveNow(); }, 1000); }
function shellStats() { if (!game) return; $('#money').textContent = `₩${game.player.money.toLocaleString('ko-KR')}`; $('#badges').textContent = `도감 ${game.dex.caught.length}/${POKEMON.length}`; $('.topbar').classList.toggle('map-overlay', tab === 'map'); document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab)); }
onSaveStorageStatus(status => setSaveState(status.state, status.message));
function captureWorld() { if (worldPanel) { view.openWorld = worldPanel.simulation.snapshot(); view.openWorldPaused = worldPanel.paused; } }
function prepareWorld() {
  worldPanel?.unmount(); worldPanel = undefined;
  if (!game) return;
  setServerBrainScope(currentAccount() ? `account:${currentAccount()!.id}:${game.seed}` : game.seed);
  if (game.battle && !view.openWorld) return;
  if (view.openWorld && view.openWorld.mapVersion !== getWorldAtlas(view.openWorld.regionId ?? 'kanto').mapVersion) {
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
    changed: immediate => { shellStats(); if (immediate) return saveNow(false, true); queueSave(); } });
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
  $('#screen').innerHTML = `<div class="battle-page page"><div class="battle-top"><div><span class="kicker">${battle.kind.toUpperCase()} BATTLE · TURN ${battle.turn}</span><h1>${battle.kind === 'wild' ? '야생 포켓몬과 조우' : battle.kind === 'gym' ? '체육관 승부' : '챔피언 결정전'}</h1></div><div class="brain-controls"><label><input id="learning" type="checkbox" ${view.learning ? 'checked' : ''}> 기술 학습</label><label class="switch"><input id="auto" type="checkbox" ${autoBattle ? 'checked' : ''}><span></span> 커넥톰 자동 배틀</label><button id="brain-turn" class="primary">회로로 한 턴</button></div></div>
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
function chooseAction(monster: Monster, other: Monster, battle: NonNullable<GameState['battle']>, reward: number | null, learning: boolean): BattleAction { const decision = graphChoose(monster, other, battle, reward, learning, true); lastDecision = `출력 ${decision.rawAction} → ${decision.action === 4 ? '대기' : `${decision.action + 1}번 기술`} · 활성도 ${(decision.activity * 100).toFixed(1)}%`; return decision.action === 4 ? { type: 'wait' } : { type: 'move', index: decision.action }; }
function performBrainTurn() { if (!game?.battle || brainTurnPending) return; void performTurn(null, true); }
async function performTurn(playerAction: BattleAction | null, learnedChoice: boolean) {
  if (!game?.battle || brainTurnPending) return; brainTurnPending = true; const battle = game.battle, player = active(battle.player), enemy = active(battle.enemy), turn = battle.turn, playerBefore = player.hp / player.stats.hp, enemyBefore = enemy.hp / enemy.stats.hp;
  const enemyBrainBefore = enemy.brain ? structuredClone(enemy.brain) : undefined, playerBrainBefore = player.brain ? structuredClone(player.brain) : undefined;
  try {
    const episode = `classic:${battle.enemy.team[0].instanceId}`;
    let enemyDecision;
    if (usesServerBrain()) {
      const automaticPlayer = !playerAction;
      const choices = [
        ...(automaticPlayer ? [{ self: { ...player, ...effective(battle, player) }, foe: { ...enemy, ...effective(battle, enemy) }, turn, reward: view.rewards?.[player.instanceId] ?? null, learning: view.learning, battleId: episode, context: { selfStatStages: battle.statStages?.[player.instanceId], otherStatStages: battle.statStages?.[enemy.instanceId], automatic: true } }] : []),
        { self: { ...enemy, ...effective(battle, enemy) }, foe: { ...player, ...effective(battle, player) }, turn, reward: null, learning: false, battleId: episode, context: { selfStatStages: battle.statStages?.[enemy.instanceId], otherStatStages: battle.statStages?.[player.instanceId], automatic: true } },
      ];
      const decisions = await chooseServerBrains(controller, choices);
      if (automaticPlayer) {
        const decision = decisions[0]; playerAction = decision.action === 4 ? { type: 'wait' } : { type: 'move', index: decision.action };
        lastDecision = `서버 ${decision.nodes.toLocaleString()}개 노드 · ${decision.elapsedMs.toFixed(1)}ms · 학습 ${decision.updates}회`;
      }
      enemyDecision = decisions[automaticPlayer ? 1 : 0];
    } else {
      if (!playerAction) playerAction = chooseAction(player, enemy, battle, view.rewards?.[player.instanceId] ?? null, view.learning);
      enemyDecision = graphChoose(enemy, player, battle, null, false, true);
    }
    if (!playerAction) throw new Error('플레이어 행동을 결정하지 못했습니다.');
    if (!learnedChoice) clearPendingLearning(player);
    const result = actBattle(game, playerAction, enemyDecision.action);
    const playerAfter = result.outcome === 'lost' ? 0 : player.hp / player.stats.hp, enemyAfter = enemy.hp / enemy.stats.hp;
    const reward = (enemyBefore - enemyAfter) - (playerBefore - playerAfter) + (result.outcome === 'won' ? 1 : result.outcome === 'lost' ? -1 : 0);
    view.rewards ??= {};
    if (learnedChoice && !result.battleEnded) view.rewards[player.instanceId] = reward; else delete view.rewards[player.instanceId];
    if (result.battleEnded) {
      if (usesServerBrain()) {
        await chooseServerBrains(controller, [
          { self: player, foe: enemy, turn: turn + 1, reward, learning: learnedChoice && view.learning, battleId: episode, terminal: true },
          { self: enemy, foe: player, turn: turn + 1, reward: -reward, learning: false, battleId: episode, terminal: true },
        ]);
      } else if (learnedChoice) controller.finish(player, reward, view.learning);
      autoBattle = false; view.rewards = {};
    }
    await saveNow(false, true);
  }
  catch (error) { autoBattle = false; enemy.brain = enemyBrainBefore; player.brain = playerBrainBefore; notify(error instanceof Error ? error.message : '행동을 처리하지 못했습니다.', true); } finally { brainTurnPending = false; render(); if (autoBattle && game?.battle) scheduleAutoTurn(); }
}
function scheduleAutoTurn() { window.setTimeout(() => { if (autoBattle && game?.battle && !brainTurnPending) performBrainTurn(); }, 650); }
function showSwitchMenu() { if (!game?.battle) return; const menu = document.createElement('div'); menu.className = 'modal-shade'; menu.innerHTML = `<section class="choice-modal"><span class="eyebrow">TEAM SWITCH</span><h2>교체할 포켓몬</h2><div>${game.battle.player.team.map((monster, index) => `<button data-switch="${index}" ${monster.hp <= 0 || index === game!.battle!.player.activeIndex ? 'disabled' : ''}>${monsterCard(monster)}</button>`).join('')}</div><button class="quiet close-choice">취소</button></section>`; document.body.append(menu); menu.querySelectorAll<HTMLButtonElement>('[data-switch]').forEach(b => b.onclick = () => { menu.remove(); performTurn({ type: 'switch', index: Number(b.dataset.switch) }, false); }); menu.querySelector<HTMLButtonElement>('.close-choice')!.onclick = () => menu.remove(); }

const BOX_PAGE_SIZE = 24;
function boxMatches(monster: Monster) {
  const species = getSpecies(monster.speciesId), query = boxQuery.trim().toLowerCase();
  return (boxType === 'all' || species.types.some(type => type === boxType)) && (!query || species.name.includes(query) || species.englishName.toLowerCase().includes(query) || String(species.id).includes(query) || monster.nickname.toLowerCase().includes(query) || monster.instanceId.toLowerCase().includes(query));
}
function sortedBox() {
  if (!game) return [];
  const indexed = game.player.box.map((monster, index) => ({ monster, index })).filter(({ monster }) => boxMatches(monster));
  indexed.sort((a, b) => boxSort === 'recent' ? b.index - a.index : boxSort === 'level' ? b.monster.level - a.monster.level || a.index - b.index : boxSort === 'name' ? a.monster.nickname.localeCompare(b.monster.nickname, 'ko') || a.index - b.index : a.monster.speciesId - b.monster.speciesId || a.index - b.index);
  return indexed.map(({ monster }) => monster);
}
function boxCollectionHtml() {
  if (!game) return '';
  const matches = sortedBox(), pages = Math.max(1, Math.ceil(matches.length / BOX_PAGE_SIZE)); boxPage = Math.min(boxPage, pages - 1);
  const page = matches.slice(boxPage * BOX_PAGE_SIZE, (boxPage + 1) * BOX_PAGE_SIZE);
  return `<div class="box-result-line"><span>${matches.length}마리${matches.length !== game.player.box.length ? ` / 전체 ${game.player.box.length}마리` : ''}</span><span>${boxPage + 1} / ${pages} 페이지</span></div><div class="box-grid" role="list" aria-label="보관된 포켓몬">${page.map(monster => monsterCard(monster, `<button class="card-action" data-withdraw-id="${escapeHtml(monster.instanceId)}" ${game!.player.team.length >= 6 ? 'disabled' : ''}>데려오기</button>`, 'box-monster')).join('') || '<p class="empty box-empty">검색 조건에 맞는 포켓몬이 없습니다.</p>'}</div><nav class="box-pagination" aria-label="박스 페이지"><button data-box-page="${boxPage - 1}" ${boxPage === 0 ? 'disabled' : ''}>이전</button><span>${boxPage + 1}<small> / ${pages}</small></span><button data-box-page="${boxPage + 1}" ${boxPage >= pages - 1 ? 'disabled' : ''}>다음</button></nav>`;
}
function detailHtml(selected: Monster) {
  if (!game) return ''; const species = getSpecies(selected.speciesId), ready = availableEvolutions(game, selected.instanceId); controller.ensure(selected);
  return `<div class="detail-portrait"><span>No.${String(species.id).padStart(3, '0')}</span><img src="${species.frontSprite}" alt="${species.name}"></div><div class="detail-title"><div>${typesHtml(species.id)}</div><h2>${escapeHtml(selected.nickname)}</h2><p>Lv.${selected.level} · 개체 ID <code>${escapeHtml(selected.instanceId)}</code></p><span class="brain-memory"><i></i> 이 개체의 회로 상태 · ${selected.brain ? '저장됨' : '준비 중'}</span></div><div class="stat-list">${([['HP', `${selected.hp}/${selected.stats.hp}`], ['공격', selected.stats.attack], ['방어', selected.stats.defense], ['특공', selected.stats.specialAttack], ['특방', selected.stats.specialDefense], ['스피드', selected.stats.speed], ['이동 속도', `${movementSpeed(selected.speciesId, selected.level).toFixed(1)} m/s`]] as const).map(([label, value]) => `<span>${label}<b>${value}</b></span>`).join('')}</div><div class="detail-xp"><span>누적 경험치</span><strong>${selected.xp.toLocaleString()}</strong></div><h3>현재 기술</h3><div class="move-list">${selected.moves.map(slot => { const move = getMove(slot.moveId); return `<span><b>${move.name}</b><small>${typeLabel[move.type]} · 위력 ${move.power || '—'} · 명중 ${move.accuracy || '—'}<br>PP ${slot.pp}/${move.pp} · 우선도 ${move.priority}</small></span>`; }).join('')}</div><h3>다음 습득 기술</h3><div class="move-list">${species.moves.filter(entry => entry.level > selected.level).slice(0, 3).map(entry => `<span><b>${getMove(entry.moveId).name}</b><small>Lv.${entry.level}</small></span>`).join('') || '<p class="empty">레벨업 기술을 모두 익혔습니다.</p>'}</div><div class="item-use"><button id="use-potion">상처약 ×${game.inventory.potion}</button><button id="use-candy">이상한사탕 ×${game.inventory['rare-candy']}</button></div><h3>진화</h3><div class="evolution-list">${species.evolutions.map(evo => { const target = getSpecies(evo.target), available = ready.some(c => c.target === evo.target), requirement = evo.method === 'special' ? '특수 진화 · 이 게임에서는 야생 포획으로 수집' : evo.method === 'level' ? `Lv.${evo.level}` : evo.method === 'trade' ? '연결의끈' : ITEM_LABELS[evo.item as InventoryItem] ?? evo.item; return `<button data-evolve="${evo.target}" ${available ? '' : 'disabled'}><img src="${target.frontSprite}" alt=""><span><b>${target.name}</b><small>${requirement}</small></span></button>`; }).join('') || '<p class="empty">더 이상 진화하지 않습니다.</p>'}</div>`;
}
function renderSelectedDetail() {
  if (!game) return; const selected = owned().find(monster => monster.instanceId === selectedMonsterId) ?? game.player.team[0]; selectedMonsterId = selected.instanceId;
  const detail = $<HTMLElement>('#team-detail'); detail.innerHTML = detailHtml(selected);
  detail.querySelectorAll<HTMLButtonElement>('[data-evolve]').forEach(button => button.onclick = () => action(() => evolve(game!, selected.instanceId, { targetId: Number(button.dataset.evolve) }), '진화가 완료됐습니다.'));
  $<HTMLButtonElement>('#use-potion').onclick = () => action(() => useItem(game!, 'potion', selected.instanceId)); $<HTMLButtonElement>('#use-candy').onclick = () => action(() => useItem(game!, 'rare-candy', selected.instanceId));
  const duplicates = owned().filter(monster => monster.speciesId === selected.speciesId && monster.instanceId !== selected.instanceId);
  detail.insertAdjacentHTML('beforeend', `<section class="collection-actions"><h3>개체 관리</h3><p>경험치를 합치면 선택한 중복 개체를 놓아주고, 현재 개체의 회로 기억을 유지합니다.</p>${duplicates.length ? `<label for="merge-donor">경험치를 보낼 중복 개체</label><select id="merge-donor">${duplicates.map(monster => `<option value="${monster.instanceId}">Lv.${monster.level} · ${monster.instanceId} · 경험치 ${monster.xp.toLocaleString()}</option>`).join('')}</select><button id="merge-duplicate" ${selected.level >= 100 ? 'disabled' : ''}>이 포켓몬에게 경험치 합치기</button>` : '<small>같은 종을 더 잡으면 경험치를 합칠 수 있습니다.</small>'}<button id="release-monster" class="danger" ${game.player.team.length === 1 && game.player.team[0].instanceId === selected.instanceId ? 'disabled' : ''}>이 포켓몬 놓아주기</button></section>`);
  const remove = async (donorId: string, merge: boolean) => {
    if (!game || !confirm(merge ? `${donorId}을(를) 놓아주고 ${selected.nickname}에게 경험치를 합칠까요? 남긴 개체의 기억은 유지됩니다.` : `${selected.nickname} (${donorId})을(를) 놓아줄까요? 도감 기록은 유지됩니다.`)) return;
    try {
      captureWorld(); await writeSave(packSave(game, controller.graph, view), 'backup-before-release');
      if (merge) mergeDuplicateMonster(game, selected.instanceId, donorId); else releaseMonster(game, donorId);
      if (view.rewards) delete view.rewards[donorId];
      captureWorld(); renderTeam(); shellStats(); await saveNow(false, true); notify(merge ? '경험치를 합쳤습니다.' : '포켓몬을 놓아주었습니다.');
    } catch (error) { notify(String(error), true); }
  };
  detail.querySelector<HTMLButtonElement>('#merge-duplicate')?.addEventListener('click', () => void remove($<HTMLSelectElement>('#merge-donor').value, true));
  $('#release-monster').onclick = () => void remove(selected.instanceId, false);
  if (game.battle) detail.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; });
  if (hasPokemonModel(selected.speciesId)) getPokemonScene().showSpecimen($('.detail-portrait'), selected.speciesId); else getPokemonScene().detach();
}
function chooseTeamMonster(card: HTMLElement) {
  selectedMonsterId = card.dataset.monster!; document.querySelectorAll<HTMLElement>('.team-page [data-monster]').forEach(item => item.classList.toggle('selected', item.dataset.monster === selectedMonsterId)); renderSelectedDetail();
}
function bindMonsterCards(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('[data-monster]').forEach(card => { card.onclick = event => { if ((event.target as HTMLElement).closest('.card-action')) return; chooseTeamMonster(card); }; card.onkeydown = event => { if ((event.key === 'Enter' || event.key === ' ') && !(event.target as HTMLElement).closest('.card-action')) { event.preventDefault(); chooseTeamMonster(card); } }; });
}
function bindBoxCollection() {
  const collection = $('#box-collection'); bindMonsterCards(collection);
  collection.querySelectorAll<HTMLButtonElement>('[data-withdraw-id]').forEach(button => button.onclick = () => action(() => { const index = game!.player.box.findIndex(monster => monster.instanceId === button.dataset.withdrawId); if (index < 0) throw new Error('박스에서 개체를 찾지 못했습니다.'); withdrawMonster(game!, index); }));
  collection.querySelectorAll<HTMLButtonElement>('[data-box-page]').forEach(button => button.onclick = () => { boxPage = Number(button.dataset.boxPage); collection.innerHTML = boxCollectionHtml(); bindBoxCollection(); collection.scrollIntoView({ block: 'nearest' }); });
}
function renderTeam() {
  if (!game) return; const all = owned(); if (!selectedMonsterId || !all.some(monster => monster.instanceId === selectedMonsterId)) selectedMonsterId = game.player.team[0].instanceId;
  $('#screen').innerHTML = `<div class="page team-page"><section class="section-heading team-heading"><div><span class="kicker">INDIVIDUAL MEMORY</span><h1>팀과 박스</h1><p>같은 종도 개체 ID와 회로 상태, 학습 기록을 서로 따로 보관합니다.</p></div><span class="count-chip">팀 ${game.player.team.length}/6 · 박스 ${game.player.box.length}</span></section><section class="team-rack panel" aria-labelledby="team-title"><div class="subheading"><div><span class="kicker">ACTIVE PARTY</span><h2 id="team-title">함께 걷는 팀</h2></div><small>첫 칸이 선두입니다</small></div><div class="team-slots">${game.player.team.map((monster, index) => monsterCard(monster, `<div class="card-actions"><button class="card-action" data-lead="${index}" ${index === 0 ? 'disabled' : ''}>선두</button><button class="card-action" data-deposit="${index}" ${game!.player.team.length <= 1 ? 'disabled' : ''}>맡기기</button></div>`, 'team-monster')).join('')}${Array.from({ length: 6 - game.player.team.length }, (_, index) => `<div class="team-slot-empty" aria-label="빈 팀 슬롯">${game!.player.team.length + index + 1}</div>`).join('')}</div></section><div class="team-layout"><section class="box-panel panel"><div class="subheading box-heading"><div><span class="kicker">STORAGE BOX</span><h2>보관 박스</h2></div></div><div class="box-tools"><label class="box-search"><span>박스 검색</span><input id="box-search" type="search" value="${escapeHtml(boxQuery)}" placeholder="이름, 번호, 개체 ID" autocomplete="off"></label><label><span>타입</span><select id="box-type"><option value="all">모든 타입</option>${Object.entries(typeLabel).map(([value, label]) => `<option value="${value}" ${boxType === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label><span>정렬</span><select id="box-sort"><option value="number" ${boxSort === 'number' ? 'selected' : ''}>도감 번호</option><option value="level" ${boxSort === 'level' ? 'selected' : ''}>레벨 높은 순</option><option value="name" ${boxSort === 'name' ? 'selected' : ''}>이름</option><option value="recent" ${boxSort === 'recent' ? 'selected' : ''}>최근 보관</option></select></label></div><div id="box-collection">${boxCollectionHtml()}</div></section><aside id="team-detail" class="detail-card panel" aria-live="polite"></aside></div></div>`;
  bindMonsterCards($('.team-rack')); document.querySelectorAll<HTMLButtonElement>('[data-lead]').forEach(button => button.onclick = () => action(() => { const index = Number(button.dataset.lead), [monster] = game!.player.team.splice(index, 1); game!.player.team.unshift(monster); }, '선두 포켓몬을 바꿨습니다.')); document.querySelectorAll<HTMLButtonElement>('[data-deposit]').forEach(button => button.onclick = () => action(() => depositMonster(game!, Number(button.dataset.deposit))));
  const search = $<HTMLInputElement>('#box-search'); search.oninput = () => { boxQuery = search.value; boxPage = 0; $('#box-collection').innerHTML = boxCollectionHtml(); bindBoxCollection(); }; $<HTMLSelectElement>('#box-type').onchange = event => { boxType = (event.target as HTMLSelectElement).value; boxPage = 0; $('#box-collection').innerHTML = boxCollectionHtml(); bindBoxCollection(); }; $<HTMLSelectElement>('#box-sort').onchange = event => { boxSort = (event.target as HTMLSelectElement).value as typeof boxSort; boxPage = 0; $('#box-collection').innerHTML = boxCollectionHtml(); bindBoxCollection(); };
  bindBoxCollection(); renderSelectedDetail(); if (game.battle) document.querySelectorAll<HTMLButtonElement>('.team-page .card-action').forEach(button => { button.disabled = true; });
}

function renderDex() {
  getPokemonScene().detach();
  if (!game) return;
  const pool = getVersionSpecies(dexVersion), caughtIds = dexVersion === 'national' ? game.dex.caught : game.versionCaught?.[dexVersion] ?? [];
  const q = dexQuery.trim().toLowerCase();
  const filtered = pool.filter(s => (!q || s.name.includes(q) || s.englishName.toLowerCase().includes(q) || String(s.id) === q || s.types.some(type => type.includes(q) || typeLabel[type].includes(q)))
    && (dexMode === 'all' || (dexMode === 'caught' ? caughtIds : game!.dex.seen).includes(s.id)));
  const pageSize = 60, pages = Math.max(1, Math.ceil(filtered.length / pageSize)); dexPage = Math.min(dexPage, pages - 1);
  const versionName = dexVersion === 'national' ? '전국도감' : getPokemonVersion(dexVersion).name;
  $('#screen').innerHTML = `<div class="page dex-page"><section class="section-heading"><div><span class="kicker">POKÉDEX · COLLECTION</span><h1>${escapeHtml(versionName)}</h1><p>수록 ${pool.length}종 · 수집 ${caughtIds.filter(id => pool.some(s => s.id === id)).length}종</p></div>
    <div class="dex-tools"><label for="dex-version">버전별 도감</label><select id="dex-version"><option value="national">전국도감 · ${POKEMON.length}종</option>${VERSIONS.map(version => `<option value="${version.id}" ${version.speciesIds.length ? '' : 'disabled'}>${escapeHtml(version.name)}${version.id.endsWith('-japan') ? ' (일본판)' : ''} · ${version.speciesIds.length ? `${version.speciesIds.length}종` : '원본 도감 없음'}</option>`).join('')}</select><input id="dex-search" type="search" aria-label="도감 검색" value="${escapeHtml(dexQuery)}" placeholder="이름, 번호, 타입 검색"><div>${(['all', 'seen', 'caught'] as const).map(mode => `<button data-dex-mode="${mode}" class="${dexMode === mode ? 'active' : ''}">${mode === 'all' ? '전체' : mode === 'seen' ? '발견' : '수집'}</button>`).join('')}</div></div></section>
    <section class="collection-note"><p>버전 목록은 원본 지역도감 기준입니다. 선택한 버전의 지역 맵에 이 게임의 규칙으로 배치합니다. 지형·배치·출현은 게임용으로 구성했으며 본가 지도와 다릅니다. 버전마다 직접 잡거나 진화한 기록을 따로 모읍니다.</p><button id="collect-version" class="primary" ${game.adventureVersion === dexVersion ? 'disabled' : ''}>${game.adventureVersion === dexVersion ? '이 버전 수집 중' : '이 버전에서 수집'}</button></section>
    <div class="dex-grid">${filtered.slice(dexPage * pageSize, (dexPage + 1) * pageSize).map(s => {
      const seen = game!.dex.seen.includes(s.id), caught = caughtIds.includes(s.id);
      const regions = s.id <= 151 && ['red', 'blue', 'yellow'].includes(dexVersion) ? kantoSpeciesSources(s.id).join(' / ') : '수집 버전 선택 후 해당 지역 탐험';
      return `<article class="dex-card" data-species="${s.id}" tabindex="0" role="button" aria-label="${escapeHtml(s.name)} 상세 보기"><span>No.${String(s.id).padStart(3, '0')} · ${escapeHtml(s.englishName)}</span><img loading="lazy" src="${s.frontSprite}" alt="${escapeHtml(s.name)}"><strong>${escapeHtml(s.name)}</strong><div>${typesHtml(s.id)}</div><small>${caught ? '● 수집' : seen ? '○ 발견' : '미발견'}</small><p><b>출현</b> ${escapeHtml(regions)}</p></article>`;
    }).join('') || '<p class="empty">검색 조건에 맞는 포켓몬이 없습니다.</p>'}</div>
    <nav class="box-pagination" aria-label="도감 페이지"><button id="dex-prev" ${dexPage === 0 ? 'disabled' : ''}>이전</button><span>${dexPage + 1} / ${pages} · 검색 ${filtered.length}종</span><button id="dex-next" ${dexPage + 1 >= pages ? 'disabled' : ''}>다음</button></nav></div>`;
  document.querySelectorAll<HTMLElement>('[data-species]').forEach(card => {
    card.onclick = () => showModel(Number(card.dataset.species));
    card.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.click(); } };
  });
  const select = $<HTMLSelectElement>('#dex-version'); select.value = dexVersion;
  select.onchange = () => { dexVersion = select.value; dexPage = 0; renderDex(); };
  $('#collect-version').onclick = () => action(() => { if (!worldPanel) prepareWorld(); worldPanel!.simulation.changeVersion(dexVersion); tab = 'map'; }, `${versionName} 수집을 시작합니다.`);
  const search = $<HTMLInputElement>('#dex-search'); search.oninput = () => { dexQuery = search.value; dexPage = 0; renderDex(); $<HTMLInputElement>('#dex-search').focus(); };
  document.querySelectorAll<HTMLButtonElement>('[data-dex-mode]').forEach(button => button.onclick = () => { dexMode = button.dataset.dexMode as typeof dexMode; dexPage = 0; renderDex(); });
  $('#dex-prev').onclick = () => { dexPage--; renderDex(); }; $('#dex-next').onclick = () => { dexPage++; renderDex(); };
}
function renderShop() { if (!game) return; getPokemonScene().detach(); $('#screen').innerHTML = `<div class="page shop-page"><section class="section-heading"><div><span class="kicker">ROUTE MARKET</span><h1>모험 상점</h1><p>포획, 회복, 진화에 필요한 12가지 도구입니다.</p></div><strong class="wallet">₩${game.player.money.toLocaleString()}</strong></section><div class="shop-grid">${itemKeys.map(item => `<article class="shop-card"><span class="item-icon">${item.includes('ball') ? '◉' : item.includes('stone') ? '◆' : item === 'link-cable' ? '∞' : '✦'}</span><div><strong>${ITEM_LABELS[item]}</strong><small>보유 ${game!.inventory[item]}개</small></div><b>₩${ITEM_PRICES[item].toLocaleString()}</b><button data-buy="${item}" ${game!.player.money < ITEM_PRICES[item] ? 'disabled' : ''}>1개 구매</button></article>`).join('')}</div><section class="center-banner"><div><span class="eyebrow">POKÉMON CENTER</span><h2>팀을 무료로 회복하세요</h2><p>HP와 모든 기술의 PP, 상태 이상을 한 번에 회복합니다.</p></div><button id="shop-heal" class="primary">무료 회복</button></section></div>`; document.querySelectorAll<HTMLButtonElement>('[data-buy]').forEach(b => b.onclick = () => action(() => buyItem(game!, b.dataset.buy as InventoryItem), `${ITEM_LABELS[b.dataset.buy as InventoryItem]}을(를) 샀습니다.`)); $('#shop-heal').onclick = () => action(() => heal(game!), '팀을 모두 회복했습니다.'); }

function serverCircuitHtml() {
  const remote = serverConnectome, available = Boolean(remote?.available);
  return `<section class="server-circuit panel" data-available="${String(available)}"><div><span class="eyebrow">SERVER CONNECTOME</span><h2>${available ? '서버 전체 회로' : '서버 회로 미연결'}</h2><p>${available ? '서버 배틀 계산은 브라우저용 128개 부분 회로와 구분된 전체 회로를 사용하며, 반환된 개체 상태는 이 기기에 저장합니다.' : '현재는 브라우저의 128개 부분 회로로 실행합니다.'}</p></div><dl><div><dt>종류</dt><dd>${escapeHtml(remote?.kind ?? '확인 불가')}</dd></div><div><dt>뉴런</dt><dd>${remote?.nodes?.toLocaleString() ?? '—'}</dd></div><div><dt>연결</dt><dd>${remote?.edges?.toLocaleString() ?? '—'}</dd></div><div><dt>활성 연결</dt><dd>${remote?.activeEdges?.toLocaleString() ?? '—'}</dd></div><div><dt>그래프 ID</dt><dd><code>${escapeHtml(remote?.graphId ?? '—')}</code></dd></div></dl></section>`;
}
function renderLab() {
  getPokemonScene().detach();
  if (!game) return; const specimen = owned().find(m => m.instanceId === selectedMonsterId) ?? game.player.team[0], brain = controller.ensure(specimen);
  const serverReceipt = lastServerDecision(specimen.instanceId);
  if (serverReceipt) lastDecision = `서버 ${serverReceipt.nodes.toLocaleString()}개 뉴런 · 마지막 출력 ${serverReceipt.action + 1} · ${serverReceipt.elapsedMs.toFixed(1)}ms · 학습 ${serverReceipt.updates}회. 아래 연결 그림은 브라우저 부분 회로입니다.`;
  const provenance = controller.graph.provenance;
  $('#screen').innerHTML = `<div class="page lab-page"><section class="lab-hero"><div><span class="kicker">MALE CNS · CONNECTOME SUBSET</span><h1>실제 연결 지도,<br>게임용 동역학</h1><p>커넥톰은 신경 연결 지도이며 완성된 뇌가 아닙니다. 이 게임은 실제 연결 일부 위에 감각·행동·학습 규칙을 직접 설계했습니다.</p></div><div class="graph-numbers"><span><strong>${controller.graph.nodes.length}</strong>브라우저 뉴런</span><span><strong>${controller.graph.edges.length.toLocaleString()}</strong>브라우저 연결</span><span><strong>64</strong>화면 표시</span></div></section>${serverCircuitHtml()}<div class="lab-layout"><section class="brain-card panel"><div class="panel-heading"><div><span class="eyebrow">LIVE ACTIVITY · ${escapeHtml(specimen.nickname)}</span><h2>회로 활성도</h2></div><span class="live-dot">LIVE</span></div><canvas id="brain-canvas" width="280" height="170"></canvas><p>${escapeHtml(lastDecision)}</p></section><section class="method-card panel"><span class="eyebrow">MODEL DISCLOSURE</span><h2>직접 설계한 부분</h2><p>${escapeHtml(BRAIN_ASSUMPTIONS)}</p><dl><div><dt>회로 범위</dt><dd>Male CNS v1.0, DNa02 이웃 128개 노드</dd></div><div><dt>행동 출력</dt><dd>0~3 기술, 4 기다리기</dd></div><div><dt>학습 보상</dt><dd>조우·피해·상성·승패·레벨 상승·진화 보상</dd></div><div><dt>평가 규칙</dt><dd>학습을 끄면 가중치를 고정</dd></div></dl></section></div><section class="source-card panel"><div><span class="eyebrow">SOURCE & LICENSE</span><h2>원본과 변환 근거</h2></div><div><p><b>버전</b> ${escapeHtml(provenance.version)}</p><p><b>브라우저 그래프 ID</b> ${escapeHtml(controller.graph.id)}</p><p><b>원본 SHA-256</b> <code>${escapeHtml(provenance.sha256)}</code></p><p><b>라이선스</b> ${escapeHtml(provenance.license)}</p><p>${escapeHtml(provenance.note)}</p><a href="https://male-cns.janelia.org/download/" target="_blank" rel="noreferrer">HHMI Janelia Male CNS 다운로드 ↗</a><a href="${escapeHtml(provenance.source)}" target="_blank" rel="noreferrer">사용한 원본 파일 ↗</a></div></section><section class="data-actions panel"><div><h2>저장 데이터 관리</h2><p>진행 상황과 개체별 회로 상태는 IndexedDB에 자동 저장됩니다. 계정을 연결하면 로그인·로그아웃·60초 자동저장과 지금 저장에서 서버와 동기화합니다.</p></div><button id="export-save">내보내기</button><button id="import-save">불러오기</button><button id="new-game" class="danger">새 게임</button></section></div>`;
  drawBrain($<HTMLCanvasElement>('#brain-canvas'), brain.state); $('#export-save').onclick = exportSave; $('#import-save').onclick = () => $<HTMLInputElement>('#import-file').click(); $('#new-game').onclick = newGame;
}
function showModel(id: number) {
  const species = getSpecies(id), dialog = document.createElement('dialog');
  dialog.className = 'model-dialog';
  dialog.innerHTML = `<div class="model-dialog-top"><div><span class="eyebrow">No.${String(id).padStart(3, '0')} · ${species.englishName}</span><h2>${species.name}</h2><div>${typesHtml(id)}</div></div><button aria-label="닫기">×</button></div><div class="model-host"></div><div class="model-control-hint">드래그로 회전 · 휠 / 두 손가락으로 확대</div><p>출현 지역 · ${escapeHtml(kantoSpeciesSources(id).join(' / '))}</p>`;
  const forms = getPokemonForms(id);
  dialog.insertAdjacentHTML('beforeend', `<details class="form-gallery"><summary>원본 폼 자료 ${forms.length}개</summary><p>폼 이미지 자료입니다. 현재 포획·능력치·개체 저장은 종의 기본 폼 기준입니다.</p><div>${forms.map(form => `<figure>${form.frontSprite ? `<img loading="lazy" src="${pokemonSpriteUrl(form.spriteKey)}" alt="${escapeHtml(form.name)}">` : '<span>원본 이미지 없음</span>'}<figcaption>${escapeHtml(form.formName || form.name || form.identifier)}${form.isBattleOnly ? ' · 배틀 전용' : ''}</figcaption></figure>`).join('')}</div></details>`);
  document.body.append(dialog); dialog.showModal();
  if (hasPokemonModel(id)) getPokemonScene().showSpecimen(dialog.querySelector<HTMLElement>('.model-host')!, id); else { dialog.querySelector('.model-host')!.innerHTML = `<img class="species-preview" src="${species.frontSprite}" alt="${escapeHtml(species.name)}">`; dialog.querySelector('.model-control-hint')!.textContent = '공개 원본에 3D 모델이 없는 종 · 스프라이트로 표시합니다.'; }
  dialog.querySelector('button')!.onclick = () => dialog.close();
  dialog.addEventListener('close', () => { getPokemonScene().detach(); dialog.remove(); render(); }, { once: true });
}
function action(operation: () => unknown, success?: string) { try { operation(); if (success) notify(success); render(); queueSave(); } catch (error) { notify(error instanceof Error ? error.message : '요청을 처리하지 못했습니다.', true); } }
function exportSave() { if (!game) return; captureWorld(); const blob = new Blob([JSON.stringify(packSave(game, controller.graph, view), null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `choketmon-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
async function newGame() { if (!game) return; captureWorld(); await writeSave(packSave(game, controller.graph, view), 'backup-before-new-game'); worldPanel?.unmount(); worldPanel = undefined; game = undefined; view = { ...defaultView(), rewards: {} }; selectedMonsterId = ''; $<HTMLDialogElement>('#starter-dialog').showModal(); notify('현재 모험을 백업했습니다. 새 파트너를 골라 주세요.'); }

document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.onclick = e => { e.preventDefault(); if (!game?.battle || worldPanel) { tab = b.dataset.tab as Tab; render(); } else notify('배틀을 마친 뒤 다른 화면으로 이동할 수 있습니다.'); }); $('#save-now').onclick = () => { void (async () => { try { await saveNow(false, true); await accountPanel?.checkpoint(); notify(getSaveStorageStatus()?.state === 'synced' ? '서버와 동기화했습니다.' : '이 기기에 저장했습니다.'); } catch (error) { notify(String(error), true); } })(); };
document.querySelectorAll<HTMLButtonElement>('[data-starter]').forEach(b => b.onclick = () => { const id = Number(b.dataset.starter) as 1 | 4 | 7; game = createGame(id, `${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0]}`); view = { ...defaultView(), rewards: {} }; controller.ensure(game.player.team[0]); selectedMonsterId = game.player.team[0].instanceId; prepareWorld(); $<HTMLDialogElement>('#starter-dialog').close(); tab = 'map'; render(); queueSave(); });
$<HTMLInputElement>('#import-file').onchange = async e => { const input = e.target as HTMLInputElement, file = input.files?.[0]; if (!file) return; try { if (file.size > 20_000_000) throw new Error('저장 파일은 20MB 이하여야 합니다.'); const loaded = unpackSave(await file.text(), controller.graph); captureWorld(); if (game) await writeSave(packSave(game, controller.graph, view), 'backup-before-import'); game = loaded.game; view = { ...loaded.view, rewards: (loaded.view as PersistentView).rewards ?? {} }; selectedMonsterId = game.player.team[0].instanceId; prepareWorld(); tab = 'map'; render(); await saveNow(); notify('저장 파일을 불러왔습니다. 이전 모험은 백업했습니다.'); } catch (error) { notify(error instanceof Error ? error.message : '저장 파일을 읽지 못했습니다.', true); } finally { input.value = ''; } };
document.addEventListener('visibilitychange', () => { if (document.hidden) void saveNow(); });
window.addEventListener('pagehide', () => { void saveNow(); });
async function boot() { try { controller = await ConnectomeController.load();
  await initializeServerBrain();
  try { const response = await fetch('/api/connectome', { headers: { accept: 'application/json' }, credentials: 'same-origin' }); if (response.ok) serverConnectome = await response.json() as typeof serverConnectome; } catch { serverConnectome = null; }
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
  accountPanel = mountAccountPanel({ container: $('#account-controls'), notify,
    beforeSwitch: async () => { pausedBeforeAccountSwitch = worldPanel?.paused ?? false; if (worldPanel) await worldPanel.pauseAndSettle(); await saveNow(false, true); },
    onSwitchError: change => {
      if (currentAccount()?.id !== change.from?.id) {
        worldPanel?.unmount(); worldPanel = undefined; game = undefined;
        if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = 0; }
        view = { ...defaultView(), rewards: {} }; selectedMonsterId = '';
        $('#screen').innerHTML = '<section class="fatal"><h1>계정 저장을 다시 확인해 주세요</h1><p>이 기기의 기록은 보존되어 있습니다. 새로고침하면 선택한 계정의 저장을 다시 불러옵니다.</p><button id="retry-account">새로고침</button></section>';
        $('#retry-account').onclick = () => location.reload();
      } else if (worldPanel) worldPanel.paused = pausedBeforeAccountSwitch;
    },
    afterSwitch: async change => {
      if (change.reason === 'initialize') return;
      worldPanel?.unmount(); worldPanel = undefined;
      if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = 0; }
      game = undefined; view = { ...defaultView(), rewards: {} }; selectedMonsterId = ''; tab = 'map';
      if (change.save) {
        const loaded = unpackSave(change.save, controller.graph); game = loaded.game; view = loaded.view;
        selectedMonsterId = game.player.team[0].instanceId; prepareWorld(); render();
      } else { $('#screen').innerHTML = '<section class="loading"><h1>새 모험을 시작하세요</h1></section>'; $<HTMLDialogElement>('#starter-dialog').showModal(); }
    },
  });
  await accountPanel.ready;
  const stored = await readSave();
  if (stored) {
    const loaded = unpackSave(stored, controller.graph); game = loaded.game; view = { ...loaded.view, rewards: (loaded.view as PersistentView).rewards ?? {} };
    selectedMonsterId = game.player.team[0].instanceId; prepareWorld(); render();
  } else $<HTMLDialogElement>('#starter-dialog').showModal();
} catch (error) { $('#screen').innerHTML = `<section class="fatal"><span>!</span><h1>게임을 시작할 수 없습니다</h1><p>${escapeHtml(error instanceof Error ? error.message : error)}</p><button onclick="location.reload()">다시 시도</button></section>`; } }
void boot();
