import type { Graph } from '../core/brain';
import { getMove, getSpecies } from '../data/pokemon';
import { VERSIONS, getVersionSpeciesIds } from '../data/pokemon-versions';
import { pokemonModelUrl, pokemonSpriteUrl } from '../game/assets';
import { buyItem, experienceAtLevel, heal, ITEM_LABELS, ITEM_PRICES, statsFor, type BallItem, type GameState, type Monster } from '../game/engine';
import { WORLDS, getWorldAtlas } from './atlas';
import type { FieldPolicy } from '../game/field';
import { movementSpeed, OpenWorldSimulation, versionEncounters, type OpenWorldSnapshot } from './simulation';
import { lastServerDecision } from '../game/server-brain';
import { mountOpenWorld } from './view';
import type { OpenWorldRenderSnapshot, OpenWorldView, WorldCreature, WorldHeading } from './types';
import './panel.css';

const biomes = { meadow: '바람 초원', forest: '초록 숲', lake: '물빛 호수', rock: '돌바람 고원' };
const types: Record<string, string> = { normal: '노말', fire: '불꽃', water: '물', grass: '풀', electric: '전기', ice: '얼음', fighting: '격투', poison: '독', ground: '땅', flying: '비행', psychic: '에스퍼', bug: '벌레', rock: '바위', ghost: '고스트', dragon: '드래곤', steel: '강철', dark: '악', fairy: '페어리' };
const escape = (text: unknown) => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
// Display size only; movement speed, collision and saved species data stay in world units.
const pokemonDisplayHeight = (speciesId: number) => Math.min(4.8, Math.max(1.3, (getSpecies(speciesId).heightMeters ?? 1) * 2.5));
const MANUAL_IDLE_SECONDS = 3;
type Options = { game: GameState; graph: Graph; policy: FieldPolicy; checkpoint?: OpenWorldSnapshot; learning(): boolean; setLearning(value: boolean): void; notify(message: string, error?: boolean): void; changed(immediate?: boolean): void | Promise<void> };

