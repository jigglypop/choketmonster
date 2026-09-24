import type { Graph } from '../core/brain';
import { getMove, getSpecies } from '../data/pokemon';
import { fieldTrainersAt, getFieldTrainer } from '../data/field-trainers';
import { pokemonModelUrl, pokemonSpriteUrl } from '../game/assets';
import { getMoveLayout } from '../game/move-layout';
import { battleMonsterMaxHp, battleMoveView, experienceAtLevel, FIELD_ITEMS, firstUsableRegionalTeamIndex, heal, HEALING_ITEM_HP, HELD_TOOL_DESCRIPTIONS, ITEM_LABELS, statsFor, type BattleTurnResult, type GameState, type HeldTool, type Monster } from '../game/engine';
import { isCampaignRegion, monsterRegionalUseReason, REGIONAL_STARTERS } from '../game/regional-policy';
import { CAMPAIGN_TRAINERS, campaignEntryReason, campaignTravelReason, getCampaignGyms, getNextCampaignTrainer, getRegionalBadges, type CampaignRegion } from '../game/campaign';
import { getWorldAtlas } from './atlas';
import { progressionRequirement } from './progression-gates';
import { PLAYABLE_WORLDS } from './availability';
import type { FieldPolicy } from '../game/field';
import { movementSpeed, OpenWorldSimulation, PORTAL_WALK_RADIUS, type OpenWorldSnapshot } from './simulation';
import { lastServerDecision } from '../game/server-brain';
import { mountOpenWorld } from './view';
import { createWorldLoading, type LoadingScreen } from '../ui/loading-screen';
import type { OpenWorldRenderSnapshot, OpenWorldView, WorldCreature, WorldHeading, WorldMoveEffect, WorldPoint } from './types';
import './panel.css';
import { atlasMapProjection, cachedAtlasTerrain, placeMapLabels, prepareAtlasTerrain } from './map-terrain';
import { filterMapLocations, mapLocationDetails, mapLocationList, type MapFilter } from './map-explorer';
import './map-explorer.css';
import './world-bag.css';
import './trainer-battles.css';
import './regional-starter.css';
import { showGymVictory } from '../ui/gym-victory';
import { openMachineDialog } from '../ui/machine-dialog';
import { statusLabel } from '../game/status-labels';
import { pokemonWorldDisplayHeight } from './visual-scale';
import { MultiplayerSession } from './multiplayer';
import { playGameSound } from '../audio';
import { currentAccount } from '../game/account';
import { WORLD_MIN, WORLD_MAX } from './world-space';
import { getCaveScene, cavePortalAtSurface, cavePortalAtInterior, caveStairsAt, dungeonEntrance } from './caves';
import { getGymScene, gymSceneId, LEAGUE_LOCATION_IDS, leagueSceneId, onGymCourt, type GymScene } from './gym-scenes';
import { gymTeam } from '../game/gym-teams';
import { technicalMachines } from '../game/technical-machines';
import { nextDestinationGuide, regionalItinerary, type DestinationGuide } from './next-destination';
import { pokemonPresentation, battleTransformationsHtml, combatFormSprite, fieldMegaForm } from '../ui/pokemon-presentation';
import { getAlolaCombatForm, getCombatForm } from '../data/pokemon-combat-forms';
import { getPokemonFormModelSource } from '../data/pokemon-form-models';
import { CARDINAL_CAMERA_HEADINGS, cameraMapRotation, compassLabel, mapKindSymbol, nearestMapOrientation, rotateMapPoint, unrotateMapPoint, type MapOrientation } from './map-presentation';

const types: Record<string, string> = { normal: '노말', fire: '불꽃', water: '물', grass: '풀', electric: '전기', ice: '얼음', fighting: '격투', poison: '독', ground: '땅', flying: '비행', psychic: '에스퍼', bug: '벌레', rock: '바위', ghost: '고스트', dragon: '드래곤', steel: '강철', dark: '악', fairy: '페어리' };
const escape = (text: unknown) => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const pokemonDisplayHeight = (speciesId: number) => pokemonWorldDisplayHeight(getSpecies(speciesId).heightMeters);
const MANUAL_IDLE_SECONDS = .25;
type Options = { game: GameState; graph: Graph; policy: FieldPolicy; checkpoint?: OpenWorldSnapshot; learning(): boolean; setLearning(value: boolean): void; musicChanged?(): void; editMoves?(instanceId: string): void; trade?(): void; openAccount?(): void; notify(message: string, error?: boolean): void; changed(immediate?: boolean): void | Promise<void> };

