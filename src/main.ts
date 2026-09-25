import { hasPokemonModel } from './game/assets';
import { getPokemonMotionSupport } from './data/model-motion';
import { getPokemonFormModelSource } from './data/pokemon-form-models';
import { getMoveLayout } from './game/move-layout';
import { getWorldAtlas } from './openworld/atlas';
import { getPlayableSpeciesIds, isPlayableSpecies, PLAYABLE_SPECIES_IDS, isPlayableAdventureVersion, isPlayableWorldRegion } from './openworld/availability';
import './game.css';
import './team.css';
import './game/breeding.css';
import { currentAccount, logout } from './game/account';
import { AUTH_SESSION_EXPIRED } from './game/auth-session';
import { mountAccountPanel } from './game/account-panel';
import './game/account-form.css';
import { getPokemonForms } from './data/pokemon-versions';
import './three/scene.css';
import { detachPokemonScene, getPokemonScene } from './three/scene';
import { withSaveRenderBudget } from './three/render-budget';
import { OpenWorldPanel } from './openworld/panel';
import type { OpenWorldSnapshot } from './openworld/simulation';
import { movementSpeed, needsRedEncounterMigration } from './openworld/simulation';
import { createFieldRuntime } from './three/field-runtime';
import type { FieldPolicy } from './game/field';
import { getMove, getSpecies, POKEMON } from './data/pokemon';
import { pokemonSpriteUrl } from './game/assets';
import { drawBrain } from './render';
import {
  actBattle, battleMonsterMaxHp, battleMonsterView, buyItem, createGame, setAutoMergeDuplicates, previewCollectionMerge, mergeCollectionDuplicates,
  assignHeldTool, assignMonsterAbility, assignAlolaForm, assignPreferredTransformation, activateBattleTransformation, HEALING_ITEM_HP, monsterAbilities, type EquippableItem,
  depositMonster, evolve, heal, individualValues, isMonsterInBattle, monsterAbility, mergeDuplicateMonster, mergeDuplicateMonsters, previewDuplicateMerge, releaseMonster, reorderMonsterMoves, availableMonsterMoveIds, replaceMonsterMove, recoverableAttackMoveIds, recoverAttackMove, ITEM_LABELS, useItem, withdrawMonster,
  type BattleAction, type GameState, type InventoryItem, type Monster,
} from './game/engine';
import { BRAIN_ASSUMPTIONS, ConnectomeController } from './game/connectome';
import { chooseServerBrains, getServerConnectomeInfo, initializeServerBrain, lastServerDecision, setServerBrainScope, usesServerBrain } from './game/server-brain';
import { startupLoading } from './ui/loading-screen';
import { CAMPAIGN_TRAINERS } from './game/campaign';
import { isCampaignRegion, monsterRegionalUseReason, monsterRegionalUseTag, regionalLevelCap } from './game/regional-policy';
import { defaultView, getSaveStorageStatus, onSaveStorageStatus, packSave, unpackSave, writeSave, type ViewState } from './game/storage';

import './responsive.css';
import './ui/design-system.css';
import './ui/appearance.css';
import './openworld/social.css';
import './ui/fonts.css';
import './ui/collection-layout.css';
import './ui/hud-layout.css';
import './ui/glass.css';
import './ui/auth-glass.css';
import './ui/hud-card.css';
import './ui/hud-social.css';
import { openMachineDialog } from './ui/machine-dialog';
import { statusLabel } from './game/status-labels';
import { mountInterfaceSettings } from './ui/settings';
import { transformationPreference, transformationSettingsHtml } from './ui/transformation-settings';
import { confirmAction } from './ui/confirm-action';
import { showGymVictory } from './ui/gym-victory';
import { attachGameAudio, playGameSound } from './audio';
import { mountTradePanel } from './game/trade-panel';
import { mountRankedPanel, RANKED_SESSION_MESSAGE } from './game/ranked-panel';
import { mountOriginalMusic } from './audio/original-music';
import { bindBreedingPanel, breedingPanelHtml } from './game/breeding-ui';
import { regionalSpeciesHabitats } from './data/regional-encounters';
import { expansionSpeciesHabitats } from './data/expansion-spawns';
import { evolutionSectionHtml } from './game/evolution-ui';
import { legendaryClass } from './game/legendary';
import { DEX_REGIONS, regionalDexSpeciesIds, type DexRegionId } from './game/regional-dex';
import { searchPokemon } from './ui/pokemon-search';
import { pokemonPresentation, battleTransformationsHtml, formDisplayName } from './ui/pokemon-presentation';
import fieldItems from './data/field-items.json' with { type: 'json' };
import { heldToolSelectHtml, itemSourceDetailsHtml } from './ui/item-sources';
import { getAlolaCombatForm } from './data/pokemon-combat-forms';
import { EVOLUTION_TREAT_EFFECTS } from './game/evolution-conditions';
import { evolutionProgress } from './game/evolution-progress';
import { itemShopHtml, type ShopCategory } from './ui/item-shop';

type Tab = 'map' | 'team' | 'dex' | 'shop' | 'ranked' | 'lab';
type PersistentView = ViewState & { rewards?: Record<string, number>; openWorld?: OpenWorldSnapshot };
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const app = $('#app');
const escapeHtml = (value: unknown) => String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]!);
const typeLabel: Record<string, string> = { normal: '노말', fire: '불꽃', water: '물', electric: '전기', grass: '풀', ice: '얼음', fighting: '격투', poison: '독', ground: '땅', flying: '비행', psychic: '에스퍼', bug: '벌레', rock: '바위', ghost: '고스트', dragon: '드래곤', dark: '악', steel: '강철', fairy: '페어리' };

let controller: ConnectomeController;
let worldPanel: OpenWorldPanel | undefined;
let fieldPolicy: FieldPolicy;
let originalFieldPolicy: FieldPolicy;
let legacyOpenWorldPolicy: FieldPolicy;
let game: GameState | undefined;
let view: PersistentView = { ...defaultView(), rewards: {} };
let tab: Tab = 'map', selectedMonsterId = '', dexQuery = '', boxQuery = '';
let dexPage = 0;
let releaseAccountSwitchHold: (() => void) | undefined;
let switchingAccount = false;
let reauthenticationRequired = false;
let trading = false, releaseTradeHold: (() => void) | undefined;
let accountPanel: ReturnType<typeof mountAccountPanel> | undefined;
let dexMode: 'all' | 'seen' | 'caught' = 'all';
let dexRegion: DexRegionId | 'all' = 'all';
let boxType = 'all', boxSort: 'number' | 'level' | 'name' | 'recent' = 'number', boxPage = 0;
let toastTimer = 0, autosaveTimer = 0;
let autoBattle = false, brainTurnPending = false, lastDecision = '회로 대기 중';
let serverConnectome: { available: boolean; graphId?: string; kind?: string; nodes?: number; edges?: number; activeEdges?: number } | null = null;

app.innerHTML = `
  <header class="topbar"><a class="brand" href="#" aria-label="초켓몬스터 홈" title="초켓몬스터"></a>
    <nav aria-label="주 메뉴"><button data-tab="map" class="active">모험</button><button data-tab="team">팀 · 박스</button><button data-tab="dex">도감</button><button data-tab="shop">상점</button><button data-tab="ranked">랭크전</button></nav>
    <div class="trainer-summary"><span id="money">₩0</span><span id="badges">도감 0/${PLAYABLE_SPECIES_IDS.length}</span><button id="open-interface-settings" class="interface-settings-trigger" aria-label="화면 설정" title="화면 설정"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--ui-surface, white)"/><circle cx="15" cy="17" r="3" fill="var(--ui-surface, white)"/></svg><span>화면 설정</span></button><details class="account-menu"><summary aria-label="계정·저장" title="계정·저장"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6"/><path d="M4.8 20c.9-3.8 3.7-5.8 7.2-5.8s6.3 2 7.2 5.8"/></svg><i class="account-menu-dot" aria-hidden="true"></i></summary><div class="account-menu-panel"><span id="save-state" class="save-state" data-state="local" aria-live="polite"><i></i> 이 기기에 저장됨</span><button id="save-now" class="quiet">지금 저장</button><span class="device-storage">이 기기에 저장</span><span id="account-controls"></span></div></details></div></header>
  <main id="screen" tabindex="-1"></main>
  <div id="toast" class="toast" role="status" aria-live="polite" aria-atomic="true" popover="manual" hidden></div><input id="import-file" type="file" accept="application/json" hidden>
  <dialog id="starter-dialog" class="starter-dialog"><div class="starter-copy"><span class="kicker">PALLET LAB · 첫 파트너</span><h1>관동에서 함께 떠날<br>포켓몬을 선택하세요</h1><p>선택한 한 마리만 처음 팀에 들어옵니다. 각 개체는 서로 다른 회로 상태와 학습 기록을 이 기기에 보관합니다.</p><div class="starter-account"><span>진행 상황은 이 브라우저의 IndexedDB에 자동 저장됩니다.</span><button type="button" class="quiet" data-load-account>계정 저장 불러오기</button></div></div><div class="starter-grid">
    ${[1, 4, 7].map(id => { const s = getSpecies(id); return `<button data-starter="${id}" class="starter-card"><span>No.${String(id).padStart(3, '0')}</span><img src="${s.frontSprite}" alt="${s.name}"><strong>${s.name}</strong><small>${s.types.map(type => typeLabel[type]).join(' · ')}</small><em>이 파트너로 시작</em></button>`; }).join('')}</div></dialog>`;
// Held by reference: without popovers the toast moves into dialogs that are later removed or re-rendered.
const toast = $('#toast');
const toastDialogs = new WeakSet<HTMLDialogElement>();
const starterDialog = $<HTMLDialogElement>('#starter-dialog');
// Nothing is playable behind the partner choice, so Esc or Android Back must not leave it.
starterDialog.addEventListener('cancel', event => { if (!game) event.preventDefault(); });
// Chromium closes a modal on a repeated Esc/Back even when cancel was prevented.
starterDialog.addEventListener('close', () => { if (!game && !starterDialog.open) starterDialog.showModal(); });

setAccountSwitching(true);
window.addEventListener(AUTH_SESSION_EXPIRED, () => {
  if (reauthenticationRequired) return;
  reauthenticationRequired = true; setAccountSwitching(true);
  void (async () => {
    let release: (() => void) | undefined;
    try { release = await worldPanel?.hold(); await saveNow(false, true, true); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
    finally { release?.(); }
    await accountPanel?.ready.catch(() => {});
    startupLoading?.remove(); accountPanel?.open();
  })();
});
mountInterfaceSettings($<HTMLButtonElement>('#open-interface-settings'), {
  enabled: () => game?.autoMergeDuplicates ?? false,
  available: () => !!game && !switchingAccount && !trading,
  change: async enabled => { if (!game) return; setAutoMergeDuplicates(game, enabled); await saveNow(false, true); },
});
const headerObserver = new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty('--app-header-height', `${Math.ceil(entry.target.getBoundingClientRect().height)}px`);
});
headerObserver.observe($('.topbar'), { box: 'border-box' });
if (import.meta.hot) import.meta.hot.dispose(() => headerObserver.disconnect());
const accountMenu = $<HTMLDetailsElement>('.account-menu');
const closeAccountMenu = (event: Event) => { if (accountMenu.open && !(event.target instanceof Node && accountMenu.contains(event.target))) accountMenu.open = false; };
document.addEventListener('pointerdown', closeAccountMenu, { capture: true });
accountMenu.addEventListener('keydown', event => { if (event.key === 'Escape') { accountMenu.open = false; accountMenu.querySelector('summary')!.focus(); } });
if (import.meta.hot) import.meta.hot.dispose(() => document.removeEventListener('pointerdown', closeAccountMenu, { capture: true }));
const detachAudio = attachGameAudio();
if (import.meta.hot) import.meta.hot.dispose(detachAudio);
const soundButton = document.createElement('button'); soundButton.id = 'game-sound-toggle'; soundButton.className = 'quiet';
$('#open-interface-settings').before(soundButton);
const originalMusic = mountOriginalMusic(soundButton);
function syncMusicScene() {
  const world = worldPanel?.simulation;
  const trainer = game?.battle?.trainerId ? CAMPAIGN_TRAINERS.find(item => item.id === game!.battle!.trainerId) : undefined;
  originalMusic.setScene({ started: Boolean(game), battle: game?.battle, captureOffer: Boolean(game?.captureOffer),
    champion: trainer?.kind === 'champion' || trainer?.kind === 'red', sceneId: world?.sceneId,
    location: world?.locationAt(world.player.x, world.player.z) });
}
if (import.meta.hot) import.meta.hot.dispose(originalMusic.destroy);
const tradePanel = mountTradePanel({ container: document.body, game: () => game!, graph: () => controller.graph, currentAccount,
  prepare: async () => {
    if (!game) throw new Error('모험을 시작한 뒤 교환할 수 있습니다.');
    if (game.battle || game.captureOffer) throw new Error('배틀과 포획을 마친 뒤 교환해 주세요.');
    trading = true;
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = 0; }
    releaseTradeHold?.(); releaseTradeHold = await worldPanel?.hold();
    await saveNow(false, true, false, true);
  },
  applied: save => { const loaded = unpackSave(save, controller.graph); game = loaded.game; view = loaded.view; selectedMonsterId = game.player.team[0].instanceId; prepareWorld(); render(); playGameSound('capture'); },
  closed: () => { if (!trading) return; trading = false; releaseTradeHold?.(); releaseTradeHold = undefined; worldPanel?.refresh(); queueSave(); },
  notify, openAccount: () => accountPanel?.open(),
});
if (import.meta.hot) import.meta.hot.dispose(() => tradePanel.destroy());
const rankedPanel = mountRankedPanel({
  game: () => game!, currentAccount,
  prepare: async () => {
    if (!game) throw new Error('모험을 시작한 뒤 랭크전에 참가할 수 있습니다.');
    if (!currentAccount()) throw new Error('계정 연결이 필요합니다.');
    if (game.battle || game.captureOffer) throw new Error('진행 중인 배틀과 포획을 먼저 마쳐 주세요.');
    // Settle the in-flight neural batch so the checkpoint holds its result, then let the world run again.
    const release = await worldPanel?.hold();
    try {
      await saveNow(false, true);
      await accountPanel?.checkpoint();
    } finally { release?.(); }
  },
  notify, openAccount: () => accountPanel?.open(),
});
if (import.meta.hot) import.meta.hot.dispose(() => rankedPanel.destroy());

