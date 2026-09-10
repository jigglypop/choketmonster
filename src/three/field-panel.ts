import './field-panel.css';
import { pokemonSpriteUrl } from '../game/assets';

export type FieldCreatureOption = {
  instanceId: string;
  name: string;
  speciesId: number;
};

export type FieldGraphEdge = { source: number; target: number; weight: number };
export type FieldPresentation = {
  creatures: readonly FieldCreatureOption[];
  selectedId: string;
  graph: { nodeIds: readonly string[]; edges: readonly FieldGraphEdge[] };
  activity: readonly number[];
  action: 0 | 1 | 2 | 3 | 4;
  paused: boolean;
  learning: boolean;
  lesionEnabled: boolean;
  energy: number;
  berries: number;
  reward: number;
  updates: number;
  tick: number;
  decisionText?: string;
};

export type FieldPanelCallbacks = {
  onSelect(instanceId: string): void;
  onTogglePause(): void;
  onToggleLearning(): void;
  onPlaceFood(): void;
  onToggleLesion(): void;
};

type Point = { x: number; y: number };
type Runtime = {
  callbacks: FieldPanelCallbacks;
  canvas: HTMLCanvasElement;
  creatureHost: HTMLElement;
  actionButtons: HTMLButtonElement[];
  pause: HTMLButtonElement;
  learning: HTMLButtonElement;
  lesion: HTMLButtonElement;
  energy: HTMLElement;
  energyFill: HTMLElement;
  berries: HTMLElement;
  reward: HTMLElement;
  updates: HTMLElement;
  tick: HTMLElement;
  decision: HTMLElement;
  graphMeta: HTMLElement;
  graphKey: string;
  points: Point[];
};

const runtimes = new WeakMap<HTMLElement, Runtime>();
const ACTIONS = [
  { symbol: '↑', label: '위로' },
  { symbol: '→', label: '오른쪽' },
  { symbol: '↓', label: '아래로' },
  { symbol: '←', label: '왼쪽' },
  { symbol: '·', label: '쉼' },
] as const;

