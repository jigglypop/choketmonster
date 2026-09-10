import type { Graph } from '../core/brain';
import { getMove, getSpecies } from '../data/pokemon';
import { pokemonModelUrl, pokemonSpriteUrl } from '../game/assets';
import { experienceAtLevel, heal, statsFor, type GameState, type Monster } from '../game/engine';
import type { FieldPolicy } from '../game/field';
import { movementSpeed, OpenWorldSimulation, sampleWorld, type OpenWorldSnapshot } from './simulation';
import { mountOpenWorld } from './view';
import type { OpenWorldRenderSnapshot, OpenWorldView, WorldCreature, WorldHeading } from './types';
import './panel.css';

const biomes = { meadow: '바람 초원', forest: '초록 숲', lake: '물빛 호수', rock: '돌바람 고원' };
const types: Record<string, string> = { normal: '노말', fire: '불꽃', water: '물', grass: '풀', electric: '전기', ice: '얼음', fighting: '격투', poison: '독', ground: '땅', flying: '비행', psychic: '에스퍼', bug: '벌레', rock: '바위', ghost: '고스트', dragon: '드래곤', steel: '강철', dark: '악', fairy: '페어리' };
const escape = (text: unknown) => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
type Options = { game: GameState; graph: Graph; policy: FieldPolicy; checkpoint?: OpenWorldSnapshot; learning(): boolean; setLearning(value: boolean): void; notify(message: string, error?: boolean): void; changed(): void };

export class OpenWorldPanel {
  readonly simulation: OpenWorldSimulation;
  private renderer?: OpenWorldView;
  private host?: HTMLElement;
  private ready = false;
  private attackUntil = 0;
  private attackTypes: [string | undefined, string | undefined] = [undefined, undefined];
  paused = false;

  constructor(private readonly options: Options) {
    const seed = options.checkpoint?.seed ?? [...options.game.seed].reduce((value, c) => (Math.imul(value, 31) + c.charCodeAt(0)) >>> 0, 517);
    this.simulation = new OpenWorldSimulation(options.graph, options.game, seed, options.checkpoint, options.policy);
    this.simulation.syncPlayerToCompanion();
  }