function notify(message: string, error = false) {
  toast.textContent = message; toast.classList.toggle('error', error); toast.hidden = false;
  // A fixed z-index cannot rise above showModal(). A manual popover enters the
  // browser's top layer without stealing focus or intercepting world controls.
  if (typeof toast.showPopover === 'function') {
    if (toast.matches(':popover-open')) toast.hidePopover();
    toast.showPopover();
  } else {
    const dialog = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1);
    (dialog ?? document.body).append(toast);
    if (dialog && !toastDialogs.has(dialog)) {
      toastDialogs.add(dialog);
      // Closed dialogs are often removed or re-rendered; the toast returns to the page instead.
      dialog.addEventListener('close', () => {
        toastDialogs.delete(dialog);
        if (dialog.contains(toast) || !toast.isConnected) document.body.append(toast);
      }, { once: true });
    }
  }
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    if (typeof toast.hidePopover === 'function' && toast.matches(':popover-open')) toast.hidePopover();
    toast.hidden = true;
  }, Math.min(9000, Math.max(5000, message.length * 90)));
}
const active = (side: { team: Monster[]; activeIndex: number }) => side.team[side.activeIndex];
const owned = () => game ? [...game.player.team, ...game.player.box] : [];
const typesHtml = (id: number) => getSpecies(id).types.map(type => `<span class="type type-${type}">${typeLabel[type]}</span>`).join('');
function effective(battle: NonNullable<GameState['battle']>, monster: Monster) {
  return battleMonsterView(battle, monster);
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
function currentCollectionRegion() {
  const region = worldPanel?.simulation.regionId ?? view.openWorld?.regionId ?? game?.campaign?.startRegion;
  return isCampaignRegion(region) ? region : 'kanto';
}
function regionalUseHtml(monster: Monster) {
  if (!game) return '';
  const reason = monsterRegionalUseReason(game, currentCollectionRegion(), monster);
  return reason ? `<small class="regional-use-reason">${escapeHtml(reason)}</small>` : '';
}
function monsterCard(monster: Monster, action = '', variant = '') { const species = getSpecies(monster.speciesId), interactive = Boolean(variant), presentation = pokemonPresentation(monster, game?.battle); const lockReason = interactive && game ? monsterRegionalUseReason(game, currentCollectionRegion(), monster) : undefined, lockTag = lockReason ? monsterRegionalUseTag(game!, currentCollectionRegion(), monster) : undefined; return `<article class="monster-card ${variant}${legendaryClass(monster.speciesId)} ${monster.instanceId === selectedMonsterId ? 'selected' : ''}${lockReason ? ' regional-locked' : ''}" data-monster="${monster.instanceId}"${lockReason ? ` title="${escapeHtml(lockReason)}"` : ''}${interactive ? ` tabindex="0" role="button" aria-label="${escapeHtml(monster.nickname)}, 레벨 ${monster.level}, 개체 ${escapeHtml(monster.instanceId.slice(-8))}${lockReason ? `, ${escapeHtml(lockReason)}` : ''} 상세 보기"` : ''}>${lockTag ? `<em class="regional-lock-tag">${escapeHtml(lockTag)}</em>` : ''}<img loading="lazy" decoding="async" src="${presentation.sprite}" alt=""><div class="monster-card-copy"><span>No.${String(species.id).padStart(3, '0')} · Lv.${monster.level}</span><strong>${escapeHtml(presentation.name)}</strong><div>${presentation.types.map(type => `<span class="type type-${type}">${typeLabel[type]}</span>`).join('')}</div><small>HP ${monster.hp}/${battleMonsterMaxHp(game?.battle, monster)}</small></div>${action}</article>`; }
function setSaveState(state: 'pending' | 'saving' | 'saved' | 'error' | 'local' | 'synced' | 'conflict', message = '') { const badge = document.querySelector<HTMLElement>('#save-state'); if (!badge) return; badge.dataset.state = state; badge.title = message; badge.lastChild!.textContent = ` ${state === 'pending' ? '변경 있음' : state === 'saving' ? '저장 중' : state === 'error' ? '동기화 확인 필요' : state === 'conflict' ? '저장 선택 필요' : state === 'synced' ? '서버 동기화 완료' : '이 기기에 저장됨'}`; }
async function saveNow(announce = false, throwOnError = false, duringAccountSwitch = false, duringTrade = false) { if (!game || !controller || (switchingAccount && !duringAccountSwitch) || (trading && !duringTrade)) return; if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = 0; } setSaveState('saving'); try { captureWorld(); await writeSave(packSave(game, controller.graph, view)); const status = getSaveStorageStatus(); setSaveState(status?.state ?? 'local', status?.message); if (announce) notify('이 기기에 저장했습니다.'); } catch (error) { setSaveState('error'); notify(`저장하지 못했습니다: ${error instanceof Error ? error.message : error}`, true); if (throwOnError) throw error; } }
function queueSave() { if (switchingAccount || trading) return; setSaveState('pending'); if (!autosaveTimer) autosaveTimer = window.setTimeout(() => { autosaveTimer = 0; void saveNow(); }, 1000); }
function shellStats() { if (!game) return; $('#money').textContent = `₩${game.player.money.toLocaleString('ko-KR')}`; $('#badges').textContent = `도감 ${game.dex.caught.filter(isPlayableSpecies).length}/${PLAYABLE_SPECIES_IDS.length}`; $('.topbar').classList.toggle('map-overlay', tab === 'map'); document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab)); }
onSaveStorageStatus(status => setSaveState(status.state, status.message));
// Every pause is a transient hold now, and exploring always resumes on load.
function captureWorld() { if (worldPanel) { view.openWorld = worldPanel.simulation.snapshot(); view.openWorldPaused = false; } }
function setAccountSwitching(value: boolean) {
  value = value || reauthenticationRequired || !currentAccount();
  switchingAccount = value;
  $('#screen').inert = value;
  document.querySelectorAll<HTMLButtonElement>('[data-tab], [data-starter], #save-now').forEach(button => { button.disabled = value; });
}
function prepareWorld() {
  worldPanel?.unmount(); worldPanel = undefined;
  if (!game) return;
  setServerBrainScope(currentAccount() ? `account:${currentAccount()!.id}:${game.seed}` : game.seed);
  if (game.battle && !view.openWorld) return;
  if (view.openWorld && (!isPlayableWorldRegion(view.openWorld.regionId ?? 'kanto') || !isPlayableAdventureVersion(game.adventureVersion ?? 'red') || view.openWorld.mapVersion !== getWorldAtlas(view.openWorld.regionId ?? 'kanto').mapVersion)) {
    void writeSave(packSave(game, controller.graph, view), `backup-before-map-${Date.now()}`).catch(error => notify(String(error), true));
  }
  if (view.openWorld && (view.openWorld.entities.some(entity => entity.kind === 'wild' && entity.id !== view.openWorld!.battleWildId && !isPlayableSpecies(entity.speciesId)) || view.openWorld.respawnQueue?.some(entity => !isPlayableSpecies(entity.speciesId)))) {
    void writeSave(packSave(game, controller.graph, view), `backup-before-roster-${Date.now()}`).catch(error => notify(String(error), true));
  }
  if (view.openWorld && needsRedEncounterMigration(view.openWorld, game.adventureVersion)) {
    void writeSave(packSave(game, controller.graph, view), 'backup-before-red-layout').catch(error => notify(String(error), true));
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
    musicChanged: syncMusicScene,
    learning: () => view.learning, setLearning: value => { view.learning = value; }, notify, trade: () => void tradePanel.open(), openAccount: () => accountPanel?.open(),
    editMoves: instanceId => { selectedMonsterId = instanceId; tab = 'team'; render(); $('#team-detail').scrollIntoView({ block: 'start', behavior: 'smooth' }); },
    changed: immediate => { shellStats(); if (immediate) return saveNow(false, true); queueSave(); } });
  // A saved pause is often a transient one (tab switch, trade, save); exploring always resumes on load.
  worldPanel.paused = false;
}
function render() {
  syncMusicScene();
  shellStats(); if (!game) return;
  if (tab !== 'ranked') rankedPanel.unmount();
  if (game.battle && !worldPanel && tab !== 'team' && tab !== 'shop') { renderBattle(); return; }
  if (tab === 'map') renderMap();
  else { worldPanel?.unmount(); if (tab === 'team') renderTeam(); else if (tab === 'dex') renderDex(); else if (tab === 'shop') renderShop(); else if (tab === 'ranked') rankedPanel.mount($('#screen')); else renderLab(); }
}

function renderMap() {
  if (!game) return;
  detachPokemonScene();
  if (!worldPanel) prepareWorld();
  worldPanel?.mount($('#screen'));
}