export class OpenWorldPanel {
  readonly simulation: OpenWorldSimulation;
  private renderer?: OpenWorldView;
  private host?: HTMLElement;
  private ready = false;
  private attacks = new Map<string, { start: number; end: number; type: string }>();
  private tickPending = false;
  private manualIdleSeconds = 0;
  private serverRequest?: Promise<void>;
  private readonly htmlCache = new WeakMap<Element, string>();
  private readonly hotkeys = (event: KeyboardEvent) => {
    if (!this.host || event.repeat || event.ctrlKey || event.metaKey || event.altKey || (event.target instanceof Element && event.target.closest('input,textarea,select,dialog'))) return;
    if (event.code === 'KeyM') { event.preventDefault(); this.changeMode(this.simulation.controlMode === 'auto' ? 'manual' : 'auto'); }
    const index = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(event.code);
    if (index >= 0 && !this.paused) { event.preventDefault(); this.simulation.requestAction({ type: 'move', index }); }
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
      <div class="world-heading"><label class="world-eyebrow" for="world-version"><span id="world-region-label">관동</span> · 수집 <select id="world-version"><option value="national">전국도감</option>${VERSIONS.filter(version => version.speciesIds.length).map(version => `<option value="${version.id}">${escape(version.name)}${version.id.endsWith('-japan') ? ' (일본판)' : ''}</option>`).join('')}</select></label><h1 id="world-biome">태초마을</h1><p id="world-zone-level">1번도로에서 첫 모험을 시작하세요</p></div>
      <aside class="world-radar"><button id="world-map-open" aria-label="지역 전체 지도 열기"><canvas id="world-minimap" width="180" height="180" aria-label="월드 지도"></canvas></button><span id="world-position"></span><small id="world-map-caption">지역 지도 ↗</small></aside>
      <div class="world-tools"><button id="world-pause">Ⅱ 일시 정지</button><button id="world-heal">캠프 회복</button><label><input id="world-auto-hunt" type="checkbox" checked><span>자동 사냥</span></label><label><input id="world-learning" type="checkbox"><span id="world-learning-label">기술 학습</span></label></div>
      <div class="world-control-mode" role="group" aria-label="조작 모드"><div class="world-mode-buttons"><button id="world-mode-auto">자동</button><button id="world-mode-manual">수동</button></div><div class="world-control-copy"><strong id="world-control-title"></strong><small id="world-control-help"></small></div></div>
      <details class="world-shop"><summary>프렌들리숍 · <span id="world-ball-stock"></span></summary><div id="world-shop-items"></div><small id="world-shop-note">승리 후에는 볼 1개로 확정 포획합니다.</small></details>
      <div class="world-gym" id="world-gym"></div>
      <details class="world-objective"><summary><span>주변 포켓몬 ▾</span><strong id="world-objective">첫 야생 포켓몬 발견하기</strong></summary><small>선택해 정보를 보고 추적·배틀하세요.</small><div id="world-nearby"></div></details>
      <div class="world-lower-hud">
        <section class="world-target" id="world-target" aria-label="선택한 야생 포켓몬" hidden><div id="world-target-info"></div><div class="world-target-actions"><button id="world-target-track">추적</button><button id="world-target-battle">배틀</button><details><summary>정보</summary><p id="world-target-detail"></p></details><button id="world-target-clear" aria-label="선택 해제">✕</button></div></section>
        <details class="world-battle-hud" aria-label="파트너와 배틀">
          <summary><span>PARTNER · 파트너와 배틀</span><strong>파트너 상태</strong><i aria-hidden="true">⌄</i></summary>
          <div class="world-battle-deck">
            <div id="world-combatants"></div><div id="world-moves" class="world-moves"></div><div id="world-emergency-action"></div>
            <div class="world-battle-actions"><button id="world-engage">가까운 포켓몬 배틀</button><button id="world-catch" disabled>볼 던지기</button><button id="world-potion" disabled>상처약</button><button id="world-run" disabled>도망</button><label><input id="world-auto-catch" type="checkbox"> 자동 포획</label><span id="world-battle-state">자동 배틀 대기</span></div>
            <label class="world-exp-share"><input id="world-exp-share" type="checkbox"> 팀 경험치 공유</label>
            <details class="world-rewards"><summary>이 개체의 보상 기록</summary><div id="world-rewards"></div><small>게임에서 설계한 보상이며 생물학적 학습의 증거가 아닙니다.</small></details>
          </div>
        </details>
      </div>
      <section class="world-capture-offer" id="world-capture-offer" aria-label="승리 후 포획" hidden></section>
      <dialog class="kanto-map-dialog" id="world-map-dialog"><header><div><small id="world-map-region-name">KANTO REGION</small><h2>지도 · 순간이동</h2></div><button id="world-map-close">닫기 ✕</button></header><div class="world-region-picker"><label for="world-region">여행할 지역</label><select id="world-region">${WORLDS.map(region => `<option value="${region.id}">${region.name}</option>`).join('')}</select></div><p id="world-map-note">방문한 마을로 무료 이동합니다. 도시 연결·지형·출현은 게임용으로 구성한 지도입니다.</p><div id="world-travel"></div><div id="world-map-content"></div></dialog>
      <div class="world-feed" id="world-feed" aria-live="polite"></div>
      <div class="world-respawn" id="world-respawn"></div>
      <div class="world-dpad" aria-label="터치 이동"><button data-world-step="0,-1" aria-label="북쪽 이동">▲</button><div><button data-world-step="-1,0" aria-label="서쪽 이동">◀</button><button data-world-step="0,1" aria-label="남쪽 이동">▼</button><button data-world-step="1,0" aria-label="동쪽 이동">▶</button></div></div>
      <details class="world-method"><summary>회로와 게임 규칙</summary><p>브라우저 MaleCNS 실측 부분 회로 ${this.options.graph.nodes.length} 뉴런 · ${this.options.graph.edges.length.toLocaleString()} 연결. 전체 회로가 연결된 배틀은 서버에서 계산하고 반환된 개체 기억은 이 기기에 저장합니다. 감각 입력·행동 대응·학습 보상·월드 속도는 게임을 위해 설계했습니다.</p></details>
    </section>`;
    this.renderer = mountOpenWorld(host.querySelector('#ow-host')!, {
      getSnapshot: () => this.renderSnapshot(), sampleWorld: (x, z) => this.simulation.sampleWorld(x, z), modelUrl: pokemonModelUrl, spriteUrl: pokemonSpriteUrl,
      onReady: () => { this.ready = true; const canvasHost = this.host?.querySelector<HTMLElement>('#ow-host'); if (canvasHost) canvasHost.dataset.ready = 'true'; },
      onNavigationStart: () => this.noteManualInput(),
      onMovementInput: () => this.noteManualInput(),
      onPlayerMove: next => {
        if (!this.noteManualInput()) return false;
        const accepted = this.simulation.movePartner(next);
        if (accepted) { this.renderer?.update(); this.refresh(); }
        return accepted;
      },
      onSelect: id => { if (id?.startsWith('companion:')) return; this.manualIdleSeconds = 0; this.simulation.selectWild(id, true); this.options.changed(); this.refresh(); },
      onInteract: id => this.encounter(id),
    });
    window.addEventListener('keydown', this.hotkeys);
    this.host.querySelector<HTMLDetailsElement>('.world-battle-hud')!.open = !window.matchMedia('(max-width: 720px)').matches;
    this.button('#world-mode-auto').onclick = () => this.changeMode('auto');
    this.button('#world-mode-manual').onclick = () => this.changeMode('manual');
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
      heal(this.options.game); this.options.notify('캠프에서 HP·PP·상태 이상을 회복했습니다.'); this.options.changed(); this.refresh();
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
    host.querySelectorAll<HTMLButtonElement>('[data-world-step]').forEach(button => {
      let timer: number | undefined;
      const move = () => { if (!this.noteManualInput()) return; const [x, z] = button.dataset.worldStep!.split(',').map(Number), player = this.simulation.player, companion = this.simulation.entities.find(entity => entity.kind === 'companion')!, step = movementSpeed(companion.speciesId, companion.level) * .1; this.simulation.movePartner({ x: player.x + x * step, z: player.z + z * step, heading: x ? (x > 0 ? 1 : 3) : z > 0 ? 2 : 0 }); this.renderer?.update(); this.refresh(); };
      const stop = () => { window.clearInterval(timer); timer = undefined; };
      button.onpointerdown = e => { e.preventDefault(); this.changeMode('manual'); button.setPointerCapture(e.pointerId); stop(); move(); timer = window.setInterval(move, 100); };
      button.onpointerup = button.onpointercancel = button.onlostpointercapture = stop;
    });
    const versionSelect = host.querySelector<HTMLSelectElement>('#world-version')!;
    versionSelect.value = this.options.game.adventureVersion ?? 'red';
    versionSelect.onchange = () => {
      try { this.simulation.changeVersion(versionSelect.value); this.options.changed(); this.refresh(); this.options.notify(`${this.simulation.atlas.name} 지역에서 수집을 시작합니다.`); }
      catch (error) { versionSelect.value = this.options.game.adventureVersion ?? 'red'; this.options.notify(String(error), true); }
    };
    const regionSelect = host.querySelector<HTMLSelectElement>('#world-region')!;
    regionSelect.onchange = () => {
      try { this.simulation.changeRegion(getWorldAtlas(regionSelect.value).id); this.options.changed(); this.refresh(); this.drawRegionMap(); this.options.notify(`${this.simulation.atlas.name}에 도착했습니다.`); }
      catch (error) { regionSelect.value = this.simulation.regionId; this.options.notify(String(error), true); }
    };
    this.refresh();
  }

  private canAcceptMovement(): boolean {
    return !this.paused
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
  private catchVictory(): void { this.options.notify(this.simulation.captureVictory() ? '포획 성공! 팀 또는 박스에 저장했습니다.' : '볼이 없어 포획을 패스합니다.'); this.options.changed(); this.refresh(); }

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
    if (this.paused || document.hidden || this.host?.querySelector<HTMLDialogElement>('#world-map-dialog')?.open) { this.manualIdleSeconds = 0; return; }
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
        const now = performance.now(); this.attacks.clear();
        event.result.executedMoves.filter(move => move.executed).forEach((move, index) => {
          this.attacks.set(move.actorInstanceId, { start: now + index * 300, end: now + index * 300 + 280, type: move.moveType });
        });
        if (event.result.battleEnded) this.options.notify(event.result.outcome === 'won' ? '승리! 경험치와 보상을 받았습니다.' : event.result.outcome === 'caught' ? '포획 성공! 팀과 도감에 등록했습니다.' : event.result.outcome === 'lost' ? '파트너가 쓰러졌습니다. 회복한 뒤 다시 탐험하세요.' : '배틀에서 벗어났습니다.');
        await this.options.changed(true);
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
      player: { ...this.simulation.player, heading: this.simulation.player.heading as WorldHeading }, tick: this.simulation.tick, selectedWildId: this.simulation.selectedWildId, badges: game.player.badges,
      foods: this.simulation.foods.map(food => ({ ...food, id: String(food.id) })),
      entities: this.simulation.visibleEntities(18).map(entity => {
        const inBattle = Boolean(battle && (entity.kind === 'companion' || entity.id === this.simulation.battleWildId));
        const monster = entity.kind === 'companion' ? ally : entity.id === this.simulation.battleWildId ? enemy : undefined;
        const transformed = monster && battle?.transformations?.[monster.instanceId];
        const speciesId = transformed?.speciesId ?? monster?.speciesId ?? entity.speciesId;
        const stats = transformed?.stats ?? monster?.stats ?? statsFor(getSpecies(entity.speciesId), entity.level);
        return { id: entity.id, speciesId, name: getSpecies(speciesId).name, level: entity.level, hp: monster?.hp ?? stats.hp, maxHp: stats.hp,
          x: entity.x, z: entity.z,
          heading: entity.heading as WorldHeading, inBattle,
          action: monster?.hp === 0 ? 'fainted' : inBattle ? (attacking(monster?.instanceId) ? 'attack' : 'idle') : entity.action < 4 ? 'walk' : 'idle',
          moveType: attacking(monster?.instanceId)?.type,
          lookAt: inBattle ? (() => {
            const target = this.simulation.entities.find(other => entity.kind === 'companion' ? other.id === this.simulation.battleWildId : other.kind === 'companion');
            return target ? { x: target.x, z: target.z } : undefined;
          })() : undefined,
          movementSpeed: movementSpeed(speciesId, entity.level),
          displayHeight: pokemonDisplayHeight(speciesId),
        } as WorldCreature;
      }).concat(battle && battle.kind !== 'wild' && enemy ? [{ id: this.simulation.battleWildId!, speciesId: enemy.speciesId, name: enemy.nickname, level: enemy.level, hp: enemy.hp, maxHp: enemy.stats.hp, x: this.simulation.player.x, z: this.simulation.player.z - 3, heading: 2 as WorldHeading, action: attacking(enemy.instanceId) ? 'attack' as const : 'idle' as const, moveType: attacking(enemy.instanceId)?.type, inBattle: true, lookAt: this.simulation.player, displayHeight: pokemonDisplayHeight(enemy.speciesId), movementSpeed: movementSpeed(enemy.speciesId, enemy.level) }] : []),
    };
  }

  refresh(): void {
    if (!this.host?.querySelector('#ow-host')) return;
    const game = this.options.game, world = this.simulation, battle = game.battle;
    const host = this.host.querySelector<HTMLElement>('#ow-host')!;
    host.dataset.runtime = 'gaesup-world'; host.dataset.graphId = this.options.graph.id;
    host.dataset.region = world.regionId;
    this.html('#world-region-label', world.atlas.name);
    this.html('#world-map-caption', `${world.atlas.name} 지도 ↗`);
    for (const [id, value] of [['world-version', game.adventureVersion ?? 'red'], ['world-region', world.regionId]]) {
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
    this.html('#world-combatants', `${card(lead, '내 파트너')}${enemy ? card(enemy, `${battle!.kind === 'wild' ? '야생' : '체육관'} · ${world.controlMode === 'manual' ? '수동' : '자동'} 배틀`) : `<div class="world-growth"><small>다음 레벨까지 ${Math.max(0, xpEnd - lead.xp)} EXP</small><div class="world-xp"><i style="width:${xp}%"></i></div><span>${species.moves.filter(move => move.level > lead.level).slice(0, 1).map(move => `Lv.${move.level} ${getMove(move.moveId).name} 습득`).join('') || '현재 레벨의 기술을 모두 익혔습니다.'}</span></div>`}`);
    this.html('#world-moves', Array.from({ length: 4 }, (_, index) => {
      const slot = moves[index]; if (!slot) return `<div class="world-move empty-slot"><span>${index + 1}</span><strong>미습득</strong><small>레벨을 올려 기술을 익히세요</small></div>`;
      const move = getMove(slot.moveId);
      return `<button data-world-move="${index}" class="world-move type-${move.type}" ${!battle || slot.pp <= 0 ? 'disabled' : ''} title="${move.damageClass === 'physical' ? '물리' : move.damageClass === 'special' ? '특수' : '변화'} · 우선도 ${move.priority} · 클릭하면 다음 턴에 사용"><span>${index + 1} · ${types[move.type]} · 우선 ${move.priority}</span><strong>${move.name}</strong><small><span class="move-details">위력 ${move.power || '—'} · 명중 ${move.accuracy || '—'} · </span>PP ${slot.pp}/${move.pp}</small></button>`;
    }).join(''));
    this.html('#world-emergency-action', battle && !battle.awaitingSwitch && moves.every(slot => slot.pp <= 0) ? '<button id="world-struggle">발버둥 (PP 소진)</button>' : '');
    const location = this.simulation.locationAt(world.player.x, world.player.z);
    this.html('#world-biome', location.name);
    const pool = versionEncounters(location.id, game.adventureVersion ?? 'red', game.player.badges, world.regionId);
    this.html('#world-zone-level', pool.length ? `야생 Lv.${location.minLevel}–${location.maxLevel} · ${pool.slice(0, 3).map(id => getSpecies(id).name).join(' · ')}` : '도시와 길을 따라 다음 구역으로 탐험하세요');
    this.html('#world-position', `${world.player.x.toFixed(0)}, ${world.player.z.toFixed(0)}`);
    this.html('#world-objective', `${game.versionCaught?.[game.adventureVersion ?? 'red']?.length ?? 0} / ${getVersionSpeciesIds(game.adventureVersion ?? 'red').length}종 수집 · 전국 ${game.dex.caught.length}종`);
    this.html('#world-feed', game.logs.slice(-3).map(log => `<p>${escape(log)}</p>`).join(''));
    this.html('#world-battle-state', game.captureOffer ? '승리! 포획 여부를 선택하세요' : battle ? `${battle.awaitingSwitch ? '다음 파트너로 자동 교대 중' : world.escaping ? '도망 시도 중' : world.controlMode === 'manual' ? (battle.canRun ? '기술 선택 · 이동키로 도주' : '기술 선택 대기') : '자동 배틀'} · 턴 ${battle.turn}` : !world.hasBalls ? '볼 소진 · 구매 후 자동 사냥 가능' : this.paused ? '탐험 일시 정지' : world.controlMode === 'manual' ? '수동 탐험 · 배틀 버튼으로만 전투' : world.autoHunt ? '자동 추적 · 접근하면 배틀' : '접근하면 자동 배틀');
    this.button('#world-mode-auto').setAttribute('aria-pressed', String(world.controlMode === 'auto'));
    this.button('#world-mode-manual').setAttribute('aria-pressed', String(world.controlMode === 'manual'));
    this.html('#world-control-title', world.controlMode === 'manual' ? '수동 이동' : '자동 이동 · 배틀');
    this.html('#world-control-help', world.controlMode === 'manual' ? (battle || game.captureOffer ? '기술 1–4 · M 전환' : '3초간 이동 입력이 없으면 자동 · M 전환') : `${world.autoHunt ? '대상 자동 선택·추적' : '이동만 자동'} · WASD로 직접 조작`);
    this.html('#world-ball-stock', `볼 ${game.inventory['poke-ball'] + game.inventory['great-ball'] + game.inventory['ultra-ball']}개 · ₩${game.player.money.toLocaleString('ko-KR')}`);
    this.html('#world-shop-items', (['poke-ball', 'great-ball', 'ultra-ball'] as BallItem[]).map(ball => `<div><strong>${ITEM_LABELS[ball]} <small>보유 ${game.inventory[ball]}개 · 개당 ₩${ITEM_PRICES[ball].toLocaleString('ko-KR')}</small></strong>${[1, 5].map(quantity => { const total = ITEM_PRICES[ball] * quantity, reason = battle ? '배틀 중 구매 불가' : game.player.money < total ? `₩${(total - game.player.money).toLocaleString('ko-KR')} 부족` : ''; return `<button data-world-buy="${ball}" data-quantity="${quantity}" ${reason ? `disabled title="${reason}"` : ''}>${quantity}개 · ₩${total.toLocaleString('ko-KR')}${reason ? `<small>${reason}</small>` : ''}</button>`; }).join('')}</div>`).join(''));
    this.html('#world-shop-note', `몬스터볼 30초마다 +1 · 기본 보충 한도 20개 · 다음 ${Math.ceil(30 - (game.ballRefillSeconds ?? 0))}초. ` + (battle ? '배틀 중에는 구매할 수 없습니다.' : game.player.money < Math.min(...Object.values(ITEM_PRICES)) ? '소지금이 부족합니다. 배틀에서 이기면 상금을 받습니다.' : '볼이 없으면 자동 포획을 건너뜁니다.'));
    this.host.querySelectorAll<HTMLButtonElement>('[data-world-buy]').forEach(button => button.onclick = () => { const ball = button.dataset.worldBuy as BallItem, quantity = Number(button.dataset.quantity), total = ITEM_PRICES[ball] * quantity; try { buyItem(game, ball, quantity); this.options.notify(`${ITEM_LABELS[ball]} ${quantity}개 · ₩${total.toLocaleString('ko-KR')} 구매 완료`); this.options.changed(); this.refresh(); } catch (error) { this.options.notify(String(error), true); } });
    const offer = game.captureOffer, offerNode = this.host.querySelector<HTMLElement>('#world-capture-offer')!;
    offerNode.hidden = !offer;
    if (offer) {
      this.html('#world-capture-offer', `<img src="${pokemonSpriteUrl(offer.speciesId)}" alt=""><div><small>배틀 승리 · Lv.${offer.level}</small><strong>${escape(offer.nickname)}을(를) 잡을까요?</strong><p>볼 1개로 확정 포획 · ${game.player.team.length < 6 ? '팀에 합류' : '박스로 이동'}</p><button id="world-win-catch">볼 1개로 잡기</button><button id="world-win-release">놓아주고 계속</button></div>`);
      this.button('#world-win-catch').onclick = () => this.catchVictory();
      this.button('#world-win-release').onclick = () => { world.releaseVictory(); this.options.changed(); this.refresh(); };
    }
    const gym = this.simulation.atlas.gyms.find(item => item.locationId === location.id);
    this.html('#world-gym', gym ? `<button id="world-gym-challenge" ${battle || offer || gym.badge !== game.player.badges + 1 ? 'disabled' : ''}>${gym.name} · Lv.${gym.level} ${game.player.badges >= gym.badge ? '클리어 ✓' : '도전'}</button><small>배지 ${game.player.badges}/8${gym.badge > game.player.badges + 1 ? ' · 앞 체육관부터 도전하세요' : ''}</small>` : '');
    if (gym) this.button('#world-gym-challenge').onclick = () => { if (world.challengeLocalGym()) { this.options.changed(); this.refresh(); } };
    if (!gym && this.simulation.atlas.locations.some(item => item.id.startsWith('diglett-cave-') && Math.hypot(item.x - world.player.x, item.z - world.player.z) <= 5)) {
      this.html('#world-gym', `<button id="world-tunnel" ${battle || offer ? 'disabled' : ''}>디그다의 굴 통과 → 반대편 입구</button>`);
      this.button('#world-tunnel').onclick = () => { if (world.traverseTunnel()) { this.options.changed(); this.refresh(); } };
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
    const world = this.simulation, scale = (n: number) => n + 120;
    this.html('#world-map-region-name', `${world.atlas.englishName.toUpperCase()} REGION`);
    this.html('#world-travel', this.simulation.atlas.locations.filter(item => item.kind === 'town').map(item => `<button data-world-travel="${item.id}" ${!world.visitedTownIds.includes(item.id) || this.options.game.battle || this.options.game.captureOffer ? 'disabled' : ''}>${item.name}<small>${world.visitedTownIds.includes(item.id) ? '순간이동' : '미방문'}</small></button>`).join(''));
    this.host!.querySelectorAll<HTMLButtonElement>('[data-world-travel]').forEach(button => button.onclick = () => { if (world.teleportToTown(button.dataset.worldTravel!)) { this.host!.querySelector<HTMLDialogElement>('#world-map-dialog')!.close(); this.options.notify('안전한 마을 입구로 이동했습니다.'); this.options.changed(); this.refresh(); } });
    const lines = this.simulation.atlas.connections.map(([from, to]) => { const a = this.simulation.atlas.locations.find(item => item.id === from)!, b = this.simulation.atlas.locations.find(item => item.id === to)!; return `<line x1="${scale(a.x)}" y1="${scale(a.z)}" x2="${scale(b.x)}" y2="${scale(b.z)}"/>`; }).join('');
    const towns = this.simulation.atlas.locations.filter(item => item.kind === 'town' || item.kind === 'special').map(item => `<g><circle cx="${scale(item.x)}" cy="${scale(item.z)}" r="2.8"/><text x="${scale(item.x) + 4}" y="${scale(item.z) - 3}">${item.name}</text></g>`).join('');
    this.html('#world-map-content', `<svg viewBox="0 0 260 240" role="img" aria-label="${world.atlas.name} 도시 연결 지도"><rect width="260" height="240" rx="8" fill="#bed5c0"/><g stroke="#faf1ce" stroke-width="3" fill="none">${lines}</g><g fill="#35594a">${towns}</g><circle cx="${scale(world.player.x)}" cy="${scale(world.player.z)}" r="4" fill="#e04f45" stroke="white"/><text x="8" y="16">N ↑ · 빨간 점: 내 위치</text></svg><div class="kanto-zone-list">${this.simulation.atlas.locations.map(item => `<div class="${this.simulation.locationAt(world.player.x, world.player.z).id === item.id ? 'current' : ''}"><strong>${item.name}</strong><small>${item.encounters.length ? `Lv.${item.minLevel}–${item.maxLevel} · ${item.encounters.slice(0, 4).map(id => getSpecies(id).name).join(' / ')}` : '마을 · 연결 거점'}${item.requiredBadges ? ` · 배지 ${item.requiredBadges}개` : ''}</small></div>`).join('')}</div>`);
  }

  private minimap(): void {
    const canvas = this.host?.querySelector<HTMLCanvasElement>('#world-minimap'); if (!canvas) return;
    const ctx = canvas.getContext('2d')!, size = canvas.width;
    const colors = { meadow: '#88a565', forest: '#345d42', lake: '#69adb3', rock: '#ac9f85' };
    for (let x = 0; x < size; x += 4) for (let z = 0; z < size; z += 4) { ctx.fillStyle = colors[this.simulation.sampleWorld(x / size * 240 - 120, z / size * 240 - 120).biome]; ctx.fillRect(x, z, 4, 4); }
    ctx.strokeStyle = '#efe4bb'; ctx.lineWidth = 2;
    for (const [from, to] of this.simulation.atlas.connections) { const a = this.simulation.atlas.locations.find(item => item.id === from)!, b = this.simulation.atlas.locations.find(item => item.id === to)!; ctx.beginPath(); ctx.moveTo((a.x + 120) / 240 * size, (a.z + 120) / 240 * size); ctx.lineTo((b.x + 120) / 240 * size, (b.z + 120) / 240 * size); ctx.stroke(); }
    for (const location of this.simulation.atlas.locations.filter(item => item.kind === 'town')) { ctx.fillStyle = '#b05946'; ctx.fillRect((location.x + 120) / 240 * size - 2, (location.z + 120) / 240 * size - 2, 4, 4); }
    for (const entity of this.simulation.entities) { ctx.fillStyle = entity.id === this.simulation.selectedWildId ? '#fff0a1' : '#faf2dc'; ctx.beginPath(); ctx.arc((entity.x + 120) / 240 * size, (entity.z + 120) / 240 * size, 2.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#e0543e'; ctx.strokeStyle = '#fff8dd'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc((this.simulation.player.x + 120) / 240 * size, (this.simulation.player.z + 120) / 240 * size, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  private html(selector: string, value: string): void { const node = this.host?.querySelector(selector); if (node && this.htmlCache.get(node) !== value) { node.innerHTML = value; this.htmlCache.set(node, value); } }
  private button(selector: string): HTMLButtonElement { return this.host!.querySelector(selector)!; }
  private input(selector: string): HTMLInputElement { return this.host!.querySelector(selector)!; }
  unmount(): void { window.removeEventListener('keydown', this.hotkeys); this.renderer?.destroy(); this.renderer = undefined; this.host = undefined; this.ready = false; }
}