  mount(host: HTMLElement): void {
    if (this.host === host && this.renderer && host.querySelector('#ow-host')) { this.refresh(); return; }
    this.unmount(); this.host = host;
    host.innerHTML = `<section class="adventure" aria-label="오픈월드 모험">
      <div id="ow-host"></div>
      <div class="world-heading"><span class="world-eyebrow">GAESUP WORLD · KANTO WILDS</span><h1 id="world-biome">바람 초원</h1><p>당신과 파트너의 첫 번째 탐험</p></div>
      <aside class="world-radar"><canvas id="world-minimap" width="180" height="180" aria-label="월드 지도"></canvas><span id="world-position"></span><small>초원 · 숲 · 호수 · 고원</small></aside>
      <div class="world-tools"><button id="world-pause">Ⅱ 일시 정지</button><button id="world-heal">캠프 회복</button><label><input id="world-auto-hunt" type="checkbox" checked> 자동 사냥</label><label><input id="world-learning" type="checkbox"> 보상 학습</label></div>
      <details class="world-objective"><summary><span>주변 포켓몬 ▾</span><strong id="world-objective">첫 야생 포켓몬 발견하기</strong></summary><small>목표를 직접 선택할 수도 있습니다.</small><div id="world-nearby"></div></details>
      <section class="world-battle-hud" aria-label="파트너와 배틀"><div id="world-combatants"></div><div id="world-moves" class="world-moves"></div>
        <div class="world-battle-actions"><button id="world-engage">가까운 포켓몬 선택</button><button id="world-catch" disabled>볼 던지기</button><button id="world-potion" disabled>상처약</button><button id="world-run" disabled>도망</button><label><input id="world-auto-catch" type="checkbox"> 자동 포획</label><span id="world-battle-state">자동 배틀 대기</span></div>
      </section>
      <div class="world-feed" id="world-feed" aria-live="polite"></div>
      <div class="world-respawn" id="world-respawn"></div>
      <div class="world-dpad" aria-label="터치 이동"><button data-world-step="0,-1" aria-label="북쪽 이동">▲</button><div><button data-world-step="-1,0" aria-label="서쪽 이동">◀</button><button data-world-step="0,1" aria-label="남쪽 이동">▼</button><button data-world-step="1,0" aria-label="동쪽 이동">▶</button></div></div>
      <details class="world-method"><summary>회로와 게임 규칙</summary><p>MaleCNS 실측 부분 회로 ${this.options.graph.nodes.length} 뉴런 · ${this.options.graph.edges.length.toLocaleString()} 연결. 개체별 이동과 기술 선택에 사용합니다. 감각 입력·행동 대응·학습 보상·월드 속도는 게임을 위해 설계했습니다.</p></details>
    </section>`;
    this.renderer = mountOpenWorld(host.querySelector('#ow-host')!, {
      getSnapshot: () => this.renderSnapshot(), sampleWorld, modelUrl: pokemonModelUrl, spriteUrl: pokemonSpriteUrl,
      onReady: () => { this.ready = true; const canvasHost = this.host?.querySelector<HTMLElement>('#ow-host'); if (canvasHost) canvasHost.dataset.ready = 'true'; },
      onPlayerMove: next => {
        const accepted = !this.paused && !this.options.game.battle && this.simulation.movePartner(next);
        if (accepted) { this.renderer?.update(); this.refresh(); }
        return accepted;
      },
      onSelect: id => { if (id?.startsWith('companion:')) return; this.simulation.selectWild(id); this.refresh(); },
      onInteract: id => this.encounter(id),
    });
    this.button('#world-pause').onclick = () => { this.paused = !this.paused; this.options.changed(); this.refresh(); };
    this.button('#world-heal').onclick = () => {
      if (this.options.game.battle) return this.options.notify('배틀을 마친 뒤 회복할 수 있습니다.');
      heal(this.options.game); this.options.notify('캠프에서 HP·PP·상태 이상을 회복했습니다.'); this.options.changed(); this.refresh();
    };
    this.button('#world-engage').onclick = () => {
      const nearest = this.simulation.visibleEntities(18).filter(entity => entity.kind === 'wild').sort((a, b) => Math.hypot(a.x - this.simulation.player.x, a.z - this.simulation.player.z) - Math.hypot(b.x - this.simulation.player.x, b.z - this.simulation.player.z))[0];
      if (nearest) { this.simulation.selectWild(nearest.id); this.encounter(nearest.id); }
    };
    this.button('#world-catch').onclick = () => { if (this.simulation.requestCapture()) this.options.notify('다음 턴에 볼을 던집니다.'); else this.options.notify('사용할 수 있는 볼이 없습니다.'); };
    this.button('#world-potion').onclick = () => { if (this.simulation.requestAction({ type: 'item', item: 'potion' })) this.options.notify('다음 턴에 상처약을 사용합니다.'); };
    this.button('#world-run').onclick = () => { if (this.simulation.requestAction({ type: 'run' })) this.options.notify('다음 턴에 도망을 시도합니다.'); };
    this.input('#world-auto-catch').onchange = e => { this.simulation.setAutoCapture((e.target as HTMLInputElement).checked); this.options.changed(); };
    this.input('#world-auto-hunt').onchange = e => { this.simulation.setAutoHunt((e.target as HTMLInputElement).checked); this.options.changed(); this.refresh(); };
    this.input('#world-learning').checked = this.options.learning();
    this.input('#world-learning').onchange = e => { this.options.setLearning((e.target as HTMLInputElement).checked); this.options.changed(); };
    host.querySelectorAll<HTMLButtonElement>('[data-world-step]').forEach(button => {
      let timer: number | undefined;
      const move = () => { if (this.paused || this.options.game.battle) return; const [x, z] = button.dataset.worldStep!.split(',').map(Number), player = this.simulation.player, companion = this.simulation.entities.find(entity => entity.kind === 'companion')!, step = movementSpeed(companion.speciesId) * .1; this.simulation.movePartner({ x: player.x + x * step, z: player.z + z * step, heading: x ? (x > 0 ? 1 : 3) : z > 0 ? 2 : 0 }); this.renderer?.update(); this.refresh(); };
      const stop = () => { window.clearInterval(timer); timer = undefined; };
      button.onpointerdown = e => { e.preventDefault(); button.setPointerCapture(e.pointerId); stop(); move(); timer = window.setInterval(move, 100); };
      button.onpointerup = button.onpointercancel = button.onlostpointercapture = stop;
    });
    this.refresh();
  }