function renderBattle() {
  if (!game?.battle) return; const battle = game.battle, player = active(battle.player), enemy = active(battle.enemy), pView = effective(battle, player), eView = effective(battle, enemy), pSpecies = getSpecies(pView.speciesId), pHp = Math.max(0, Math.round(player.hp / pView.stats.hp * 100)), eHp = Math.max(0, Math.round(enemy.hp / eView.stats.hp * 100));
  const pDisplay = pokemonPresentation(player, battle), eDisplay = pokemonPresentation(enemy, battle);
  const trainer = battle.trainerId ? CAMPAIGN_TRAINERS.find(item => item.id === battle.trainerId) : undefined;
  const battleTitle = battle.kind === 'wild' ? '야생 포켓몬과 조우' : battle.kind === 'gym' ? '체육관 승부' : trainer ? `${trainer.name}과의 승부` : '챔피언 결정전';
  $('#screen').innerHTML = `<div class="battle-page page"><div class="battle-top"><div><span class="kicker">${battle.kind.toUpperCase()} BATTLE · TURN ${battle.turn}</span><h1>${escapeHtml(battleTitle)}</h1></div><div class="brain-controls"><label><input id="learning" type="checkbox" ${view.learning ? 'checked' : ''}> 기술 학습</label><label class="switch"><input id="auto" type="checkbox" ${autoBattle ? 'checked' : ''}><span></span> 커넥톰 자동 배틀</label><button id="brain-turn" class="primary">회로로 한 턴</button></div></div>
    <section class="battle-stage panel"><div class="opponent combatant"><div class="battle-info"><span>Lv.${enemy.level} ${eDisplay.types.map(type => `<span class="type type-${type}">${typeLabel[type]}</span>`).join('')}</span><h2>${escapeHtml(eDisplay.name)}</h2><div class="hp"><i style="width:${eHp}%"></i></div><small>HP ${enemy.hp}/${eView.stats.hp}${statusLabel(enemy.status) ? ` · ${statusLabel(enemy.status)}` : ''}</small></div><img src="${eDisplay.sprite}" alt="${escapeHtml(eDisplay.name)}"></div><div class="battle-ground"></div><div class="player combatant"><img src="${pDisplay.form ? pDisplay.sprite : pSpecies.backSprite}" alt="${escapeHtml(pDisplay.name)}"><div class="battle-info"><span>Lv.${player.level} ${pDisplay.types.map(type => `<span class="type type-${type}">${typeLabel[type]}</span>`).join('')}</span><h2>${escapeHtml(pDisplay.name)}</h2><div class="hp"><i style="width:${pHp}%"></i></div><small>HP ${player.hp}/${pView.stats.hp}${statusLabel(player.status) ? ` · ${statusLabel(player.status)}` : ''}</small></div></div></section>
    <div class="battle-console"><section class="move-grid">${getMoveLayout({ ...player, moves: pView.moves }).map(slot => { const move = getMove(slot.moveId); return `<button data-battle-move="${slot.sourceIndex}" ${brainTurnPending || (pView.lockedMoveId !== undefined && pView.lockedMoveId !== slot.moveId) ? 'disabled' : ''}><span>${typeLabel[move.type]} · ${move.damageClass === 'status' ? '변화' : move.power}</span><strong>${move.name}</strong><small>명중 ${move.accuracy || '—'}</small></button>`; }).join('') || '<button data-battle-wait="1"><strong>기다리기</strong></button>'}${pView.lockedMoveId !== undefined && !pView.moves.some(slot => slot.moveId === pView.lockedMoveId) ? '<button data-battle-move="0"><strong>발버둥</strong></button>' : ''}</section>
      <aside class="battle-menu">${battleTransformationsHtml(game, brainTurnPending)}<div class="ball-row"><span class="infinite-ball">${ITEM_LABELS['poke-ball']} ∞</span><button id="catch" ${battle.kind !== 'wild' ? 'disabled' : ''}>잡기</button></div>${(['potion', 'super-potion'] as const).map(item => `<button data-battle-heal="${item}" ${!game!.inventory[item] || player.hp <= 0 || player.hp >= battleMonsterMaxHp(battle, player) ? 'disabled' : ''}>${ITEM_LABELS[item]} +${HEALING_ITEM_HP[item]} HP · ×${game!.inventory[item]}</button>`).join('')}<button id="switch-mon">포켓몬 교체</button><button id="run" ${!battle.canRun ? 'disabled' : ''}>도망치기</button><p><b>회로:</b> ${escapeHtml(lastDecision)}</p></aside></div>
    <section class="battle-log panel">${game.logs.slice(-5).reverse().map(log => `<p>${escapeHtml(log)}</p>`).join('')}</section></div>`;
  document.querySelectorAll<HTMLButtonElement>('[data-battle-move]').forEach(b => b.onclick = () => submitTurn({ type: 'move', index: Number(b.dataset.battleMove) }, false)); const wait = document.querySelector<HTMLButtonElement>('[data-battle-wait]'); if (wait) wait.onclick = () => submitTurn({ type: 'wait' }, false);
  $('#learning').onchange = e => { view.learning = (e.target as HTMLInputElement).checked; queueSave(); }; $('#auto').onchange = e => { autoBattle = (e.target as HTMLInputElement).checked; if (autoBattle) scheduleAutoTurn(); }; $('#brain-turn').onclick = performBrainTurn;
  $('#catch').onclick = () => submitTurn({ type: 'catch', ball: 'poke-ball' }, false); document.querySelectorAll<HTMLButtonElement>('[data-battle-heal]').forEach(button => button.onclick = () => submitTurn({ type: 'item', item: button.dataset.battleHeal as 'potion' | 'super-potion' }, false)); $('#run').onclick = () => submitTurn({ type: 'run' }, false); $('#switch-mon').onclick = showSwitchMenu;
  document.querySelectorAll<HTMLButtonElement>('[data-battle-transformation]').forEach(button => button.onclick = () => action(() => {
    if (brainTurnPending) return;
    activateBattleTransformation(game!, 'mega', {
      formIdentifier: document.querySelector<HTMLSelectElement>('[data-mega-form]')?.value,
    });
  }));
  controller.ensure(player); controller.ensure(enemy);
  if (pDisplay.form || eDisplay.form) detachPokemonScene();
  else { try { getPokemonScene().showBattle($('.battle-stage'), game); } catch { detachPokemonScene(); } }
}
function chooseAction(monster: Monster, other: Monster, battle: NonNullable<GameState['battle']>, reward: number | null, learning: boolean): BattleAction { const decision = graphChoose(monster, other, battle, reward, learning, true); lastDecision = `출력 ${decision.rawAction} → ${decision.action === 4 ? '대기' : (effective(battle, monster).moves[decision.action] ? getMove(effective(battle, monster).moves[decision.action].moveId).name : '발버둥')} · 활성도 ${(decision.activity * 100).toFixed(1)}%`; return decision.action === 4 ? { type: 'wait' } : { type: 'move', index: decision.action }; }
let classicTurnPromise: Promise<void> = Promise.resolve();
function submitTurn(action: BattleAction | null, learnedChoice: boolean) {
  if (!game?.battle || brainTurnPending) return;
  classicTurnPromise = performTurn(action, learnedChoice);
}
function performBrainTurn() { submitTurn(null, true); }
async function performTurn(playerAction: BattleAction | null, learnedChoice: boolean) {
  if (!game?.battle || brainTurnPending) return; brainTurnPending = true; const turnGame = game, battle = game.battle, player = active(battle.player), enemy = active(battle.enemy), turn = battle.turn, playerBefore = player.hp / battleMonsterMaxHp(battle, player), enemyBefore = enemy.hp / battleMonsterMaxHp(battle, enemy);
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
    if (game !== turnGame || turnGame.battle !== battle || battle.turn !== turn) throw new Error('전투 상태가 바뀌어 이전 턴 결정을 적용하지 않았습니다.');
    if (!playerAction) throw new Error('플레이어 행동을 결정하지 못했습니다.');
    if (!learnedChoice) clearPendingLearning(player);
    const result = actBattle(turnGame, playerAction, enemyDecision.action);
    const playerEnding = result.endingHp?.[player.instanceId], enemyEnding = result.endingHp?.[enemy.instanceId];
    const playerAfter = result.outcome === 'lost' ? 0 : (playerEnding?.hp ?? player.hp) / (playerEnding?.maxHp ?? battleMonsterMaxHp(battle, player)), enemyAfter = (enemyEnding?.hp ?? enemy.hp) / (enemyEnding?.maxHp ?? battleMonsterMaxHp(battle, enemy));
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
    if (result.gymVictory) await showGymVictory(result.gymVictory, false);
  }
  catch (error) { autoBattle = false; enemy.brain = enemyBrainBefore; player.brain = playerBrainBefore; notify(error instanceof Error ? error.message : '행동을 처리하지 못했습니다.', true); } finally { brainTurnPending = false; render(); if (autoBattle && game?.battle) scheduleAutoTurn(); }
}
function scheduleAutoTurn() { window.setTimeout(() => { if (autoBattle && game?.battle && !brainTurnPending) performBrainTurn(); }, 650); }
function showSwitchMenu() { if (!game?.battle) return; const menu = document.createElement('div'); menu.className = 'modal-shade'; menu.innerHTML = `<section class="choice-modal"><span class="eyebrow">TEAM SWITCH</span><h2>교체할 포켓몬</h2><div>${game.battle.player.team.map((monster, index) => `<button data-switch="${index}" ${monster.hp <= 0 || index === game!.battle!.player.activeIndex || (game!.battle!.policyRegion && monsterRegionalUseReason(game!, game!.battle!.policyRegion!, monster)) ? 'disabled' : ''}>${monsterCard(monster)}</button>`).join('')}</div><button class="quiet close-choice">취소</button></section>`; document.body.append(menu); menu.querySelectorAll<HTMLButtonElement>('[data-switch]').forEach(b => b.onclick = () => { menu.remove(); submitTurn({ type: 'switch', index: Number(b.dataset.switch) }, false); }); menu.querySelector<HTMLButtonElement>('.close-choice')!.onclick = () => menu.remove(); }

