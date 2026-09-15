import type { Graph } from '../core/brain';
import { getMove, getSpecies } from '../data/pokemon';
import { pokemonModelUrl, pokemonSpriteUrl } from '../game/assets';
import { getMoveLayout } from '../game/move-layout';
import { buyItem, depositMonster, experienceAtLevel, heal, ITEM_LABELS, ITEM_PRICES, SHOP_ITEMS, statsFor, withdrawMonster, type GameState, type InventoryItem, type Monster } from '../game/engine';
import { CAMPAIGN_TRAINERS, campaignTravelReason, getCampaignGyms, getNextCampaignTrainer, getRegionalBadges, regionalWildLevels } from '../game/campaign';
import { getWorldAtlas } from './atlas';
import { PLAYABLE_WORLDS, getPlayableSpeciesIds, isPlayableSpecies } from './availability';
import type { FieldPolicy } from '../game/field';
import { movementSpeed, OpenWorldSimulation, regionalEncounters, type OpenWorldSnapshot } from './simulation';
import { lastServerDecision } from '../game/server-brain';
import { mountOpenWorld } from './view';
import type { OpenWorldRenderSnapshot, OpenWorldView, WorldCreature, WorldHeading } from './types';
import './panel.css';
import { showGymVictory } from '../ui/gym-victory';
import { pokemonWorldDisplayHeight } from './visual-scale';
import { MultiplayerSession } from './multiplayer';
import { playGameSound } from '../audio';
import { currentAccount } from '../game/account';
import { WORLD_MIN, WORLD_MAX, WORLD_SCALE } from './world-space';
import { getCaveScene, cavePortalAtSurface, cavePortalAtInterior } from './caves';

const biomes = { meadow: '바람 초원', forest: '초록 숲', lake: '물빛 호수', rock: '돌바람 고원' };
const types: Record<string, string> = { normal: '노말', fire: '불꽃', water: '물', grass: '풀', electric: '전기', ice: '얼음', fighting: '격투', poison: '독', ground: '땅', flying: '비행', psychic: '에스퍼', bug: '벌레', rock: '바위', ghost: '고스트', dragon: '드래곤', steel: '강철', dark: '악', fairy: '페어리' };
const escape = (text: unknown) => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const pokemonDisplayHeight = (speciesId: number) => pokemonWorldDisplayHeight(getSpecies(speciesId).heightMeters);
const MANUAL_IDLE_SECONDS = 3;
type Options = { game: GameState; graph: Graph; policy: FieldPolicy; checkpoint?: OpenWorldSnapshot; learning(): boolean; setLearning(value: boolean): void; editMoves?(instanceId: string): void; trade?(): void; openAccount?(): void; notify(message: string, error?: boolean): void; changed(immediate?: boolean): void | Promise<void> };