function build(host: HTMLElement, callbacks: FieldPanelCallbacks): Runtime {
  host.classList.add('field-panel');
  host.innerHTML = `
    <div class="field-panel__top">
      <div>
        <span class="field-panel__eyebrow">CONNECTOME FIELD · 128 NODES</span>
        <h2>커넥톰 자율 필드</h2>
      </div>
      <span class="field-panel__live"><i></i> 실시간 활동</span>
    </div>
    <div class="field-panel__creatures" role="list" aria-label="필드에서 관찰할 개체"></div>
    <div class="field-panel__body">
      <section class="field-panel__graph-card" aria-labelledby="field-graph-title">
        <div class="field-panel__graph-heading">
          <div><span>신경 활동</span><strong id="field-graph-title">128개 노드의 현재 신호</strong></div>
          <small data-field-graph-meta></small>
        </div>
        <canvas width="760" height="330" aria-label="실제 커넥톰 부분 그래프의 128개 노드 활성도"></canvas>
        <div class="field-panel__legend"><span><i class="positive"></i> 양의 활성</span><span><i class="negative"></i> 음의 활성</span><span><i class="quiet"></i> 낮은 활성</span></div>
      </section>
      <aside class="field-panel__readout">
        <div class="field-panel__readout-title"><span>현재 행동 출력</span><p data-field-decision aria-live="polite"></p></div>
        <div class="field-panel__actions" role="list" aria-label="다섯 행동 출력">
          ${ACTIONS.map((action, index) => `<button type="button" tabindex="-1" aria-label="출력 ${index}, ${action.label}"><b>${action.symbol}</b><span>${action.label}</span><small>${index}</small></button>`).join('')}
        </div>
        <div class="field-panel__metrics">
          <div class="field-panel__energy"><span>에너지</span><strong data-field-energy>0</strong><i><b data-field-energy-fill></b></i></div>
          <div><span>획득 열매</span><strong data-field-berries>0</strong></div>
          <div><span>최근 보상</span><strong data-field-reward>0</strong></div>
          <div><span>학습 횟수</span><strong data-field-updates>0</strong></div>
          <div><span>필드 틱</span><strong data-field-tick>0</strong></div>
        </div>
      </aside>
    </div>
    <div class="field-panel__explain">
      <span>감각 → 회로 → 행동</span>
      <p>먹이·장애물 감각이 실제 128개 뉴런 연결을 거쳐 이동 또는 쉬기로 이어집니다. 감각과 학습 규칙은 게임용으로 설계했습니다.</p>
      <small>들판에서 배운 행동과 전투 경험은 개체별로 나누어 기억합니다.</small>
    </div>
    <div class="field-panel__controls" aria-label="자율 필드 제어">
      <button type="button" data-field-control="pause"><span>Ⅱ</span><b>일시정지</b></button>
      <button type="button" data-field-control="learning" aria-pressed="false"><span>↗</span><b>보상 학습</b></button>
      <button type="button" data-field-control="food"><span>●</span><b>먹이 놓기</b></button>
      <button type="button" data-field-control="lesion" aria-pressed="false"><span>⌁</span><b>연결 차단 비교</b></button>
    </div>`;

  host.querySelector('.field-panel__creatures')!.after(host.querySelector('.field-panel__controls')!);
  const runtime: Runtime = {
    callbacks,
    canvas: host.querySelector('canvas')!,
    creatureHost: host.querySelector('.field-panel__creatures')!,
    actionButtons: [...host.querySelectorAll<HTMLButtonElement>('.field-panel__actions button')],
    pause: host.querySelector('[data-field-control="pause"]')!,
    learning: host.querySelector('[data-field-control="learning"]')!,
    lesion: host.querySelector('[data-field-control="lesion"]')!,
    energy: host.querySelector('[data-field-energy]')!,
    energyFill: host.querySelector('[data-field-energy-fill]')!,
    berries: host.querySelector('[data-field-berries]')!,
    reward: host.querySelector('[data-field-reward]')!,
    updates: host.querySelector('[data-field-updates]')!,
    tick: host.querySelector('[data-field-tick]')!,
    decision: host.querySelector('[data-field-decision]')!,
    graphMeta: host.querySelector('[data-field-graph-meta]')!,
    graphKey: '', points: [],
  };
  runtime.creatureHost.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-field-creature]');
    if (button?.dataset.fieldCreature) runtime.callbacks.onSelect(button.dataset.fieldCreature);
  });
  runtime.pause.addEventListener('click', () => runtime.callbacks.onTogglePause());
  runtime.learning.addEventListener('click', () => runtime.callbacks.onToggleLearning());
  host.querySelector<HTMLButtonElement>('[data-field-control="food"]')!.addEventListener('click', () => runtime.callbacks.onPlaceFood());
  runtime.lesion.addEventListener('click', () => runtime.callbacks.onToggleLesion());
  runtimes.set(host, runtime);
  return runtime;
}

function reconcileCreatures(runtime: Runtime, creatures: readonly FieldCreatureOption[], selectedId: string): void {
  const wanted = new Set(creatures.map(creature => creature.instanceId));
  for (const existing of runtime.creatureHost.querySelectorAll<HTMLButtonElement>('[data-field-creature]')) {
    if (!wanted.has(existing.dataset.fieldCreature!)) existing.remove();
  }
  for (const creature of creatures) {
    let chip = [...runtime.creatureHost.querySelectorAll<HTMLButtonElement>('[data-field-creature]')]
      .find(button => button.dataset.fieldCreature === creature.instanceId);
    if (!chip) {
      chip = document.createElement('button');
      chip.type = 'button'; chip.dataset.fieldCreature = creature.instanceId; chip.setAttribute('role', 'listitem');
      chip.innerHTML = '<img alt=""><span><b></b><small></small></span><i aria-hidden="true"></i>';
      runtime.creatureHost.append(chip);
    }
    const image = chip.querySelector('img')!;
    const expectedSource = pokemonSpriteUrl(creature.speciesId);
    if (image.getAttribute('src') !== expectedSource) image.src = expectedSource;
    image.alt = `${creature.name} 모습`;
    chip.querySelector('b')!.textContent = creature.name;
    chip.querySelector('small')!.textContent = `No.${String(creature.speciesId).padStart(3, '0')}`;
    const active = creature.instanceId === selectedId;
    chip.classList.toggle('active', active); chip.setAttribute('aria-pressed', String(active));
  }
}

function graphPoints(count: number, width: number, height: number): Point[] {
  const cx = width / 2, cy = height / 2;
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: count }, (_, index) => {
    const ratio = Math.sqrt((index + .65) / Math.max(1, count));
    const angle = index * golden + (index % 3) * .12;
    return { x: cx + Math.cos(angle) * width * .43 * ratio, y: cy + Math.sin(angle) * height * .40 * ratio };
  });
}