const BOX_PAGE_SIZE = 48;
let boxResults: Monster[] | undefined;
let boxObserver: IntersectionObserver | undefined;
function sortedBox() {
  return boxResults ??= game ? searchPokemon(game.player.box, boxQuery, boxType, boxSort, monster => !monsterRegionalUseReason(game!, currentCollectionRegion(), monster)) : [];
}
function boxCardsHtml(monsters: Monster[]) {
  return monsters.map(monster => monsterCard(monster, `<button class="card-action" data-withdraw-id="${escapeHtml(monster.instanceId)}" ${game!.player.team.length >= 6 ? 'disabled' : ''}>데려오기</button>`, 'box-monster')).join('');
}
function boxCollectionHtml() {
  if (!game) return '';
  const matches = sortedBox(), visible = Math.min(matches.length, (boxPage + 1) * BOX_PAGE_SIZE);
  return `<div class="box-result-line" role="status"><span>${matches.length}마리${matches.length !== game.player.box.length ? ` / ${game.player.box.length}마리` : ''}</span><button type="button" id="box-clear" ${boxQuery || boxType !== 'all' ? '' : 'hidden'}>검색 초기화</button></div><div class="box-grid" role="list" aria-label="보관된 포켓몬">${boxCardsHtml(matches.slice(0, visible)) || '<p class="empty box-empty">검색 결과가 없습니다.</p>'}</div><button type="button" id="box-more" class="box-more" ${visible < matches.length ? '' : 'hidden'}>더 보기 · ${visible} / ${matches.length}</button>`;
}
function moveLayoutHtml(monster: Monster) {
  const layout = getMoveLayout(monster), recoverable = recoverableAttackMoveIds(monster);
  const available = availableMonsterMoveIds(monster, game?.technicalMachines), learned = new Set(availableMonsterMoveIds(monster));
  const editor = (index: number, currentId?: number) => {
    const options = available.filter(id => id === currentId || !monster.moves.some(slot => slot.moveId === id));
    if (currentId !== undefined && !options.includes(currentId)) options.unshift(currentId);
    return `<div class="move-slot-editor"><select data-move-choice="${index}" aria-label="${index + 1}번 칸 기술 선택" ${options.length ? '' : 'disabled'}>${currentId === undefined ? '<option value="" selected disabled>배치할 기술 선택</option>' : ''}${options.map(id => { const move = getMove(id); return `<option value="${id}" ${id === currentId ? 'selected' : ''}>${escapeHtml(move.name)} · ${move.damageClass === 'status' ? '변화' : '공격'}${learned.has(id) ? '' : ' · 기술머신'}</option>`; }).join('')}</select><button data-replace-move="${index}" disabled>${currentId === undefined ? '배치' : '교체'}</button></div>`;
  };
  return `<div class="move-layout" aria-label="기술 배치">${layout.map((slot, index) => {
    const move = getMove(slot.moveId);
    return `<div class="move-layout-entry" data-layout-move="${slot.moveId}"><b class="move-layout-number">${index + 1}</b><div class="move-layout-copy"><strong>${escapeHtml(move.name)}</strong><small>${move.damageClass === 'status' ? '변화' : '공격'} · ${typeLabel[move.type]} · 위력 ${move.power || '—'} · 우선도 ${move.priority}</small></div><div class="move-layout-controls"><button data-reorder-from="${index}" data-reorder-to="${index - 1}" aria-label="${escapeHtml(move.name)} 앞으로" ${index === 0 ? 'disabled' : ''}>▲</button><button data-reorder-from="${index}" data-reorder-to="${index + 1}" aria-label="${escapeHtml(move.name)} 뒤로" ${index === layout.length - 1 ? 'disabled' : ''}>▼</button></div>${editor(index, slot.moveId)}</div>`;
  }).join('')}${layout.length < 4 ? `<div class="move-layout-entry empty-move-slot"><b class="move-layout-number">${layout.length + 1}</b><div class="move-layout-copy"><strong>빈 기술 칸</strong><small>배운 기술을 추가할 수 있습니다.</small></div>${editor(layout.length)}</div>` : ''}</div>${recoverable.length ? `<section class="attack-recovery"><p>현재 공격 기술이 없습니다. 자동 배틀에 사용할 공격 기술을 바로 배치할 수 있습니다.</p><label for="recover-attack">배치할 공격 기술</label><select id="recover-attack">${recoverable.map(id => `<option value="${id}">${escapeHtml(getMove(id).name)} · ${typeLabel[getMove(id).type]}</option>`).join('')}</select><button id="recover-attack-move">공격 기술 배치</button></section>` : ''}`;
}
function modelMotionHtml(id: number) {
  const support = getPokemonMotionSupport(id);
  if (support === 'rigged-static' || support === 'static') {
    return '<details class="model-motion"><summary>3D · 자체 리깅 동작</summary><p>확보한 모델에 골격 또는 관절 동작을 추가했습니다. 대기·이동·공격·피격은 이 게임에서 제작한 동작입니다.</p></details>';
  }
  const [label, description] = {
    'rigged-animated': ['3D 동작 지원', '관절과 애니메이션이 포함된 모델입니다.'],
    'rigged-static': ['3D · 동작 없음', '관절은 있지만 원본에 재생할 애니메이션이 없습니다.'],
    'transform-animated': ['3D 동작 지원', '모델 부분의 위치와 회전을 움직이는 애니메이션입니다.'],
    'static': ['3D · 고정 모델', '원본에 관절과 애니메이션이 없습니다.'],
    'unavailable': ['3D 모델 없음', '도감 이미지를 표시합니다.'],
  }[support];
  return `<details class="model-motion"><summary>${label}</summary><p>${description}</p></details>`;
}
function selectedCollection(selected: Monster) {
  if (!game) return { monsters: [] as Monster[], label: '' };
  if (game.player.box.some(monster => monster.instanceId === selected.instanceId)) {
    const matches = sortedBox();
    return { monsters: matches.some(monster => monster.instanceId === selected.instanceId) ? matches : [selected], label: '박스 검색 결과' };
  }
  return { monsters: game.player.team, label: '팀' };
}
function detailNavigatorHtml(selected: Monster) {
  const collection = selectedCollection(selected), index = Math.max(0, collection.monsters.findIndex(monster => monster.instanceId === selected.instanceId));
  const last = Math.max(0, collection.monsters.length - 1);
  return `<nav class="detail-navigator" aria-label="선택 포켓몬 이동"><span>${collection.label} ${index + 1} / ${collection.monsters.length}</span><div><button data-select-index="0" ${index === 0 ? 'disabled' : ''} aria-label="맨 처음 포켓몬">맨 처음</button><button data-select-index="${index - 1}" ${index === 0 ? 'disabled' : ''} aria-label="이전 포켓몬">이전</button><button data-select-index="${index + 1}" ${index >= last ? 'disabled' : ''} aria-label="다음 포켓몬">다음</button><button data-select-index="${last}" ${index >= last ? 'disabled' : ''} aria-label="맨 끝 포켓몬">맨 끝</button></div></nav>`;
}
function bindDetailNavigator(detail: HTMLElement, selected: Monster) {
  detail.querySelectorAll<HTMLButtonElement>('[data-select-index]').forEach(button => button.onclick = () => {
    const collection = selectedCollection(selected).monsters, target = collection[Number(button.dataset.selectIndex)];
    if (!target) return;
    selectedMonsterId = target.instanceId;
    const targetIndex = sortedBox().findIndex(monster => monster.instanceId === target.instanceId);
    if (targetIndex >= (boxPage + 1) * BOX_PAGE_SIZE) {
      boxPage = Math.floor(targetIndex / BOX_PAGE_SIZE);
      $('#box-collection').innerHTML = boxCollectionHtml(); bindBoxCollection();
    }
    document.querySelectorAll<HTMLElement>('.team-page .monster-card').forEach(card => card.classList.toggle('selected', card.dataset.monster === selectedMonsterId));
    renderSelectedDetail();
    $<HTMLButtonElement>(`[data-select-index="${Number(button.dataset.selectIndex) + (button.textContent === '이전' ? -1 : 1)}"]`)?.focus({ preventScroll: true });
  });
}
function refreshDetailNavigator(selected: Monster) {
  const detail = $<HTMLElement>('#team-detail'), current = detail.querySelector<HTMLElement>('.detail-navigator');
  if (!current) return;
  const template = document.createElement('template'); template.innerHTML = detailNavigatorHtml(selected);
  current.replaceWith(template.content);
  bindDetailNavigator(detail, selected);
}
function quickCollectionActionsHtml(selected: Monster, candyMax: number) {
  if (!game) return '';
  const duplicates = owned().filter(monster => monster.speciesId === selected.speciesId && monster.regionalForm === selected.regionalForm && monster.instanceId !== selected.instanceId)
    .filter(monster => { try { previewDuplicateMerge(game!, selected.instanceId, [monster.instanceId], currentCollectionRegion()); return true; } catch { return false; } });
  return `<section class="detail-quick-actions" aria-label="선택 포켓몬 빠른 관리"><div class="quick-action-heading"><strong>바로 관리</strong></div>${game.inventory['rare-candy'] > 0 ? `<div class="candy-use"><label for="candy-quantity">이상한사탕</label><input id="candy-quantity" type="number" inputmode="numeric" min="1" max="${Math.max(1, candyMax)}" value="1" ${candyMax ? '' : 'disabled'}><small id="candy-preview">${candyMax ? `Lv.${selected.level} → Lv.${selected.level + 1}` : selected.level >= regionalLevelCap(game, currentCollectionRegion()) ? `현지 배지 상한 Lv.${regionalLevelCap(game, currentCollectionRegion())}` : '보유한 사탕이 없습니다'}</small><button id="use-candy" ${candyMax && !game.battle ? '' : 'disabled'}>${candyMax ? `먹이기 · 최대 ${candyMax}개` : `사탕 ×${game.inventory['rare-candy']}`}</button></div>` : ''}<div class="merge-use">${duplicates.length ? `<label for="merge-donor">합칠 중복 개체</label><select id="merge-donor">${duplicates.map(monster => { const plan = previewDuplicateMerge(game!, selected.instanceId, [monster.instanceId], currentCollectionRegion()); return `<option value="${monster.instanceId}">Lv.${monster.level} → Lv.${plan.toLevel} · ${escapeHtml(monster.instanceId.slice(-8))}</option>`; }).join('')}</select><button id="merge-duplicate">선택 1마리 합치기</button><button id="merge-all-duplicates" class="quiet">같은 종 ${duplicates.length}마리 모두 합치기</button>` : '<small class="no-duplicates">합칠 수 있는 같은 종 개체가 없습니다.</small>'}</div></section>`;
}
function individualTraitsHtml(selected: Monster) {
  const ivs = individualValues(selected), ability = monsterAbility(selected), alola = getAlolaCombatForm(selected.speciesId);
  const disabled = game?.battle || game?.captureOffer;
  const tools = fieldItems.filter(item => item.kind === 'held-tool' || item.speciesId === selected.speciesId);
  const values = [['HP', ivs.hp], ['공격', ivs.attack], ['방어', ivs.defense], ['특공', ivs.specialAttack], ['특방', ivs.specialDefense], ['스피드', ivs.speed]] as const;
  return `<section class="individual-traits" aria-label="특성과 도구">${transformationSettingsHtml(selected, !!disabled, game!.inventory)}${alola ? `<label class="equipment-field"><span>모습</span><select id="monster-form" ${disabled ? 'disabled' : ''}><option value="">기본</option><option value="alola" ${selected.regionalForm ? 'selected' : ''}>알로라</option></select></label>` : ''}<label class="equipment-field"><span>특성</span><select id="monster-ability" ${disabled ? 'disabled' : ''}>${monsterAbilities(selected).map(option => `<option value="${option.slot}" ${option.slot === ability.slot ? 'selected' : ''}>${escapeHtml(option.name)}${option.hidden ? ' · 숨겨진 특성' : ''}</option>`).join('')}</select></label>${heldToolSelectHtml(selected.heldTool, tools as import('./openworld/field-item-drops').FieldItem[], game!.inventory, !!disabled)}${itemSourceDetailsHtml(tools as import('./openworld/field-item-drops').FieldItem[])}<details><summary>특성 · 개체값</summary><p>${escapeHtml(ability.description)}</p><div class="iv-grid">${values.map(([label, value]) => `<span><small>${label}</small><b>${value}</b></span>`).join('')}</div></details></section>`;
}
function consumableItemsHtml(selected: Monster) {
  const progress = evolutionProgress(selected), blocked = Boolean(game!.battle || game!.captureOffer);
  const healing = (Object.keys(HEALING_ITEM_HP) as (keyof typeof HEALING_ITEM_HP)[]).map(item => `<button data-heal-item="${item}" ${blocked || !game!.inventory[item] || selected.hp <= 0 || selected.hp >= selected.stats.hp ? 'disabled' : ''}>${ITEM_LABELS[item]} · HP +${HEALING_ITEM_HP[item]} · ×${game!.inventory[item]}</button>`).join('');
  const treats = (['beauty-treat', 'affection-treat'] as const).map(item => {
    const effect = EVOLUTION_TREAT_EFFECTS[item], max = Math.min(game!.inventory[item], Math.ceil((255 - progress[effect.key]) / effect.amount));
    return `<div class="treat-use"><label>${ITEM_LABELS[item]}<small>${progress[effect.key]}/255 · +${effect.amount} · 보유 ${game!.inventory[item]}개</small></label><input data-treat-quantity="${item}" aria-label="${ITEM_LABELS[item]} 수량" type="number" min="1" max="${Math.max(1, max)}" value="1" ${blocked || !max ? 'disabled' : ''}><button data-use-treat="${item}" ${blocked || !max ? 'disabled' : ''}>먹이기</button></div>`;
  }).join('');
  return `<details class="collection-fold item-use-fold"><summary>물품</summary><div class="healing-items">${healing}</div>${treats}</details>`;
}
function compactMoveManagementHtml(selected: Monster) {
  const species = getSpecies(selected.speciesId);
  return `<section class="compact-moves"><div class="compact-move-summary">${getMoveLayout(selected).map(slot => `<span>${escapeHtml(getMove(slot.moveId).name)}</span>`).join('')}</div><details class="collection-fold" id="move-layout-fold"><summary>기술 배치 편집</summary>${Object.values(game?.technicalMachines ?? {}).some(count => count > 0) ? '<button type="button" class="open-machines" data-open-machines>기술머신</button>' : ''}${moveLayoutHtml(selected)}<details class="next-moves"><summary>다음 습득 기술</summary><div class="move-list">${species.moves.filter(entry => entry.level > selected.level).slice(0, 3).map(entry => `<span><b>${getMove(entry.moveId).name}</b><small>Lv.${entry.level}</small></span>`).join('') || '<p class="empty">레벨업 기술을 모두 익혔습니다.</p>'}</div></details></details></section>`;
}
function detailHtml(selected: Monster) {
  if (!game) return ''; const species = getSpecies(selected.speciesId), presentation = pokemonPresentation(selected, game.battle), candyMax = Math.max(0, Math.min(game.inventory['rare-candy'], regionalLevelCap(game, currentCollectionRegion()) - selected.level));
  const gender = selected.gender === 'female' ? '암컷' : selected.gender === 'male' ? '수컷' : '성별 없음';
  return `${detailNavigatorHtml(selected)}<div class="detail-portrait"><span>No.${String(species.id).padStart(3, '0')}</span><img src="${presentation.sprite}" alt="${escapeHtml(presentation.name)}"></div><div class="detail-title${legendaryClass(species.id)}"><div>${presentation.types.map(type => `<span class="type type-${type}">${typeLabel[type]}</span>`).join('')}</div><h2>${escapeHtml(presentation.name)}</h2><p>Lv.${selected.level} · ${gender}</p>${regionalUseHtml(selected)}</div>${quickCollectionActionsHtml(selected, candyMax)}${consumableItemsHtml(selected)}${compactMoveManagementHtml(selected)}${individualTraitsHtml(selected)}<div class="stat-list">${([['HP', `${selected.hp}/${presentation.stats.hp}`], ['공격', presentation.stats.attack], ['방어', presentation.stats.defense], ['특공', presentation.stats.specialAttack], ['특방', presentation.stats.specialDefense], ['스피드', presentation.stats.speed], ['이동 속도', `${movementSpeed(selected.speciesId, selected.level).toFixed(1)} m/s`]] as const).map(([label, value]) => `<span>${label}<b>${value}</b></span>`).join('')}</div><div class="detail-xp"><span>누적 경험치</span><strong>${selected.xp.toLocaleString()}</strong></div>${evolutionSectionHtml(game, selected)}`;
}
function renderSelectedDetail() {
  if (!game) return; const selected = owned().find(monster => monster.instanceId === selectedMonsterId) ?? game.player.team[0]; selectedMonsterId = selected.instanceId;
  const detail = $<HTMLElement>('#team-detail');
  const keepMoveEditor = detail.dataset.monster === selected.instanceId && detail.querySelector<HTMLDetailsElement>('#move-layout-fold')?.open;
  detail.innerHTML = detailHtml(selected); detail.dataset.monster = selected.instanceId;
  if (keepMoveEditor) detail.querySelector<HTMLDetailsElement>('#move-layout-fold')!.open = true;
  bindDetailNavigator(detail, selected);
  detail.querySelector<HTMLSelectElement>('#monster-form')?.addEventListener('change', event => action(() => assignAlolaForm(game!, selected.instanceId, (event.target as HTMLSelectElement).value === 'alola')));
  detail.querySelector<HTMLSelectElement>('#monster-ability')!.onchange = event => action(() => {
    assignMonsterAbility(game!, selected.instanceId, Number((event.target as HTMLSelectElement).value));
  });
  detail.querySelector<HTMLSelectElement>('#monster-tool')!.onchange = event => action(() => {
    assignHeldTool(game!, selected.instanceId, ((event.target as HTMLSelectElement).value || undefined) as EquippableItem | undefined);
  });
  detail.querySelector<HTMLSelectElement>('#monster-transformation')!.onchange = event => action(() => {
    assignPreferredTransformation(game!, selected.instanceId, transformationPreference((event.target as HTMLSelectElement).value));
  });
  detail.querySelectorAll<HTMLButtonElement>('[data-heal-item]').forEach(button => button.onclick = () => action(() => useItem(game!, button.dataset.healItem as InventoryItem, selected.instanceId)));
  detail.querySelectorAll<HTMLButtonElement>('[data-reorder-from]').forEach(button => button.onclick = async () => {
    try {
      const from = Number(button.dataset.reorderFrom), to = Number(button.dataset.reorderTo);
      reorderMonsterMoves(game!, selected.instanceId, from, to);
      renderSelectedDetail();
      detail.querySelector<HTMLButtonElement>(`[data-reorder-from="${to}"][data-reorder-to="${from}"]`)?.focus();
      await saveNow(false, true); notify('기술 배치를 저장했습니다.');
    } catch (error) { notify(error instanceof Error ? error.message : '배치를 바꾸지 못했습니다.', true); }
  });
  detail.querySelectorAll<HTMLSelectElement>('[data-move-choice]').forEach(select => {
    const index = Number(select.dataset.moveChoice), currentId = getMoveLayout(selected)[index]?.moveId;
    select.onchange = () => { detail.querySelector<HTMLButtonElement>(`[data-replace-move="${index}"]`)!.disabled = !select.value || Number(select.value) === currentId; };
  });
  detail.querySelectorAll<HTMLButtonElement>('[data-replace-move]').forEach(button => button.onclick = async () => {
    const editedGame = game!, index = Number(button.dataset.replaceMove);
    const moveId = Number(detail.querySelector<HTMLSelectElement>(`[data-move-choice="${index}"]`)!.value);
    button.disabled = true;
    try {
      captureWorld(); await writeSave(packSave(editedGame, controller.graph, view), 'backup-before-move-change');
      if (game !== editedGame) throw new Error('모험이 바뀌었습니다. 현재 포켓몬을 다시 선택해 주세요.');
      replaceMonsterMove(editedGame, selected.instanceId, index, moveId);
      clearPendingLearning(selected); worldPanel?.simulation.reconcileTeamChange();
      renderSelectedDetail(); await saveNow(false, true); notify('기술을 교체하고 저장했습니다.');
      detail.querySelector<HTMLSelectElement>(`[data-move-choice="${index}"]`)?.focus();
    } catch (error) { button.disabled = false; notify(error instanceof Error ? error.message : '기술을 교체하지 못했습니다.', true); }
  });
  detail.querySelector<HTMLButtonElement>('[data-open-machines]')?.addEventListener('click', () => openMachineDialog({ game: game!, instanceId: selected.instanceId, notify,
    applied: async monster => { clearPendingLearning(monster); worldPanel?.simulation.reconcileTeamChange(); if (tab === 'team') renderSelectedDetail(); await saveNow(false, true); } }));
  detail.querySelector<HTMLButtonElement>('#recover-attack-move')?.addEventListener('click', async () => {
    const editedGame = game!;
    const button = detail.querySelector<HTMLButtonElement>('#recover-attack-move')!;
    const moveId = Number(detail.querySelector<HTMLSelectElement>('#recover-attack')!.value);
    button.disabled = true;
    try {
      captureWorld(); await writeSave(packSave(editedGame, controller.graph, view), 'backup-before-attack-recovery');
      if (game !== editedGame) throw new Error('모험이 바뀌었습니다. 현재 포켓몬을 다시 선택해 주세요.');
      recoverAttackMove(editedGame, selected.instanceId, moveId); worldPanel?.simulation.reconcileTeamChange();
      renderSelectedDetail(); await saveNow(false, true); notify('공격 기술을 배치했습니다.');
    } catch (error) { button.disabled = false; notify(error instanceof Error ? error.message : '공격 기술을 배치하지 못했습니다.', true); }
  });
  detail.querySelectorAll<HTMLButtonElement>('[data-evolve]').forEach(button => button.onclick = () => action(() => evolve(game!, selected.instanceId, { targetId: Number(button.dataset.evolve), item: button.dataset.evolutionItem as InventoryItem | undefined, autoBuyMissing: true }), '진화가 완료됐습니다.'));
  detail.querySelectorAll<HTMLButtonElement>('[data-capsule-evolve]').forEach(button => button.onclick = () => action(() => evolve(game!, selected.instanceId, { targetId: Number(button.dataset.capsuleEvolve), item: 'evolution-catalyst', autoBuyMissing: true }), '특수진화 캡슐로 진화했습니다.'));
  detail.querySelectorAll<HTMLInputElement>('[data-treat-quantity]').forEach(input => input.oninput = () => {
    const quantity = Number(input.value), maximum = Number(input.max);
    input.parentElement!.querySelector<HTMLButtonElement>('[data-use-treat]')!.disabled = Boolean(game!.battle)
      || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > maximum;
  });
  detail.querySelectorAll<HTMLButtonElement>('[data-use-treat]').forEach(button => button.onclick = () => {
    const item = button.dataset.useTreat as InventoryItem;
    const input = detail.querySelector<HTMLInputElement>(`[data-treat-quantity="${item}"]`)!;
    const quantity = Number(input.value);
    action(() => useItem(game!, item, selected.instanceId, quantity), `${ITEM_LABELS[item]} ${quantity}개를 먹였습니다.`);
  });
  const candyInput = detail.querySelector<HTMLInputElement>('#candy-quantity'), candyButton = detail.querySelector<HTMLButtonElement>('#use-candy'), candyPreview = detail.querySelector<HTMLElement>('#candy-preview');
  if (candyInput && candyButton && candyPreview) {
    const updateCandyPreview = () => { const quantity = Number(candyInput.value), valid = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= Number(candyInput.max); candyButton.disabled = !valid || Boolean(game!.battle); candyPreview.textContent = valid ? `Lv.${selected.level} → Lv.${selected.level + quantity}` : `1~${candyInput.max}개를 입력하세요`; };
    candyInput.oninput = updateCandyPreview;
    candyButton.onclick = () => { const quantity = Number(candyInput.value); action(() => useItem(game!, 'rare-candy', selected.instanceId, quantity, currentCollectionRegion()), `이상한사탕 ${quantity}개를 먹였습니다.`); };
  }
  const duplicates = owned().filter(monster => monster.speciesId === selected.speciesId && monster.regionalForm === selected.regionalForm && monster.instanceId !== selected.instanceId)
    .filter(monster => { try { previewDuplicateMerge(game!, selected.instanceId, [monster.instanceId], currentCollectionRegion()); return true; } catch { return false; } });
  detail.insertAdjacentHTML('beforeend', `<section class="collection-actions"><button id="release-monster" class="danger" ${game.player.team.length === 1 && game.player.team[0].instanceId === selected.instanceId ? 'disabled' : ''}>이 포켓몬 놓아주기</button></section>`);
  let managingCollection = false;
  const remove = async (donorId: string, merge: boolean) => {
    if (!game || managingCollection) return;
    const editedGame = game, donor = owned().find(monster => monster.instanceId === donorId);
    if (!donor) return;
    managingCollection = true;
    try {
      const confirmed = await confirmAction({
        title: merge ? '레벨을 합칠까요?' : '포켓몬을 놓아줄까요?',
        message: merge
          ? (() => { const plan = previewDuplicateMerge(editedGame, selected.instanceId, [donorId], currentCollectionRegion()); return `${selected.nickname} Lv.${selected.level} → Lv.${plan.toLevel}`; })()
          : `${donor.nickname} (Lv.${donor.level} · ${donorId})을 놓아줍니다.`,
        detail: merge ? `${donor.nickname} Lv.${donor.level} 1마리를 합칩니다.` : '되돌릴 수 없습니다.',
        confirmLabel: merge ? '레벨 합치기' : '놓아주기', destructive: !merge,
      });
      if (!confirmed) return;
      if (game !== editedGame) throw new Error('모험이 바뀌었습니다. 현재 포켓몬을 다시 선택해 주세요.');
      captureWorld(); await writeSave(packSave(editedGame, controller.graph, view), 'backup-before-release');
      if (game !== editedGame) throw new Error('모험이 바뀌었습니다. 현재 포켓몬을 다시 선택해 주세요.');
      if (merge) mergeDuplicateMonster(editedGame, selected.instanceId, donorId, currentCollectionRegion()); else releaseMonster(editedGame, donorId, currentCollectionRegion());
      if (view.rewards) delete view.rewards[donorId];
      captureWorld(); renderTeam(); shellStats(); await saveNow(false, true); notify(merge ? '레벨을 합쳤습니다.' : '포켓몬을 놓아주었습니다.');
    } catch (error) { notify(String(error), true); }
    finally { managingCollection = false; }
  };
  detail.querySelector<HTMLButtonElement>('#merge-duplicate')?.addEventListener('click', () => void remove($<HTMLSelectElement>('#merge-donor').value, true));
  detail.querySelector<HTMLButtonElement>('#merge-all-duplicates')?.addEventListener('click', async () => {
    if (!game || managingCollection) return;
    const editedGame = game;
    managingCollection = true;
    try {
      const donorIds = duplicates.map(monster => monster.instanceId);
      const plan = previewDuplicateMerge(editedGame, selected.instanceId, donorIds, currentCollectionRegion());
      const confirmed = await confirmAction({
        title: '모두 합치기',
        message: `${selected.nickname} Lv.${selected.level} → Lv.${plan.toLevel}`,
        detail: `${plan.count}마리를 합쳐 1마리를 남깁니다.`,
        confirmLabel: `${plan.count}마리 합치기`,
      });
      if (!confirmed) return;
      if (game !== editedGame) throw new Error('모험이 바뀌었습니다. 현재 포켓몬을 다시 선택해 주세요.');
      captureWorld(); await writeSave(packSave(editedGame, controller.graph, view), 'backup-before-merge-all');
      if (game !== editedGame) throw new Error('모험이 바뀌었습니다. 현재 포켓몬을 다시 선택해 주세요.');
      const result = mergeDuplicateMonsters(editedGame, selected.instanceId, donorIds, currentCollectionRegion());
      if (view.rewards) for (const id of donorIds) delete view.rewards[id];
      captureWorld(); renderTeam(); shellStats(); await saveNow(false, true);
      notify(`${result.count}마리를 합쳐 +${result.gainedLevels}레벨 올랐습니다.`);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
    finally { managingCollection = false; }
  });
  $('#release-monster').onclick = () => void remove(selected.instanceId, false);
  if (game.battle) {
    detail.querySelectorAll<HTMLButtonElement>('[data-reorder-from],[data-replace-move],#recover-attack-move,[data-use-treat],#use-candy').forEach(button => { button.disabled = true; });
    if (isMonsterInBattle(game, selected.instanceId)) detail.querySelectorAll<HTMLButtonElement>('[data-evolve],[data-capsule-evolve]').forEach(button => { button.disabled = true; });
  }
  const selectedForm = pokemonPresentation(selected, game.battle).form?.identifier;
  if (selectedForm ? getPokemonFormModelSource(selectedForm) : hasPokemonModel(selected.speciesId)) {
    try { getPokemonScene().showSpecimen($('.detail-portrait'), selected.speciesId, selectedForm); }
    catch { detachPokemonScene(); }
  } else detachPokemonScene();
}
function chooseTeamMonster(card: HTMLElement) {
  selectedMonsterId = card.dataset.monster!; document.querySelectorAll<HTMLElement>('.team-page [data-monster]').forEach(item => item.classList.toggle('selected', item.dataset.monster === selectedMonsterId)); renderSelectedDetail();
  if (matchMedia('(max-width:1000px)').matches) $('#team-detail').scrollIntoView({ block: 'start' });
}
function bindMonsterCards(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('[data-monster]').forEach(card => { card.onclick = event => { if ((event.target as HTMLElement).closest('.card-action')) return; chooseTeamMonster(card); }; card.onkeydown = event => { if ((event.key === 'Enter' || event.key === ' ') && !(event.target as HTMLElement).closest('.card-action')) { event.preventDefault(); chooseTeamMonster(card); } }; });
}
function bindBoxCollection() {
  boxObserver?.disconnect();
  const collection = $('#box-collection'); bindMonsterCards(collection);
  collection.querySelectorAll<HTMLButtonElement>('[data-withdraw-id]').forEach(button => button.onclick = () => action(() => { const index = game!.player.box.findIndex(monster => monster.instanceId === button.dataset.withdrawId); if (index < 0) throw new Error('박스에서 개체를 찾지 못했습니다.'); withdrawMonster(game!, index); worldPanel?.simulation.reconcileTeamChange(); }));
  collection.querySelector<HTMLButtonElement>('#box-clear')!.onclick = () => { boxQuery = ''; boxType = 'all'; boxPage = 0; renderTeam(); $('#box-search').focus(); };
  const more = collection.querySelector<HTMLButtonElement>('#box-more')!;
  more.onclick = () => {
    const matches = sortedBox(), start = (boxPage + 1) * BOX_PAGE_SIZE;
    if (start >= matches.length) return;
    boxPage++;
    collection.querySelector('.box-grid')!.insertAdjacentHTML('beforeend', boxCardsHtml(matches.slice(start, start + BOX_PAGE_SIZE)));
    const visible = Math.min(matches.length, (boxPage + 1) * BOX_PAGE_SIZE);
    more.hidden = visible >= matches.length; more.textContent = `더 보기 · ${visible} / ${matches.length}`;
    bindBoxCollection();
  };
  if (!more.hidden) {
    boxObserver = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting) && more.isConnected) more.click(); }, { rootMargin: '200px' });
    boxObserver.observe(more);
  }
}
function renderTeam() {
  boxResults = undefined; boxObserver?.disconnect();
  if (!game) return; const all = owned(); if (!selectedMonsterId || !all.some(monster => monster.instanceId === selectedMonsterId)) selectedMonsterId = game.player.team[0].instanceId;
  const healthy = game.player.team.filter(monster => monster.hp > 0).length;
  const emptyTeamSlots = 6 - game.player.team.length;
  $('#screen').innerHTML = `<div class="page team-page"><section class="section-heading team-heading"><div><h1>팀과 박스</h1></div><div class="team-heading-actions"><span class="count-chip">팀 ${game.player.team.length}/6 · 박스 ${game.player.box.length}</span><button id="merge-collection" ${game.battle || game.captureOffer ? 'disabled' : ''}>중복 한번에 합치기</button></div></section><section class="team-rack panel" aria-labelledby="team-title"><div class="subheading"><div><h2 id="team-title">함께 걷는 팀</h2></div><small>${game.battle ? '전투 중에는 현재 출전·마지막 생존 개체를 보존합니다' : '첫 칸이 선두입니다'}</small></div><div class="team-slots">${game.player.team.map((monster, index) => { const active = game!.battle?.player.activeIndex === index, lastHealthy = Boolean(game!.battle && monster.hp > 0 && healthy <= 1); return monsterCard(monster, `<div class="card-actions"><button class="card-action" data-lead="${index}" ${index === 0 || game!.battle ? 'disabled' : ''}>선두</button><button class="card-action" data-deposit="${index}" ${game!.player.team.length <= 1 || active || lastHealthy ? 'disabled' : ''}>맡기기</button></div>`, 'team-monster'); }).join('')}${emptyTeamSlots ? `<div class="team-slot-empty team-slot-empty-summary" aria-label="빈 팀 슬롯 ${emptyTeamSlots}칸">빈 자리 ${emptyTeamSlots}칸</div>` : ''}</div></section><details class="breeding-fold panel"><summary>교배와 알 · ${game.nursery?.length ?? 0}/6</summary>${breedingPanelHtml(game)}</details><div class="team-layout"><section class="box-panel panel"><div class="subheading box-heading"><div><h2>보관 박스</h2></div></div><div class="box-tools"><label class="box-search"><span>박스 검색</span><input id="box-search" type="search" value="${escapeHtml(boxQuery)}" placeholder="이름 · 번호 · 타입" autocomplete="off"></label><label><span>타입</span><select id="box-type"><option value="all">모든 타입</option>${Object.entries(typeLabel).map(([value, label]) => `<option value="${value}" ${boxType === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label><span>정렬</span><select id="box-sort"><option value="number" ${boxSort === 'number' ? 'selected' : ''}>도감 번호</option><option value="level" ${boxSort === 'level' ? 'selected' : ''}>레벨 높은 순</option><option value="name" ${boxSort === 'name' ? 'selected' : ''}>이름</option><option value="recent" ${boxSort === 'recent' ? 'selected' : ''}>최근 보관</option></select></label></div><div id="box-collection">${boxCollectionHtml()}</div></section><aside id="team-detail" class="detail-card panel" aria-live="polite"></aside></div></div>`;
  $('#merge-collection').onclick = async () => {
    if (!game) return;
    const editedGame = game, button = $<HTMLButtonElement>('#merge-collection'); button.disabled = true;
    let release: (() => void) | undefined;
    try {
      release = await worldPanel?.hold();
      const plan = previewCollectionMerge(editedGame, currentCollectionRegion(), selectedMonsterId);
      if (!plan.totalDonors) { notify('합칠 중복 포켓몬이 없습니다.'); return; }
      const confirmed = await confirmAction({ title: '중복 한번에 합치기', message: `${plan.groups.length}종 · ${plan.totalDonors}마리 합치기`,
        detail: plan.groups.map(group => `${getSpecies(group.speciesId).name} Lv.${group.toLevel}`).join(' · '), confirmLabel: '합치기' });
      if (!confirmed || game !== editedGame) return;
      captureWorld(); await writeSave(packSave(editedGame, controller.graph, view), 'backup-before-merge-collection');
      if (game !== editedGame) return;
      mergeCollectionDuplicates(editedGame, plan, currentCollectionRegion());
      if (view.rewards) for (const group of plan.groups) for (const id of group.donorIds) delete view.rewards[id];
      worldPanel?.simulation.reconcileTeamChange(); captureWorld(); renderTeam(); shellStats();
      await saveNow(false, true); notify(`${plan.totalDonors}마리를 합쳤습니다.`);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
    finally { release?.(); if (button.isConnected) button.disabled = !!game?.battle || !!game?.captureOffer; }
  };
  bindMonsterCards($('.team-rack')); document.querySelectorAll<HTMLButtonElement>('[data-lead]').forEach(button => button.onclick = () => action(() => { const index = Number(button.dataset.lead), [monster] = game!.player.team.splice(index, 1); game!.player.team.unshift(monster); worldPanel?.simulation.reconcileTeamChange(); }, '선두 포켓몬을 바꿨습니다.')); document.querySelectorAll<HTMLButtonElement>('[data-deposit]').forEach(button => button.onclick = () => action(() => { depositMonster(game!, Number(button.dataset.deposit), currentCollectionRegion()); worldPanel?.simulation.reconcileTeamChange(); }));
  const refreshFilteredBox = () => {
    boxResults = undefined; boxPage = 0;
    const previousSelection = selectedMonsterId;
    const matches = sortedBox();
    if (game!.player.box.some(monster => monster.instanceId === selectedMonsterId) && !matches.some(monster => monster.instanceId === selectedMonsterId)) selectedMonsterId = matches[0]?.instanceId ?? game!.player.team[0].instanceId;
    $('#box-collection').innerHTML = boxCollectionHtml(); bindBoxCollection();
    if (selectedMonsterId !== previousSelection) renderSelectedDetail();
    else refreshDetailNavigator(owned().find(monster => monster.instanceId === selectedMonsterId) ?? game!.player.team[0]);
  };
  const search = $<HTMLInputElement>('#box-search'); search.oninput = () => { boxQuery = search.value; refreshFilteredBox(); }; $<HTMLSelectElement>('#box-type').onchange = event => { boxType = (event.target as HTMLSelectElement).value; refreshFilteredBox(); }; $<HTMLSelectElement>('#box-sort').onchange = event => { boxSort = (event.target as HTMLSelectElement).value as typeof boxSort; refreshFilteredBox(); };
  bindBoxCollection();
  bindBreedingPanel($('#screen'), game, controller.graph, (message, monster) => {
    if (monster) selectedMonsterId = monster.instanceId;
    worldPanel?.simulation.reconcileTeamChange(); renderTeam(); shellStats(); queueSave(); notify(message);
  }, message => notify(message, true));
  renderSelectedDetail();
}

const DEX_PAGE_SIZE = 60;
function dexPool() {
  return (dexRegion === 'all' ? getPlayableSpeciesIds() : regionalDexSpeciesIds(dexRegion).filter(isPlayableSpecies)).map(getSpecies);
}
function filteredDexSpecies() {
  if (!game) return [];
  const pool = dexPool(), caughtIds = game.dex.caught;
  const q = dexQuery.trim().toLowerCase();
  return pool.filter(s => (!q || s.name.includes(q) || s.englishName.toLowerCase().includes(q) || String(s.id) === q || s.types.some(type => type.includes(q) || typeLabel[type].includes(q)))
    && (dexMode === 'all' || (dexMode === 'caught' ? caughtIds : game!.dex.seen).includes(s.id)));
}
function dexGridHtml(filtered: ReturnType<typeof filteredDexSpecies>) {
  return filtered.slice(dexPage * DEX_PAGE_SIZE, (dexPage + 1) * DEX_PAGE_SIZE).map(s => {
    const seen = game!.dex.seen.includes(s.id), caught = game!.dex.caught.includes(s.id);
    return `<article class="dex-card${legendaryClass(s.id)} ${caught ? 'is-caught' : seen ? 'is-seen' : 'is-unseen'}" data-species="${s.id}" tabindex="0" role="button" aria-label="${escapeHtml(s.name)} 상세 보기"><span>No.${String(s.id).padStart(3, '0')} · ${escapeHtml(s.englishName)}</span><img loading="lazy" src="${s.frontSprite}" alt="${escapeHtml(s.name)}"><strong>${escapeHtml(s.name)}</strong><div>${typesHtml(s.id)}</div><small>${caught ? '● 수집' : seen ? '○ 발견' : '미발견'} · 상세 보기</small></article>`;
  }).join('') || '<p class="empty">검색 조건에 맞는 포켓몬이 없습니다.</p>';
}
function dexPaginationHtml(filteredCount: number, pages: number) {
  return `<button id="dex-first" ${dexPage === 0 ? 'disabled' : ''}>맨 처음</button><button id="dex-prev" ${dexPage === 0 ? 'disabled' : ''}>이전</button><span>${dexPage + 1} / ${pages} · 검색 ${filteredCount}종</span><button id="dex-next" ${dexPage + 1 >= pages ? 'disabled' : ''}>다음</button><button id="dex-last" ${dexPage + 1 >= pages ? 'disabled' : ''}>맨 끝</button>`;
}
function bindDexResults(filtered: ReturnType<typeof filteredDexSpecies>, pages: number) {
  const filteredIds = filtered.map(species => species.id);
  document.querySelectorAll<HTMLElement>('.dex-grid [data-species]').forEach(card => {
    card.onclick = () => showModel(Number(card.dataset.species), filteredIds);
    card.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.click(); } };
  });
  $('#dex-first').onclick = () => { dexPage = 0; refreshDexResults(); }; $('#dex-prev').onclick = () => { dexPage--; refreshDexResults(); };
  $('#dex-next').onclick = () => { dexPage++; refreshDexResults(); }; $('#dex-last').onclick = () => { dexPage = pages - 1; refreshDexResults(); };
}
function refreshDexResults() {
  const filtered = filteredDexSpecies(), pages = Math.max(1, Math.ceil(filtered.length / DEX_PAGE_SIZE)); dexPage = Math.max(0, Math.min(dexPage, pages - 1));
  $('.dex-grid').innerHTML = dexGridHtml(filtered);
  $('.dex-pagination').innerHTML = dexPaginationHtml(filtered.length, pages);
  bindDexResults(filtered, pages);
}
function renderDex() {
  detachPokemonScene();
  if (!game) return;
  const pool = dexPool(), caughtIds = game.dex.caught;
  const filtered = filteredDexSpecies(), pages = Math.max(1, Math.ceil(filtered.length / DEX_PAGE_SIZE)); dexPage = Math.max(0, Math.min(dexPage, pages - 1));
  const regionName = dexRegion === 'all' ? '전체' : DEX_REGIONS.find(region => region.id === dexRegion)!.name;
  const caughtSet = new Set(caughtIds);
  const tab = (id: DexRegionId | 'all', name: string, ids: readonly number[]) => `<button data-dex-region="${id}" class="${dexRegion === id ? 'active' : ''}" aria-pressed="${dexRegion === id}">${name}<small>${ids.filter(speciesId => caughtSet.has(speciesId)).length}/${ids.length}</small></button>`;
  const tabs = [tab('all', '전체', getPlayableSpeciesIds()), ...DEX_REGIONS.map(region => tab(region.id, region.name, regionalDexSpeciesIds(region.id).filter(isPlayableSpecies)))].join('');
  $('#screen').innerHTML = `<div class="page dex-page"><section class="section-heading"><div><span class="kicker">POKÉDEX · COLLECTION</span><h1>${escapeHtml(regionName)} 도감</h1><p>수록 ${pool.length}종 · 3D 지원 ${pool.filter(s => hasPokemonModel(s.id)).length}종 · 수집 ${caughtIds.filter(id => pool.some(s => s.id === id)).length}종</p></div>
    <div class="dex-tools"><input id="dex-search" type="search" aria-label="도감 검색" value="${escapeHtml(dexQuery)}" placeholder="이름, 번호, 타입 검색"><div>${(['all', 'seen', 'caught'] as const).map(mode => `<button data-dex-mode="${mode}" class="${dexMode === mode ? 'active' : ''}">${mode === 'all' ? '전체' : mode === 'seen' ? '발견' : '수집'}</button>`).join('')}</div></div></section>
    <nav class="dex-regions" aria-label="지역 도감">${tabs}</nav>
    <section class="collection-note"><p>지역별 원본 출현표로 고정됩니다. 원본 분포와 희귀 추가 분포를 구분해 표시합니다.</p></section>
    <div class="dex-grid">${dexGridHtml(filtered)}</div>
    <nav class="box-pagination dex-pagination" aria-label="도감 페이지">${dexPaginationHtml(filtered.length, pages)}</nav></div>`;
  const search = $<HTMLInputElement>('#dex-search'); search.oninput = () => { dexQuery = search.value; dexPage = 0; refreshDexResults(); };
  document.querySelectorAll<HTMLButtonElement>('[data-dex-region]').forEach(button => button.onclick = () => { dexRegion = button.dataset.dexRegion as typeof dexRegion; dexPage = 0; renderDex(); });
  document.querySelectorAll<HTMLButtonElement>('[data-dex-mode]').forEach(button => button.onclick = () => {
    dexMode = button.dataset.dexMode as typeof dexMode; dexPage = 0;
    document.querySelectorAll<HTMLButtonElement>('[data-dex-mode]').forEach(mode => mode.classList.toggle('active', mode.dataset.dexMode === dexMode));
    refreshDexResults();
  });
  bindDexResults(filtered, pages);
}
let shopCategory: ShopCategory = 'all';
function renderShop() {
  if (!game) return;
  detachPokemonScene(); $('#screen').innerHTML = itemShopHtml(game, shopCategory);
  document.querySelectorAll<HTMLButtonElement>('[data-shop-category]').forEach(button => button.onclick = () => {
    shopCategory = button.dataset.shopCategory as ShopCategory; renderShop();
  });
  document.querySelectorAll<HTMLInputElement>('[data-buy-quantity]').forEach(input => input.oninput = () => {
    const quantity = Number(input.value);
    input.parentElement!.querySelector<HTMLButtonElement>('[data-buy]')!.disabled = !Number.isSafeInteger(quantity) || quantity < 1 || quantity > Number(input.max);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-buy]').forEach(button => button.onclick = () => {
    const item = button.dataset.buy as InventoryItem, quantity = Number(button.parentElement!.querySelector<HTMLInputElement>('[data-buy-quantity]')!.value);
    action(() => buyItem(game!, item, quantity));
  });
  $('#shop-heal').onclick = () => action(() => heal(game!));
}

function serverCircuitHtml() {
  const remote = serverConnectome, available = Boolean(remote?.available);
  return `<section class="server-circuit panel" data-available="${String(available)}"><div><span class="eyebrow">SERVER CONNECTOME</span><h2>${available ? '서버 전체 회로' : '서버 회로 미연결'}</h2><p>${available ? '서버 배틀 계산은 브라우저용 128개 부분 회로와 구분된 전체 회로를 사용하며, 반환된 개체 상태는 이 기기에 저장합니다.' : '현재는 브라우저의 128개 부분 회로로 실행합니다.'}</p></div><dl><div><dt>종류</dt><dd>${escapeHtml(remote?.kind ?? '확인 불가')}</dd></div><div><dt>뉴런</dt><dd>${remote?.nodes?.toLocaleString() ?? '—'}</dd></div><div><dt>연결</dt><dd>${remote?.edges?.toLocaleString() ?? '—'}</dd></div><div><dt>활성 연결</dt><dd>${remote?.activeEdges?.toLocaleString() ?? '—'}</dd></div><div><dt>그래프 ID</dt><dd><code>${escapeHtml(remote?.graphId ?? '—')}</code></dd></div></dl></section>`;
}
function renderLab() {
  detachPokemonScene();
  if (!game) return; const specimen = owned().find(m => m.instanceId === selectedMonsterId) ?? game.player.team[0], brain = controller.ensure(specimen);
  const serverReceipt = lastServerDecision(specimen.instanceId);
  if (serverReceipt) lastDecision = `서버 ${serverReceipt.nodes.toLocaleString()}개 뉴런 · 마지막 출력 ${serverReceipt.action + 1} · ${serverReceipt.elapsedMs.toFixed(1)}ms · 학습 ${serverReceipt.updates}회. 아래 연결 그림은 브라우저 부분 회로입니다.`;
  const provenance = controller.graph.provenance;
  $('#screen').innerHTML = `<div class="page lab-page"><section class="lab-hero"><div><span class="kicker">MALE CNS · CONNECTOME SUBSET</span><h1>실제 연결 지도,<br>게임용 동역학</h1><p>커넥톰은 신경 연결 지도이며 완성된 뇌가 아닙니다. 이 게임은 실제 연결 일부 위에 감각·행동·학습 규칙을 직접 설계했습니다.</p></div><div class="graph-numbers"><span><strong>${controller.graph.nodes.length}</strong>브라우저 뉴런</span><span><strong>${controller.graph.edges.length.toLocaleString()}</strong>브라우저 연결</span><span><strong>64</strong>화면 표시</span></div></section>${serverCircuitHtml()}<div class="lab-layout"><section class="brain-card panel"><div class="panel-heading"><div><span class="eyebrow">LIVE ACTIVITY · ${escapeHtml(specimen.nickname)}</span><h2>회로 활성도</h2></div><span class="live-dot">LIVE</span></div><canvas id="brain-canvas" width="280" height="170"></canvas><p>${escapeHtml(lastDecision)}</p></section><section class="method-card panel"><span class="eyebrow">MODEL DISCLOSURE</span><h2>직접 설계한 부분</h2><p>${escapeHtml(BRAIN_ASSUMPTIONS)}</p><dl><div><dt>회로 범위</dt><dd>Male CNS v1.0, DNa02 이웃 128개 노드</dd></div><div><dt>행동 출력</dt><dd>0~3 기술, 4 기다리기</dd></div><div><dt>학습 보상</dt><dd>조우·피해·상성·승패·레벨 상승·진화 보상</dd></div><div><dt>평가 규칙</dt><dd>학습을 끄면 가중치를 고정</dd></div></dl></section></div><section class="source-card panel"><div><span class="eyebrow">SOURCE & LICENSE</span><h2>원본과 변환 근거</h2></div><div><p><b>버전</b> ${escapeHtml(provenance.version)}</p><p><b>브라우저 그래프 ID</b> ${escapeHtml(controller.graph.id)}</p><p><b>원본 SHA-256</b> <code>${escapeHtml(provenance.sha256)}</code></p><p><b>라이선스</b> ${escapeHtml(provenance.license)}</p><p>${escapeHtml(provenance.note)}</p><a href="https://male-cns.janelia.org/download/" target="_blank" rel="noreferrer">HHMI Janelia Male CNS 다운로드 ↗</a><a href="${escapeHtml(provenance.source)}" target="_blank" rel="noreferrer">사용한 원본 파일 ↗</a></div></section><section class="data-actions panel"><div><h2>저장 데이터 관리</h2><p>진행 상황과 개체별 회로 상태는 IndexedDB에 자동 저장됩니다. 계정을 연결하면 로그인·로그아웃·60초 자동저장과 지금 저장에서 서버와 동기화합니다.</p></div><button id="export-save">내보내기</button><button id="import-save">불러오기</button><button id="new-game" class="danger">새 게임</button></section></div>`;
  drawBrain($<HTMLCanvasElement>('#brain-canvas'), brain.state); $('#export-save').onclick = exportSave; $('#import-save').onclick = () => $<HTMLInputElement>('#import-file').click(); $('#new-game').onclick = newGame;
}
function dexHabitats(id: number) {
  const habitats: Array<ReturnType<typeof regionalSpeciesHabitats>[number] | ReturnType<typeof expansionSpeciesHabitats>[number]> = [];
  try { habitats.push(...regionalSpeciesHabitats(id)); } catch { /* A missing source anchor must not break the entire Pokédex. */ }
  try { habitats.push(...expansionSpeciesHabitats(id)); } catch { /* The detail remains available while source data is incomplete. */ }
  return habitats.map(habitat => {
    const atlas = getWorldAtlas(habitat.region), periods = habitat.periods.map(period => ({ morning: '아침', day: '낮', night: '밤' })[period]).join('·');
    const names = habitat.locationIds.map(locationId => atlas.locations.find(item => item.id === locationId)?.name ?? locationId).join(', ');
    return { label: `${atlas.name} · ${names}`, detail: `${periods} · ${habitat.origin === 'supplemental' ? `희귀 추가 · 배지 ${habitat.requiredBadges}개` : '원본 분포'}` };
  });
}
function dexHabitatSummary(id: number) {
  const sourceNames = dexHabitats(id).map(habitat => `${habitat.label} (${habitat.detail})`);
  const parents = POKEMON.filter(species => species.evolutions.some(evolution => evolution.target === id));
  if (!hasPokemonModel(id)) return '3D 미지원 · 도감 자료만 제공';
  if (!isPlayableSpecies(id)) return '현재 탐험 지도 없음';
  return sourceNames.join(' / ') || (parents.length ? `${parents.map(parent => parent.name).join(' / ')}에서 진화` : '야생 출현 없음 · 별도 입수 경로 확인 필요');
}
function showModel(initialId: number, orderedIds = getPlayableSpeciesIds()) {
  let id = initialId;
  const dialog = document.createElement('dialog');
  dialog.className = 'model-dialog';
  // Registered before any 3D work so a failed scene still leaves a dialog that closes and cleans up.
  dialog.addEventListener('close', () => { detachPokemonScene(); dialog.remove(); render(); }, { once: true });
  const renderDetail = () => {
    const species = getSpecies(id), forms = getPokemonForms(id).filter(form => !/-mega(?:-[xyz])?$/.test(form.identifier) || getPokemonFormModelSource(form.identifier)), index = orderedIds.indexOf(id), habitats = dexHabitats(id);
    const caught = game?.dex.caught.includes(id), seen = game?.dex.seen.includes(id), ownedCount = owned().filter(monster => monster.speciesId === id).length;
    const parents = POKEMON.filter(parent => parent.evolutions.some(evolution => evolution.target === id));
    const evolutions = species.evolutions.map(evolution => getSpecies(evolution.target));
    dialog.innerHTML = `<div class="model-dialog-top"><div><span class="eyebrow">No.${String(id).padStart(3, '0')} · ${escapeHtml(species.englishName)}</span><h2>${escapeHtml(species.name)}</h2><div>${typesHtml(id)}</div></div><button class="model-close" aria-label="닫기">×</button></div>
      <nav class="dex-detail-nav" aria-label="도감 상세 이동"><button data-dex-detail="first" ${index <= 0 ? 'disabled' : ''}>처음</button><button data-dex-detail="prev" ${index <= 0 ? 'disabled' : ''}>이전</button><span>${index + 1} / ${orderedIds.length}</span><button data-dex-detail="next" ${index < 0 || index + 1 >= orderedIds.length ? 'disabled' : ''}>다음</button><button data-dex-detail="last" ${index < 0 || index + 1 >= orderedIds.length ? 'disabled' : ''}>마지막</button></nav>
      <div class="dex-detail-layout"><section><div class="model-host"></div><div class="model-control-hint">드래그로 회전 · 휠 / 두 손가락으로 확대</div>${modelMotionHtml(id)}</section>
      <section class="dex-facts"><div class="dex-status"><strong>${caught ? '● 수집 완료' : seen ? '○ 발견' : '미발견'}</strong><span>보유 개체 ${ownedCount}마리</span></div><dl><div><dt>키</dt><dd>${species.heightMeters ? `${species.heightMeters} m` : '자료 없음'}</dd></div><div><dt>포획률</dt><dd>${species.catchRate}</dd></div><div><dt>기초 경험치</dt><dd>${species.baseExperience}</dd></div><div><dt>서식 환경</dt><dd>${escapeHtml(species.habitat || '자료 없음')}</dd></div></dl><div class="dex-base-stats">${Object.entries(species.baseStats).map(([key, value]) => `<span>${({ hp: 'HP', attack: '공격', defense: '방어', specialAttack: '특공', specialDefense: '특방', speed: '스피드' } as Record<string, string>)[key] ?? key}<b>${value}</b></span>`).join('')}</div></section></div>
      <section class="dex-detail-section"><h3>출현·입수</h3>${habitats.length ? `<ul>${habitats.map(habitat => `<li><strong>${escapeHtml(habitat.label)}</strong><span>${escapeHtml(habitat.detail)}</span></li>`).join('')}</ul>` : `<p>${escapeHtml(dexHabitatSummary(id))}</p>`}</section>
      <section class="dex-detail-section"><h3>진화 계보</h3><div class="dex-relatives">${[...parents.map(parent => ({ species: parent, relation: '진화 전' })), ...evolutions.map(target => ({ species: target, relation: '진화 후' }))].map(({ species: relative, relation }) => `<button data-related-species="${relative.id}"><img src="${relative.frontSprite}" alt=""><span><small>${relation}</small><strong>${escapeHtml(relative.name)}</strong></span></button>`).join('') || '<p>연결된 진화가 없습니다.</p>'}</div></section>
      <details class="form-gallery"><summary>원본 폼 자료 ${forms.length}개</summary><p>폼 이미지 자료입니다. 현재 포획·능력치·개체 저장은 종의 기본 폼 기준입니다.</p><div>${forms.map(form => `<figure>${form.frontSprite ? `<img loading="lazy" src="${pokemonSpriteUrl(form.spriteKey)}" alt="${escapeHtml(form.name)}">` : '<span>원본 이미지 없음</span>'}<figcaption>${escapeHtml(/-mega(?:-[xyz])?$/.test(form.identifier) ? formDisplayName(form) : form.formName || form.name || form.identifier)}${form.isBattleOnly ? ' · 배틀 전용' : ''}</figcaption></figure>`).join('')}</div></details>`;
    dialog.querySelector<HTMLButtonElement>('.model-close')!.onclick = () => dialog.close();
    dialog.querySelectorAll<HTMLButtonElement>('[data-dex-detail]').forEach(button => button.onclick = () => {
      const target = button.dataset.dexDetail === 'first' ? 0 : button.dataset.dexDetail === 'last' ? orderedIds.length - 1 : index + (button.dataset.dexDetail === 'prev' ? -1 : 1);
      if (orderedIds[target] !== undefined) { id = orderedIds[target]; detachPokemonScene(); renderDetail(); }
    });
    dialog.querySelectorAll<HTMLButtonElement>('[data-related-species]').forEach(button => button.onclick = () => { id = Number(button.dataset.relatedSpecies); if (!orderedIds.includes(id)) orderedIds = [...orderedIds, id].sort((a, b) => a - b); detachPokemonScene(); renderDetail(); });
    const modelHost = dialog.querySelector<HTMLElement>('.model-host')!, hint = dialog.querySelector<HTMLElement>('.model-control-hint')!;
    const preview = () => { modelHost.innerHTML = `<img class="species-preview" src="${species.frontSprite}" alt="${escapeHtml(species.name)}">`; };
    if (!hasPokemonModel(id)) { preview(); hint.textContent = '현재 게임에서 3D 미지원 · 도감 이미지를 표시합니다.'; }
    else {
      try { getPokemonScene().showSpecimen(modelHost, id); }
      catch { detachPokemonScene(); preview(); hint.hidden = true; }
    }
  };
  document.body.append(dialog); dialog.showModal();
  renderDetail();
}
function action(operation: () => unknown, success?: string) { try { operation(); if (success) notify(success); render(); queueSave(); } catch (error) { notify(error instanceof Error ? error.message : '요청을 처리하지 못했습니다.', true); } }
function exportSave() { if (!game) return; captureWorld(); const blob = new Blob([JSON.stringify(packSave(game, controller.graph, view), null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `choketmon-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
async function newGame() { if (!game) return; captureWorld(); await writeSave(packSave(game, controller.graph, view), 'backup-before-new-game'); worldPanel?.unmount(); worldPanel = undefined; game = undefined; view = { ...defaultView(), rewards: {} }; selectedMonsterId = ''; if (!starterDialog.open) starterDialog.showModal(); notify('현재 모험을 백업했습니다. 새 파트너를 골라 주세요.'); }

let changingTab = false;
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.onclick = async e => {
  e.preventDefault();
  if (changingTab || switchingAccount) return;
  const next = b.dataset.tab as Tab;
  if (tab === 'ranked' && next !== 'ranked' && rankedPanel.hasActiveSession()) { notify(RANKED_SESSION_MESSAGE); return; }
  if (game?.battle && !worldPanel && next !== 'team' && next !== 'shop') { notify('배틀 중에는 팀·박스와 상점만 열 수 있습니다.'); return; }
  const panel = worldPanel, editing = next === 'team' || next === 'shop';
  changingTab = true;
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => { button.disabled = true; });
  let release: (() => void) | undefined;
  try {
    // Finish any already submitted battle decision before exposing team edits. Other screens stop
    // world ticks by leaving the map tab, so they need not wait for the neural server.
    if (panel && editing) release = await panel.hold();
    else if (!panel && game?.battle && editing) await classicTurnPromise;
    if (panel !== worldPanel || switchingAccount) return;
    tab = next; render();
  } catch (error) { notify(error instanceof Error ? error.message : '화면을 전환하지 못했습니다.', true); }
  finally {
    release?.();
    changingTab = false;
    document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => { button.disabled = switchingAccount; });
  }
});
$('#save-now').onclick = () => {
  const button = $<HTMLButtonElement>('#save-now'); if (button.disabled) return; button.disabled = true;
  void withSaveRenderBudget(async () => {
    try { await saveNow(false, true); await accountPanel?.checkpoint(); notify(getSaveStorageStatus()?.state === 'synced' ? '서버와 동기화했습니다.' : '이 기기에 저장했습니다.'); }
    catch (error) { notify(String(error), true); }
    finally { button.disabled = switchingAccount; }
  });
};
document.querySelectorAll<HTMLButtonElement>('[data-starter]').forEach(b => b.onclick = () => { const id = Number(b.dataset.starter) as 1 | 4 | 7; game = createGame(id, `${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0]}`); view = { ...defaultView(), rewards: {} }; controller.ensure(game.player.team[0]); selectedMonsterId = game.player.team[0].instanceId; prepareWorld(); $<HTMLDialogElement>('#starter-dialog').close(); tab = 'map'; render(); playGameSound('creature', { speciesId: id }); queueSave(); });
$<HTMLInputElement>('#import-file').onchange = async e => { const input = e.target as HTMLInputElement, file = input.files?.[0]; if (!file) return; try { if (file.size > 20_000_000) throw new Error('저장 파일은 20MB 이하여야 합니다.'); const loaded = unpackSave(await file.text(), controller.graph); captureWorld(); if (game) await writeSave(packSave(game, controller.graph, view), 'backup-before-import'); game = loaded.game; view = { ...loaded.view, rewards: (loaded.view as PersistentView).rewards ?? {} }; selectedMonsterId = game.player.team[0].instanceId; prepareWorld(); tab = 'map'; render(); await saveNow(); notify('저장 파일을 불러왔습니다. 이전 모험은 백업했습니다.'); } catch (error) { notify(error instanceof Error ? error.message : '저장 파일을 읽지 못했습니다.', true); } finally { input.value = ''; } };
document.addEventListener('visibilitychange', () => { if (document.hidden) void saveNow(); });
window.addEventListener('pagehide', () => { void saveNow(); });
async function boot() { try {
  let completed = 0;
  startupLoading?.status('Male CNS 회로와 이동 정책을 확인하고 있습니다.');
  const tracked = <T>(task: Promise<T>) => task.then(result => {
    startupLoading?.stage('connectome', ++completed / 5 * 100, `회로·정책 ${completed} / 5 단계 확인`);
    return result;
  });
  const policy = async (path: string, message: string): Promise<FieldPolicy> => {
    const response = await fetch(path, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(message);
    return response.json() as Promise<FieldPolicy>;
  };
  [controller, fieldPolicy, originalFieldPolicy, legacyOpenWorldPolicy] = await Promise.all([
    tracked(ConnectomeController.load()),
    tracked(policy('/data/openworld-policy.json', '자율 필드의 신경 정책을 읽지 못했습니다.')),
    tracked(policy('/data/field-policy.json', '기존 이동 정책을 확인하지 못했습니다.')),
    tracked(policy('/data/openworld-policy-legacy.json', '기존 관동 이동 정책을 확인하지 못했습니다.')),
    tracked(initializeServerBrain()),
  ]);
  serverConnectome = getServerConnectomeInfo();
  startupLoading?.stage('connectome', 100, serverConnectome?.available ? 'Male CNS 부분 회로 · 서버 회로 연결 완료' : 'Male CNS 부분 회로 준비 완료');
  startupLoading?.status('저장된 모험을 확인하고 있습니다.');
  // A failing tick retries on the next one; the same error is reported at most every ten seconds.
  let lastTickError = '', lastTickErrorAt = 0;
  const reportTickError = (error: unknown) => {
    const message = error instanceof Error ? error.message : '월드 실행 오류', now = Date.now();
    if (message === lastTickError && now - lastTickErrorAt < 10_000) return;
    lastTickError = message; lastTickErrorAt = now; notify(message, true);
  };
  const runtime = createFieldRuntime(() => { if (!switchingAccount && !trading && tab === 'map') worldPanel?.tick().catch(reportTickError); }, 250);
  await runtime.start();
  accountPanel = mountAccountPanel({ container: $('#account-controls'), notify, requireLogin: true,
    canClose: () => !reauthenticationRequired,
    beforeSwitch: async change => {
      // The server scores a missed ranked deadline as a loss after this account leaves. A re-login
      // for an expired session keeps the same account, and its requests would be refused anyway.
      if (change.reason !== 'recovery' && !reauthenticationRequired) await rankedPanel.leave();
      setAccountSwitching(true);
      if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = 0; }
      releaseAccountSwitchHold?.(); releaseAccountSwitchHold = await worldPanel?.hold();
      await saveNow(false, true, true);
    },
    onSwitchError: change => {
      if (change.reason === 'recovery') { setAccountSwitching(true); return; }
      setAccountSwitching(false);
      if (currentAccount()?.id !== change.from?.id) {
        worldPanel?.unmount(); worldPanel = undefined; game = undefined;
        if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = 0; }
        view = { ...defaultView(), rewards: {} }; selectedMonsterId = '';
        $('#screen').innerHTML = '<section class="fatal"><h1>계정 저장을 다시 확인해 주세요</h1><p>이 기기의 기록은 보존되어 있습니다. 새로고침하면 선택한 계정의 저장을 다시 불러옵니다.</p><button id="retry-account">새로고침</button></section>';
        $('#retry-account').onclick = () => location.reload();
      }
      releaseAccountSwitchHold?.(); releaseAccountSwitchHold = undefined;
    },
    afterSwitch: async change => {
      if (!change.to) { setAccountSwitching(true); worldPanel?.unmount(); worldPanel = undefined; game = undefined; location.reload(); return; }
      if (change.reason === 'login' || change.reason === 'register') reauthenticationRequired = false;
      releaseAccountSwitchHold?.(); releaseAccountSwitchHold = undefined;
      worldPanel?.unmount(); worldPanel = undefined;
      if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = 0; }
      game = undefined; view = { ...defaultView(), rewards: {} }; selectedMonsterId = ''; tab = 'map';
      if (change.save) {
        const loaded = unpackSave(change.save, controller.graph); game = loaded.game; view = loaded.view;
        $<HTMLDialogElement>('#starter-dialog').close();
        selectedMonsterId = game.player.team[0].instanceId; prepareWorld(); render();
      } else { $('#screen').innerHTML = '<section class="loading"><h1>새 모험을 시작하세요</h1></section>'; if (!starterDialog.open) starterDialog.showModal(); }
      setAccountSwitching(getSaveStorageStatus()?.state === 'conflict');
    },
  });
  $<HTMLButtonElement>('[data-load-account]').onclick = () => accountPanel?.open();
  await accountPanel.ready;
  startupLoading?.remove();
} catch (error) {
  // A save that cannot load must not lock this device to the account.
  startupLoading?.fail(`게임을 시작할 수 없습니다. ${error instanceof Error ? error.message : String(error)}`, undefined, currentAccount() ? logout : undefined);
} }
void boot();