export class OpenWorldPanel {
  readonly simulation: OpenWorldSimulation;
  private renderer?: OpenWorldView;
  private layoutObserver?: ResizeObserver;
  private host?: HTMLElement;
  private ready = false;
  private loading?: LoadingScreen;
  private loadProgress = 0;
  private attacks = new Map<string, { start: number; end: number; type: string }>();
  /** Move names above nameplates, target flinches and move effects, keyed by battler instance. */
  private cues = new Map<string, { key: string; text: string; moveType: string; start: number; end: number }>();
  private hurts = new Map<string, { start: number; end: number }>();
  private effects: WorldMoveEffect[] = [];
  private cueSerial = 0;
  private tickPending = false;
  private manualIdleSeconds = 0;
  private manualMovementActive = false;
  private serverRequest?: Promise<void>;
  private recoveryError?: { message: string; source: 'server' | 'world' };
  private recovering = false;
  private readonly onConnectionRestored = () => {
    if (this.recoveryError?.source === 'server') void this.resume();
    this.renderer?.retryModels();
  };
  private multiplayer?: MultiplayerSession;
  private movingUntil = 0;
  private trackedPlayerId?: string;
  private lastChatId?: string;
  private unreadChats = 0;
  private lastMovementRefresh = -Infinity;
  private readonly compactViewport = window.matchMedia('(max-width: 900px), (max-height: 600px)');
  private readonly onViewportChange = () => {
    this.setChatCollapsed(this.compactViewport.matches);
    if (this.compactViewport.matches) this.host?.querySelector<HTMLDetailsElement>('.world-battle-hud')?.removeAttribute('open');
  };
  private miniTerrain?: HTMLCanvasElement;
  private miniRegion?: string;
  private mapProjection?: (x: number, z: number) => { x: number; y: number };
  private terrainAtlas?: unknown;
  private minimapSize: 'small' | 'medium' | 'large' = 'medium';
  private cameraHeading = Math.PI;
  private mapView = { sceneId: '', zoom: 1, centerX: 120, centerY: 120 };
  private mapDrag?: { pointerId: number; x: number; y: number; moved: boolean };
  private suppressMapClick = false;
  private mapQuery = '';
  private mapFilter: MapFilter = 'all';
  private mapSelection = '';
  /** Last town marker tap on the map; a second tap on it within 450 ms is a double tap. */
  private lastMapTap?: { id: string; at: number };
  /** A gym whose building was clicked; the player walks to the door and goes in on arrival. */
  private pendingGymEntry?: string;
  /** A dungeon entrance whose building was clicked; the player walks to the door and goes in on arrival. */
  private pendingDungeonEntry?: string;
  /** Walking back onto the doorway just used waits until this time. */
  private portalCooldownUntil = 0;
  /** Set once the partner has stepped off every doorway, so arriving or loading on one never bounces straight through. */
  private portalArmed = false;
  /** A gym or league location without a hall; arriving there starts the battle on the field. */
  private pendingFieldChallenge?: string;
  private bagTab: 'tools' | 'machines' = 'tools';
  private previousBattle?: GameState['battle'];
  private guideCache?: { key: string; guide: DestinationGuide };
  private starterDialog?: HTMLDialogElement;
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
    this.simulation.requireReadyModels();
    host.innerHTML = `<section class="adventure" aria-label="오픈월드 모험">
      <div id="ow-host"></div>
      <section id="world-recovery" class="world-recovery" aria-label="탐험 상태" hidden><p id="world-recovery-message" aria-live="polite"></p><div><button id="world-resume">계속 탐험</button><button id="world-model-retry" hidden>모델 다시 불러오기</button></div></section>
      <details class="world-explore-panel"><summary class="world-explore-toggle"><div><strong id="world-location-short">성도</strong><small id="world-explore-short">성도</small></div><i>⌄</i></summary><div class="world-explore-scroll">
      <div class="world-tools"><button id="world-pause">Ⅱ 일시 정지</button><button id="world-heal">캠프 회복</button></div>
      <button id="world-trainer-open" class="world-trainer-open">트레이너 배틀</button>
      <fieldset class="world-automation"><legend>자동 설정</legend><label><input id="world-auto-catch" type="checkbox" checked><span>자동 포획</span></label><label title="건강한 팀원 모두 같은 경험치"><input id="world-exp-share" type="checkbox" checked><span>팀 경험치 공유</span></label><label><input id="world-learning" type="checkbox" checked><span id="world-learning-label">기술 학습</span></label></fieldset>
      <div class="world-control-mode" role="group" aria-label="조작 모드"><div class="world-mode-buttons"><button id="world-mode-auto">자동</button><button id="world-mode-manual">수동</button></div><div class="world-control-copy"><strong id="world-control-title"></strong><small id="world-control-help"></small></div></div>
      <div class="world-gym" id="world-gym"></div>
      </div></details>
      <aside class="world-radar" data-size="${this.minimapSize}"><button id="world-map-open" aria-label="지역 전체 지도 열기"><span class="world-minimap-frame"><canvas id="world-minimap" width="180" height="180" aria-label="카메라 방향으로 회전하는 월드 지도"></canvas><b id="world-minimap-heading" aria-hidden="true">북</b></span></button><div class="world-minimap-controls" role="group" aria-label="미니맵 크기"><button id="world-minimap-smaller" type="button" aria-label="미니맵 축소" ${this.minimapSize === 'small' ? 'disabled' : ''}>−</button><span id="world-minimap-size">${this.minimapSize === 'small' ? '작게' : this.minimapSize === 'large' ? '크게' : '보통'}</span><button id="world-minimap-larger" type="button" aria-label="미니맵 확대" ${this.minimapSize === 'large' ? 'disabled' : ''}>＋</button></div><span id="world-position"></span><small id="world-map-caption">지역 지도 ↗</small><details class="world-bag" id="world-bag"><summary aria-label="도구 목록"><span>도구</span><b id="world-bag-count">0</b></summary><div class="world-bag-panel" id="world-bag-content"></div></details></aside>
      <button id="world-next-guide" class="world-next-guide" aria-label="다음 목적지 길안내" aria-expanded="false"></button>
      <button id="world-gym-notice" class="world-gym-notice" hidden></button>
      <div id="world-cave-exits" class="world-cave-exits" hidden></div>
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
            <div id="world-combatants"></div><div id="world-moves" class="world-moves"></div><div id="world-transformations"></div><button id="world-edit-moves" class="world-edit-moves">특성 · 도구 · 기술 배치</button><div id="world-emergency-action"></div>
            <details class="world-switch"><summary>포켓몬 교체</summary><div id="world-switch-options"></div></details>
            <div class="world-battle-actions"><button id="world-catch" disabled>몬스터볼 ∞</button><button id="world-potion" disabled>상처약</button><button id="world-super-potion" disabled>좋은상처약</button><button id="world-run" disabled>도망</button><span id="world-battle-state">자동 배틀 대기</span></div>
            <details class="world-rewards"><summary>이 개체의 보상 기록</summary><div id="world-rewards"></div><small>게임에서 설계한 보상이며 생물학적 학습의 증거가 아닙니다.</small></details>
          </div>
        </details>
      </div>
      <section class="world-capture-offer" id="world-capture-offer" aria-label="승리 후 포획" hidden></section>
      <dialog class="kanto-map-dialog" id="world-map-dialog"><header><div><small id="world-map-region-name">KANTO REGION</small><h2>지도 · 길찾기</h2></div><button id="world-map-close">닫기 ✕</button></header><div class="world-map-toolbar"><div class="world-region-picker"><label for="world-region">여행할 지역</label><select id="world-region">${PLAYABLE_WORLDS.map(region => `<option value="${region.id}">${region.name}</option>`).join('')}</select></div><fieldset id="world-map-orientation"><legend>카메라 방향</legend>${(['north','east','south','west'] as const).map(direction => `<button type="button" data-map-orientation="${direction}">${compassLabel(direction)}</button>`).join('')}</fieldset><div class="world-map-zoom" role="group" aria-label="지도 확대와 축소"><button id="world-map-zoom-out" type="button" aria-label="지도 축소">−</button><button id="world-map-reset" type="button">초기화</button><button id="world-map-zoom-in" type="button" aria-label="지도 확대">＋</button></div></div><section id="world-campaign-guide" class="world-campaign-guide" aria-label="지역 진행"></section><p id="world-map-note">방문한 마을로 무료 이동합니다. 지도 지점은 통행 가능한 경우 걸어서 이동합니다.</p><details class="map-travel-fold"><summary>순간이동</summary><div id="world-travel"></div></details><div id="world-map-searchbar" class="world-map-searchbar"><input id="world-map-search" type="search" placeholder="지역 · 포켓몬 · 도구 검색" aria-label="지역 · 포켓몬 · 도구 검색"><select id="world-map-filter" aria-label="지도 분류"><option value="all">전체</option><option value="items">도구 획득처</option><option value="town">마을</option><option value="cave">동굴</option><option value="unvisited">미방문 마을</option></select></div><div id="world-map-content"></div></dialog>
      <dialog class="world-trainer-dialog" id="world-trainer-dialog" aria-labelledby="world-trainer-title"><header><div><small>TRAINER BATTLE</small><h2 id="world-trainer-title">트레이너 배틀</h2></div><button id="world-trainer-close">닫기</button></header><p id="world-trainer-description"></p><div id="world-trainer-list"></div></dialog>
      <div class="world-feed" id="world-feed" aria-live="polite"></div>
      <div class="world-respawn" id="world-respawn"></div>
      <details class="world-method"><summary>회로와 게임 규칙</summary><p>브라우저 MaleCNS 실측 부분 회로 ${this.options.graph.nodes.length} 뉴런 · ${this.options.graph.edges.length.toLocaleString()} 연결. 전체 회로가 연결된 배틀은 서버에서 계산하고 반환된 개체 기억은 이 기기에 저장합니다. 감각 입력·행동 대응·학습 보상·월드 속도는 게임을 위해 설계했습니다. 자동 모드에서 추적 대상이 없으면 통행 가능한 탐험 목적지를 게임 규칙으로 정하고, 회로가 이동 방향을 선택합니다.</p></details>
    </section>`;
    const layoutSizes: Array<[string, string, 'height' | 'width']> = [['.world-radar', '--world-radar-height', 'height'], ['.world-radar', '--world-radar-width', 'width'], ['#world-next-guide', '--world-guide-height', 'height'], ['#world-gym-notice', '--world-gym-notice-height', 'height'], ['.world-battle-hud', '--world-partner-height', 'height'], ['.world-explore-toggle', '--world-explore-toggle-height', 'height'], ['.social-dock', '--world-chat-height', 'height']];
    this.layoutObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        for (const [, variable, dimension] of layoutSizes.filter(([selector]) => entry.target.matches(selector))) {
          const rect = entry.target.getBoundingClientRect();
          host.style.setProperty(variable, `${Math.ceil(dimension === 'width' ? rect.width : rect.height)}px`);
        }
        if (entry.target.matches('.world-radar')) this.syncMinimapResolution();
      }
    });
    for (const selector of new Set(layoutSizes.map(([selector]) => selector))) this.layoutObserver.observe(host.querySelector(selector)!, { box: 'border-box' });
    this.loading = createWorldLoading(host.querySelector('.adventure')!);
    this.loadProgress = 0;
    this.renderer = mountOpenWorld(host.querySelector('#ow-host')!, {
      getSnapshot: () => this.renderSnapshot(), sampleWorld: (x, z) => this.simulation.sampleWorld(x, z), modelUrl: pokemonModelUrl, spriteUrl: pokemonSpriteUrl,
      onReady: () => {
        this.ready = true; this.refreshRecovery();
        if (getGymScene(this.simulation.sceneId)) { this.cameraHeading = CARDINAL_CAMERA_HEADINGS.south; this.renderer?.setCameraHeading(this.cameraHeading); }
      },
      onLoadProgress: (percent, detail) => {
        if (percent < this.loadProgress) return;
        this.loadProgress = percent;
        this.loading?.stage('world', this.loadProgress, detail);
      },
      onLoadError: error => {
        this.ready = false; this.paused = true;
        this.loading ??= createWorldLoading(host.querySelector('.adventure')!);
        this.loading?.fail(`3D 월드를 준비하지 못했습니다. ${error instanceof Error ? error.message : String(error)}`);
      },
      onRendererLost: () => { this.ready = false; this.paused = true; this.simulation.requireReadyModels(); this.refresh(); },
      onNavigationStart: () => { this.pendingGymEntry = undefined; this.pendingFieldChallenge = undefined; this.pendingDungeonEntry = undefined; return this.noteManualInput(); },
      onMovementInput: () => this.noteManualInput(),
      onMovementEnd: () => {
        this.manualMovementActive = false;
        if (this.shouldResumeAutomaticControl()) this.changeMode('auto');
      },
      onPlayerMove: next => {
        if (!this.noteManualInput()) return false;
        const accepted = this.simulation.movePartner(next);
        // The render store polls positions separately. Rebuilding the full HUD and
        // scene here duplicated that work on the input path and stalled movement.
        const now = performance.now();
        if (accepted && this.pendingGymEntry) this.enterPendingGym();
        if (accepted && this.pendingFieldChallenge) this.arriveFieldChallenge();
        if (accepted) this.enterGymCourt();
        if (accepted) this.walkThroughPortal();
        if (accepted && now - this.lastMovementRefresh >= 100) {
          this.lastMovementRefresh = now;
          this.html('#world-position', `${next.x.toFixed(0)}, ${next.z.toFixed(0)}`);
        }
        return accepted;
      },
      onSelect: id => { if (id?.startsWith('companion:')) return; this.manualIdleSeconds = 0; this.simulation.selectWild(id, true); this.options.changed(); this.refresh(); },
      onInteract: id => this.encounter(id),
      onCollectItem: id => { if (this.simulation.collectFieldItem(id)) { this.options.changed(true); this.refresh(); this.renderer?.update(); } },
      onModelStatus: (id, status, speciesId) => {
        this.simulation.setModelStatus(id, status, speciesId);
        this.refreshRecovery();
        if (this.simulation.selectedWildId === id) this.refresh();
      },
      onPortal: portalId => this.usePortal(portalId),
      onGymEnter: locationId => this.enterHallFromWorld(gymSceneId(this.simulation.regionId, locationId)),
      onLeagueEnter: locationId => this.enterHallFromWorld(leagueSceneId(this.simulation.regionId, locationId)),
      onGymExit: () => { if (this.simulation.exitGym()) this.afterSceneChange(); },
      onGymChallenge: () => this.challengeGymHall(),
      onCameraHeading: heading => { this.cameraHeading = heading; this.updateMapOrientation(); this.minimap(); },
    });
    this.multiplayer = new MultiplayerSession(() => { if (this.host === host) this.renderRealtime(); });
    this.multiplayer.join(this.presence());
    window.addEventListener('keydown', this.hotkeys);
    window.addEventListener('online', this.onConnectionRestored);
    this.button('#world-resume').onclick = () => void this.resume();
    this.button('#world-model-retry').onclick = () => { this.renderer?.retryModels(); };
    const battleHud = this.host.querySelector<HTMLDetailsElement>('.world-battle-hud')!;
    battleHud.open = false;
    battleHud.addEventListener('toggle', () => {
      if (battleHud.open && this.compactViewport.matches) {
        this.setChatCollapsed(true);
        this.host?.querySelector<HTMLDetailsElement>('.world-explore-panel')?.removeAttribute('open');
      }
    });
    this.compactViewport.addEventListener('change', this.onViewportChange);
    this.button('#world-mode-auto').onclick = () => { this.changeMode('auto'); if (this.paused) void this.resume(); };
    this.button('#world-mode-manual').onclick = () => this.changeMode('manual');
    this.button('#world-gym-notice').onclick = () => this.startNextChallenge();
    this.button('#world-edit-moves').onclick = () => {
      const game = this.options.game;
      const lead = game.battle?.player.team[game.battle.player.activeIndex] ?? game.player.team[firstUsableRegionalTeamIndex(game, this.simulation.regionId)] ?? game.player.team[0];
      this.options.editMoves?.(lead.instanceId);
    };
    this.button('#world-target-track').onclick = () => {
      if (this.simulation.trackingSelected) this.simulation.selectWild(null);
      else this.simulation.trackSelected();
      this.options.changed(); this.refresh();
    };
    this.button('#world-target-battle').onclick = () => { const id = this.simulation.selectedWildId; if (id) this.encounter(id); };
    this.button('#world-target-clear').onclick = () => { this.simulation.selectWild(null); this.options.changed(); this.refresh(); };
    this.host.querySelector('#world-moves')!.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-world-move]');
      if (button && this.simulation.requestAction({ type: 'move', index: Number(button.dataset.worldMove) })) this.options.notify('다음 턴에 선택한 기술을 사용합니다.');
    });
    this.host.querySelector('#world-emergency-action')!.addEventListener('click', event => {
      if ((event.target as Element).closest('#world-struggle')) this.simulation.requestAction({ type: 'move', index: 0 });
    });
    this.host.querySelector('#world-switch-options')!.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-world-switch]');
      if (!button || button.disabled) return;
      const index = Number(button.dataset.worldSwitch);
      if (this.simulation.requestAction({ type: 'switch', index })) {
        this.options.notify(`${this.options.game.player.team[index].nickname}(으)로 교체합니다.`);
        this.host!.querySelector<HTMLDetailsElement>('.world-switch')!.open = false;
        this.refresh();
      }
    });
    this.input('#world-map-search').oninput = event => { this.mapQuery = (event.target as HTMLInputElement).value; this.drawRegionMap(); };
    this.host.querySelector<HTMLSelectElement>('#world-map-filter')!.onchange = event => { this.mapFilter = (event.target as HTMLSelectElement).value as MapFilter; this.drawRegionMap(); };
    this.button('#world-map-open').onclick = () => { this.drawRegionMap(); this.host!.querySelector<HTMLDialogElement>('#world-map-dialog')!.showModal(); };
    const bag = this.host.querySelector<HTMLDetailsElement>('#world-bag')!;
    bag.addEventListener('toggle', () => this.renderBag());
    this.host.querySelector('#world-bag-content')!.addEventListener('click', event => {
      const target = event.target as Element;
      const tab = target.closest<HTMLButtonElement>('[data-bag-tab]'), machine = target.closest<HTMLButtonElement>('[data-bag-machine]');
      if (tab) { this.bagTab = tab.dataset.bagTab === 'machines' ? 'machines' : 'tools'; this.renderBag(); return; }
      if (machine) { this.openMachines(Number(machine.dataset.bagMachine)); return; }
      const pickup = target.closest<HTMLButtonElement>('[data-bag-pickup]'), member = target.closest<HTMLButtonElement>('[data-bag-member]');
      if (pickup && !pickup.disabled) {
        const item = this.simulation.fieldPickups.find(row => row.id === pickup.dataset.bagPickup);
        if (item && this.renderer?.navigateTo(item)) { bag.open = false; this.options.notify(`${item.name}까지 길찾기를 시작합니다.`); }
        else if (item) this.options.notify('현재 위치에서 이어지는 도보 경로가 없습니다.', true);
      }
      if (member && !member.disabled) this.options.editMoves?.(member.dataset.bagMember!);
    });
    this.button('#world-minimap-smaller').onclick = () => this.resizeMinimap(-1);
    this.button('#world-minimap-larger').onclick = () => this.resizeMinimap(1);
    this.button('#world-next-guide').onclick = () => {
      const guide = this.button('#world-next-guide');
      if (this.compactViewport.matches && guide.dataset.expanded !== 'true') {
        guide.dataset.expanded = 'true'; guide.setAttribute('aria-expanded', 'true');
        guide.querySelector('b')!.textContent = '지도'; return;
      }
      guide.dataset.expanded = 'false'; guide.setAttribute('aria-expanded', 'false');
      guide.querySelector('b')!.textContent = this.compactViewport.matches ? '상세' : '지도';
      this.button('#world-map-open').click();
    };
    this.button('#world-map-close').onclick = () => this.host!.querySelector<HTMLDialogElement>('#world-map-dialog')!.close();
    this.button('#world-map-zoom-out').onclick = () => this.setMapZoom(this.mapView.zoom / 1.5);
    this.button('#world-map-zoom-in').onclick = () => this.setMapZoom(this.mapView.zoom * 1.5);
    this.button('#world-map-reset').onclick = () => { this.resetMapView(); this.applyMapView(); };
    this.host.querySelectorAll<HTMLButtonElement>('[data-map-orientation]').forEach(button => button.onclick = () => {
      const orientation = button.dataset.mapOrientation as MapOrientation;
      this.cameraHeading = CARDINAL_CAMERA_HEADINGS[orientation];
      this.renderer?.setCameraHeading(this.cameraHeading);
      this.resetMapView(); this.updateMapOrientation(); this.drawRegionMap(); this.minimap();
    });
    this.button('#world-trainer-open').onclick = () => this.openTrainerBattles();
    this.button('#world-trainer-close').onclick = () => this.host!.querySelector<HTMLDialogElement>('#world-trainer-dialog')!.close();
    this.host.querySelector('#world-trainer-list')!.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-trainer-battle]');
      if (!button || button.disabled) return;
      if (this.simulation.challengeFieldTrainerById(button.dataset.trainerBattle!)) {
        this.host!.querySelector<HTMLDialogElement>('#world-trainer-dialog')!.close();
        this.paused = false; this.manualMovementActive = false;
        this.options.changed(); this.refresh();
      }
    });
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
      if (this.paused) { await this.resume(); return; }
      this.paused = true; this.refresh();
      const button = this.button('#world-pause'); button.disabled = true;
      try {
        // A request already in flight still owns a durable neural result. Finish
        // it before marking this paused snapshot saved, so reload sees that head.
        if (this.paused) await this.serverRequest;
        await this.options.changed(true);
      } catch (error) {
        this.pauseWithError(error, 'world');
      } finally { button.disabled = false; this.refresh(); }
    };
    this.button('#world-heal').onclick = () => {
      if (this.options.game.battle) return this.options.notify('배틀을 마친 뒤 회복할 수 있습니다.');
      heal(this.options.game); playGameSound('heal'); this.options.notify('캠프에서 HP·상태 이상을 회복했습니다.'); this.options.changed(); this.refresh();
    };
    this.button('#world-catch').onclick = () => { if (this.options.game.captureOffer) this.catchVictory(); else if (this.simulation.requestCapture()) this.options.notify('다음 턴에 몬스터볼을 던집니다.'); };
    for (const item of ['potion', 'super-potion'] as const) this.button(`#world-${item}`).onclick = () => { if (this.simulation.requestAction({ type: 'item', item })) this.options.notify(`다음 턴에 ${ITEM_LABELS[item]}을 사용합니다.`); };
    this.button('#world-run').onclick = () => { if (this.simulation.requestAction({ type: 'run' })) this.options.notify('다음 턴에 도망을 시도합니다.'); };
    this.input('#world-auto-catch').onchange = e => { this.simulation.setAutoCapture((e.target as HTMLInputElement).checked); if (this.simulation.autoCapture && this.simulation.hasBalls && this.options.game.captureOffer) this.catchVictory(); this.options.changed(); this.refresh(); };
    this.input('#world-learning').checked = this.options.learning();
    this.input('#world-learning').onchange = e => { this.options.setLearning((e.target as HTMLInputElement).checked); this.options.changed(); };
    this.input('#world-exp-share').onchange = e => { this.options.game.experienceShare = (e.target as HTMLInputElement).checked; this.options.changed(); this.refresh(); };
    const regionSelect = host.querySelector<HTMLSelectElement>('#world-region')!;
    regionSelect.onchange = () => {
      try {
        const destination = getWorldAtlas(regionSelect.value).id;
        const reason = campaignEntryReason(this.options.game, destination as CampaignRegion);
        if (reason) throw new Error(reason);
        this.simulation.changeRegion(destination); this.multiplayer?.join(this.presence()); this.options.changed(); this.refresh(); this.drawRegionMap(); this.options.notify(`${this.simulation.atlas.name}에 도착했습니다.`);
      }
      catch (error) { regionSelect.value = this.simulation.regionId; this.options.notify(String(error), true); }
    };
    this.refresh();
  }

  /** Wild battles keep running while the partner walks; trainer and gym battles hold position. */
  private get walkableBattle(): boolean { const battle = this.options.game.battle; return !battle || battle.kind === 'wild'; }

  private canAcceptMovement(): boolean {
    return !this.paused
      && this.ready && this.simulation.modelsReady
      && !this.simulation.regionalStarterRequired
      && !document.querySelector('dialog[open]')
      && this.walkableBattle
      && !this.options.game.captureOffer
      && firstUsableRegionalTeamIndex(this.options.game, this.simulation.regionId) >= 0
      && !this.host?.querySelector<HTMLDialogElement>('#world-map-dialog')?.open;
  }

  /** Clicked a gym building or league stadium: walk to its door, go in and start the battle. */
  private enterHallFromWorld(sceneId: string): void {
    const world = this.simulation, game = this.options.game;
    if (game.battle || game.captureOffer || getCaveScene(world.sceneId) || getGymScene(world.sceneId)) return;
    const hall = getGymScene(sceneId); if (!hall) return;
    const badges = getRegionalBadges(game, world.regionId), gym = hall.kind === 'gym' ? getCampaignGyms(game, world.regionId).find(item => item.locationId === hall.locationId) : undefined;
    if (gym && gym.badge > badges + 1) { this.options.notify(`앞 체육관 ${gym.badge - badges - 1}곳 필요`, true); return; }
    if (Math.hypot(world.player.x - hall.door.x, world.player.z - hall.door.z) <= 2 && this.enterHall(hall)) return;
    if (this.renderer?.navigateTo(hall.door)) this.pendingGymEntry = sceneId;
  }

  /** The next gym, or the next league trainer once all eight badges are in. */
  private nextChallenge() {
    const game = this.options.game, world = this.simulation, region = world.regionId;
    if (!isCampaignRegion(region) || campaignTravelReason(game, region)) return undefined;
    const badges = getRegionalBadges(game, region), detail = `${world.atlas.name} 배지 ${badges}/8`;
    if (badges >= 8) {
      const trainer = getNextCampaignTrainer(game, region);
      return trainer ? { kind: 'trainer' as const, locationId: trainer.locationId, title: `${trainer.name} · 도전`, speciesId: trainer.team.at(-1)?.[0], detail } : undefined;
    }
    const gym = getCampaignGyms(game, region).find(item => item.badge === badges + 1);
    return gym ? { kind: 'gym' as const, locationId: gym.locationId, title: `${gym.name} · Lv.${gym.level} 도전`, speciesId: gym.speciesId, detail } : undefined;
  }

  /** The challenge notice: walk into the hall, or, where a region has no hall for it, fight on the field when you get there. */
  private startNextChallenge(): void {
    const next = this.nextChallenge(), world = this.simulation, game = this.options.game, region = world.regionId;
    if (!next || game.battle || game.captureOffer || getCaveScene(world.sceneId) || getGymScene(world.sceneId)) return;
    const hall = getGymScene(next.kind === 'gym' ? gymSceneId(region, next.locationId) : LEAGUE_LOCATION_IDS[region] === next.locationId ? leagueSceneId(region, next.locationId) : '');
    if (hall) {
      this.enterHallFromWorld(hall.sceneId);
      if (!this.pendingGymEntry && !getGymScene(world.sceneId)) this.travelTowards(next.locationId, hall.door);
      return;
    }
    if (this.fieldChallenge(next)) return;
    const location = world.atlas.locations.find(item => item.id === next.locationId);
    if (location && this.travelTowards(next.locationId, location)) this.pendingFieldChallenge = next.locationId;
  }

  /** Walk there when a route exists; otherwise fast-travel to a visited town first, or show the guide route. */
  private travelTowards(locationId: string, point: { x: number; z: number }): boolean {
    const world = this.simulation;
    if (this.renderer?.navigateTo(point)) return true;
    if (world.visitedTownIds.includes(locationId) && this.teleportFromMap(locationId)) return Boolean(this.renderer?.navigateTo(point));
    this.button('#world-next-guide').click();
    return false;
  }

  private fieldChallenge(next: NonNullable<ReturnType<OpenWorldPanel['nextChallenge']>>): boolean {
    const world = this.simulation;
    if (world.locationAt(world.player.x, world.player.z).id !== next.locationId) return false;
    if (!(next.kind === 'gym' ? world.challengeLocalGym() : world.challengeLocalTrainer())) return false;
    this.pendingFieldChallenge = undefined; this.paused = false; this.options.changed(); this.refresh();
    return true;
  }

  private arriveFieldChallenge(): void {
    const next = this.nextChallenge();
    if (!next || next.locationId !== this.pendingFieldChallenge || getGymScene(this.simulation.sceneId)) { this.pendingFieldChallenge = undefined; return; }
    this.fieldChallenge(next);
  }

  private enterPendingGym(): void {
    const sceneId = this.pendingGymEntry, world = this.simulation; if (!sceneId) return;
    const hall = getGymScene(sceneId);
    if (!hall) { this.pendingGymEntry = undefined; return; }
    if (Math.hypot(world.player.x - hall.door.x, world.player.z - hall.door.z) > 1.6) return;
    this.pendingGymEntry = undefined;
    this.enterHall(hall);
  }

  /** A doorway ring, label or building was clicked: use it when close, otherwise walk to it and go in on arrival. */
  private usePortal(portalId: string): void {
    const world = this.simulation, game = this.options.game;
    if (game.battle || game.captureOffer || getGymScene(world.sceneId)) return;
    const found = portalId === 'nearest' || getCaveScene(world.sceneId) ? undefined : dungeonEntrance(world.regionId, portalId);
    // A door the badges have not opened is not worth the walk.
    if (found && !world.doorwayOpen(found.scene, found.portal)) return;
    const entrance = found?.portal;
    if (!entrance || Math.hypot(world.player.x - entrance.surface.x, world.player.z - entrance.surface.z) <= 3.6) {
      if (world.traverseCavePortal()) this.afterPortal();
      return;
    }
    if (this.renderer?.navigateTo(entrance.surface)) this.pendingDungeonEntry = portalId;
  }

  /** Walking onto an entrance, exit or stairs uses it; automatic exploration never does. A short pause stops a bounce back. */
  private walkThroughPortal(): void {
    const world = this.simulation, pending = this.pendingDungeonEntry && dungeonEntrance(world.regionId, this.pendingDungeonEntry)?.portal;
    if (pending && Math.hypot(world.player.x - pending.surface.x, world.player.z - pending.surface.z) <= 1.6) {
      this.pendingDungeonEntry = undefined;
      if (world.traverseCavePortal()) { this.afterPortal(); return; }
    }
    if (!world.portalUnderfoot()) { this.portalArmed = true; return; }
    if (!this.portalArmed || performance.now() < this.portalCooldownUntil) return;
    if (world.traverseCavePortal(PORTAL_WALK_RADIUS)) this.afterPortal();
  }

  private afterPortal(): void {
    this.portalCooldownUntil = performance.now() + 1200; this.pendingDungeonEntry = undefined; this.portalArmed = false;
    this.manualMovementActive = false; this.multiplayer?.join(this.presence()); this.options.changed(); this.refresh(); this.renderer?.update(); this.minimap();
  }

  /** Going into a gym starts the automatic leader battle; league trainers are challenged by hand, one at a time. */
  private enterHall(hall: GymScene): boolean {
    if (!(hall.kind === 'league' ? this.simulation.enterLeague() : this.simulation.enterGym(hall.locationId))) return false;
    this.afterSceneChange();
    if (hall.kind === 'gym') this.challengeGymHall();
    return true;
  }

  /** Stepping onto the marked court starts the leader battle when the badge is next in order. */
  private enterGymCourt(): void {
    const hall = getGymScene(this.simulation.sceneId), game = this.options.game;
    if (!hall || game.battle || game.captureOffer || !onGymCourt(hall, this.simulation.player.x, this.simulation.player.z)) return;
    this.challengeGymHall();
  }

  private challengeGymHall(): void {
    try { if (!this.simulation.challengeGymHall()) return; }
    catch (error) { this.options.notify(error instanceof Error ? error.message : String(error), true); return; }
    this.paused = false; this.manualMovementActive = false; this.options.changed(); this.refresh();
  }

  /** A hall battle ended: a league win heals the team for the next trainer; the last win, a loss or a gym ends the visit. */
  private afterHallBattle(outcome: BattleTurnResult['outcome']): void {
    const world = this.simulation, hall = getGymScene(world.sceneId); if (!hall) return;
    if (hall.kind === 'league' && outcome === 'won') {
      heal(this.options.game); world.reconcileTeamChange();
      if (world.hallTrainer) return;
    }
    if (world.exitGym()) this.afterSceneChange();
  }

  private afterSceneChange(): void {
    this.manualMovementActive = false; this.multiplayer?.join(this.presence()); this.options.changed(); this.refresh(); this.renderer?.update();
    // Face into the hall on the way in, and away from the building on the way out.
    this.cameraHeading = CARDINAL_CAMERA_HEADINGS[getGymScene(this.simulation.sceneId) ? 'south' : 'north'];
    this.renderer?.setCameraHeading(this.cameraHeading); this.updateMapOrientation(); this.minimap();
  }

  private noteManualInput(): boolean {
    if (!this.canAcceptMovement()) return false;
    this.manualMovementActive = true;
    this.manualIdleSeconds = 0;
    // Changing mode mid-battle would drop a queued move; walking keeps the battle's mode.
    if (!this.options.game.battle && this.simulation.controlMode !== 'manual') this.changeMode('manual');
    return true;
  }

  private offerRegionalStarter(): void {
    const world = this.simulation, game = this.options.game;
    if (!this.host || this.starterDialog || !world.regionalStarterRequired || game.battle || game.captureOffer) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'regional-starter-dialog'; dialog.id = 'regional-starter-dialog';
    dialog.setAttribute('aria-labelledby', 'regional-starter-title');
    dialog.innerHTML = `<header><small>${escape(world.atlas.name)}의 새 모험</small><h2 id="regional-starter-title">함께할 포켓몬을 선택하세요</h2><p>Lv.5 스타팅을 지방마다 한 번 받을 수 있습니다. 기존 포켓몬과 기록은 그대로 보관됩니다.</p></header><div class="regional-starter-options">${REGIONAL_STARTERS[world.regionId].map(id => {
      const species = getSpecies(id);
      return `<button data-regional-starter="${id}"><img src="${pokemonSpriteUrl(id)}" alt=""><strong>${escape(species.name)}</strong><span>${species.types.map(type => types[type]).join(' · ')} · Lv.5</span></button>`;
    }).join('')}</div><p class="regional-starter-rule">배지 0개: 현지 출신 Lv.20까지 · 배지 1개부터 타지방 포켓몬 사용 가능<br>배지를 얻을 때마다 상한 +10레벨, 배지 8개면 Lv.100까지</p><p class="regional-starter-error" role="status"></p>`;
    dialog.addEventListener('cancel', event => event.preventDefault());
    this.starterDialog = dialog; document.body.append(dialog); dialog.showModal();
    dialog.querySelectorAll<HTMLButtonElement>('[data-regional-starter]').forEach(button => button.onclick = async () => {
      const buttons = dialog.querySelectorAll<HTMLButtonElement>('button'); buttons.forEach(item => { item.disabled = true; });
      try {
        const monster = world.claimRegionalStarter(Number(button.dataset.regionalStarter));
        world.setControlMode('manual'); this.manualMovementActive = false;
        dialog.close(); dialog.remove(); this.starterDialog = undefined;
        this.refresh(); await this.options.changed(true);
        this.options.notify(`${monster.nickname}와 ${world.atlas.name} 모험을 시작합니다.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (dialog.isConnected) { dialog.querySelector<HTMLElement>('[role="status"]')!.textContent = message; buttons.forEach(item => { item.disabled = false; }); }
        else this.options.notify(message, true);
      }
    });
  }

  private shouldResumeAutomaticControl(): boolean {
    return this.simulation.controlMode === 'manual'
      && !this.options.game.battle
      && this.canAcceptMovement()
      && !this.simulation.isSafeTown(this.simulation.player.x, this.simulation.player.z);
  }

  private changeMode(mode: 'auto' | 'manual'): void { this.manualIdleSeconds = 0; this.simulation.setControlMode(mode); this.options.changed(); this.refresh(); }
  private catchVictory(): void { const caught = this.simulation.captureVictory(); if (caught) playGameSound('capture'); this.options.notify(caught ? '포획 성공! 팀 또는 박스에 저장했습니다.' : '볼이 없어 포획을 패스합니다.'); this.options.changed(); this.refresh(); }

  private encounter(id: string): void {
    if (this.recoveryError || this.recovering) return;
    const wild = this.simulation.entities.find(entity => entity.id === id);
    if (!wild || wild.kind !== 'wild') return;
    this.simulation.selectWild(id, true);
    const modelStatus = this.simulation.modelStatus(id);
    if (modelStatus) {
      this.options.notify(modelStatus === 'failed' ? '3D 모델을 불러오지 못해 이 개체의 이동과 배틀을 중지했습니다.' : '3D 모델을 확인한 뒤 이동과 배틀을 시작합니다.', modelStatus === 'failed');
      this.refresh(); return;
    }
    if (!this.simulation.canEngageWild(id)) { this.simulation.trackSelected(); this.options.notify(`${getSpecies(wild.speciesId).name} 추적 중 · 길을 따라 4m 안에 도착하면 배틀합니다.`); this.options.changed(); }
    else if (this.simulation.startEncounter(id)) { this.paused = false; this.options.changed(); }
    this.refresh();
  }

  async tick(): Promise<void> {
    if (this.tickPending || !this.renderer || !this.ready) return;
    this.simulation.synchronizeWorldClock(Date.now());
    this.simulation.synchronizeEvolutionContext(this.multiplayer?.view.status === 'connected' && this.multiplayer.view.players.length > 0);
    this.refreshRecovery();
    if (this.paused || !this.simulation.modelsReady || document.hidden || document.querySelector('dialog[open]')) { this.manualIdleSeconds = 0; return; }
    this.tickPending = true;
    try {
    // A route or held key owns control until the renderer reports movement end.
    // Fixed simulation ticks must not expire that ownership between render frames.
    if (this.simulation.controlMode === 'manual' && !this.manualMovementActive && !this.options.game.battle && this.canAcceptMovement()
      && !this.simulation.isSafeTown(this.simulation.player.x, this.simulation.player.z) && !getGymScene(this.simulation.sceneId)) {
      this.manualIdleSeconds += .25;
      if (this.manualIdleSeconds >= MANUAL_IDLE_SECONDS) this.changeMode('auto');
    } else this.manualIdleSeconds = 0;
    // Resolve neural decisions alongside the fixed-rate world clock. The simulation
    // itself gates a battle turn until all required decisions are present.
    if (!this.serverRequest) {
      this.serverRequest = this.simulation.prepareServerBattle(this.options.learning())
        .catch(error => {
          this.pauseWithError(error, 'server');
        }).finally(() => { this.serverRequest = undefined; });
    }
    const battlers = this.battlerPoints();
    const result = this.simulation.step({ deltaSeconds: .25, learning: this.options.learning() });
    this.simulation.syncPlayerToCompanion();
    for (const event of result.events) {
      if (event.type === 'battle-turn') {
        if (event.result.executedMoves.some(move => move.executed)) playGameSound('attack');
        if (event.result.outcome === 'won') playGameSound('victory');
        else if (event.result.outcome === 'caught') playGameSound('capture');
        const now = performance.now(); this.attacks.clear();
        this.effects = this.effects.filter(effect => now - effect.start < 2000);
        event.result.executedMoves.filter(move => move.executed).forEach((move, index) => {
          const start = now + index * 300, key = String(++this.cueSerial), style = move.damageClass;
          this.attacks.set(move.actorInstanceId, { start, end: start + 280, type: move.moveType });
          this.cues.set(move.actorInstanceId, { key, text: move.moveId < 0 ? '발버둥' : getMove(move.moveId).name, moveType: move.moveType, start, end: start + 1600 });
          const self = move.category === 'buff' || move.category === 'healing' || move.targetInstanceId === move.actorInstanceId;
          const from = battlers.get(move.actorInstanceId), to = self ? from : battlers.get(move.targetInstanceId);
          if (from && to) this.effects.push({ key, moveType: move.moveType, style, hit: move.hit && move.result !== 'immune' && move.result !== 'failed', from, to, start });
          if (move.damage > 0 && !self) { const impact = start + (style === 'special' ? 420 : 200); this.hurts.set(move.targetInstanceId, { start: impact, end: impact + 320 }); }
        });
        if (event.result.battleEnded && !event.result.gymVictory) this.options.notify(event.result.outcome === 'won' ? '승리! 경험치와 보상을 받았습니다.' : event.result.outcome === 'caught' ? '포획 성공! 팀과 도감에 등록했습니다.' : event.result.outcome === 'lost' ? '파트너가 쓰러졌습니다. 회복한 뒤 다시 탐험하세요.' : '배틀에서 벗어났습니다.');
        await this.options.changed(true);
        if (event.result.battleEnded) this.afterHallBattle(event.result.outcome);
        if (event.result.gymVictory) {
          this.refresh(); await showGymVictory(event.result.gymVictory);
          this.manualIdleSeconds = 0;
        }
      }
      if (event.type === 'evolved') this.options.notify(`${getSpecies(event.fromSpeciesId).name} → ${getSpecies(event.speciesId).name} 진화!`);
    }
    const drops = result.events.filter(event => event.type === 'item-drop');
    if (drops.length) { this.options.notify(drops.map(event => event.message).join(' · ')); playGameSound('select'); this.options.changed(); }
    if (result.tick % 20 === 0) this.options.changed();
    this.refresh();
    } catch (error) {
      this.pauseWithError(error, 'world');
    } finally { this.tickPending = false; }
  }

  private pauseWithError(error: unknown, source: 'server' | 'world'): void {
    this.paused = true;
    this.recoveryError = { message: error instanceof Error ? error.message : String(error), source };
    this.options.notify(`${this.recoveryError.message} · 화면의 ‘다시 연결하고 재개’를 눌러 재시도할 수 있습니다.`, true);
    this.refresh();
  }

  private async resume(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true; this.paused = true;
    const host = this.host;
    let source: 'server' | 'world' = 'server';
    this.refreshRecovery();
    try {
      // Preserve pending neural finalizations and retry the same idempotent turn.
      // Never switch to a different circuit or discard a failed request's memory.
      await this.serverRequest;
      await this.simulation.prepareServerBattle(this.options.learning());
      if (this.host !== host) return;
      source = 'world';
      this.recoveryError = undefined;
      this.paused = false;
      await this.options.changed(true);
      this.options.notify('탐험을 재개했습니다.');
    } catch (error) {
      if (this.host === host) this.pauseWithError(error, source);
    } finally { this.recovering = false; if (this.host === host) this.refresh(); }
  }

  private refreshRecovery(): void {
    const host = this.host?.querySelector<HTMLElement>('#ow-host');
    const banner = this.host?.querySelector<HTMLElement>('#world-recovery');
    if (!host || !banner) return;
    const world = this.simulation, blocked = !world.modelsReady;
    const required = world.entities.filter(entity => entity.kind === 'companion' || entity.id === world.battleWildId || entity.id === world.selectedWildId).map(entity => entity.id);
    if (world.battleWildId) required.push(world.battleWildId);
    const failed = required.some(id => world.modelStatus(id) === 'failed');
    if (this.loading) {
      if (failed) this.loading.fail('파트너의 3D 모델을 불러오지 못했습니다. 연결을 확인하고 다시 시도해 주세요.', () => {
        this.loading?.status('3D 모델을 다시 불러오고 있습니다.');
        this.renderer?.retryModels();
      });
      else if (this.ready && !blocked) {
        this.loading.stage('world', 100, '장면과 파트너 준비 완료');
        this.loading.remove(); this.loading = undefined;
      } else if (this.ready) {
        const complete = required.filter(id => !world.modelStatus(id)).length;
        this.loadProgress = Math.max(this.loadProgress, 65 + Math.floor(30 * complete / Math.max(1, required.length)));
        this.loading.stage('world', this.loadProgress, `3D 장면 준비 완료 · 필수 모델 ${complete} / ${required.length}`);
      }
    }
    host.dataset.rendererReady = String(this.ready);
    host.dataset.ready = String(this.ready && !blocked);
    host.dataset.paused = String(this.paused);
    banner.hidden = !failed && !this.paused && !this.recoveryError;
    this.html('#world-recovery-message', escape(this.recovering ? '연결과 저장 상태를 확인하고 있습니다…'
      : this.recoveryError ? this.recoveryError.message
      : failed ? '포켓몬 3D 모델을 불러오지 못했습니다. 해당 개체의 이동·배틀을 멈췄습니다.'
      : '탐험이 일시 정지되어 있습니다.'));
    const resume = this.button('#world-resume');
    resume.hidden = !this.paused && !this.recoveryError;
    resume.disabled = this.recovering || blocked;
    resume.textContent = this.recoveryError ? '다시 연결하고 재개' : '계속 탐험';
    const retry = this.button('#world-model-retry');
    retry.hidden = !failed; retry.disabled = this.recovering;
  }

  private destinationGuide(): DestinationGuide {
    const world = this.simulation, game = this.options.game;
    const key = `${world.regionId}:${world.sceneId}:${getRegionalBadges(game, world.regionId)}:${JSON.stringify(game.campaign)}:${Math.round(world.player.x / 5)}:${Math.round(world.player.z / 5)}`;
    if (this.guideCache?.key !== key) this.guideCache = { key, guide: nextDestinationGuide(game, world.atlas, world.sceneId, world.player) };
    return this.guideCache.guide;
  }

  /** Where each battler stands, captured before a turn can remove the wild entity. */
  private battlerPoints(): Map<string, WorldPoint & { height: number }> {
    const battle = this.options.game.battle, world = this.simulation, points = new Map<string, WorldPoint & { height: number }>();
    if (!battle) return points;
    const companion = world.entities.find(entity => entity.kind === 'companion');
    const opponent = battle.kind === 'wild' ? world.entities.find(entity => entity.id === world.battleWildId) : { x: world.player.x, z: world.player.z + (getGymScene(world.sceneId) ? 6 : -3) };
    const place = (team: readonly Monster[], point?: { x: number; z: number }) => {
      if (point) for (const monster of team) points.set(monster.instanceId, { x: point.x, z: point.z, height: pokemonDisplayHeight(monster.speciesId) });
    };
    place(battle.player.team, companion); place(battle.enemy.team, opponent);
    return points;
  }

  private renderSnapshot(): OpenWorldRenderSnapshot {
    const game = this.options.game, battle = game.battle;
    const now = performance.now();
    const attacking = (id?: string) => { const attack = id ? this.attacks.get(id) : undefined; return attack && now >= attack.start && now < attack.end ? attack : undefined; };
    const hurting = (id?: string) => { const hurt = id ? this.hurts.get(id) : undefined; return Boolean(hurt && now >= hurt.start && now < hurt.end); };
    const cue = (id?: string) => { const shown = id ? this.cues.get(id) : undefined; return shown && now >= shown.start && now < shown.end ? { key: shown.key, text: shown.text, moveType: shown.moveType } : undefined; };
    const ally = battle ? battle.player.team[battle.player.activeIndex] : game.player.team[firstUsableRegionalTeamIndex(game, this.simulation.regionId)] ?? game.player.team[0];
    const enemy = battle?.enemy.team[battle.enemy.activeIndex];
    const hall = getGymScene(this.simulation.sceneId), hallGym = hall?.kind === 'gym' ? getCampaignGyms(game, this.simulation.regionId).find(gym => gym.locationId === hall.locationId) : undefined;
    const hallTrainer = this.simulation.hallTrainer, hallAce = hallTrainer?.team.at(-1);
    // The leader's ace waits on the dais until the battle begins.
    // Trainer and hall opponents are drawn beside the partner rather than simulated; both face each other.
    const opponentPoint = battle && battle.kind !== 'wild' ? { x: this.simulation.player.x, z: this.simulation.player.z + (hall ? 6 : -3) } : undefined;
    const hallLeader = hallGym ? { speciesId: hallGym.speciesId, level: hallGym.level } : hallAce ? { speciesId: hallAce[0], level: hallAce[1] } : undefined;
    return {
      guide: battle || hall ? undefined : this.destinationGuide(),
      gyms: getCampaignGyms(game, this.simulation.regionId),
      busy: Boolean(battle || game.captureOffer),
      gymParty: hallGym ? gymTeam(this.simulation.regionId, hallGym.badge) ?? [[hallGym.speciesId, hallGym.level]] : undefined,
      hallTrainer: hallTrainer ? { name: hallTrainer.name, team: hallTrainer.team } : undefined,
      regionId: this.simulation.regionId,
      sceneId: this.simulation.sceneId,
      player: { ...this.simulation.player, heading: this.simulation.player.heading as WorldHeading }, tick: this.simulation.tick, selectedWildId: this.simulation.selectedWildId, badges: getRegionalBadges(game, this.simulation.regionId),
      fieldItems: this.simulation.fieldPickups,
      foods: this.simulation.foods.map(food => ({ ...food, id: String(food.id) })),
      effects: this.effects.filter(effect => now < effect.start + 1800),
      entities: this.simulation.visibleEntities(18).map(entity => {
        const inBattle = Boolean(battle && (entity.kind === 'companion' || entity.id === this.simulation.battleWildId));
        const monster = entity.kind === 'companion' ? ally : entity.id === this.simulation.battleWildId ? enemy : undefined;
        const transformed = monster && battle?.transformations?.[monster.instanceId];
        const speciesId = transformed?.speciesId ?? monster?.speciesId ?? entity.speciesId;
        const fieldMega = !battle && monster ? fieldMegaForm(monster) : undefined;
        const formIdentifier = transformed?.formIdentifier ?? fieldMega?.identifier ?? monster?.regionalForm ?? (!monster && this.simulation.regionId === 'alola' ? getAlolaCombatForm(speciesId)?.identifier : undefined);
        const form = formIdentifier ? getCombatForm(formIdentifier) : undefined;
        const formModel = getPokemonFormModelSource(formIdentifier);
        const stats = transformed?.stats ?? monster?.stats ?? statsFor(getSpecies(entity.speciesId), entity.level);
        const level = monster?.level ?? entity.level;
        return { id: entity.id, speciesId, name: form?.name || getSpecies(speciesId).name, level, hp: monster?.hp ?? stats.hp, maxHp: stats.hp,
          formIdentifier, formModelUrl: formModel?.url, formSpriteUrl: form ? combatFormSprite(form) : undefined,
          transformationKind: transformed?.kind === 'mega' ? transformed.kind : fieldMega ? 'mega' : undefined,
          x: entity.x, z: entity.z,
          heading: entity.heading as WorldHeading, inBattle,
          action: monster?.hp === 0 ? 'fainted' : inBattle && attacking(monster?.instanceId) ? 'attack' : inBattle && hurting(monster?.instanceId) ? 'hurt' : entity.action < 4 ? 'walk' : 'idle',
          moveType: attacking(monster?.instanceId)?.type,
          cue: inBattle ? cue(monster?.instanceId) : undefined, status: monster?.status,
          lookAt: inBattle && entity.action >= 4 ? entity.kind === 'companion' && opponentPoint ? opponentPoint : (() => {
            const target = this.simulation.entities.find(other => entity.kind === 'companion' ? other.id === this.simulation.battleWildId : other.kind === 'companion');
            return target ? { x: target.x, z: target.z } : undefined;
          })() : undefined,
          movementSpeed: movementSpeed(speciesId, level),
          displayHeight: formModel ? pokemonWorldDisplayHeight(formModel.heightMeters) : pokemonDisplayHeight(speciesId),
        } as WorldCreature;
      }).concat(battle && battle.kind !== 'wild' && enemy ? [{ id: this.simulation.battleWildId!, speciesId: enemy.speciesId, name: enemy.nickname, level: enemy.level, hp: enemy.hp, maxHp: enemy.stats.hp, ...opponentPoint!, heading: (hall ? 0 : 2) as WorldHeading, action: enemy.hp === 0 ? 'fainted' as const : attacking(enemy.instanceId) ? 'attack' as const : hurting(enemy.instanceId) ? 'hurt' as const : 'idle' as const, moveType: attacking(enemy.instanceId)?.type, cue: cue(enemy.instanceId), status: enemy.status, inBattle: true, lookAt: this.simulation.player, displayHeight: pokemonDisplayHeight(enemy.speciesId), movementSpeed: movementSpeed(enemy.speciesId, enemy.level) }] : [])
        .concat(hallLeader && !battle ? [{ id: `gym-leader:${hall!.locationId}`, speciesId: hallLeader.speciesId, name: getSpecies(hallLeader.speciesId).name, level: hallLeader.level, hp: 1, maxHp: 1, x: hall!.leader.x, z: hall!.leader.z - 3.2, heading: 0 as WorldHeading, action: 'idle' as const, displayHeight: pokemonDisplayHeight(hallLeader.speciesId), movementSpeed: 0 }] : [])
        .concat(this.multiplayer?.creatures(this.simulation.player, id => movementSpeed(id)) ?? []),
    };
  }

  private presence() {
    const game = this.options.game, battle = game.battle;
    const lead = battle?.player.team[battle.player.activeIndex] ?? game.player.team[firstUsableRegionalTeamIndex(game, this.simulation.regionId)] ?? game.player.team[0];
    const player = this.simulation.player, now = performance.now();
    if (player.x !== this.lastPresence.x || player.z !== this.lastPresence.z) { this.lastPresence = { x: player.x, z: player.z }; this.movingUntil = now + 300; }
    return { region: this.simulation.regionId as CampaignRegion, sceneId: this.simulation.sceneId, speciesId: lead.speciesId, x: player.x, z: player.z, heading: player.heading,
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

  /** Region and cave maps turn in quarter steps so the square relief never shows tilted corners. */
  private get svgRotation(): number { return cameraMapRotation(CARDINAL_CAMERA_HEADINGS[nearestMapOrientation(this.cameraHeading)]); }

  private mapPeers(project: (x: number, z: number) => { x: number; y: number } = this.mapProjection ?? ((x, z) => this.mapPoint(x, z, 240, this.svgRotation))): string {
    return (this.multiplayer?.view.players ?? []).map(player => { const marker = project(player.x, player.z); return `<g class="map-trainer" data-map-player="${escape(player.id)}"><circle cx="${marker.x}" cy="${marker.y}" r="${player.id === this.trackedPlayerId ? 4 : 2.8}" fill="#45d7ec" stroke="#123c48" stroke-width=".7"/><title>${escape(player.name)} · ${escape(this.simulation.locationAt(player.x, player.z).name)}</title>${player.id === this.trackedPlayerId ? `<text x="${marker.x + 5}" y="${marker.y - 2}" fill="#123c48">${escape(player.name)}</text>` : ''}</g>`; }).join('');
  }

  private updateMapOrientation(): void {
    if (!this.host) return;
    const current = nearestMapOrientation(this.cameraHeading);
    this.host.querySelectorAll<HTMLButtonElement>('[data-map-orientation]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mapOrientation === current)));
    this.html('#world-minimap-heading', compassLabel(current));
  }

  private resizeMinimap(direction: -1 | 1): void {
    const sizes = ['small', 'medium', 'large'] as const;
    const next = Math.max(0, Math.min(sizes.length - 1, sizes.indexOf(this.minimapSize) + direction));
    this.minimapSize = sizes[next];
    const radar = this.host?.querySelector<HTMLElement>('.world-radar');
    if (!radar) return;
    radar.dataset.size = this.minimapSize;
    const labels = { small: '작게', medium: '보통', large: '크게' } as const;
    this.html('#world-minimap-size', labels[this.minimapSize]);
    this.button('#world-minimap-smaller').disabled = next === 0;
    this.button('#world-minimap-larger').disabled = next === sizes.length - 1;
    requestAnimationFrame(() => { this.syncMinimapResolution(); this.minimap(); });
  }

  private mapPoint(x: number, z: number, size = 240, rotation = cameraMapRotation(this.cameraHeading)): { x: number; y: number } {
    return rotateMapPoint(this.mapCoordinate(x, size), this.mapCoordinate(z, size), size, rotation);
  }

  private mapCompass(size: number): string {
    const positions = [
      ['북', size / 2, 13], ['동', size - 13, size / 2], ['남', size / 2, size - 12], ['서', 13, size / 2],
    ] as const;
    return `<g class="world-map-compass" aria-label="현재 지도 방위">${positions.map(([label, x, y]) => { const marker = rotateMapPoint(x, y, size, this.svgRotation); return `<text x="${marker.x}" y="${marker.y}">${label}</text>`; }).join('')}<circle cx="${size / 2}" cy="${size / 2}" r="3"/><title>화면 위: ${compassLabel(nearestMapOrientation(this.cameraHeading))}</title></g>`;
  }

  private resetMapView(): void {
    const svg = this.host?.querySelector<SVGSVGElement>('#world-map-content svg');
    const width = Number(svg?.dataset.mapWidth ?? 240), height = Number(svg?.dataset.mapHeight ?? 240);
    this.mapView = { sceneId: `${this.simulation.regionId}:${this.simulation.sceneId}`, zoom: 1, centerX: width / 2, centerY: height / 2 };
  }

  private applyMapView(): void {
    const svg = this.host?.querySelector<SVGSVGElement>('#world-map-content svg'); if (!svg) return;
    const width = Number(svg.dataset.mapWidth ?? 240), height = Number(svg.dataset.mapHeight ?? 240);
    const viewWidth = width / this.mapView.zoom, viewHeight = height / this.mapView.zoom;
    this.mapView.centerX = Math.min(width - viewWidth / 2, Math.max(viewWidth / 2, this.mapView.centerX));
    this.mapView.centerY = Math.min(height - viewHeight / 2, Math.max(viewHeight / 2, this.mapView.centerY));
    svg.setAttribute('viewBox', `${this.mapView.centerX - viewWidth / 2} ${this.mapView.centerY - viewHeight / 2} ${viewWidth} ${viewHeight}`);
    this.button('#world-map-zoom-out').disabled = this.mapView.zoom <= 1;
    this.button('#world-map-zoom-in').disabled = this.mapView.zoom >= 4;
    this.button('#world-map-reset').textContent = this.mapView.zoom === 1 ? '초기화' : `${Math.round(this.mapView.zoom * 100)}% · 초기화`;
  }

  private setMapZoom(zoom: number): void {
    this.mapView.zoom = Math.min(4, Math.max(1, zoom)); this.applyMapView();
  }

  private mapEventPoint(svg: SVGSVGElement, event: MouseEvent | PointerEvent): DOMPoint {
    const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
    return point.matrixTransform(svg.getScreenCTM()!.inverse());
  }

  private mapWorldPoint(svg: SVGSVGElement, point: DOMPoint): { x: number; z: number } | undefined {
    const unrotated = unrotateMapPoint(point.x, point.y, 240, this.svgRotation);
    if (svg.dataset.mapMode === 'cave') {
      const extent = Number(svg.dataset.mapExtent); if (!Number.isFinite(extent)) return;
      return { x: unrotated.x / 240 * extent - extent / 2, z: unrotated.y / 240 * extent - extent / 2 };
    }
    const centerX = Number(svg.dataset.mapCenterX), centerZ = Number(svg.dataset.mapCenterZ), scale = Number(svg.dataset.mapScale);
    if (![centerX, centerZ, scale].every(Number.isFinite) || scale <= 0) return;
    return { x: (unrotated.x - 120) / scale + centerX, z: (unrotated.y - 120) / scale + centerZ };
  }

  /** Visited towns are fast-travel targets, also from the middle of a wild battle. */
  private teleportFromMap(townId: string): boolean {
    const world = this.simulation, inBattle = !!this.options.game.battle;
    if (world.atlas.locations.find(item => item.id === townId)?.kind !== 'town' || !world.teleportToTown(townId, true)) return false;
    this.host!.querySelector<HTMLDialogElement>('#world-map-dialog')!.close();
    this.options.notify('안전한 마을 입구로 이동했습니다.');
    // An immediate save reports its own failure; a battle that just ended must not replay on reload.
    void Promise.resolve(this.options.changed(inBattle)).catch(() => undefined); this.refresh(); this.renderer?.update();
    return true;
  }

  private bindMapNavigation(): void {
    const svg = this.host?.querySelector<SVGSVGElement>('#world-map-content svg'); if (!svg) return;
    if (this.mapView.sceneId !== `${this.simulation.regionId}:${this.simulation.sceneId}`) this.resetMapView();
    this.applyMapView();
    const navigate = (target: Element, event?: MouseEvent) => {
      if (this.suppressMapClick) return;
      const marker = target.closest<SVGGElement>('.world-map-point');
      if (marker?.dataset.locationId && event && marker.dataset.navigate !== 'true') {
        const id = marker.dataset.locationId, now = performance.now(), last = this.lastMapTap;
        this.lastMapTap = { id, at: now };
        if (last?.id === id && now - last.at < 450 && this.teleportFromMap(id)) return;
      }
      if (marker?.dataset.locationId && marker.dataset.navigate !== 'true') { this.mapSelection = marker.dataset.locationId; this.drawRegionMap(); return; }
      if (marker?.dataset.lockReason) { this.options.notify(marker.dataset.lockReason); return; }
      const road = target.closest<SVGLineElement>('.world-map-road-hit');
      const clicked = event && !marker ? this.mapWorldPoint(svg, this.mapEventPoint(svg, event)) : undefined;
      const cave = getCaveScene(this.simulation.sceneId), badges = getRegionalBadges(this.options.game, this.simulation.regionId as CampaignRegion);
      const x = marker ? Number(marker.dataset.mapX) : road ? Number(road.dataset.mapX) : clicked?.x;
      const z = marker ? Number(marker.dataset.mapZ) : road ? Number(road.dataset.mapZ) : clicked?.z;
      if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z) || !this.walkableBattle || this.options.game.captureOffer) return;
      const destination = cave ? (!this.simulation.sampleWorld(x, z).blocked ? { x, z } : undefined) : this.simulation.atlas.nearestWalkable(x, z, badges);
      if (!destination) { this.options.notify('현재 위치에서는 통행 가능한 길을 찾지 못했습니다.', true); return; }
      if (!this.simulation.modelsReady) {
        const companion = this.simulation.entities.find(entity => entity.kind === 'companion');
        this.options.notify(this.simulation.modelStatus(companion?.id ?? '') === 'failed' ? '파트너 3D 모델을 불러오지 못해 이동할 수 없습니다. 모델을 다시 불러와 주세요.' : '파트너 3D 모델을 불러오는 중입니다. 준비되면 다시 이동해 주세요.', true);
        return;
      }
      const dialog = this.host!.querySelector<HTMLDialogElement>('#world-map-dialog')!; dialog.close();
      if (!this.renderer?.navigateTo(destination)) { dialog.showModal(); this.options.notify('현재 위치에서 이어지는 도보 경로가 없습니다.', true); return; }
      const name = marker?.dataset.locationId ? this.simulation.atlas.locations.find(item => item.id === marker.dataset.locationId)?.name : '선택한 도로';
      this.options.notify(`${name ?? '선택한 지점'}까지 길찾기를 시작합니다.`);
    };
    svg.onclick = event => navigate(event.target as Element, event);
    svg.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigate(event.target as Element); } };
    svg.onpointerdown = event => { if (event.button !== 0) return; this.mapDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false }; };
    svg.onpointermove = event => {
      const drag = this.mapDrag; if (!drag || drag.pointerId !== event.pointerId) return;
      const distanceX = event.clientX - drag.x, distanceY = event.clientY - drag.y;
      if (Math.hypot(distanceX, distanceY) > 3 && !drag.moved) { drag.moved = true; svg.setPointerCapture(event.pointerId); }
      if (drag.moved) {
        const box = svg.getBoundingClientRect(), width = Number(svg.dataset.mapWidth ?? 240), height = Number(svg.dataset.mapHeight ?? 240);
        this.mapView.centerX -= distanceX / box.width * width / this.mapView.zoom;
        this.mapView.centerY -= distanceY / box.height * height / this.mapView.zoom;
        drag.x = event.clientX; drag.y = event.clientY; this.applyMapView();
      }
    };
    svg.onpointerup = event => {
      if (!this.mapDrag || this.mapDrag.pointerId !== event.pointerId) return;
      this.suppressMapClick = this.mapDrag.moved; this.mapDrag = undefined;
      window.setTimeout(() => { this.suppressMapClick = false; }, 0);
    };
    svg.onpointercancel = () => { this.mapDrag = undefined; this.suppressMapClick = false; };
    svg.onwheel = event => { event.preventDefault(); this.setMapZoom(this.mapView.zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2)); };
  }

  private openTrainerBattles(): void {
    const world = this.simulation, game = this.options.game;
    const location = world.locationAt(world.player.x, world.player.z);
    const trainers = fieldTrainersAt(world.regionId, location.id);
    const blocked = Boolean(game.battle || game.captureOffer || !game.player.team.some(monster => monster.hp > 0));
    this.html('#world-trainer-description', `${escape(location.name)}의 상대에게 도전하세요. 승리하면 경험치와 상금을 받습니다.`);
    this.html('#world-trainer-list', trainers.length ? trainers.map(trainer => {
      const defeated = game.defeatedFieldTrainers?.includes(trainer.id);
      return `<article class="world-trainer-card"><div><strong>${escape(trainer.name)}</strong><small>${escape(trainer.trainerClass)} · ${trainer.trainerOrigin === 'source' ? '크리스탈 원본 편성' : '게임용 추가 대전'}</small><p>${trainer.team.map(([id, level]) => `${escape(getSpecies(id).name)} Lv.${level}`).join(' · ')}</p><small>상금 ${trainer.reward.toLocaleString()}원</small></div><button data-trainer-battle="${escape(trainer.id)}" ${defeated || blocked ? 'disabled' : ''}>${defeated ? '승리 완료' : '도전'}</button></article>`;
    }).join('') : '<p class="world-trainer-empty">이 구역에는 대전 상대가 없습니다. 가까운 마을이나 도로에서 도전하세요.</p>');
    this.host!.querySelector<HTMLDialogElement>('#world-trainer-dialog')!.showModal();
  }

  refresh(): void {
    this.options.musicChanged?.();
    if (!this.host?.querySelector('#ow-host')) return;
    const game = this.options.game, world = this.simulation, battle = game.battle;
    if (battle && battle !== this.previousBattle) {
      playGameSound('encounter', { speciesId: battle.enemy.team[battle.enemy.activeIndex].speciesId });
    }
    this.previousBattle = battle;
    this.multiplayer?.update(this.presence());
    this.renderRealtime();
    const campaignTrainer = battle?.trainerId ? getFieldTrainer(battle.trainerId) ?? CAMPAIGN_TRAINERS.find(item => item.id === battle.trainerId) : undefined;
    const host = this.host.querySelector<HTMLElement>('#ow-host')!;
    host.dataset.runtime = 'gaesup-world'; host.dataset.graphId = this.options.graph.id;
    host.dataset.region = world.regionId;
    this.text('#world-explore-short', world.atlas.name);
    this.html('#world-map-caption', `${world.atlas.name} 지도 ↗`);
    this.html('#world-map-note', '지점을 선택해 출현 포켓몬·도구를 확인하세요. ◇ 길가 물품');
    for (const [id, value] of [['world-region', world.regionId]]) {
      const select = this.host.querySelector<HTMLSelectElement>(`#${id}`)!; if (select.value !== value) select.value = value;
      select.disabled = Boolean(battle || game.captureOffer);
    }
    host.dataset.tick = String(world.tick); host.dataset.paused = String(this.paused);
    this.refreshRecovery();
    const lead = battle ? battle.player.team[battle.player.activeIndex] : game.player.team[firstUsableRegionalTeamIndex(game, world.regionId)] ?? game.player.team[0];
    const serverReceipt = lastServerDecision(lead.instanceId);
    this.html('#world-learning-label', serverReceipt ? `기술 학습 · ${serverReceipt.updates}회` : '기술 학습');
    this.html('.world-battle-hud > summary strong', `<span class="world-summary-name">${escape(pokemonPresentation(lead, battle).name)} · Lv.${lead.level}</span><span class="world-summary-hp">HP ${lead.hp} / ${battleMonsterMaxHp(battle, lead)}</span>`);
    const enemy = battle?.enemy.team[battle.enemy.activeIndex];
    const transformed = battle?.transformations?.[lead.instanceId];
    const species = getSpecies(transformed?.speciesId ?? lead.speciesId), moves = transformed?.moves ?? lead.moves;
    const xpStart = experienceAtLevel(lead.level, species.growthRate), xpEnd = experienceAtLevel(lead.level + 1, species.growthRate);
    const xp = Math.min(100, Math.max(0, (lead.xp - xpStart) / Math.max(1, xpEnd - xpStart) * 100));
    const card = (mon: Monster, label: string) => {
      const info = pokemonPresentation(mon, battle);
      return `<div class="world-combatant"><img src="${info.sprite}" alt="${escape(info.name)}"><div class="world-combatant-copy"><small>${label} · Lv.${mon.level}</small><strong>${escape(info.name)}</strong><div class="world-hp-row"><span>HP</span><b>${mon.hp} / ${info.stats.hp}</b>${statusLabel(mon.status) ? `<em>${statusLabel(mon.status)}</em>` : ''}</div><div class="world-hp" role="meter" aria-label="${escape(mon.nickname)} HP" aria-valuemin="0" aria-valuemax="${info.stats.hp}" aria-valuenow="${mon.hp}"><i style="width:${mon.hp / info.stats.hp * 100}%"></i></div><span class="world-combatant-meta">${info.types.map(type => types[type]).join(' · ')} · 스피드 ${info.stats.speed}</span></div></div>`;
    };
    const enemyParty = battle && battle.kind !== 'wild' ? `<ol class="world-enemy-party" aria-label="상대 포켓몬">${battle.enemy.team.map((monster, index) => `<li class="${monster.hp <= 0 ? 'fainted' : ''}${index === battle.enemy.activeIndex ? ' active' : ''}"><img src="${pokemonSpriteUrl(monster.speciesId)}" alt="${escape(monster.nickname)} Lv.${monster.level}" title="${escape(monster.nickname)} Lv.${monster.level}"></li>`).join('')}</ol>` : '';
    this.html('#world-combatants', `${card(lead, '파트너')}${enemy ? card(enemy, battle!.kind === 'wild' ? '야생' : campaignTrainer?.name ?? getCampaignGyms(game, battle!.campaignRegion ?? world.regionId).find(item => item.badge === battle!.gymBadge)?.name ?? '체육관') + enemyParty : `<div class="world-growth"><small>다음 레벨까지 ${Math.max(0, xpEnd - lead.xp)} EXP</small><div class="world-xp"><i style="width:${xp}%"></i></div><span>${species.moves.filter(move => move.level > lead.level).slice(0, 1).map(move => `Lv.${move.level} ${getMove(move.moveId).name} 습득`).join('') || '현재 레벨의 기술을 모두 익혔습니다.'}</span></div>`}`);
    const moveLayout = getMoveLayout({ ...lead, moves });
    this.button('#world-edit-moves').disabled = !this.options.editMoves;
    this.html('#world-transformations', battleTransformationsHtml(game, this.recovering));
    this.host.querySelectorAll<HTMLButtonElement>('[data-battle-transformation]').forEach(button => button.onclick = async () => {
      const paused = this.paused, currentBattle = game.battle;
      const formIdentifier = this.host!.querySelector<HTMLSelectElement>('[data-mega-form]')?.value;
      button.disabled = true;
      try {
        await this.pauseAndSettle();
        if (currentBattle !== game.battle) throw new Error('전투가 바뀌었습니다.');
        this.simulation.transformBattle('mega', { formIdentifier });
        await this.options.changed(true);
      } catch (error) { this.options.notify(error instanceof Error ? error.message : String(error), true); }
      finally { this.paused = paused; this.refresh(); this.renderer?.update(); }
    });
    this.html('#world-moves', Array.from({ length: 4 }, (_, index) => {
      const slot = moveLayout[index]; if (!slot) return `<div class="world-move empty-slot"><span>${index + 1}</span><strong>미습득</strong><small>레벨을 올려 기술을 익히세요</small></div>`;
      const move = battle ? battleMoveView(battle, lead, slot.moveId) : getMove(slot.moveId);
      return `<button data-world-move="${slot.sourceIndex}" data-world-slot="${index}" data-world-move-id="${slot.moveId}" class="world-move type-${move.type}" ${!battle || (battle.choiceLocks?.[lead.instanceId] !== undefined && battle.choiceLocks[lead.instanceId] !== slot.moveId) ? 'disabled' : ''} title="${move.damageClass === 'physical' ? '물리' : move.damageClass === 'special' ? '특수' : '변화'} · 우선도 ${move.priority} · 위력 ${move.power || '—'} · 명중 ${move.accuracy || '—'} · 클릭하면 다음 턴에 사용"><span>${index + 1} · ${types[move.type]}</span><strong>${move.name}</strong><small><span class="move-details">위력 ${move.power || '—'} · 명중 ${move.accuracy || '—'}</span></small></button>`;
    }).join(''));
    this.html('#world-emergency-action', battle && !battle.awaitingSwitch && (!moves.length || (battle.choiceLocks?.[lead.instanceId] !== undefined && !moves.some(slot => slot.moveId === battle.choiceLocks![lead.instanceId]))) ? '<button id="world-struggle">발버둥</button>' : '');
    const location = this.simulation.locationAt(world.player.x, world.player.z);
    const region = world.regionId as CampaignRegion;
    const switchPanel = this.host.querySelector<HTMLDetailsElement>('.world-switch')!;
    switchPanel.hidden = !battle;
    if (battle) {
      this.html('#world-switch-options', battle.player.team.map((monster, index) => {
        const current = index === battle.player.activeIndex;
        const reason = current ? '현재 출전' : monster.hp <= 0 ? '기절' : battle.policyRegion ? monsterRegionalUseReason(game, battle.policyRegion, monster) : undefined;
        return `<button data-world-switch="${index}" ${reason ? `disabled title="${escape(reason)}"` : ''}><img src="${pokemonSpriteUrl(monster.speciesId)}" alt=""><span><strong>${escape(monster.nickname)} · Lv.${monster.level}</strong><small>HP ${monster.hp}/${battleMonsterMaxHp(game.battle, monster)}${statusLabel(monster.status) ? ` · ${statusLabel(monster.status)}` : ''}</small></span><b>${escape(reason ?? '교체')}</b></button>`;
      }).join(''));
      if (battle.awaitingSwitch) switchPanel.open = true;
    }
    this.text('#world-location-short', location.name);
    host.dataset.scene = world.sceneId;
    this.html('#world-position', `${world.player.x.toFixed(0)}, ${world.player.z.toFixed(0)}`);
    this.html('#world-feed', game.logs.slice(-3).map(log => `<p>${escape(log)}</p>`).join(''));
    this.html('#world-battle-state', game.captureOffer ? '승리! 포획 여부를 선택하세요' : battle ? `${battle.awaitingSwitch ? '교체할 포켓몬 선택' : world.escaping ? '도망 시도 중' : world.controlMode === 'manual' ? '기술 선택 대기' : '자동 배틀'} · 턴 ${battle.turn}` : this.paused ? '탐험 일시 정지' : world.controlMode === 'manual' ? '수동 탐험 · 배틀 버튼으로만 전투' : '가까운 포켓몬 추적 · 접근하면 배틀');
    this.button('#world-mode-auto').setAttribute('aria-pressed', String(world.controlMode === 'auto'));
    this.button('#world-mode-manual').setAttribute('aria-pressed', String(world.controlMode === 'manual'));
    this.html('#world-control-title', world.controlMode === 'manual' ? '수동 이동' : '자동 이동 · 배틀');
    this.html('#world-control-help', world.controlMode === 'manual' ? (battle || game.captureOffer ? '기술 1–4 · M 전환' : location.kind === 'town' ? '마을에서는 수동 이동 유지 · M 전환' : '이동을 멈추면 자동 전환') : '가까운 포켓몬 자동 배틀');
    const offer = game.captureOffer, offerNode = this.host.querySelector<HTMLElement>('#world-capture-offer')!;
    offerNode.hidden = !offer;
    if (offer) {
      this.html('#world-capture-offer', `<img src="${pokemonSpriteUrl(offer.speciesId)}" alt=""><div><small>배틀 승리 · Lv.${offer.level}</small><strong>${escape(offer.nickname)}을(를) 잡을까요?</strong><p>몬스터볼 무제한 · ${game.player.team.length < 6 ? '팀에 합류' : '박스로 이동'}</p><button id="world-win-catch">몬스터볼로 잡기</button><button id="world-win-release">놓아주고 계속</button></div>`);
      this.button('#world-win-catch').onclick = () => this.catchVictory();
      this.button('#world-win-release').onclick = () => { world.releaseVictory(); this.options.changed(); this.refresh(); };
    }
    const cave = getCaveScene(world.sceneId), hall = getGymScene(world.sceneId);
    // Doorways behind a gate the badges have not opened stay shut.
    const nearExit = cave ? cavePortalAtInterior(world.sceneId, world.player.x, world.player.z) : undefined;
    const exitPortal = nearExit && world.doorwayOpen(cave!, nearExit) ? nearExit : undefined;
    const stairs = cave && !exitPortal ? caveStairsAt(world.sceneId, world.player.x, world.player.z) : undefined;
    const nearEntrance = !cave && !hall ? cavePortalAtSurface(region, world.player.x, world.player.z) : undefined;
    const entrance = nearEntrance && world.doorwayOpen(nearEntrance.scene, nearEntrance.portal) ? nearEntrance : undefined;
    const portal = exitPortal ?? stairs ?? entrance;
    const exits = world.caveExits(), exitHost = this.host.querySelector<HTMLElement>('#world-cave-exits')!;
    exitHost.hidden = !cave && !hall;
    if (hall) {
      this.html('#world-cave-exits', `<button id="world-gym-exit" ${battle || offer ? 'disabled' : ''}>${hall.kind === 'league' ? '나가기' : '체육관 나가기'}</button>`);
      this.button('#world-gym-exit').onclick = () => { if (world.exitGym()) this.afterSceneChange(); };
    }
    if (cave) {
      this.html('#world-cave-exits', `<button id="world-cave-exit" ${battle || offer ? 'disabled' : ''}>${cave.kind === 'cave' ? '동굴 밖으로 나가기' : '나가기'}</button>${exits.length > 1 ? `<select id="world-cave-exit-choice" aria-label="나갈 출구">${exits.map(exit => `<option value="${escape(exit.id)}">${escape(exit.label)}</option>`).join('')}</select>` : ''}`);
      this.button('#world-cave-exit').onclick = () => {
        const chosen = this.host?.querySelector<HTMLSelectElement>('#world-cave-exit-choice')?.value;
        if (world.exitCave(chosen)) { world.setControlMode('manual'); this.afterPortal(); if (cave.kind === 'cave') this.options.notify('동굴 밖으로 나왔습니다.'); }
      };
    }
    // A completed gym and the league can share a location (Hisui's temple).
    // The next available final must take precedence over the completed trial.
    const next = !battle && !offer && !hall && !cave ? this.nextChallenge() : undefined, notice = this.button('#world-gym-notice');
    if (notice.hidden !== !next) notice.hidden = !next;
    if (next) this.html('#world-gym-notice', `${next.speciesId ? `<img src="${pokemonSpriteUrl(next.speciesId)}" alt="">` : ''}<span><strong>${escape(next.title)}</strong><small>${escape(next.detail)}</small></span>`);
    const portalLabel = exitPortal ? `${escape(cave!.dungeonName)} · 밖으로 나가기` : stairs ? `${stairs.direction === 'up' ? '▲' : '▼'} ${escape(stairs.targetLabel)}`
      : entrance?.scene.kind === 'cave' ? '동굴 들어가기' : `${escape(entrance?.scene.dungeonName ?? '')} 들어가기`;
    this.html('#world-gym', (portal ? `<button id="world-cave-enter" ${battle || offer ? 'disabled' : ''}>${portalLabel}</button>` : ''));
    if (portal) {
      this.button('#world-cave-enter').onclick = () => { if (world.traverseCavePortal()) this.afterPortal(); };
    }
    const respawns = world.respawnQueue;
    this.html('#world-respawn', respawns.length && world.sceneHasWilds ? `${respawns.length}마리 리젠 대기 · ${Math.ceil(Math.min(...respawns.map(spawn => spawn.remainingSeconds)))}초` : '');
    this.button('#world-catch').disabled = !offer && battle?.kind !== 'wild';
    for (const item of ['potion', 'super-potion'] as const) {
      const button = this.button(`#world-${item}`);
      button.disabled = !battle || game.inventory[item] <= 0 || lead.hp <= 0 || lead.hp >= battleMonsterMaxHp(battle, lead);
      button.textContent = `${ITEM_LABELS[item]} ×${game.inventory[item]}`;
      button.title = `HP +${HEALING_ITEM_HP[item]}`;
    }
    this.button('#world-run').disabled = !battle?.canRun;
    this.button('#world-heal').disabled = Boolean(battle);
    this.button('#world-trainer-open').disabled = Boolean(battle || offer);
    this.button('#world-pause').textContent = this.paused ? '▶ 계속 탐험' : 'Ⅱ 일시 정지';
    this.input('#world-auto-catch').checked = world.autoCapture;
    this.input('#world-exp-share').checked = game.experienceShare !== false;
    const ledger = world.rewardLedgers[lead.instanceId], signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
    const rewardNames = { engagement: '조우', damageDealt: '공격', damageReceived: '피해', typeChoice: '상성', outcome: '승패', growth: '레벨 성장', evolution: '진화' };
    this.html('#world-rewards', ledger ? `<strong>누적 ${signed(ledger.lifetime.total)} · ${ledger.lifetime.events}회</strong><p>${Object.entries(rewardNames).map(([key, label]) => `${label} ${signed(ledger.lifetime.componentTotals[key as keyof typeof rewardNames])}`).join(' · ')}</p><small>최근: ${ledger.latest.at(-1)?.learningEligible ? '자동 행동 학습 반영' : '관찰 기록 · 가중치 갱신 없음'}</small>` : '<p>배틀과 성장 결과가 이 개체의 기록에 쌓입니다.</p>');
    const target = world.entities.find(entity => entity.id === world.selectedWildId && entity.kind === 'wild'), targetNode = this.host.querySelector<HTMLElement>('#world-target')!;
    targetNode.hidden = !target || !world.selectionPinned || Boolean(battle || offer);
    if (target && !targetNode.hidden) {
      const info = getSpecies(target.speciesId), distance = Math.hypot(target.x - world.player.x, target.z - world.player.z), targetHp = statsFor(info, target.level).hp;
      const modelStatus = world.modelStatus(target.id);
      this.html('#world-target-info', `<strong>${escape(info.name)} · Lv.${target.level}</strong><small><b>${modelStatus === 'failed' ? '모델 오류 · 정지됨' : modelStatus === 'loading' ? '모델 확인 중 · 정지됨' : world.trackingSelected ? '추적 중' : '선택됨'}</b> · ${distance.toFixed(1)}m · HP ${targetHp} / ${targetHp}</small>`);
      this.html('#world-target-detail', `${info.types.map(type => types[type]).join(' / ')} · 이동 ${movementSpeed(target.speciesId, target.level).toFixed(1)}m/s`);
      this.button('#world-target-track').textContent = world.trackingSelected ? '목표 해제' : '목표로 고정';
      this.button('#world-target-track').setAttribute('aria-pressed', String(world.trackingSelected));
      this.button('#world-target-track').disabled = Boolean(modelStatus);
      this.button('#world-target-battle').disabled = Boolean(modelStatus);
      this.button('#world-target-battle').textContent = modelStatus ? '모델 확인 필요' : world.canEngageWild(target.id) ? '배틀' : '접근 후 배틀';
    }
    const guide = this.destinationGuide();
    this.html('#world-next-guide', `<span class="world-guide-symbol" aria-hidden="true">›</span><span><small>목적지${guide.recommendedLevel ? ` · Lv.${guide.recommendedLevel}` : ''}</small><strong>${escape(guide.title)}</strong><span class="world-guide-detail">${escape(guide.detail)}</span></span><b aria-hidden="true">${this.compactViewport.matches && this.button('#world-next-guide').dataset.expanded !== 'true' ? '상세' : '지도'}</b>`);
    const guideNode = this.host.querySelector<HTMLElement>('#world-next-guide')!;
    if (guideNode.dataset.status !== guide.status) guideNode.dataset.status = guide.status;
    const pickedUp = this.simulation.drainItemDropEvents();
    if (pickedUp.length) { this.options.notify(pickedUp.map(event => event.message).join(' · ')); playGameSound('select'); this.options.changed(); }
    if (this.terrainAtlas !== world.atlas) {
      // Prepare the relief in idle slices before the first map open.
      this.terrainAtlas = world.atlas; const atlas = world.atlas;
      void prepareAtlasTerrain(atlas).then(() => { if (this.simulation.atlas === atlas) this.minimap(); });
    }
    this.renderBag(); this.minimap(); this.renderer?.update(); this.offerRegionalStarter();
  }

  /** Owned equipment, what the team holds, and roadside items on this map. */
  private renderBag(): void {
    const bag = this.host?.querySelector<HTMLDetailsElement>('#world-bag'); if (!bag) return;
    const game = this.options.game, world = this.simulation, player = world.player;
    const owned = FIELD_ITEMS.filter(item => (game.inventory[item.id] ?? 0) > 0);
    const pickups = world.fieldPickups.map(item => ({ item, distance: Math.hypot(item.x - player.x, item.z - player.z) })).sort((a, b) => a.distance - b.distance);
    const machines = technicalMachines().filter(machine => (game.technicalMachines?.[String(machine.moveId)] ?? 0) > 0);
    this.html('#world-bag-count', String(owned.reduce((sum, item) => sum + game.inventory[item.id], 0) + game.player.team.filter(monster => monster.heldTool).length
      + machines.reduce((sum, machine) => sum + game.technicalMachines![String(machine.moveId)], 0)));
    const near = pickups.some(row => row.distance <= 30);
    if (bag.dataset.nearby !== String(near)) bag.dataset.nearby = String(near);
    if (!bag.open) return;
    const compass = (x: number, z: number) => ['북', '북동', '동', '남동', '남', '남서', '서', '북서'][(Math.round(Math.atan2(x - player.x, player.z - z) / (Math.PI / 4)) + 8) % 8];
    const walking = this.walkableBattle && !game.captureOffer, editing = !game.battle && !game.captureOffer && !!this.options.editMoves;
    const groups = [['battle', '장착 도구'], ['berry', '열매'], ['support', '보조'], ['mega-stone', '메가진화석']] as const;
    const describe = (id: string) => HELD_TOOL_DESCRIPTIONS[id as HeldTool] ?? '';
    const pickupRows = pickups.map(({ item, distance }) => `<button type="button" class="bag-pickup kind-${item.kind}" data-bag-pickup="${escape(item.id)}" ${walking ? '' : 'disabled'}><span>${escape(item.name)}</span><small>${compass(item.x, item.z)} ${Math.round(distance)}m</small></button>`).join('');
    const teamRows = game.player.team.map(monster => `<button type="button" data-bag-member="${escape(monster.instanceId)}" ${editing ? '' : 'disabled'} title="${escape(monster.heldTool ? describe(monster.heldTool) : '')}"><img src="${pokemonSpriteUrl(monster.speciesId)}" alt=""><span>${escape(monster.nickname)}</span><small>${monster.heldTool ? escape(ITEM_LABELS[monster.heldTool]) : '없음'}</small></button>`).join('');
    const ownedRows = groups.map(([group, label]) => {
      const rows = owned.filter(item => (item.kind === 'mega-stone' ? 'mega-stone' : item.category) === group);
      return rows.length ? `<h4>${label}</h4>${rows.map(item => `<p title="${escape(describe(item.id))}"><span>${escape(item.name)}</span><b>×${game.inventory[item.id]}</b></p>`).join('')}` : '';
    }).join('');
    const tabs = `<nav class="world-bag-tabs" role="tablist">${([['tools', '도구'], ['machines', '기술머신']] as const).map(([id, label]) => `<button type="button" role="tab" data-bag-tab="${id}" aria-selected="${this.bagTab === id}">${label}</button>`).join('')}</nav>`;
    if (this.bagTab === 'machines') {
      const machineRows = machines.map(machine => {
        const move = getMove(machine.moveId);
        return `<button type="button" class="bag-machine type-${move.type}" data-bag-machine="${machine.moveId}"><span>${escape(machine.name)}</span><small>${types[move.type]}${move.power ? ` · ${move.power}` : ''}</small><b>×${game.technicalMachines![String(machine.moveId)]}</b></button>`;
      }).join('');
      this.html('#world-bag-content', `${tabs}<section>${machineRows || '<p class="bag-empty">없음</p>'}</section>`);
      return;
    }
    this.html('#world-bag-content', `${tabs}<section><h3>주변</h3>${pickupRows || '<p class="bag-empty">없음</p>'}</section><section><h3>팀</h3>${teamRows}</section><section><h3>가방</h3>${ownedRows || '<p class="bag-empty">없음</p>'}</section>`);
  }

  private openMachines(moveId?: number): void {
    const game = this.options.game;
    const lead = game.battle?.player.team[game.battle.player.activeIndex] ?? game.player.team[firstUsableRegionalTeamIndex(game, this.simulation.regionId)] ?? game.player.team[0];
    openMachineDialog({ game, instanceId: lead?.instanceId, moveId, notify: this.options.notify,
      applied: async () => { this.simulation.reconcileTeamChange(); await this.options.changed(true); this.renderBag(); this.refresh(); } });
  }

  private drawRegionMap(): void {
    const world = this.simulation, rotation = this.svgRotation, point = (x: number, z: number) => this.mapPoint(x, z, 240, rotation);
    const cave = getCaveScene(world.sceneId);
    this.host!.querySelector<HTMLElement>('#world-map-searchbar')!.hidden = !!cave;
    // Heading of the camera relative to the quarter-turned map.
    const facing = (rotation - cameraMapRotation(this.cameraHeading)) * 180 / Math.PI;
    if (cave) {
      this.mapProjection = point;
      this.html('#world-map-region-name', `${world.atlas.name} · ${cave.name}`);
      this.html('#world-campaign-guide', `<p><b>${escape(cave.name)}</b> · 출구까지 통로를 따라 이동하세요.</p>`);
      this.html('#world-travel', '');
      const extent = Math.max(cave.width, cave.depth) + 4, player = point(world.player.x, world.player.z);
      this.html('#world-map-content', `<svg viewBox="0 0 240 240" data-map-width="240" data-map-height="240" data-map-mode="cave" data-map-extent="${extent}" role="img" aria-label="${escape(cave.name)} 내부 지도. 확대하거나 드래그하고 통행 가능한 곳을 선택해 이동하세요."><rect width="240" height="240" rx="8" fill="#a7b3a5"/><g transform="rotate(${rotation * 180 / Math.PI} 120 120)">${cave.wallSegments.map(wall => `<rect x="${this.mapCoordinate(wall.x - wall.width / 2)}" y="${this.mapCoordinate(wall.z - wall.depth / 2)}" width="${wall.width / extent * 240}" height="${wall.depth / extent * 240}" fill="#334a44" transform="rotate(${wall.rotationY * -180 / Math.PI} ${this.mapCoordinate(wall.x)} ${this.mapCoordinate(wall.z)})"/>`).join('')}</g>${cave.portals.map(portal => { const marker = point(portal.interior.x, portal.interior.z); return `<g class="world-map-point traversable" data-map-x="${portal.interior.x}" data-map-z="${portal.interior.z}" tabindex="0" role="button" aria-label="출구로 걸어가기"><circle cx="${marker.x}" cy="${marker.y}" r="5"/><text x="${marker.x + 6}" y="${marker.y - 5}">출구</text></g>`; }).join('')}${cave.stairs.map(stairs => { const marker = point(stairs.interior.x, stairs.interior.z), label = `${stairs.direction === 'up' ? '▲' : '▼'} ${escape(stairs.targetLabel)}`; return `<g class="world-map-point traversable" data-map-x="${stairs.interior.x}" data-map-z="${stairs.interior.z}" tabindex="0" role="button" aria-label="${label}"><rect x="${marker.x - 4.5}" y="${marker.y - 4.5}" width="9" height="9" rx="2"/><text x="${marker.x + 6}" y="${marker.y - 5}">${label}</text></g>`; }).join('')}<g id="world-map-peers">${this.mapPeers(point)}</g>${this.mapCompass(240)}<path class="world-map-player" transform="translate(${player.x} ${player.y}) rotate(${facing})" d="M0,-6 L4,5 L0,3 L-4,5 Z"/></svg>`);
      this.bindMapNavigation();
      return;
    }
    const region = world.regionId as CampaignRegion, atlas = world.atlas;
    const game = this.options.game, badges = getRegionalBadges(game, region);
    const gyms = getCampaignGyms(game, region), nextGym = gyms.find(gym => gym.badge === badges + 1);
    const trainer = badges >= 8 ? getNextCampaignTrainer(game, region) : undefined;
    const places = new Map(atlas.locations.map(item => [item.id, item]));
    const destinationId = trainer?.locationId ?? nextGym?.locationId;
    const destination = destinationId ? places.get(destinationId) : undefined;
    const nextLabel = trainer ? `${trainer.kind === 'red' ? '최종 도전' : trainer.kind === 'champion' ? '챔피언전' : '사천왕전'} · ${trainer.name}` : nextGym ? `${nextGym.badgeName} · ${nextGym.name}` : '이 지역의 주요 도전을 완료했습니다.';
    this.html('#world-map-region-name', `${atlas.name} 지방`);
    this.html('#world-campaign-guide', `<div><span>${atlas.name} 진행</span><strong>배지 ${badges}/8</strong></div><p><b>다음 도전</b> ${escape(nextLabel)}</p><p><b>목적지</b> ${escape(destination?.name ?? '—')}</p>`);
    this.html('#world-travel', atlas.locations.filter(item => item.kind === 'town').map(item => `<button data-world-travel="${item.id}" ${!world.visitedTownIds.includes(item.id) || !this.walkableBattle || game.captureOffer ? 'disabled' : ''}>${item.name}<small>${world.visitedTownIds.includes(item.id) ? '순간이동' : '미방문'}</small></button>`).join(''));
    this.host!.querySelectorAll<HTMLButtonElement>('[data-world-travel]').forEach(button => button.onclick = () => this.teleportFromMap(button.dataset.worldTravel!));
    const { centerX, centerZ, scale: fitScale } = atlasMapProjection(atlas);
    const fullPoint = (x: number, z: number) => rotateMapPoint(120 + (x - centerX) * fitScale, 120 + (z - centerZ) * fitScale, 240, rotation);
    this.mapProjection = fullPoint;
    const lines = atlas.connections.map(([from, to]) => { const a = places.get(from)!, b = places.get(to)!, start = fullPoint(a.x, a.z), end = fullPoint(b.x, b.z), bridge = a.kind === 'sea' || b.kind === 'sea'; return `<line class="world-map-road-shadow" x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}"/><line class="world-map-road ${bridge ? 'bridge' : ''}" x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}"/><line class="world-map-road-hit" x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" data-map-x="${(a.x + b.x) / 2}" data-map-z="${(a.z + b.z) / 2}" aria-label="${escape(a.name)}와 ${escape(b.name)} 사이 도로로 이동"/>`; }).join('');
    const currentLocationId = world.locationAt(world.player.x, world.player.z).id;
    const badgeLabel = region === 'hisui' ? '조사증' : '배지';
    const lockReasons = new Map(atlas.locations.map(item => [item.id, item.requiredBadges > badges
      ? progressionRequirement(item.requiredBadges, badges, atlas.gyms, badgeLabel) : '']));
    const matches = filterMapLocations(atlas, this.mapQuery, this.mapFilter, world.visitedTownIds), matchingIds = new Set(matches.map(item => item.id));
    const selection = places.get(this.mapSelection) ?? places.get(currentLocationId)!;
    this.mapSelection = selection.id;
    const route = regionalItinerary(atlas, currentLocationId, selection.id, badges);
    const routePoints = route.map(id => places.get(id)!).map(item => fullPoint(item.x, item.z));
    const routeHtml = routePoints.length > 1 ? `<polyline class="world-map-route-preview" points="${routePoints.map(item => `${item.x},${item.y}`).join(' ')}"/>` : '';
    const pickupHtml = world.fieldPickups.map(item => { const marker = fullPoint(item.x, item.z); return `<g class="world-map-pickup kind-${item.kind}" data-pickup-id="${item.id}" data-map-x="${item.x}" data-map-z="${item.z}" tabindex="0" role="button" aria-label="${escape(item.name)} 위치"><path transform="translate(${marker.x} ${marker.y})" d="M0,-3 L2.8,0 L0,3 L-2.8,0 Z"/><title>${escape(item.name)} · 길가에서 줍기</title></g>`; }).join('');
    const kindOrder = { special: 4, town: 5, cave: 6, forest: 7, route: 8, sea: 9 } as const, searching = this.mapQuery.trim().length > 0;
    const markers = atlas.locations.map(item => ({ item, ...fullPoint(item.x, item.z) }));
    const labeled = placeMapLabels(markers.map(({ item, x, y }) => ({ id: item.id, name: item.name, x, y,
      priority: item.id === selection.id ? 0 : item.id === currentLocationId ? 1 : item.id === destinationId ? 2 : searching && matchingIds.has(item.id) ? 3 : kindOrder[item.kind] })), 5.4);
    // Document order is paint order: towns and special places sit above the road markers they touch.
    const locations = [...markers].sort((a, b) => kindOrder[b.item.kind] - kindOrder[a.item.kind]).map(({ item, x, y }) => {
      const reason = lockReasons.get(item.id)!;
      return `<g class="world-map-point ${matchingIds.has(item.id) ? 'matched' : 'filtered'} ${item.id === selection.id ? 'selected' : ''} ${reason ? 'blocked' : 'traversable'} kind-${item.kind}" data-map-x="${item.x}" data-map-z="${item.z}" data-location-id="${item.id}" data-lock-reason="${escape(reason)}" tabindex="0" role="button" aria-label="${escape(item.name)} · ${escape(reason || '클릭해 길찾기')}"><circle cx="${x}" cy="${y}" r="${item.kind === 'town' ? 4 : item.kind === 'special' ? 4.5 : 2.7}"/><text class="world-map-symbol" x="${x}" y="${y + 1.6}">${reason ? '🔒' : mapKindSymbol(item.kind)}</text><text class="world-map-label${labeled.has(item.id) ? '' : ' secondary'}" x="${x + 5}" y="${y - 4}">${escape(item.name)}</text><title>${escape(item.name)} · ${escape(reason || '클릭해 길찾기')}</title></g>`;
    }).join('');
    const terrain = cachedAtlasTerrain(atlas);
    if (!terrain) void prepareAtlasTerrain(atlas).then(ready => {
      const image = this.host?.querySelector<SVGImageElement>('#world-map-terrain');
      if (image && this.simulation.atlas === atlas) image.setAttribute('href', ready.url);
    });
    const player = fullPoint(world.player.x, world.player.z), destinationPoint = destination ? fullPoint(destination.x, destination.z) : undefined;
    this.html('#world-map-content', `<svg viewBox="0 0 240 240" data-map-width="240" data-map-height="240" data-map-mode="region" data-map-center-x="${centerX}" data-map-center-z="${centerZ}" data-map-scale="${fitScale}" role="img" aria-label="${atlas.name} 도로·다리·특별 지점 지도. 확대하거나 드래그하고 도로를 선택해 이동하세요."><rect width="240" height="240" rx="8" fill="#bed5c0"/><image id="world-map-terrain" href="${terrain?.url ?? ''}" x="0" y="0" width="240" height="240" preserveAspectRatio="none" transform="rotate(${rotation * 180 / Math.PI} 120 120)" style="pointer-events:none"/><g class="world-map-roads">${lines}</g>${routeHtml}<g class="world-map-locations">${locations}</g>${pickupHtml}<g id="world-map-peers">${this.mapPeers(fullPoint)}</g>${destinationPoint ? `<circle cx="${destinationPoint.x}" cy="${destinationPoint.y}" r="6" fill="none" stroke="#d19c00" stroke-width="2"/><text x="${destinationPoint.x + 7}" y="${destinationPoint.y + 8}">다음</text>` : ''}<path class="world-map-player" transform="translate(${player.x} ${player.y}) rotate(${facing})" d="M0,-6 L4,5 L0,3 L-4,5 Z"/>${this.mapCompass(240)}<text class="world-map-legend" x="8" y="232">◆ 도시 · ● 도로 · ≈ 수로/다리 · ★ 특별 지점 · ◇ 길가 물품</text></svg><aside class="world-map-explorer">${mapLocationDetails(atlas, selection, game, lockReasons.get(selection.id) ?? '', world.visitedTownIds)}${mapLocationList(atlas, matches, selection.id, currentLocationId, destinationId, lockReasons)}</aside>`);
    this.bindMapNavigation();
    this.host!.querySelectorAll<HTMLButtonElement>('[data-map-list-location]').forEach(button => {
      button.onclick = () => { this.mapSelection = button.dataset.mapListLocation!; this.drawRegionMap(); };
    });
    this.button('#world-map-go').onclick = () => {
      const marker = this.host!.querySelector<SVGGElement>(`[data-location-id="${CSS.escape(this.mapSelection)}"]`);
      if (marker) { marker.dataset.navigate = 'true'; marker.dispatchEvent(new MouseEvent('click', { bubbles: true })); delete marker.dataset.navigate; }
    };
    this.host!.querySelectorAll<SVGGElement>('[data-pickup-id]').forEach(marker => {
      const navigate = () => { const item = world.fieldPickups.find(row => row.id === marker.dataset.pickupId); if (!item) return;
        if (!this.walkableBattle || game.captureOffer) return;
        const dialog = this.host!.querySelector<HTMLDialogElement>('#world-map-dialog')!; dialog.close();
        if (!this.renderer?.navigateTo(item)) { dialog.showModal(); this.options.notify('현재 위치에서 이어지는 도보 경로가 없습니다.', true); }
      };
      marker.onclick = event => { event.stopPropagation(); if (!this.suppressMapClick) navigate(); };
      marker.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); navigate(); } };
    });
  }

  /** World units from the player to the minimap rim. */
  private get minimapRadius(): number { return this.minimapSize === 'small' ? 55 : this.minimapSize === 'large' ? 95 : 72; }

  /** Keeps the minimap bitmap at the displayed size so it stays sharp on high-DPI screens. */
  private syncMinimapResolution(): void {
    const canvas = this.host?.querySelector<HTMLCanvasElement>('#world-minimap'); if (!canvas?.clientWidth) return;
    const pixels = Math.max(120, Math.min(420, Math.round(canvas.clientWidth * Math.min(2, window.devicePixelRatio || 1))));
    if (Math.abs(canvas.width - pixels) > 2) { canvas.width = pixels; canvas.height = pixels; this.miniTerrain = undefined; this.minimap(); }
  }

  /** Player-centred circular minimap that turns with the camera. */
  private minimap(): void {
    const canvas = this.host?.querySelector<HTMLCanvasElement>('#world-minimap'); if (!canvas) return;
    const ctx = canvas.getContext('2d')!, size = canvas.width, half = size / 2, unit = size / 180;
    const world = this.simulation, cave = getCaveScene(world.sceneId), rotation = cameraMapRotation(this.cameraHeading);
    const cosine = Math.cos(rotation), sine = Math.sin(rotation), player = world.player;
    let project: (x: number, z: number) => { x: number; y: number };
    ctx.clearRect(0, 0, size, size); ctx.save();
    ctx.beginPath(); ctx.arc(half, half, half - unit, 0, Math.PI * 2); ctx.clip();
    if (cave) {
      if (!this.miniTerrain || this.miniRegion !== world.sceneId) {
        this.miniTerrain = document.createElement('canvas'); this.miniTerrain.width = size; this.miniTerrain.height = size;
        this.miniRegion = world.sceneId; this.drawCaveMinimap(this.miniTerrain.getContext('2d')!, size);
      }
      ctx.fillStyle = '#334a44'; ctx.fillRect(0, 0, size, size);
      ctx.save(); ctx.translate(half, half); ctx.rotate(rotation); ctx.drawImage(this.miniTerrain, -half, -half); ctx.restore();
      project = (x, z) => this.mapPoint(x, z, size, rotation);
    } else {
      const atlas = world.atlas, terrain = cachedAtlasTerrain(atlas), scale = half / this.minimapRadius;
      if (!terrain) void prepareAtlasTerrain(atlas).then(() => this.minimap());
      project = (x, z) => { const dx = (x - player.x) * scale, dy = (z - player.z) * scale; return { x: half + dx * cosine - dy * sine, y: half + dx * sine + dy * cosine }; };
      ctx.fillStyle = '#a9c29c'; ctx.fillRect(0, 0, size, size);
      if (terrain) {
        const { centerX, centerZ, scale: fit } = atlasMapProjection(atlas), pixelsPerUnit = fit * terrain.pixels / 240;
        ctx.save(); ctx.translate(half, half); ctx.rotate(rotation); ctx.scale(scale / pixelsPerUnit, scale / pixelsPerUnit);
        ctx.drawImage(terrain.canvas, -(120 + (player.x - centerX) * fit) * terrain.pixels / 240, -(120 + (player.z - centerZ) * fit) * terrain.pixels / 240);
        ctx.restore();
      }
      const reach = this.minimapRadius * 2.2, near = (point: { x: number; z: number }) => Math.abs(point.x - player.x) < reach && Math.abs(point.z - player.z) < reach;
      const places = new Map(atlas.locations.map(item => [item.id, item]));
      ctx.lineCap = 'round';
      for (const [width, color] of [[4.4, '#5f4f3566'], [2.4, '#f3e7bf']] as const) {
        ctx.strokeStyle = color; ctx.lineWidth = width * unit; ctx.beginPath();
        for (const [from, to] of atlas.connections) {
          const a = places.get(from)!, b = places.get(to)!; if (!near(a) && !near(b)) continue;
          const start = project(a.x, a.z), end = project(b.x, b.z); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y);
        }
        ctx.stroke();
      }
      for (const town of atlas.locations) if (town.kind === 'town' && near(town)) {
        const marker = project(town.x, town.z); ctx.fillStyle = '#c0604a'; ctx.strokeStyle = '#fff6df'; ctx.lineWidth = 1.2 * unit;
        ctx.beginPath(); ctx.rect(marker.x - 3.5 * unit, marker.y - 3.5 * unit, 7 * unit, 7 * unit); ctx.fill(); ctx.stroke();
      }
    }
    const guide = this.destinationGuide();
    if (guide.points.length) {
      ctx.strokeStyle = '#ffe17c'; ctx.lineWidth = 3 * unit; ctx.setLineDash([5 * unit, 4 * unit]); ctx.beginPath();
      const start = project(player.x, player.z); ctx.moveTo(start.x, start.y);
      for (const target of guide.points) { const marker = project(target.x, target.z); ctx.lineTo(marker.x, marker.y); }
      ctx.stroke(); ctx.setLineDash([]);
    }
    const destination = !cave && world.atlas.locations.find(item => item.id === guide.destinationId);
    if (destination) {
      const marker = project(destination.x, destination.z), edge = half - 8 * unit, dx = marker.x - half, dy = marker.y - half, far = Math.hypot(dx, dy) > edge;
      const x = far ? half + dx / Math.hypot(dx, dy) * edge : marker.x, y = far ? half + dy / Math.hypot(dx, dy) * edge : marker.y;
      ctx.fillStyle = '#ffe17c'; ctx.strokeStyle = '#273f30'; ctx.lineWidth = 2 * unit; ctx.beginPath(); ctx.arc(x, y, 5 * unit, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    for (const item of world.fieldPickups) {
      const marker = project(item.x, item.z), r = 4 * unit;
      ctx.fillStyle = item.kind === 'mega-stone' ? '#af73ef' : '#f0bd4d'; ctx.strokeStyle = '#3d3351'; ctx.lineWidth = unit;
      ctx.beginPath(); ctx.moveTo(marker.x, marker.y - r); ctx.lineTo(marker.x + r, marker.y); ctx.lineTo(marker.x, marker.y + r); ctx.lineTo(marker.x - r, marker.y); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    for (const entity of world.entities) {
      if (entity.kind === 'companion') continue;
      const marker = project(entity.x, entity.z), battling = entity.id === world.battleWildId, selected = entity.id === world.selectedWildId;
      ctx.fillStyle = battling ? '#f07b55' : selected ? '#fff0a1' : '#faf2dc'; ctx.strokeStyle = '#1f3a31'; ctx.lineWidth = unit;
      ctx.beginPath(); ctx.arc(marker.x, marker.y, (battling || selected ? 3.6 : 2.7) * unit, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    for (const peer of this.multiplayer?.view.players ?? []) {
      ctx.fillStyle = '#45d7ec'; ctx.strokeStyle = '#103b48'; ctx.lineWidth = unit;
      const marker = project(peer.x, peer.z); ctx.beginPath(); ctx.arc(marker.x, marker.y, (peer.id === this.trackedPlayerId ? 4 : 3) * unit, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
    // North tick on the rim.
    const north = { x: half + sine * (half - 9 * unit), y: half - cosine * (half - 9 * unit) };
    ctx.fillStyle = '#e25a47'; ctx.beginPath(); ctx.arc(north.x, north.y, 4 * unit, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffffff55'; ctx.lineWidth = 2 * unit; ctx.beginPath(); ctx.arc(half, half, half - unit * 1.5, 0, Math.PI * 2); ctx.stroke();
    const center = project(player.x, player.z);
    ctx.save(); ctx.shadowColor = '#071f1a'; ctx.shadowBlur = 5 * unit; ctx.fillStyle = '#fff'; ctx.strokeStyle = '#173f39'; ctx.lineWidth = 2.5 * unit;
    ctx.beginPath(); ctx.moveTo(center.x, center.y - 9 * unit); ctx.lineTo(center.x + 7 * unit, center.y + 7 * unit); ctx.lineTo(center.x, center.y + 3 * unit); ctx.lineTo(center.x - 7 * unit, center.y + 7 * unit); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
    this.html('#world-minimap-heading', compassLabel(nearestMapOrientation(this.cameraHeading)));
    // Floors of a dungeon share a footprint style; name the one on screen.
    if (cave && cave.floorCount > 1) {
      ctx.font = `600 ${Math.round(12 * unit)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const width = ctx.measureText(cave.floorLabel).width + 12 * unit, y = size - 26 * unit;
      ctx.fillStyle = '#10201cd9'; ctx.beginPath(); ctx.roundRect(half - width / 2, y - 9 * unit, width, 18 * unit, 9 * unit); ctx.fill();
      ctx.fillStyle = '#fff6df'; ctx.fillText(cave.floorLabel, half, y);
    }
  }

  private drawCaveMinimap(ctx: CanvasRenderingContext2D, size: number): void {
    const cave = getCaveScene(this.simulation.sceneId); if (!cave) return;
    const extent = Math.max(cave.width, cave.depth) + 4, step = Math.max(2, Math.round(size / 90));
    for (let x = 0; x < size; x += step) for (let z = 0; z < size; z += step) {
      ctx.fillStyle = this.simulation.sampleWorld(x / size * extent - extent / 2, z / size * extent - extent / 2).blocked ? '#334a44' : '#a7b3a5'; ctx.fillRect(x, z, step, step);
    }
    for (const portal of cave.portals) { ctx.fillStyle = '#ffd189'; ctx.fillRect(this.mapCoordinate(portal.interior.x, size) - 3, this.mapCoordinate(portal.interior.z, size) - 3, 6, 6); }
    for (const stairs of cave.stairs) { ctx.fillStyle = '#a9dcff'; ctx.fillRect(this.mapCoordinate(stairs.interior.x, size) - 3, this.mapCoordinate(stairs.interior.z, size) - 3, 6, 6); }
  }
  private mapCoordinate(value: number, size = 240): number {
    const cave = getCaveScene(this.simulation.sceneId), extent = cave ? Math.max(cave.width, cave.depth) + 4 : WORLD_MAX - WORLD_MIN;
    return (value + extent / 2) / extent * size;
  }
  private html(selector: string, value: string): void { const node = this.host?.querySelector(selector); if (node && this.htmlCache.get(node) !== value) { node.innerHTML = value; this.htmlCache.set(node, value); } }
  private text(selector: string, value: string): void { const node = this.host?.querySelector(selector); if (node && this.htmlCache.get(node) !== value) { node.textContent = value; this.htmlCache.set(node, value); } }
  private button(selector: string): HTMLButtonElement { return this.host!.querySelector(selector)!; }
  private input(selector: string): HTMLInputElement { return this.host!.querySelector(selector)!; }
  unmount(): void { this.loading?.remove(); this.loading = undefined; this.starterDialog?.remove(); this.starterDialog = undefined; this.manualMovementActive = false; this.layoutObserver?.disconnect(); this.layoutObserver = undefined; window.removeEventListener('keydown', this.hotkeys); window.removeEventListener('online', this.onConnectionRestored); this.compactViewport.removeEventListener('change', this.onViewportChange); this.multiplayer?.close(); this.multiplayer = undefined; this.renderer?.destroy(); this.renderer = undefined; this.host = undefined; this.ready = false; }
}