  private encounter(id: string): void {
    const wild = this.simulation.entities.find(entity => entity.id === id);
    if (!wild || wild.kind !== 'wild') return;
    this.simulation.selectWild(id);
    if (Math.hypot(wild.x - this.simulation.player.x, wild.z - this.simulation.player.z) > 4) this.options.notify(`${getSpecies(wild.speciesId).name} 쪽으로 이동하세요. 4m 안에서 자동 배틀합니다.`);
    else if (this.simulation.startEncounter(id)) { this.paused = false; this.options.changed(); }
    this.refresh();
  }

  tick(): void {
    if (!this.renderer || !this.ready || this.paused || document.hidden) return;
    const battle = this.options.game.battle;
    const sides = battle ? [battle.player.team[battle.player.activeIndex], battle.enemy.team[battle.enemy.activeIndex]] : [];
    const result = this.simulation.step({ deltaSeconds: .25, learning: this.options.learning() });
    this.simulation.syncPlayerToCompanion();
    for (const event of result.events) {
      if (event.type === 'battle-turn') {
        const actions = [event.result.playerAction, event.result.enemyAction];
        this.attackTypes = actions.map((action, index) => action?.type === 'move' && sides[index]?.moves[action.index] ? getMove(sides[index].moves[action.index].moveId).type : undefined) as typeof this.attackTypes;
        this.attackUntil = performance.now() + 550;
        if (event.result.battleEnded) this.options.notify(event.result.outcome === 'won' ? '승리! 경험치와 보상을 받았습니다.' : event.result.outcome === 'caught' ? '포획 성공! 팀과 도감에 등록했습니다.' : event.result.outcome === 'lost' ? '파트너가 쓰러졌습니다. 회복한 뒤 다시 탐험하세요.' : '배틀에서 벗어났습니다.');
        this.options.changed();
      }
      if (event.type === 'evolved') this.options.notify(`${getSpecies(event.fromSpeciesId).name} → ${getSpecies(event.speciesId).name} 진화!`);
    }
    if (result.tick % 20 === 0) this.options.changed();
    this.refresh();
  }

  private renderSnapshot(): OpenWorldRenderSnapshot {
    const game = this.options.game, battle = game.battle;
    const ally = battle ? battle.player.team[battle.player.activeIndex] : game.player.team.find(mon => mon.hp > 0) ?? game.player.team[0];
    const enemy = battle?.enemy.team[battle.enemy.activeIndex];
    return {
      player: { ...this.simulation.player, heading: this.simulation.player.heading as WorldHeading }, tick: this.simulation.tick, selectedWildId: this.simulation.selectedWildId,
      foods: this.simulation.foods.map(food => ({ ...food, id: String(food.id) })),
      entities: this.simulation.visibleEntities(12).map(entity => {
        const inBattle = Boolean(battle && (entity.kind === 'companion' || entity.id === this.simulation.battleWildId));
        const monster = entity.kind === 'companion' ? ally : entity.id === this.simulation.battleWildId ? enemy : undefined;
        const transformed = monster && battle?.transformations?.[monster.instanceId];
        const speciesId = transformed?.speciesId ?? monster?.speciesId ?? entity.speciesId;
        const stats = transformed?.stats ?? monster?.stats ?? statsFor(getSpecies(entity.speciesId), entity.level);
        return { id: entity.id, speciesId, name: getSpecies(speciesId).name, level: entity.level, hp: monster?.hp ?? stats.hp, maxHp: stats.hp,
          x: entity.x, z: entity.z,
          heading: entity.heading as WorldHeading, inBattle,
          action: monster?.hp === 0 ? 'fainted' : inBattle ? (performance.now() < this.attackUntil ? 'attack' : 'idle') : entity.action < 4 ? 'walk' : 'idle',
          moveType: this.attackTypes[entity.kind === 'companion' ? 0 : 1],
          lookAt: inBattle ? (() => {
            const target = this.simulation.entities.find(other => entity.kind === 'companion' ? other.id === this.simulation.battleWildId : other.kind === 'companion');
            return target ? { x: target.x, z: target.z } : undefined;
          })() : undefined,
          movementSpeed: movementSpeed(speciesId),
          displayHeight: Math.min(2.8, Math.max(.65, (getSpecies(speciesId).heightMeters ?? 1) * 1.25)),
        } as WorldCreature;
      }),
    };
  }