export class OpenWorldPanel {
  readonly simulation: OpenWorldSimulation;
  private renderer?: OpenWorldView;
  private host?: HTMLElement;
  private ready = false;
  private attacks = new Map<string, { start: number; end: number; type: string }>();
  private tickPending = false;
  private manualIdleSeconds = 0;
  private serverRequest?: Promise<void>;
  private pausedBeforeBox = false;
  private multiplayer?: MultiplayerSession;
  private movingUntil = 0;
  private trackedPlayerId?: string;
  private lastChatId?: string;
  private unreadChats = 0;
  private lastMovementRefresh = -Infinity;
  private readonly compactViewport = window.matchMedia('(max-width: 720px), (max-height: 600px) and (pointer: coarse)');
  private readonly onViewportChange = () => {
    this.setChatCollapsed(this.compactViewport.matches);
    if (this.compactViewport.matches) this.host?.querySelector<HTMLDetailsElement>('.world-battle-hud')?.removeAttribute('open');
  };
  private miniTerrain?: HTMLCanvasElement;
  private miniRegion?: string;
  private previousBattle?: GameState['battle'];
  private lastPresence = { x: Number.NaN, z: Number.NaN };
  private readonly htmlCache = new WeakMap<Element, string>();
  private readonly hotkeys = (event: KeyboardEvent) => {
    if (!this.host || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]') || (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable]'))) return;
    if (event.code === 'Enter') { event.preventDefault(); this.setChatCollapsed(false); this.input('#world-chat-input').focus(); return; }
    if (event.code === 'KeyM') { event.preventDefault(); this.changeMode(this.simulation.controlMode === 'auto' ? 'manual' : 'auto'); }
    const index = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(event.code);
    if (index >= 0 && !this.paused) {
      event.preventDefault();
      const button = this.host.querySelector<HTMLButtonElement>(`[data-world-slot="${index}"]`);
      if (button && !button.disabled) button.click();
      else if (index === 0) this.host.querySelector<HTMLButtonElement>('#world-struggle')?.click();
    }
    if (event.code === 'KeyB') { event.preventDefault(); this.button('#world-catch').click(); }
    if (event.code === 'Space') { event.preventDefault(); this.button('#world-pause').click(); }
  };
  paused = false;

  constructor(private readonly options: Options) {
    const seed = options.checkpoint?.seed ?? [...options.game.seed].reduce((value, c) => (Math.imul(value, 31) + c.charCodeAt(0)) >>> 0, 517);
    this.simulation = new OpenWorldSimulation(options.graph, options.game, seed, options.checkpoint, options.policy);
    this.simulation.syncPlayerToCompanion();
  }

  async pauseAndSettle(): Promise<void> { this.paused = true; await this.serverRequest; }

  mount(host: HTMLElement): void {
    if (this.host === host && this.renderer && host.querySelector('#ow-host')) { this.refresh(); return; }
    this.unmount(); this.host = host;
    host.innerHTML = `<section class="adventure" aria-label="오픈월드 모험">
      <div id="ow-host"></div>
      <details class="world-explore-panel"><summary class="world-explore-toggle"><div><strong id="world-location-short">성도</strong><small id="world-explore-short">탐험 설정 · 상점</small></div><i>⌄</i></summary><div class="world-explore-scroll">
      <div class="world-heading"><span class="world-eyebrow" id="world-region-label">성도</span><span id="world-encounter-layout" class="world-encounter-layout">고정 야생 분포</span><h1 id="world-biome">연두마을</h1><p id="world-zone-level">다음 도로로 모험을 떠나세요</p></div>
      <div class="world-tools"><button id="world-pause">Ⅱ 일시 정지</button><button id="world-heal">캠프 회복</button></div>
      <fieldset class="world-automation"><legend>자동 설정</legend><label><input id="world-auto-hunt" type="checkbox" checked><span>자동 사냥</span></label><label><input id="world-auto-catch" type="checkbox" checked><span>자동 포획</span></label><label title="대기 팀원 80% · 출전 개체보다 낮은 레벨은 100%"><input id="world-exp-share" type="checkbox" checked><span>팀 경험치 공유</span></label><label><input id="world-learning" type="checkbox" checked><span id="world-learning-label">기술 학습</span></label></fieldset>
      <div class="world-control-mode" role="group" aria-label="조작 모드"><div class="world-mode-buttons"><button id="world-mode-auto">자동</button><button id="world-mode-manual">수동</button></div><div class="world-control-copy"><strong id="world-control-title"></strong><small id="world-control-help"></small></div></div>
      <details class="world-shop"><summary>프렌들리숍 · <span id="world-ball-stock"></span></summary><div id="world-shop-items"></div><button id="world-box-open" class="world-box-open">박스 관리 · 팀 <span id="world-team-count">1</span>/6</button><small id="world-shop-note">승리 후에는 볼 1개로 확정 포획합니다.</small></details>
      <div class="world-gym" id="world-gym"></div>
      <details class="world-objective"><summary><span>주변 포켓몬 ▾</span><strong id="world-objective">첫 야생 포켓몬 발견하기</strong></summary><small>선택해 정보를 보고 추적·배틀하세요.</small><div id="world-nearby"></div></details>
      </div></details>
      <aside class="world-radar"><button id="world-map-open" aria-label="지역 전체 지도 열기"><canvas id="world-minimap" width="180" height="180" aria-label="월드 지도"></canvas></button><span id="world-position"></span><small id="world-map-caption">지역 지도 ↗</small></aside>
      <div class="world-lower-hud">
      <section class="world-multiplayer social-dock" aria-label="지역 채팅">
        <div id="world-trainer-track" hidden></div>
        <header class="social-toolbar"><span class="social-channel"><span id="world-realtime-dot"></span><b id="world-chat-region">성도</b><small id="world-realtime-status">연결 중</small></span><details class="social-players"><summary aria-label="접속 트레이너와 위치"><span id="world-realtime-count">0명</span></summary><div class="social-player-popover"><div class="social-identity"><span>내 트레이너</span><strong id="world-chat-identity"></strong></div><div id="world-player-list" aria-label="같은 지역 플레이어"></div><small>이름을 누르면 위치를 표시합니다.</small></div></details><button id="world-trade-open" title="포켓몬 교환 · 게임 머니 거래">교환</button><button id="world-chat-collapse" aria-label="채팅 기록 접기" aria-expanded="true">⌄</button></header>
        <div id="world-chat-log" role="log" aria-label="지역 대화" aria-live="polite" tabindex="0"></div><button id="world-chat-latest" hidden>새 메시지 ↓</button>
        <form id="world-chat-form"><input id="world-chat-input" aria-label="지역 채팅 메시지" autocomplete="off" placeholder="로그인하고 대화하기" enterkeyhint="send"><button type="button" id="world-chat-login">가입 / 로그인</button><button id="world-chat-send" aria-label="메시지 전송" title="Enter로 전송">↑</button></form><small id="world-chat-error" role="status"></small>
      </section>
        <section class="world-target" id="world-target" aria-label="선택한 야생 포켓몬" hidden><div id="world-target-info"></div><div class="world-target-actions"><button id="world-target-track">추적</button><button id="world-target-battle">배틀</button><details><summary>정보</summary><p id="world-target-detail"></p></details><button id="world-target-clear" aria-label="선택 해제">✕</button></div></section>
        <details class="world-battle-hud" aria-label="파트너와 배틀">
          <summary><span>PARTNER · 파트너와 배틀</span><strong>파트너 상태</strong><i aria-hidden="true">⌄</i></summary>
          <div class="world-battle-deck">
            <div id="world-combatants"></div><div id="world-moves" class="world-moves"></div><button id="world-edit-moves" class="world-edit-moves">기술 배치</button><div id="world-emergency-action"></div>
            <div class="world-battle-actions"><button id="world-engage">가까운 포켓몬 배틀</button><button id="world-catch" disabled>볼 던지기</button><button id="world-potion" disabled>상처약</button><button id="world-run" disabled>도망</button><span id="world-battle-state">자동 배틀 대기</span></div>
            <details class="world-rewards"><summary>이 개체의 보상 기록</summary><div id="world-rewards"></div><small>게임에서 설계한 보상이며 생물학적 학습의 증거가 아닙니다.</small></details>
          </div>
        </details>
      </div>
      <section class="world-capture-offer" id="world-capture-offer" aria-label="승리 후 포획" hidden></section>
      <dialog class="kanto-map-dialog" id="world-map-dialog"><header><div><small id="world-map-region-name">KANTO REGION</small><h2>지도 · 순간이동</h2></div><button id="world-map-close">닫기 ✕</button></header><div class="world-region-picker"><label for="world-region">여행할 지역</label><select id="world-region">${PLAYABLE_WORLDS.map(region => `<option value="${region.id}">${region.name}</option>`).join('')}</select></div><section id="world-campaign-guide" class="world-campaign-guide" aria-label="지역 진행"></section><p id="world-map-note">방문한 마을로 무료 이동합니다. 도시 연결·지형·출현은 게임용으로 구성한 지도입니다.</p><div id="world-travel"></div><div id="world-map-content"></div></dialog>
      <dialog class="world-box-dialog" id="world-box-dialog" aria-labelledby="world-box-title"><header><div><small>POKÉMON STORAGE</small><h2 id="world-box-title">팀 · 박스 관리</h2></div><button id="world-box-close">닫기 ✕</button></header><p>탐험을 일시 정지하고 안전하게 팀을 정리합니다. 전투 중에는 현재 출전 개체와 마지막 생존 개체를 맡길 수 없습니다.</p><div id="world-box-content"></div></dialog>
      <div class="world-feed" id="world-feed" aria-live="polite"></div>
      <div class="world-respawn" id="world-respawn"></div>
      <details class="world-method"><summary>회로와 게임 규칙</summary><p>브라우저 MaleCNS 실측 부분 회로 ${this.options.graph.nodes.length} 뉴런 · ${this.options.graph.edges.length.toLocaleString()} 연결. 전체 회로가 연결된 배틀은 서버에서 계산하고 반환된 개체 기억은 이 기기에 저장합니다. 감각 입력·행동 대응·학습 보상·월드 속도는 게임을 위해 설계했습니다. 자동 모드에서 추적 대상이 없으면 통행 가능한 탐험 목적지를 게임 규칙으로 정하고, 회로가 이동 방향을 선택합니다.</p></details>
    </section>`;
    this.renderer = mountOpenWorld(host.querySelector('#ow-host')!, {
      getSnapshot: () => this.renderSnapshot(), sampleWorld: (x, z) => this.simulation.sampleWorld(x, z), modelUrl: pokemonModelUrl, spriteUrl: pokemonSpriteUrl,
      onReady: () => { this.ready = true; const canvasHost = this.host?.querySelector<HTMLElement>('#ow-host'); if (canvasHost) canvasHost.dataset.ready = 'true'; },
      onNavigationStart: () => this.noteManualInput(),
      onMovementInput: () => this.noteManualInput(),
      onPlayerMove: next => {
        if (!this.noteManualInput()) return false;
        const accepted = this.simulation.movePartner(next);
        // Camera movement is immediate; HTML updates are limited to 10Hz.
        const now = performance.now();
        if (accepted && now - this.lastMovementRefresh >= 100) { this.lastMovementRefresh = now; this.refresh(); }
        return accepted;
      },
      onSelect: id => { if (id?.startsWith('companion:')) return; this.manualIdleSeconds = 0; this.simulation.selectWild(id, true); this.options.changed(); this.refresh(); },
      onInteract: id => this.encounter(id),
      onPortal: () => { if (this.simulation.traverseCavePortal()) { this.multiplayer?.join(this.presence()); this.options.changed(); this.refresh(); this.renderer?.update(); } },
    });
    this.multiplayer = new MultiplayerSession(() => { if (this.host === host) this.renderRealtime(); });
    this.multiplayer.join(this.presence());
    window.addEventListener('keydown', this.hotkeys);
    const battleHud = this.host.querySelector<HTMLDetailsElement>('.world-battle-hud')!;
    battleHud.open = Boolean(this.options.game.battle) && (!this.compactViewport.matches || this.simulation.controlMode === 'manual');
    battleHud.addEventListener('toggle', () => {
      if (battleHud.open && this.compactViewport.matches) {
        this.setChatCollapsed(true);
        this.host?.querySelector<HTMLDetailsElement>('.world-explore-panel')?.removeAttribute('open');
      }
    });
    this.compactViewport.addEventListener('change', this.onViewportChange);
    this.button('#world-mode-auto').onclick = () => this.changeMode('auto');
    this.button('#world-mode-manual').onclick = () => this.changeMode('manual');
    this.button('#world-edit-moves').onclick = () => {
      const game = this.options.game;
      if (game.battle || game.captureOffer) return;
      const lead = game.player.team.find(monster => monster.hp > 0) ?? game.player.team[0];
      this.options.editMoves?.(lead.instanceId);
    };
    this.button('#world-target-track').onclick = () => { this.simulation.trackSelected(); this.options.changed(); this.refresh(); };
    this.button('#world-target-battle').onclick = () => { const id = this.simulation.selectedWildId; if (id) this.encounter(id); };
    this.button('#world-target-clear').onclick = () => { this.simulation.selectWild(null); this.options.changed(); this.refresh(); };
    this.host.querySelector('#world-moves')!.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-world-move]');
      if (button && this.simulation.requestAction({ type: 'move', index: Number(button.dataset.worldMove) })) this.options.notify('다음 턴에 선택한 기술을 사용합니다.');
    });
    this.host.querySelector('#world-emergency-action')!.addEventListener('click', event => {
      if ((event.target as Element).closest('#world-struggle')) this.simulation.requestAction({ type: 'move', index: 0 });
    });
    this.host.querySelector('#world-nearby')!.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-world-wild]');
      if (!button?.dataset.worldWild) return;
      this.manualIdleSeconds = 0;
      this.simulation.selectWild(button.dataset.worldWild, true);
      this.host!.querySelector<HTMLDetailsElement>('.world-objective')!.open = false;
      this.options.changed(); this.refresh();
    });
    this.button('#world-map-open').onclick = () => { this.drawRegionMap(); this.host!.querySelector<HTMLDialogElement>('#world-map-dialog')!.showModal(); };
    this.button('#world-map-close').onclick = () => this.host!.querySelector<HTMLDialogElement>('#world-map-dialog')!.close();
    this.button('#world-box-open').onclick = () => void this.openBox();
    this.button('#world-box-close').onclick = () => this.closeBox();
    this.host.querySelector<HTMLDialogElement>('#world-box-dialog')!.addEventListener('cancel', event => { event.preventDefault(); this.closeBox(); });
    this.button('#world-chat-login').onclick = () => this.options.openAccount?.();
    const multiplayerPanel = this.host.querySelector<HTMLElement>('.world-multiplayer')!;
    this.setChatCollapsed(this.compactViewport.matches);
    this.button('#world-chat-collapse').onclick = () => this.setChatCollapsed(!multiplayerPanel.classList.contains('chat-collapsed'));
    this.button('#world-chat-latest').onclick = () => this.scrollChatToLatest();
    this.button('#world-trade-open').onclick = () => this.options.trade?.();
    this.host.querySelector('#world-player-list')!.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLElement>('[data-remote-player]');
      if (!button) return;
      this.trackedPlayerId = button.dataset.remotePlayer;
      this.host!.querySelector<HTMLDetailsElement>('.social-players')!.open = false;
      this.renderRealtime(); this.drawRegionMap(); this.host!.querySelector<HTMLDialogElement>('#world-map-dialog')!.showModal();
    });
    this.host.querySelector('#world-trainer-track')!.addEventListener('click', event => {
      if ((event.target as Element).closest('[data-stop-tracking]')) { this.trackedPlayerId = undefined; this.renderRealtime(); }
      else { this.drawRegionMap(); this.host!.querySelector<HTMLDialogElement>('#world-map-dialog')!.showModal(); }
    });
    const chat = this.host.querySelector<HTMLFormElement>('#world-chat-form')!, chatInput = this.input('#world-chat-input');
    chatInput.oninput = () => { chatInput.value = Array.from(chatInput.value).slice(0, 200).join(''); };
    chatInput.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing) { event.stopPropagation(); chatInput.blur(); } });
    let composing = false;
    chatInput.addEventListener('compositionstart', () => { composing = true; }); chatInput.addEventListener('compositionend', () => { composing = false; });
    chat.addEventListener('submit', event => { event.preventDefault(); if (composing) return; if (this.multiplayer?.sendChat(chatInput.value)) { chatInput.value = ''; this.html('#world-chat-error', ''); this.scrollChatToLatest(); } else this.html('#world-chat-error', this.multiplayer?.view.status === 'connected' ? '1~200자로 입력해 주세요.' : '연결을 복구하고 있습니다. 입력한 내용은 유지됩니다.'); });
    this.button('#world-pause').onclick = async () => {
      this.paused = !this.paused; this.refresh();
      const button = this.button('#world-pause'); button.disabled = true;
      try {
        // A request already in flight still owns a durable neural result. Finish
        // it before marking this paused snapshot saved, so reload sees that head.
        if (this.paused) await this.serverRequest;
        await this.options.changed(true);
      } catch (error) {
        this.paused = true; this.options.notify(String(error), true);
      } finally { button.disabled = false; this.refresh(); }
    };
    this.button('#world-heal').onclick = () => {
      if (this.options.game.battle) return this.options.notify('배틀을 마친 뒤 회복할 수 있습니다.');
      heal(this.options.game); playGameSound('heal'); this.options.notify('캠프에서 HP·PP·상태 이상을 회복했습니다.'); this.options.changed(); this.refresh();
    };
    this.button('#world-engage').onclick = () => {
      const nearest = this.simulation.visibleEntities(18).filter(entity => entity.kind === 'wild').sort((a, b) => Math.hypot(a.x - this.simulation.player.x, a.z - this.simulation.player.z) - Math.hypot(b.x - this.simulation.player.x, b.z - this.simulation.player.z))[0];
      if (nearest) { this.simulation.selectWild(nearest.id); this.encounter(nearest.id); }
    };
    this.button('#world-catch').onclick = () => { if (this.options.game.captureOffer) this.catchVictory(); else if (this.simulation.requestCapture()) this.options.notify('다음 턴에 볼을 던집니다.'); else this.options.notify('사용할 수 있는 볼이 없습니다. 프렌들리숍에서 구매하세요.'); };
    this.button('#world-potion').onclick = () => { if (this.simulation.requestAction({ type: 'item', item: 'potion' })) this.options.notify('다음 턴에 상처약을 사용합니다.'); };
    this.button('#world-run').onclick = () => { if (this.simulation.requestAction({ type: 'run' })) this.options.notify('다음 턴에 도망을 시도합니다.'); };
    this.input('#world-auto-catch').onchange = e => { this.simulation.setAutoCapture((e.target as HTMLInputElement).checked); if (this.simulation.autoCapture && this.simulation.hasBalls && this.options.game.captureOffer) this.catchVictory(); this.options.changed(); this.refresh(); };
    this.input('#world-auto-hunt').onchange = e => { this.simulation.setAutoHunt((e.target as HTMLInputElement).checked); this.options.changed(); this.refresh(); };
    this.input('#world-learning').checked = this.options.learning();
    this.input('#world-learning').onchange = e => { this.options.setLearning((e.target as HTMLInputElement).checked); this.options.changed(); };
    this.input('#world-exp-share').onchange = e => { this.options.game.experienceShare = (e.target as HTMLInputElement).checked; this.options.changed(); this.refresh(); };
    const regionSelect = host.querySelector<HTMLSelectElement>('#world-region')!;
    regionSelect.onchange = () => {
      try {
        const destination = getWorldAtlas(regionSelect.value).id;
        const reason = campaignTravelReason(this.options.game, destination as 'kanto' | 'johto');
        if (reason) throw new Error(reason);
        this.simulation.changeRegion(destination); this.multiplayer?.join(this.presence()); this.options.changed(); this.refresh(); this.drawRegionMap(); this.options.notify(`${this.simulation.atlas.name}에 도착했습니다.`);
      }
      catch (error) { regionSelect.value = this.simulation.regionId; this.options.notify(String(error), true); }
    };
    this.refresh();
  }

  private canAcceptMovement(): boolean {
    return !this.paused
      && !document.querySelector('dialog[open]')
      && !this.options.game.battle
      && !this.options.game.captureOffer
      && this.options.game.player.team.some(monster => monster.hp > 0)
      && !this.host?.querySelector<HTMLDialogElement>('#world-map-dialog')?.open;
  }

  private noteManualInput(): boolean {
    if (!this.canAcceptMovement()) return false;
    this.manualIdleSeconds = 0;
    if (this.simulation.controlMode !== 'manual') this.changeMode('manual');
    return true;
  }

  private changeMode(mode: 'auto' | 'manual'): void { this.manualIdleSeconds = 0; this.simulation.setControlMode(mode); this.options.changed(); this.refresh(); }
  private catchVictory(): void { const caught = this.simulation.captureVictory(); if (caught) playGameSound('capture'); this.options.notify(caught ? '포획 성공! 팀 또는 박스에 저장했습니다.' : '볼이 없어 포획을 패스합니다.'); this.options.changed(); this.refresh(); }

  private async openBox(): Promise<void> {
    const dialog = this.host?.querySelector<HTMLDialogElement>('#world-box-dialog');
    if (!dialog || dialog.open) return;
    this.pausedBeforeBox = this.paused;
    this.paused = true;
    this.refresh();
    const open = this.button('#world-box-open'); open.disabled = true;
    try {
      await this.serverRequest;
      this.renderBox();
      dialog.showModal();
      await this.options.changed(true);
    } catch (error) {
      this.options.notify(error instanceof Error ? error.message : String(error), true);
      this.paused = this.pausedBeforeBox;
    } finally { open.disabled = false; this.refresh(); }
  }

  private closeBox(): void {
    const dialog = this.host?.querySelector<HTMLDialogElement>('#world-box-dialog');
    if (!dialog?.open) return;
    dialog.close();
    this.paused = this.pausedBeforeBox;
    this.options.changed();
    this.refresh();
  }

  private renderBox(): void {
    const root = this.host?.querySelector<HTMLElement>('#world-box-content');
    if (!root) return;
    const game = this.options.game, battle = game.battle;
    const healthy = game.player.team.filter(monster => monster.hp > 0).length;
    const team = game.player.team.map((monster, index) => {
      const active = battle?.player.activeIndex === index;
      const lastHealthy = Boolean(battle && monster.hp > 0 && healthy <= 1);
      const disabled = game.player.team.length <= 1 || active || lastHealthy;
      const reason = active ? '현재 출전 중' : lastHealthy ? '마지막 생존 개체' : game.player.team.length <= 1 ? '마지막 팀 개체' : '';
      return `<article><img src="${pokemonSpriteUrl(monster.speciesId)}" alt=""><div><strong>${escape(monster.nickname)}</strong><small>Lv.${monster.level} · HP ${monster.hp}/${monster.stats.hp}${reason ? ` · ${reason}` : ''}</small></div><button data-world-deposit="${index}" ${disabled ? 'disabled' : ''}>맡기기</button></article>`;
    }).join('');
    const box = game.player.box.map((monster, index) => `<article><img src="${pokemonSpriteUrl(monster.speciesId)}" alt=""><div><strong>${escape(monster.nickname)}</strong><small>Lv.${monster.level} · HP ${monster.hp}/${monster.stats.hp}</small></div><button data-world-withdraw="${index}" ${game.player.team.length >= 6 ? 'disabled' : ''}>데려오기</button></article>`).join('');
    root.innerHTML = `<section><h3>팀 ${game.player.team.length}/6</h3><div>${team}</div></section><section><h3>박스 ${game.player.box.length}</h3><div>${box || '<p class="world-box-empty">보관 중인 포켓몬이 없습니다.</p>'}</div></section>`;
    root.querySelectorAll<HTMLButtonElement>('[data-world-deposit]').forEach(button => button.onclick = () => void this.changeBox(() => depositMonster(game, Number(button.dataset.worldDeposit)), '박스에 맡겼습니다.'));
    root.querySelectorAll<HTMLButtonElement>('[data-world-withdraw]').forEach(button => button.onclick = () => void this.changeBox(() => withdrawMonster(game, Number(button.dataset.worldWithdraw)), '팀으로 데려왔습니다.'));
  }

  private async changeBox(operation: () => void, message: string): Promise<void> {
    try {
      operation();
      this.simulation.reconcileTeamChange();
      this.renderBox();
      this.refresh();
      await this.options.changed(true);
      this.options.notify(message);
    } catch (error) { this.options.notify(error instanceof Error ? error.message : String(error), true); }
  }

  private encounter(id: string): void {
    const wild = this.simulation.entities.find(entity => entity.id === id);
    if (!wild || wild.kind !== 'wild') return;
    this.simulation.selectWild(id, true);
    if (!this.simulation.canEngageWild(id)) { this.simulation.trackSelected(); this.options.notify(`${getSpecies(wild.speciesId).name} 추적 중 · 길을 따라 4m 안에 도착하면 배틀합니다.`); this.options.changed(); }
    else if (this.simulation.startEncounter(id)) { this.paused = false; this.options.changed(); }
    this.refresh();
  }

  async tick(): Promise<void> {
    if (this.tickPending || !this.renderer || !this.ready) return;
    this.simulation.synchronizeWorldClock(Date.now());
    if (this.paused || document.hidden || document.querySelector('dialog[open]')) { this.manualIdleSeconds = 0; return; }
    this.tickPending = true;
    try {
    // Count active exploration time only. Input also resets this when a wall
    // blocks movement, so held controls never hand the partner back to AI.
    if (this.simulation.controlMode === 'manual' && this.canAcceptMovement()) {
      this.manualIdleSeconds += .25;
      if (this.manualIdleSeconds >= MANUAL_IDLE_SECONDS) this.changeMode('auto');
    } else this.manualIdleSeconds = 0;
    // Resolve neural decisions alongside the fixed-rate world clock. The simulation
    // itself gates a battle turn until all required decisions are present.
    if (!this.serverRequest) {
      this.serverRequest = this.simulation.prepareServerBattle(this.options.learning())
        .catch(error => {
          this.paused = true;
          this.options.notify(`${error instanceof Error ? error.message : String(error)} · 연결 후 재개해 주세요.`, true);
          this.refresh();
        }).finally(() => { this.serverRequest = undefined; });
    }
    const result = this.simulation.step({ deltaSeconds: .25, learning: this.options.learning() });
    this.simulation.syncPlayerToCompanion();
    for (const event of result.events) {
      if (event.type === 'battle-turn') {
        if (event.result.executedMoves.some(move => move.executed)) playGameSound('attack');
        if (event.result.outcome === 'won') playGameSound('victory');
        else if (event.result.outcome === 'caught') playGameSound('capture');
        const now = performance.now(); this.attacks.clear();
        event.result.executedMoves.filter(move => move.executed).forEach((move, index) => {
          this.attacks.set(move.actorInstanceId, { start: now + index * 300, end: now + index * 300 + 280, type: move.moveType });
        });
        if (event.result.battleEnded && !event.result.gymVictory) this.options.notify(event.result.outcome === 'won' ? '승리! 경험치와 보상을 받았습니다.' : event.result.outcome === 'caught' ? '포획 성공! 팀과 도감에 등록했습니다.' : event.result.outcome === 'lost' ? '파트너가 쓰러졌습니다. 회복한 뒤 다시 탐험하세요.' : '배틀에서 벗어났습니다.');
        await this.options.changed(true);
        if (event.result.gymVictory) {
          this.refresh(); await showGymVictory(event.result.gymVictory);
          this.manualIdleSeconds = 0;
        }
      }
      if (event.type === 'evolved') this.options.notify(`${getSpecies(event.fromSpeciesId).name} → ${getSpecies(event.speciesId).name} 진화!`);
    }
    if (result.tick % 20 === 0) this.options.changed();
    this.refresh();
    } catch (error) {
      this.paused = true;
      this.options.notify(`${error instanceof Error ? error.message : String(error)} · 월드를 일시 정지했습니다. 연결 후 재개해 주세요.`, true);
      this.refresh();
    } finally { this.tickPending = false; }
  }

  private renderSnapshot(): OpenWorldRenderSnapshot {
    const game = this.options.game, battle = game.battle;
    const now = performance.now();
    const attacking = (id?: string) => { const attack = id ? this.attacks.get(id) : undefined; return attack && now >= attack.start && now < attack.end ? attack : undefined; };
    const ally = battle ? battle.player.team[battle.player.activeIndex] : game.player.team.find(mon => mon.hp > 0) ?? game.player.team[0];
    const enemy = battle?.enemy.team[battle.enemy.activeIndex];
    return {
      regionId: this.simulation.regionId,
      sceneId: this.simulation.sceneId,
      player: { ...this.simulation.player, heading: this.simulation.player.heading as WorldHeading }, tick: this.simulation.tick, selectedWildId: this.simulation.selectedWildId, badges: getRegionalBadges(game, this.simulation.regionId),
      foods: this.simulation.foods.map(food => ({ ...food, id: String(food.id) })),
      entities: this.simulation.visibleEntities(18).map(entity => {
        const inBattle = Boolean(battle && (entity.kind === 'companion' || entity.id === this.simulation.battleWildId));
        const monster = entity.kind === 'companion' ? ally : entity.id === this.simulation.battleWildId ? enemy : undefined;
        const transformed = monster && battle?.transformations?.[monster.instanceId];
        const speciesId = transformed?.speciesId ?? monster?.speciesId ?? entity.speciesId;
        const stats = transformed?.stats ?? monster?.stats ?? statsFor(getSpecies(entity.speciesId), entity.level);
        const level = monster?.level ?? entity.level;
        return { id: entity.id, speciesId, name: getSpecies(speciesId).name, level, hp: monster?.hp ?? stats.hp, maxHp: stats.hp,
          x: entity.x, z: entity.z,
          heading: entity.heading as WorldHeading, inBattle,
          action: monster?.hp === 0 ? 'fainted' : inBattle ? (attacking(monster?.instanceId) ? 'attack' : 'idle') : entity.action < 4 ? 'walk' : 'idle',
          moveType: attacking(monster?.instanceId)?.type,
          lookAt: inBattle ? (() => {
            const target = this.simulation.entities.find(other => entity.kind === 'companion' ? other.id === this.simulation.battleWildId : other.kind === 'companion');
            return target ? { x: target.x, z: target.z } : undefined;
          })() : undefined,
          movementSpeed: movementSpeed(speciesId, level),
          displayHeight: pokemonDisplayHeight(speciesId),
        } as WorldCreature;
      }).concat(battle && battle.kind !== 'wild' && enemy ? [{ id: this.simulation.battleWildId!, speciesId: enemy.speciesId, name: enemy.nickname, level: enemy.level, hp: enemy.hp, maxHp: enemy.stats.hp, x: this.simulation.player.x, z: this.simulation.player.z - 3, heading: 2 as WorldHeading, action: attacking(enemy.instanceId) ? 'attack' as const : 'idle' as const, moveType: attacking(enemy.instanceId)?.type, inBattle: true, lookAt: this.simulation.player, displayHeight: pokemonDisplayHeight(enemy.speciesId), movementSpeed: movementSpeed(enemy.speciesId, enemy.level) }] : [])
        .concat(this.multiplayer?.creatures(this.simulation.player, id => movementSpeed(id)) ?? []),
    };
  }

  private presence() {
    const game = this.options.game, battle = game.battle;
    const lead = battle?.player.team[battle.player.activeIndex] ?? game.player.team.find(monster => monster.hp > 0) ?? game.player.team[0];
    const player = this.simulation.player, now = performance.now();
    if (player.x !== this.lastPresence.x || player.z !== this.lastPresence.z) { this.lastPresence = { x: player.x, z: player.z }; this.movingUntil = now + 300; }
    return { region: this.simulation.regionId as 'kanto' | 'johto', sceneId: this.simulation.sceneId, speciesId: lead.speciesId, x: player.x, z: player.z, heading: player.heading,
      activity: battle ? 'battle' as const : now < this.movingUntil ? 'moving' as const : 'idle' as const };
  }

  private renderRealtime(): void {
    if (!this.host || !this.multiplayer) return;
    const view = this.multiplayer.view, account = currentAccount(), needsLogin = !account || view.status === 'auth-required';
    this.html('#world-realtime-status', !account ? '로그인 필요' : view.status === 'auth-required' ? '다시 로그인' : view.status === 'connected' ? '연결됨' : view.status === 'reconnecting' ? '재연결 중' : view.status === 'connecting' ? '연결 중' : '오프라인');
    this.html('#world-chat-region', `${this.simulation.atlas.name} 채팅`);
    this.html('#world-realtime-count', `${view.players.length + (view.status === 'connected' ? 1 : 0)}명`);
    this.html('#world-chat-identity', escape(account?.username ?? '로그인 전'));
    this.input('#world-chat-input').disabled = needsLogin;
    this.input('#world-chat-input').placeholder = needsLogin ? '계정으로 채팅에 참여하세요' : `${account!.username} · Enter로 대화하기`;
    this.button('#world-chat-login').hidden = !needsLogin;
    this.button('#world-chat-login').textContent = account ? '다시 로그인' : '가입 / 로그인';
    this.button('#world-chat-send').hidden = needsLogin;
    this.host.querySelector<HTMLElement>('#world-realtime-status')!.title = view.ping === undefined ? '자동으로 연결합니다.' : `왕복 지연 ${Math.round(view.ping)}ms`;
    const dot = this.host.querySelector<HTMLElement>('#world-realtime-dot'); if (dot) dot.dataset.status = view.status;
    const position = this.simulation.player;
    const peers = view.players.map(player => ({ ...player, distance: Math.hypot(player.x - position.x, player.z - position.z), location: this.simulation.locationAt(player.x, player.z).name })).sort((a, b) => a.distance - b.distance);
    this.html('#world-player-list', peers.map(player => `<button data-remote-player="${escape(player.id)}" data-x="${player.x}" data-z="${player.z}"><img src="${pokemonSpriteUrl(player.speciesId)}" alt=""><span><b>${escape(player.name)}</b><small>${escape(player.location)} · ${Math.round(player.distance)}m · ${player.activity === 'battle' ? '배틀 중' : player.activity === 'moving' ? '이동 중' : '대기'}</small></span><i>↗</i></button>`).join('') || '<p class="world-chat-empty">이 지역에 다른 트레이너가 아직 없습니다.</p>');
    const tracked = peers.find(player => player.id === this.trackedPlayerId);
    const tracking = this.host.querySelector<HTMLElement>('#world-trainer-track')!;
    tracking.hidden = !this.trackedPlayerId;
    const direction = tracked ? ['북', '북동', '동', '남동', '남', '남서', '서', '북서'][(Math.round(Math.atan2(tracked.x - position.x, position.z - tracked.z) / (Math.PI / 4)) + 8) % 8] : '';
    this.html('#world-trainer-track', tracked ? `<button class="trainer-destination"><b>↗ ${escape(tracked.name)}</b><small>${escape(tracked.location)} · ${direction}쪽 ${Math.round(tracked.distance)}m</small></button><button data-stop-tracking aria-label="트레이너 위치 표시 해제">×</button>` : '<span>트레이너가 다른 지역으로 이동했거나 접속을 종료했습니다.</span><button data-stop-tracking aria-label="트레이너 위치 표시 해제">×</button>');
    const log = this.host.querySelector<HTMLElement>('#world-chat-log')!;
    const collapsed = this.host.querySelector('.social-dock')!.classList.contains('chat-collapsed');
    const followLatest = !collapsed && log.scrollHeight - log.clientHeight - log.scrollTop <= 8;
    const newest = view.history.at(-1)?.id;
    if (newest !== this.lastChatId) {
      if (this.lastChatId && !followLatest) this.unreadChats += Math.max(1, view.history.length - view.history.findIndex(message => message.id === this.lastChatId) - 1);
      this.lastChatId = newest;
    }
    this.html('#world-chat-log', view.history.map(message => `<p class="${message.playerId === view.id ? 'chat-own' : ''}"><b>${escape(message.name)}</b><span>${escape(message.text)}</span><time>${new Date(message.sentAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</time></p>`).join('') || '<p class="world-chat-empty">같은 지역의 트레이너에게 인사해 보세요.</p>');
    if (followLatest) requestAnimationFrame(() => { if (this.host?.contains(log)) log.scrollTop = log.scrollHeight; });
    if (followLatest) this.unreadChats = 0;
    this.button('#world-chat-latest').hidden = this.unreadChats === 0;
    this.html('#world-chat-latest', `새 메시지 ${this.unreadChats}개 ↓`);
    this.button('#world-chat-collapse').textContent = collapsed ? `채팅${this.unreadChats ? ` ${this.unreadChats}` : ''} 열기` : '접기';
    if (view.error && account) this.html('#world-chat-error', escape(view.error));
    else if (!account) this.html('#world-chat-error', '');
    else if (view.status === 'connected' && !this.input('#world-chat-input').value) this.html('#world-chat-error', '');
    const mapPeers = this.host.querySelector('#world-map-peers');
    if (mapPeers) this.html('#world-map-peers', this.mapPeers());
  }

  private setChatCollapsed(collapsed: boolean): void {
    if (!this.host) return;
    this.host.querySelector('.social-dock')!.classList.toggle('chat-collapsed', collapsed);
    const toggle = this.button('#world-chat-collapse');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? '채팅 열기' : '채팅 접기');
    toggle.textContent = collapsed ? '채팅 열기' : '접기';
    if (!collapsed) {
      if (this.compactViewport.matches) {
        this.host.querySelector<HTMLDetailsElement>('.world-battle-hud')!.open = false;
        this.host.querySelector<HTMLDetailsElement>('.world-explore-panel')!.open = false;
      }
      this.scrollChatToLatest();
    } else if (this.compactViewport.matches && this.host.querySelector('#world-chat-form')?.contains(document.activeElement)) toggle.focus();
  }

  private scrollChatToLatest(): void {
    this.unreadChats = 0; this.button('#world-chat-latest').hidden = true;
    requestAnimationFrame(() => { const log = this.host?.querySelector<HTMLElement>('#world-chat-log'); if (log) log.scrollTop = log.scrollHeight; });
  }

  private mapPeers(): string {
    return (this.multiplayer?.view.players ?? []).map(player => `<g class="map-trainer" data-map-player="${escape(player.id)}"><circle cx="${this.mapCoordinate(player.x)}" cy="${this.mapCoordinate(player.z)}" r="${player.id === this.trackedPlayerId ? 4 : 2.8}" fill="#45d7ec" stroke="#123c48" stroke-width=".7"/><title>${escape(player.name)} · ${escape(this.simulation.locationAt(player.x, player.z).name)}</title>${player.id === this.trackedPlayerId ? `<text x="${this.mapCoordinate(player.x) + 5}" y="${this.mapCoordinate(player.z) - 2}" fill="#123c48">${escape(player.name)}</text>` : ''}</g>`).join('');
  }

  refresh(): void {
    if (!this.host?.querySelector('#ow-host')) return;
    const game = this.options.game, world = this.simulation, battle = game.battle;
    if (battle && battle !== this.previousBattle) {
      if (!this.compactViewport.matches || world.controlMode === 'manual') this.host.querySelector<HTMLDetailsElement>('.world-battle-hud')!.open = true;
      playGameSound('encounter', { speciesId: battle.enemy.team[battle.enemy.activeIndex].speciesId });
    }
    this.previousBattle = battle;
    this.multiplayer?.update(this.presence());
    this.renderRealtime();
    const campaignTrainer = battle?.trainerId ? CAMPAIGN_TRAINERS.find(item => item.id === battle.trainerId) : undefined;
    const host = this.host.querySelector<HTMLElement>('#ow-host')!;
    host.dataset.runtime = 'gaesup-world'; host.dataset.graphId = this.options.graph.id;
    host.dataset.region = world.regionId;
    this.html('#world-region-label', world.atlas.name);
    this.html('#world-encounter-layout', world.regionId === 'johto' ? '야생 분포 · 크리스탈' : '야생 분포 · 레드');
    this.html('#world-map-caption', `${world.atlas.name} 지도 ↗`);
    this.html('#world-map-note', '방문한 마을로 무료 이동합니다. 도시 연결·지형·출현은 게임용으로 구성한 지도입니다.');
    for (const [id, value] of [['world-region', world.regionId]]) {
      const select = this.host.querySelector<HTMLSelectElement>(`#${id}`)!; if (select.value !== value) select.value = value;
      select.disabled = Boolean(battle || game.captureOffer);
    }
    host.dataset.tick = String(world.tick); host.dataset.paused = String(this.paused);
    const lead = battle ? battle.player.team[battle.player.activeIndex] : game.player.team.find(mon => mon.hp > 0) ?? game.player.team[0];
    const serverReceipt = lastServerDecision(lead.instanceId);
    this.html('#world-learning-label', serverReceipt ? `기술 학습 · ${serverReceipt.updates}회` : '기술 학습');
    this.html('.world-battle-hud > summary strong', `<span class="world-summary-name">${escape(lead.nickname)} · Lv.${lead.level}</span><span class="world-summary-hp">HP ${lead.hp} / ${lead.stats.hp}</span>`);
    const enemy = battle?.enemy.team[battle.enemy.activeIndex];
    const transformed = battle?.transformations?.[lead.instanceId];
    const species = getSpecies(transformed?.speciesId ?? lead.speciesId), moves = transformed?.moves ?? lead.moves;
    const xpStart = experienceAtLevel(lead.level, species.growthRate), xpEnd = experienceAtLevel(lead.level + 1, species.growthRate);
    const xp = Math.min(100, Math.max(0, (lead.xp - xpStart) / Math.max(1, xpEnd - xpStart) * 100));
    const card = (mon: Monster, label: string) => `<div class="world-combatant"><img src="${pokemonSpriteUrl(mon.speciesId)}" alt="${getSpecies(mon.speciesId).name}"><div class="world-combatant-copy"><small>${label} · Lv.${mon.level}</small><strong>${escape(mon.nickname)}</strong><div class="world-hp-row"><span>HP</span><b>${mon.hp} / ${mon.stats.hp}</b>${mon.status ? `<em>${mon.status}</em>` : ''}</div><div class="world-hp" role="meter" aria-label="${escape(mon.nickname)} HP" aria-valuemin="0" aria-valuemax="${mon.stats.hp}" aria-valuenow="${mon.hp}"><i style="width:${mon.hp / mon.stats.hp * 100}%"></i></div><span class="world-combatant-meta">스피드 ${mon.stats.speed} · 이동 ${movementSpeed(mon.speciesId, mon.level).toFixed(1)}m/s</span></div></div>`;
    this.html('#world-combatants', `${card(lead, '내 파트너')}${enemy ? card(enemy, `${battle!.kind === 'wild' ? '야생' : campaignTrainer?.name ?? '체육관'} · ${world.controlMode === 'manual' ? '수동' : '자동'} 배틀`) : `<div class="world-growth"><small>다음 레벨까지 ${Math.max(0, xpEnd - lead.xp)} EXP</small><div class="world-xp"><i style="width:${xp}%"></i></div><span>${species.moves.filter(move => move.level > lead.level).slice(0, 1).map(move => `Lv.${move.level} ${getMove(move.moveId).name} 습득`).join('') || '현재 레벨의 기술을 모두 익혔습니다.'}</span></div>`}`);
    const moveLayout = getMoveLayout({ ...lead, moves });
    this.button('#world-edit-moves').disabled = !!battle || !!game.captureOffer || !this.options.editMoves;
    this.html('#world-moves', Array.from({ length: 4 }, (_, index) => {
      const slot = moveLayout[index]; if (!slot) return `<div class="world-move empty-slot"><span>${index + 1}</span><strong>미습득</strong><small>레벨을 올려 기술을 익히세요</small></div>`;
      const move = getMove(slot.moveId);
      return `<button data-world-move="${slot.sourceIndex}" data-world-slot="${index}" data-world-move-id="${slot.moveId}" class="world-move type-${move.type}" ${!battle || slot.pp <= 0 ? 'disabled' : ''} title="${move.damageClass === 'physical' ? '물리' : move.damageClass === 'special' ? '특수' : '변화'} · 우선도 ${move.priority} · 클릭하면 다음 턴에 사용"><span>${index + 1} · ${types[move.type]} · 우선 ${move.priority}</span><strong>${move.name}</strong><small><span class="move-details">위력 ${move.power || '—'} · 명중 ${move.accuracy || '—'} · </span>PP ${slot.pp}/${move.pp} · ${battle ? '전투 종료 후 회복' : '자동 회복됨'}</small></button>`;
    }).join(''));
    this.html('#world-emergency-action', battle && !battle.awaitingSwitch && moves.every(slot => slot.pp <= 0) ? '<button id="world-struggle">발버둥 (PP 소진)</button>' : '');
    const location = this.simulation.locationAt(world.player.x, world.player.z);
    this.html('#world-biome', location.name);
    this.html('#world-location-short', location.name);
    const pool = regionalEncounters(location.id, getRegionalBadges(game, world.regionId), world.regionId, world.dayPeriod, world.sampleWorld(world.player.x, world.player.z).biome);
    const levels = regionalWildLevels(game, world.regionId, location);
    this.html('#world-explore-short', `${pool.length ? `Lv.${levels.minLevel}–${levels.maxLevel}` : '마을'} · 설정`);
    host.dataset.scene = world.sceneId;
    this.html('#world-zone-level', pool.length ? `야생 Lv.${levels.minLevel}–${levels.maxLevel} · ${pool.slice(0, 3).map(id => getSpecies(id).name).join(' · ')}` : '도시와 길을 따라 다음 구역으로 탐험하세요');
    this.html('#world-position', `${world.player.x.toFixed(0)}, ${world.player.z.toFixed(0)}`);
    const collectionSpecies = new Set(getPlayableSpeciesIds(world.atlas.defaultVersion));
    this.html('#world-objective', `${game.dex.caught.filter(id => collectionSpecies.has(id)).length} / ${collectionSpecies.size}종 · 전체 ${game.dex.caught.filter(isPlayableSpecies).length}종`);
    this.html('#world-feed', game.logs.slice(-3).map(log => `<p>${escape(log)}</p>`).join(''));
    this.html('#world-battle-state', game.captureOffer ? '승리! 포획 여부를 선택하세요' : battle ? `${battle.awaitingSwitch ? '다음 파트너로 자동 교대 중' : world.escaping ? '도망 시도 중' : world.controlMode === 'manual' ? (battle.canRun ? '기술 선택 · 이동키로 도주' : '기술 선택 대기') : '자동 배틀'} · 턴 ${battle.turn}` : !world.hasBalls ? '볼 소진 · 구매 후 자동 사냥 가능' : this.paused ? '탐험 일시 정지' : world.controlMode === 'manual' ? '수동 탐험 · 배틀 버튼으로만 전투' : world.autoHunt ? '자동 추적 · 접근하면 배틀' : '접근하면 자동 배틀');
    this.button('#world-mode-auto').setAttribute('aria-pressed', String(world.controlMode === 'auto'));
    this.button('#world-mode-manual').setAttribute('aria-pressed', String(world.controlMode === 'manual'));
    this.html('#world-control-title', world.controlMode === 'manual' ? '수동 이동' : '자동 이동 · 배틀');
    this.html('#world-control-help', world.controlMode === 'manual' ? (battle || game.captureOffer ? '기술 1–4 · M 전환' : '3초간 이동 입력이 없으면 자동') : world.autoHunt ? '대상 자동 선택·추적' : '이동만 자동');
    this.html('#world-ball-stock', `몬스터볼 ${game.inventory['poke-ball']}개 · ₩${game.player.money.toLocaleString('ko-KR')}`);
    this.html('#world-team-count', String(game.player.team.length));
    this.html('#world-shop-items', SHOP_ITEMS.map(item => `<div><strong>${ITEM_LABELS[item]} <small>보유 ${game.inventory[item]}개 · 개당 ₩${ITEM_PRICES[item].toLocaleString('ko-KR')}</small></strong>${[1, 5].map(quantity => { const total = ITEM_PRICES[item] * quantity, reason = game.player.money < total ? `₩${(total - game.player.money).toLocaleString('ko-KR')} 부족` : ''; return `<button data-world-buy="${item}" data-quantity="${quantity}" ${reason ? `disabled title="${reason}"` : ''}>${quantity}개 · ₩${total.toLocaleString('ko-KR')}${reason ? `<small>${reason}</small>` : ''}</button>`; }).join('')}</div>`).join(''));
    this.html('#world-shop-note', `몬스터볼 30초마다 +1 · 기본 보충 한도 20개 · 다음 ${Math.ceil(30 - (game.ballRefillSeconds ?? 0))}초. ` + (game.player.money < Math.min(...SHOP_ITEMS.map(item => ITEM_PRICES[item])) ? '소지금이 부족합니다. 배틀에서 이기면 상금을 받습니다.' : '배틀 중에도 구매와 박스 관리를 할 수 있습니다.'));
    this.host.querySelectorAll<HTMLButtonElement>('[data-world-buy]').forEach(button => button.onclick = () => { const item = button.dataset.worldBuy as InventoryItem, quantity = Number(button.dataset.quantity), total = ITEM_PRICES[item] * quantity; try { buyItem(game, item, quantity); this.options.notify(`${ITEM_LABELS[item]} ${quantity}개 · ₩${total.toLocaleString('ko-KR')} 구매 완료`); this.options.changed(); this.refresh(); } catch (error) { this.options.notify(String(error), true); } });
    const offer = game.captureOffer, offerNode = this.host.querySelector<HTMLElement>('#world-capture-offer')!;
    offerNode.hidden = !offer;
    if (offer) {
      this.html('#world-capture-offer', `<img src="${pokemonSpriteUrl(offer.speciesId)}" alt=""><div><small>배틀 승리 · Lv.${offer.level}</small><strong>${escape(offer.nickname)}을(를) 잡을까요?</strong><p>볼 1개로 확정 포획 · ${game.player.team.length < 6 ? '팀에 합류' : '박스로 이동'}</p><button id="world-win-catch">볼 1개로 잡기</button><button id="world-win-release">놓아주고 계속</button></div>`);
      this.button('#world-win-catch').onclick = () => this.catchVictory();
      this.button('#world-win-release').onclick = () => { world.releaseVictory(); this.options.changed(); this.refresh(); };
    }
    const region = world.regionId as 'kanto' | 'johto';
    const badges = getRegionalBadges(game, region);
    const gym = getCampaignGyms(game, region).find(item => item.locationId === location.id);
    const trainer = getNextCampaignTrainer(game, region);
    const localTrainer = badges >= 8 && trainer?.locationId === location.id ? trainer : undefined;
    const cave = getCaveScene(world.sceneId), portal = cave ? cavePortalAtInterior(world.sceneId, world.player.x, world.player.z) : cavePortalAtSurface(region, world.player.x, world.player.z);
    const challenge = gym ? `<button id="world-gym-challenge" ${battle || offer || gym.badge !== badges + 1 ? 'disabled' : ''}>${gym.name} · Lv.${gym.level} ${badges >= gym.badge ? '클리어 ✓' : '도전'}</button><small>${region === 'johto' ? '성도' : '관동'} 배지 ${badges}/8${gym.badge > badges + 1 ? ' · 앞 체육관부터 도전하세요' : ''}</small>` : localTrainer ? `<button id="world-trainer-challenge" ${battle || offer ? 'disabled' : ''}>${escape(localTrainer.name)} · 도전</button><small>${localTrainer.team.map(([id, level]) => `${getSpecies(id).name} Lv.${level}`).join(' · ')}</small>` : '';
    this.html('#world-gym', challenge + (portal ? `<button id="world-cave-enter" ${battle || offer ? 'disabled' : ''}>${cave ? `${escape(cave.name)} · 밖으로 나가기` : '동굴 들어가기'}</button>` : ''));
    if (gym) this.button('#world-gym-challenge').onclick = () => { if (world.challengeLocalGym()) { this.options.changed(); this.refresh(); } };
    if (!gym && localTrainer) this.button('#world-trainer-challenge').onclick = () => { if (world.challengeLocalTrainer()) { this.options.changed(); this.refresh(); } };
    if (portal) {
      this.button('#world-cave-enter').onclick = () => { if (world.traverseCavePortal()) { this.multiplayer?.join(this.presence()); this.options.changed(); this.refresh(); } };
    }
    const respawns = world.respawnQueue;
    this.html('#world-respawn', respawns.length ? `${respawns.length}마리 리젠 대기 · ${Math.ceil(Math.min(...respawns.map(spawn => spawn.remainingSeconds)))}초` : '');
    this.button('#world-catch').disabled = !offer && battle?.kind !== 'wild';
    this.button('#world-potion').disabled = !battle || game.inventory.potion <= 0 || lead.hp <= 0 || lead.hp >= lead.stats.hp;
    this.button('#world-run').disabled = !battle?.canRun;
    this.button('#world-heal').disabled = Boolean(battle);
    this.button('#world-engage').disabled = Boolean(battle || offer);
    this.button('#world-pause').textContent = this.paused ? '▶ 계속 탐험' : 'Ⅱ 일시 정지';
    this.input('#world-auto-catch').checked = world.autoCapture;
    this.input('#world-auto-hunt').checked = world.autoHunt;
    this.input('#world-auto-hunt').disabled = !world.hasBalls;
    this.input('#world-exp-share').checked = game.experienceShare !== false;
    const ledger = world.rewardLedgers[lead.instanceId], signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
    const rewardNames = { engagement: '조우', damageDealt: '공격', damageReceived: '피해', typeChoice: '상성', outcome: '승패', growth: '레벨 성장', evolution: '진화' };
    this.html('#world-rewards', ledger ? `<strong>누적 ${signed(ledger.lifetime.total)} · ${ledger.lifetime.events}회</strong><p>${Object.entries(rewardNames).map(([key, label]) => `${label} ${signed(ledger.lifetime.componentTotals[key as keyof typeof rewardNames])}`).join(' · ')}</p><small>최근: ${ledger.latest.at(-1)?.learningEligible ? '자동 행동 학습 반영' : '관찰 기록 · 가중치 갱신 없음'}</small>` : '<p>배틀과 성장 결과가 이 개체의 기록에 쌓입니다.</p>');
    const target = world.entities.find(entity => entity.id === world.selectedWildId && entity.kind === 'wild'), targetNode = this.host.querySelector<HTMLElement>('#world-target')!;
    targetNode.hidden = !target || !world.selectionPinned || Boolean(battle || offer);
    if (target && !targetNode.hidden) {
      const info = getSpecies(target.speciesId), distance = Math.hypot(target.x - world.player.x, target.z - world.player.z), targetHp = statsFor(info, target.level).hp;
      this.html('#world-target-info', `<strong>${escape(info.name)} · Lv.${target.level}</strong><small><b>${world.trackingSelected ? '추적 중' : '선택됨'}</b> · ${distance.toFixed(1)}m · HP ${targetHp} / ${targetHp}</small>`);
      this.html('#world-target-detail', `${info.types.map(type => types[type]).join(' / ')} · 이동 ${movementSpeed(target.speciesId, target.level).toFixed(1)}m/s`);
      this.button('#world-target-battle').textContent = world.canEngageWild(target.id) ? '배틀' : '접근 후 배틀';
    }
    const nearby = world.visibleEntities(12).filter(entity => entity.kind === 'wild').map(entity => ({ entity, distance: Math.hypot(entity.x - world.player.x, entity.z - world.player.z) })).sort((a, b) => a.distance - b.distance);
    const list = this.host.querySelector<HTMLElement>('#world-nearby')!, nearbyIds = new Set(nearby.map(({ entity }) => entity.id));
    for (const button of list.querySelectorAll<HTMLButtonElement>('[data-world-wild]')) if (!nearbyIds.has(button.dataset.worldWild!)) button.remove();
    for (const { entity, distance } of nearby) {
      let button = list.querySelector<HTMLButtonElement>(`[data-world-wild="${entity.id}"]`);
      if (!button) { button = document.createElement('button'); button.dataset.worldWild = entity.id; list.append(button); }
      button.classList.toggle('selected', world.selectedWildId === entity.id);
      const content = `<img src="${pokemonSpriteUrl(entity.speciesId)}" alt=""><span>${getSpecies(entity.speciesId).name}<small>Lv.${entity.level} · ${distance.toFixed(0)}m</small></span><b>↗</b>`;
      if (this.htmlCache.get(button) !== content) { button.innerHTML = content; this.htmlCache.set(button, content); }
    }
    this.minimap(); this.renderer?.update();
  }

  private drawRegionMap(): void {
    const world = this.simulation, scale = (n: number) => this.mapCoordinate(n);
    const cave = getCaveScene(world.sceneId);
    if (cave) {
      this.html('#world-map-region-name', `${world.atlas.name} · ${cave.name}`);
      this.html('#world-campaign-guide', `<p><b>${escape(cave.name)}</b> · 출구까지 통로를 따라 이동하세요.</p>`);
      this.html('#world-travel', '');
      const extent = Math.max(cave.width, cave.depth) + 4;
      this.html('#world-map-content', `<svg viewBox="0 0 240 240" role="img" aria-label="${escape(cave.name)} 내부 지도"><rect width="240" height="240" rx="8" fill="#a7b3a5"/>${cave.wallSegments.map(wall => `<rect x="${scale(wall.x - wall.width / 2)}" y="${scale(wall.z - wall.depth / 2)}" width="${wall.width / extent * 240}" height="${wall.depth / extent * 240}" fill="#334a44"/>`).join('')}${cave.portals.map(portal => `<g><circle cx="${scale(portal.interior.x)}" cy="${scale(portal.interior.z)}" r="4" fill="#ffc976"/><text x="${scale(portal.interior.x) + 5}" y="${scale(portal.interior.z) - 5}" fill="#20382e">출구</text></g>`).join('')}<g id="world-map-peers">${this.mapPeers()}</g><circle cx="${scale(world.player.x)}" cy="${scale(world.player.z)}" r="4" fill="#e04f45" stroke="white"/></svg>`);
      return;
    }
    const region = world.regionId as 'kanto' | 'johto';
    const game = this.options.game, badges = getRegionalBadges(game, region);
    const gyms = getCampaignGyms(game, region), nextGym = gyms.find(gym => gym.badge === badges + 1);
    const trainer = badges >= 8 ? getNextCampaignTrainer(game, region) : undefined;
    const destinationId = trainer?.locationId ?? nextGym?.locationId;
    const destination = destinationId ? world.atlas.locations.find(item => item.id === destinationId) : undefined;
    const nextLabel = trainer ? `${trainer.kind === 'red' ? '최종 도전' : trainer.kind === 'champion' ? '챔피언전' : '사천왕전'} · ${trainer.name}` : nextGym ? `${nextGym.badgeName} · ${nextGym.name}` : '이 지역의 주요 도전을 완료했습니다.';
    this.html('#world-map-region-name', `${world.atlas.englishName.toUpperCase()} REGION`);
    const destinationGuide = destination ? destination.kind === 'town'
      ? ` · ${world.visitedTownIds.includes(destination.id) ? '방문한 마을로 순간이동할 수 있습니다.' : '길을 따라 방문하면 순간이동 거점으로 등록됩니다.'}`
      : ' · 인접한 길을 따라 도보로 도달하세요.' : '';
    this.html('#world-campaign-guide', `<div><span>${region === 'johto' ? '성도' : '관동'} 진행</span><strong>배지 ${badges}/8</strong></div><p><b>다음 도전</b> ${escape(nextLabel)}</p><p><b>목적지</b> ${escape(destination?.name ?? '—')}${destinationGuide}</p>`);
    this.html('#world-travel', this.simulation.atlas.locations.filter(item => item.kind === 'town').map(item => `<button data-world-travel="${item.id}" ${!world.visitedTownIds.includes(item.id) || game.battle || game.captureOffer ? 'disabled' : ''}>${item.name}<small>${world.visitedTownIds.includes(item.id) ? '순간이동' : '미방문'}</small></button>`).join(''));
    this.host!.querySelectorAll<HTMLButtonElement>('[data-world-travel]').forEach(button => button.onclick = () => { if (world.teleportToTown(button.dataset.worldTravel!)) { this.host!.querySelector<HTMLDialogElement>('#world-map-dialog')!.close(); this.options.notify('안전한 마을 입구로 이동했습니다.'); this.options.changed(); this.refresh(); } });
    const lines = this.simulation.atlas.connections.map(([from, to]) => { const a = this.simulation.atlas.locations.find(item => item.id === from)!, b = this.simulation.atlas.locations.find(item => item.id === to)!; return `<line x1="${scale(a.x)}" y1="${scale(a.z)}" x2="${scale(b.x)}" y2="${scale(b.z)}"/>`; }).join('');
    const towns = this.simulation.atlas.locations.filter(item => item.kind === 'town' || item.kind === 'special').map(item => `<g><circle cx="${scale(item.x)}" cy="${scale(item.z)}" r="2.8"/><text x="${scale(item.x) + 4}" y="${scale(item.z) - 3}">${item.name}</text></g>`).join('');
    this.html('#world-map-content', `<svg viewBox="0 0 260 240" role="img" aria-label="${world.atlas.name} 도시 연결 지도"><rect width="260" height="240" rx="8" fill="#bed5c0"/><g stroke="#faf1ce" stroke-width="3" fill="none">${lines}</g><g fill="#35594a">${towns}</g><g id="world-map-peers">${this.mapPeers()}</g>${destination ? `<circle cx="${scale(destination.x)}" cy="${scale(destination.z)}" r="5" fill="#f5c542" stroke="#5b4313"/><text x="${scale(destination.x) + 6}" y="${scale(destination.z) + 7}">다음</text>` : ''}<circle cx="${scale(world.player.x)}" cy="${scale(world.player.z)}" r="4" fill="#e04f45" stroke="white"/><text x="8" y="16">N ↑ · 빨간 점: 내 위치 · 노랑: 목적지 · 하늘색: 트레이너</text></svg><div class="kanto-zone-list">${this.simulation.atlas.locations.map(item => { const levels = regionalWildLevels(game, region, item), encounterIds = regionalEncounters(item.id, getRegionalBadges(game, region), region); return `<div class="${this.simulation.locationAt(world.player.x, world.player.z).id === item.id ? 'current' : ''}${destination?.id === item.id ? ' destination' : ''}"><strong>${item.name}${destination?.id === item.id ? ' · 다음 목적지' : ''}</strong><small>${encounterIds.length ? `Lv.${levels.minLevel}–${levels.maxLevel} · ${encounterIds.slice(0, 4).map(id => getSpecies(id).name).join(' / ')}` : '마을 · 연결 거점'}${item.requiredBadges ? ` · 배지 ${item.requiredBadges}개` : ''}</small></div>`; }).join('')}</div>`);
  }

  private minimap(): void {
    const canvas = this.host?.querySelector<HTMLCanvasElement>('#world-minimap'); if (!canvas) return;
    const ctx = canvas.getContext('2d')!, size = canvas.width;
    if (!this.miniTerrain || this.miniRegion !== this.simulation.sceneId) {
      this.miniTerrain = document.createElement('canvas'); this.miniTerrain.width = size; this.miniTerrain.height = size;
      this.miniRegion = this.simulation.sceneId;
      this.drawMinimapTerrain(this.miniTerrain.getContext('2d')!, size);
    }
    ctx.drawImage(this.miniTerrain, 0, 0);
    for (const entity of this.simulation.entities) { ctx.fillStyle = entity.id === this.simulation.selectedWildId ? '#fff0a1' : '#faf2dc'; ctx.beginPath(); ctx.arc(this.mapCoordinate(entity.x, size), this.mapCoordinate(entity.z, size), 2.5, 0, Math.PI * 2); ctx.fill(); }
    for (const player of this.multiplayer?.view.players ?? []) {
      ctx.fillStyle = '#45d7ec'; ctx.strokeStyle = '#103b48'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(this.mapCoordinate(player.x, size), this.mapCoordinate(player.z, size), player.id === this.trackedPlayerId ? 4 : 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = '#e0543e'; ctx.strokeStyle = '#fff8dd'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(this.mapCoordinate(this.simulation.player.x, size), this.mapCoordinate(this.simulation.player.z, size), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }

  private drawMinimapTerrain(ctx: CanvasRenderingContext2D, size: number): void {
    const colors = { meadow: '#88a565', forest: '#345d42', lake: '#69adb3', rock: '#ac9f85' };
    const cave = getCaveScene(this.simulation.sceneId), extent = cave ? Math.max(cave.width, cave.depth) + 4 : WORLD_MAX - WORLD_MIN;
    for (let x = 0; x < size; x += 3) for (let z = 0; z < size; z += 3) {
      const sample = this.simulation.sampleWorld(x / size * extent - extent / 2, z / size * extent - extent / 2);
      ctx.fillStyle = cave ? sample.blocked ? '#334a44' : '#a7b3a5' : colors[sample.biome]; ctx.fillRect(x, z, 3, 3);
    }
    if (cave) { for (const portal of cave.portals) { ctx.fillStyle = '#ffd189'; ctx.fillRect(this.mapCoordinate(portal.interior.x, size) - 2, this.mapCoordinate(portal.interior.z, size) - 2, 4, 4); } return; }
    ctx.strokeStyle = '#efe4bb'; ctx.lineWidth = 2;
    for (const [from, to] of this.simulation.atlas.connections) { const a = this.simulation.atlas.locations.find(item => item.id === from)!, b = this.simulation.atlas.locations.find(item => item.id === to)!; ctx.beginPath(); ctx.moveTo(this.mapCoordinate(a.x, size), this.mapCoordinate(a.z, size)); ctx.lineTo(this.mapCoordinate(b.x, size), this.mapCoordinate(b.z, size)); ctx.stroke(); }
    for (const location of this.simulation.atlas.locations.filter(item => item.kind === 'town')) { ctx.fillStyle = '#b05946'; ctx.fillRect(this.mapCoordinate(location.x, size) - 2, this.mapCoordinate(location.z, size) - 2, 4, 4); }
  }
  private mapCoordinate(value: number, size = 240): number {
    const cave = getCaveScene(this.simulation.sceneId), extent = cave ? Math.max(cave.width, cave.depth) + 4 : WORLD_MAX - WORLD_MIN;
    return (value + extent / 2) / extent * size;
  }
  private html(selector: string, value: string): void { const node = this.host?.querySelector(selector); if (node && this.htmlCache.get(node) !== value) { node.innerHTML = value; this.htmlCache.set(node, value); } }
  private button(selector: string): HTMLButtonElement { return this.host!.querySelector(selector)!; }
  private input(selector: string): HTMLInputElement { return this.host!.querySelector(selector)!; }
  unmount(): void { window.removeEventListener('keydown', this.hotkeys); this.compactViewport.removeEventListener('change', this.onViewportChange); this.multiplayer?.close(); this.multiplayer = undefined; this.renderer?.destroy(); this.renderer = undefined; this.host = undefined; this.ready = false; }
}