function drawGraph(runtime: Runtime, presentation: FieldPresentation): void {
  const canvas = runtime.canvas;
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(320, Math.round(rect.width || 760));
  const cssHeight = Math.max(220, Math.round(rect.height || 330));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.round(cssWidth * dpr), height = Math.round(cssHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const key = `${presentation.graph.nodeIds.join('|')}@${width}x${height}`;
  if (runtime.graphKey !== key) { runtime.graphKey = key; runtime.points = graphPoints(presentation.graph.nodeIds.length, width, height); }
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, width, height);
  const points = runtime.points, activity = presentation.activity;
  for (const edge of presentation.graph.edges) {
    const from = points[edge.source], to = points[edge.target];
    if (!from || !to) continue;
    const signal = Math.min(1, Math.abs(activity[edge.source] ?? 0));
    ctx.strokeStyle = edge.weight >= 0 ? `rgba(166,211,123,${.045 + signal * .18})` : `rgba(113,177,193,${.04 + signal * .16})`;
    ctx.lineWidth = (.42 + Math.min(1.4, Math.abs(edge.weight) * .35) + signal * .45) * dpr;
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  }
  for (let index = 0; index < points.length; index++) {
    const point = points[index], value = Math.max(-1, Math.min(1, activity[index] ?? 0)), intensity = Math.abs(value);
    ctx.fillStyle = value > .05 ? `rgb(${166 + Math.round(45 * intensity)},${194 + Math.round(45 * intensity)},${116 + Math.round(45 * intensity)})`
      : value < -.05 ? `rgb(${96 + Math.round(35 * intensity)},${154 + Math.round(45 * intensity)},${169 + Math.round(50 * intensity)})` : '#587668';
    if (intensity > .45) { ctx.shadowColor = value >= 0 ? '#d8ef9a' : '#8ed8e6'; ctx.shadowBlur = 8 * dpr; }
    ctx.beginPath(); ctx.arc(point.x, point.y, (2.05 + intensity * 2.8) * dpr, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function formatMetric(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Math.abs(value) >= 1000 ? Math.round(value).toLocaleString('ko-KR') : Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Update the live field UI without replacing focused controls or creature chips. */
export function updateFieldPanel(host: HTMLElement, presentation: FieldPresentation, callbacks: FieldPanelCallbacks): void {
  const runtime = runtimes.get(host) ?? build(host, callbacks);
  runtime.callbacks = callbacks;
  reconcileCreatures(runtime, presentation.creatures, presentation.selectedId);
  runtime.actionButtons.forEach((button, index) => {
    const active = index === presentation.action;
    button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'true' : 'false');
  });
  const action = ACTIONS[presentation.action] ?? ACTIONS[4];
  runtime.decision.textContent = presentation.decisionText ?? `출력 ${presentation.action} · ${action.label} 행동을 선택했습니다.`;
  runtime.energy.textContent = formatMetric(presentation.energy);
  runtime.energyFill.style.width = `${Math.max(0, Math.min(100, presentation.energy))}%`;
  runtime.berries.textContent = formatMetric(presentation.berries);
  runtime.reward.textContent = `${presentation.reward > 0 ? '+' : ''}${formatMetric(presentation.reward)}`;
  runtime.reward.classList.toggle('positive', presentation.reward > 0);
  runtime.reward.classList.toggle('negative', presentation.reward < 0);
  runtime.updates.textContent = formatMetric(presentation.updates);
  runtime.tick.textContent = formatMetric(presentation.tick);
  runtime.pause.classList.toggle('active', presentation.paused);
  runtime.pause.querySelector('span')!.textContent = presentation.paused ? '▶' : 'Ⅱ';
  runtime.pause.querySelector('b')!.textContent = presentation.paused ? '계속하기' : '일시정지';
  runtime.pause.setAttribute('aria-pressed', String(presentation.paused));
  runtime.learning.classList.toggle('active', presentation.learning);
  runtime.learning.setAttribute('aria-pressed', String(presentation.learning));
  runtime.lesion.classList.toggle('active', presentation.lesionEnabled);
  runtime.lesion.setAttribute('aria-pressed', String(presentation.lesionEnabled));
  runtime.graphMeta.textContent = `${presentation.graph.nodeIds.length} 노드 · ${presentation.graph.edges.length.toLocaleString('ko-KR')} 연결`;
  drawGraph(runtime, presentation);
}