  refresh(): void {
    if (!this.host?.querySelector('#ow-host')) return;
    const game = this.options.game, world = this.simulation, battle = game.battle;
    const host = this.host.querySelector<HTMLElement>('#ow-host')!;
    host.dataset.runtime = 'gaesup-world'; host.dataset.graphId = this.options.graph.id;
    host.dataset.tick = String(world.tick); host.dataset.paused = String(this.paused);
    const lead = battle ? battle.player.team[battle.player.activeIndex] : game.player.team.find(mon => mon.hp > 0) ?? game.player.team[0];
    const enemy = battle?.enemy.team[battle.enemy.activeIndex];
    const transformed = battle?.transformations?.[lead.instanceId];
    const species = getSpecies(transformed?.speciesId ?? lead.speciesId), moves = transformed?.moves ?? lead.moves;
    const xpStart = experienceAtLevel(lead.level, species.growthRate), xpEnd = experienceAtLevel(lead.level + 1, species.growthRate);
    const xp = Math.min(100, Math.max(0, (lead.xp - xpStart) / Math.max(1, xpEnd - xpStart) * 100));
    const card = (mon: Monster, label: string) => `<div class="world-combatant"><img src="${pokemonSpriteUrl(mon.speciesId)}" alt="${getSpecies(mon.speciesId).name}"><div><small>${label} · Lv.${mon.level}</small><strong>${escape(mon.nickname)}</strong><div class="world-hp"><i style="width:${mon.hp / mon.stats.hp * 100}%"></i></div><span>HP ${mon.hp}/${mon.stats.hp} · 스피드 ${mon.stats.speed} · 이동 ${movementSpeed(mon.speciesId).toFixed(1)}m/s${mon.status ? ` · ${mon.status}` : ''}</span></div></div>`;
    this.html('#world-combatants', `${card(lead, '내 파트너')}${enemy ? card(enemy, '야생 · 자동 배틀') : `<div class="world-growth"><small>다음 레벨까지 ${Math.max(0, xpEnd - lead.xp)} EXP</small><div class="world-xp"><i style="width:${xp}%"></i></div><span>${species.moves.filter(move => move.level > lead.level).slice(0, 1).map(move => `Lv.${move.level} ${getMove(move.moveId).name} 습득`).join('') || '현재 레벨의 기술을 모두 익혔습니다.'}</span></div>`}`);
    this.html('#world-moves', Array.from({ length: 4 }, (_, index) => {
      const slot = moves[index]; if (!slot) return `<div class="world-move empty-slot"><span>${index + 1}</span><strong>미습득</strong><small>레벨을 올려 기술을 익히세요</small></div>`;
      const move = getMove(slot.moveId);
      return `<button data-world-move="${index}" class="world-move type-${move.type}" ${!battle || slot.pp <= 0 ? 'disabled' : ''} title="${move.damageClass === 'physical' ? '물리' : move.damageClass === 'special' ? '특수' : '변화'} · 우선도 ${move.priority} · 클릭하면 다음 턴에 사용"><span>${index + 1} · ${types[move.type]} · 우선 ${move.priority}</span><strong>${move.name}</strong><small><span class="move-details">위력 ${move.power || '—'} · 명중 ${move.accuracy || '—'} · </span>PP ${slot.pp}/${move.pp}</small></button>`;
    }).join(''));
    this.host.querySelectorAll<HTMLButtonElement>('[data-world-move]').forEach(button => button.onclick = () => { if (world.requestAction({ type: 'move', index: Number(button.dataset.worldMove) })) this.options.notify('다음 턴에 선택한 기술을 사용합니다.'); });
    this.html('#world-biome', biomes[sampleWorld(world.player.x, world.player.z).biome]);
    this.html('#world-position', `${world.player.x.toFixed(0)}, ${world.player.z.toFixed(0)}`);
    this.html('#world-objective', `${game.dex.caught.length} / 151종 포획 · ${game.dex.seen.length}종 발견`);
    this.html('#world-feed', game.logs.slice(-3).map(log => `<p>${escape(log)}</p>`).join(''));
    this.html('#world-battle-state', battle ? `자동 배틀 · 턴 ${battle.turn}` : this.paused ? '탐험 일시 정지' : world.autoHunt ? '자동 추적 · 접근하면 배틀' : '접근하면 자동 배틀');
    const respawns = world.respawnQueue;
    this.html('#world-respawn', respawns.length ? `${respawns.length}마리 리젠 대기 · ${Math.ceil(Math.min(...respawns.map(spawn => spawn.remainingSeconds)))}초` : '');
    this.button('#world-catch').disabled = !battle;
    this.button('#world-potion').disabled = !battle || game.inventory.potion <= 0;
    this.button('#world-run').disabled = !battle?.canRun;
    this.button('#world-heal').disabled = Boolean(battle);
    this.button('#world-engage').disabled = Boolean(battle);
    this.button('#world-pause').textContent = this.paused ? '▶ 계속 탐험' : 'Ⅱ 일시 정지';
    this.input('#world-auto-catch').checked = world.autoCapture;
    this.input('#world-auto-hunt').checked = world.autoHunt;
    const nearby = world.visibleEntities(18).filter(entity => entity.kind === 'wild').sort((a, b) => Math.hypot(a.x - world.player.x, a.z - world.player.z) - Math.hypot(b.x - world.player.x, b.z - world.player.z)).slice(0, 3);
    this.html('#world-nearby', nearby.map(entity => `<button data-world-wild="${entity.id}" class="${world.selectedWildId === entity.id ? 'selected' : ''}"><img src="${pokemonSpriteUrl(entity.speciesId)}" alt=""><span>${getSpecies(entity.speciesId).name}<small>Lv.${entity.level} · ${Math.hypot(entity.x - world.player.x, entity.z - world.player.z).toFixed(0)}m</small></span><b>↗</b></button>`).join(''));
    this.host.querySelectorAll<HTMLButtonElement>('[data-world-wild]').forEach(button => button.onclick = () => { world.selectWild(button.dataset.worldWild!); this.refresh(); });
    this.minimap(); this.renderer?.update();
  }

