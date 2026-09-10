import type { Graph } from '../core/brain';
import type { FieldPolicy } from '../game/field';
import type { GameState } from '../game/engine';
import type { ViewState } from '../game/storage';
import { FieldSession } from './field-session';
import { createFieldRuntime, type FieldRuntimeAdapter } from './field-runtime';
import { updateFieldPanel } from './field-panel';
import { getPokemonScene } from './scene';

type Context = { game?: GameState; view: ViewState; tab: string };
export class FieldBindings {
  readonly session: FieldSession;
  private runtime: FieldRuntimeAdapter;
  private ready = false;

  constructor(private graph: Graph, policy: FieldPolicy | undefined, private context: () => Context,
    private notify: (message: string, error?: boolean) => void, private queueSave: () => void) {
    this.session = new FieldSession(graph, policy);
    this.runtime = createFieldRuntime(() => {
      const { game, view, tab } = this.context();
      if (!game || game.battle || tab !== 'map' || document.hidden || this.session.paused) return;
      try {
        this.session.sync(game, view);
        this.session.simulation.step(this.session.learning);
        this.paint();
        if (this.session.simulation.tick % 16 === 0) this.queueSave();
      } catch (error) {
        this.session.paused = true; this.runtime.pause();
        this.notify(`자율 행동을 멈췄습니다: ${error instanceof Error ? error.message : error}`, true);
      }
    }, 300);
  }

  async start() { await this.runtime.start(); this.ready = true; this.update(); }

  update() {
    const { game, view, tab } = this.context();
    if (game) this.session.sync(game, view);
    if (this.ready) {
      if (game && !game.battle && tab === 'map' && !document.hidden && !this.session.paused) this.runtime.resume();
      else this.runtime.pause();
    }
    if (game && !game.battle && tab === 'map') this.paint();
  }

  save() {
    const { game, view } = this.context();
    if (game) { this.session.sync(game, view); this.session.save(view); }
  }

  private paint() {
    const { game, view } = this.context(), host = document.querySelector<HTMLElement>('#field-panel'), map = document.querySelector<HTMLElement>('.canvas-wrap');
    if (!game || !host || !map) return;
    const session = this.session, simulation = session.simulation;
    const selected = simulation.entities.find(entity => entity.id === session.selectedId) ?? simulation.entities[0];
    if (!selected) return;
    host.dataset.tick = String(simulation.tick);
    host.dataset.runtime = 'gaesup-world';
    host.dataset.graphId = this.graph.id;
    host.dataset.selectedId = selected.id;
    host.dataset.updates = String(selected.brain.updates);
    host.dataset.recurrentEnabled = String(simulation.recurrentEnabled);
    updateFieldPanel(host, {
      creatures: simulation.entities.map(entity => ({ instanceId: entity.id, speciesId: entity.speciesId, name: session.name(entity.id, entity.speciesId) })),
      selectedId: selected.id, graph: { nodeIds: this.graph.nodes, edges: this.graph.edges },
      activity: selected.brain.activity, action: selected.action as 0 | 1 | 2 | 3 | 4,
      paused: session.paused, learning: session.learning, lesionEnabled: !simulation.recurrentEnabled,
      energy: selected.energy, berries: selected.foods, reward: selected.reward, updates: selected.brain.updates, tick: simulation.tick,
      decisionText: session.placingFood ? '지도에서 먹이를 놓을 바닥을 눌러 주세요.' : `${session.name(selected.id, selected.speciesId)} · 감각 → 128개 뉴런 → 행동`,
    }, {
      onSelect: id => { session.selectedId = id; this.paint(); getPokemonScene().followSelected(); this.queueSave(); },
      onTogglePause: () => { session.paused = !session.paused; this.update(); this.queueSave(); },
      onToggleLearning: () => { session.learning = !session.learning; this.paint(); this.queueSave(); },
      onPlaceFood: () => { session.placingFood = !session.placingFood; this.paint(); map.scrollIntoView({ behavior: 'smooth', block: 'center' }); },
      onToggleLesion: () => { simulation.setRecurrentEnabled(!simulation.recurrentEnabled); this.paint(); this.queueSave(); },
    });
    getPokemonScene().showMap(map, game, view.position, {
      entities: simulation.entities, foods: simulation.foods, selectedId: selected.id, placingFood: session.placingFood,
      onSelect: id => { session.selectedId = id; this.paint(); getPokemonScene().followSelected(); },
      onFood: (x, y) => {
        try { simulation.dropFood(x, y); session.placingFood = false; this.paint(); this.queueSave(); this.notify('먹이를 놓았습니다. 각 포켓몬의 반응을 관찰해 보세요.'); }
        catch { this.notify('물·건물·먹이가 없는 빈 바닥에 놓아 주세요.', true); }
      },
    });
  }

  async dispose() { this.save(); await this.runtime.dispose(); }
}