  private minimap(): void {
    const canvas = this.host?.querySelector<HTMLCanvasElement>('#world-minimap'); if (!canvas) return;
    const ctx = canvas.getContext('2d')!, size = canvas.width;
    const colors = { meadow: '#88a565', forest: '#345d42', lake: '#69adb3', rock: '#ac9f85' };
    for (let x = 0; x < size; x += 4) for (let z = 0; z < size; z += 4) { ctx.fillStyle = colors[sampleWorld(x / size * 240 - 120, z / size * 240 - 120).biome]; ctx.fillRect(x, z, 4, 4); }
    for (const entity of this.simulation.entities) { ctx.fillStyle = entity.id === this.simulation.selectedWildId ? '#fff0a1' : '#faf2dc'; ctx.beginPath(); ctx.arc((entity.x + 120) / 240 * size, (entity.z + 120) / 240 * size, 2.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#e0543e'; ctx.strokeStyle = '#fff8dd'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc((this.simulation.player.x + 120) / 240 * size, (this.simulation.player.z + 120) / 240 * size, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  private html(selector: string, value: string): void { const node = this.host?.querySelector(selector); if (node && node.innerHTML !== value) node.innerHTML = value; }
  private button(selector: string): HTMLButtonElement { return this.host!.querySelector(selector)!; }
  private input(selector: string): HTMLInputElement { return this.host!.querySelector(selector)!; }
  unmount(): void { this.renderer?.destroy(); this.renderer = undefined; this.host = undefined; this.ready = false; }
}
