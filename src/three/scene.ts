import * as THREE from 'three';
import { renderingSuspended } from './render-budget';
import { acquireModel, modelCacheStats } from './model-cache';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import type { GameState } from '../game/engine';
import type { MapPosition } from '../game/map';
import { pokemonModelUrl } from '../game/assets';
import { selectPokemonMotionClip, type PokemonMotionKind } from '../data/model-motion';
import { getSpecies } from '../data/pokemon';
import { getPokemonFormModelSource } from '../data/pokemon-form-models';
import { disposeNormalizedPokemonMaterials, normalizePokemonMaterials } from '../openworld/pokemon-materials';

type Actor = { group: THREE.Group; model: THREE.Object3D; mixer: THREE.AnimationMixer; clips: THREE.AnimationClip[]; action?: THREE.AnimationAction; target: THREE.Vector3; heading: number; restingY: number; id: number; url: string };
type SceneMode = 'map' | 'battle' | 'specimen';
export type FieldScene = {
  entities: readonly { id: string; speciesId: number; x: number; y: number; action: number }[];
  foods: readonly { x: number; y: number }[];
  selectedId: string;
  placingFood: boolean;
  onSelect: (id: string) => void;
  onFood: (x: number, y: number) => void;
};
/** One WebGL context survives DOM tab changes; renderer timing never consumes game RNG. */
export class PokemonScene {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 1, .1, 150);
  readonly controls: OrbitControls;
  private host?: HTMLElement;
  private mode: SceneMode = 'map';
  private world?: THREE.Group;
  private worldTask?: Promise<void>;
  private leases = new Map<string, ReturnType<typeof acquireModel>>();
  private load(url: string) {
    let lease = this.leases.get(url);
    if (!lease) {
      lease = acquireModel(url); this.leases.set(url, lease);
      const acquired = lease;
      void lease.promise.catch(() => { if (this.leases.get(url) === acquired) { acquired.release(); this.leases.delete(url); } });
    }
    return lease.promise;
  }
  private arena = new THREE.Group();
  private actors = new Map<string, Actor>();
  private pending = new Map<string, { token: number; url: string }>();
  private desired = new Map<string, { id: number; url: string; position: THREE.Vector3; heading: number; height: number }>();
  private epoch = 0;
  private then = 0;
  private observer: ResizeObserver;
  private marker: THREE.Mesh;
  private hitTime = 0;
  private lastTurn = -1;
  private lastHp = new Map<string, number>();
  private notice = document.createElement('span');
  private sceneKey = '';
  private disposed = false;
  private field?: FieldScene;
  private foodGroup = new THREE.Group();
  private foodKey = '';
  private fruitGeometry = new THREE.IcosahedronGeometry(.19, 2);
  private fruitMaterial = new THREE.MeshStandardMaterial({ color: '#f27b58', roughness: .7, emissive: '#552508', emissiveIntensity: .15 });
  private leafGeometry = new THREE.SphereGeometry(.08, 7, 5);
  private leafMaterial = new THREE.MeshStandardMaterial({ color: '#4b9464' });
  private pointerStart = { x: 0, y: 0 };
  private followingField = false;
  private followOffset = new THREE.Vector3();

  constructor() {
    this.canvas = document.createElement('canvas'); this.canvas.className = 'game-webgl';
    this.canvas.setAttribute('aria-label', '3D 포켓몬 장면. 드래그해 회전하고 휠이나 두 손가락으로 확대합니다.');
    this.canvas.tabIndex = 0;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.35;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color('#dce8dd');
    this.scene.fog = new THREE.Fog('#dce8dd', 38, 85);
    this.scene.add(new THREE.HemisphereLight('#fff6de', '#5e8064', 2.2));
    const sun = new THREE.DirectionalLight('#fff2d8', 3.1); sun.position.set(-12, 22, 14); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -18; sun.shadow.camera.right = 18; sun.shadow.camera.top = 18; sun.shadow.camera.bottom = -18; sun.shadow.camera.near = 1; sun.shadow.camera.far = 65; sun.shadow.bias = -.00035; sun.shadow.normalBias = .04;
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight('#d4f0ff', .7); fill.position.set(10, 8, -15); this.scene.add(fill);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true; this.controls.dampingFactor = .09; this.controls.enablePan = false;
    this.controls.minPolarAngle = .2; this.controls.maxPolarAngle = Math.PI / 2.1;
    this.notice.className = 'scene-loading'; this.notice.hidden = true;
    const ground = new THREE.Mesh(new THREE.CylinderGeometry(6.8, 7.1, .3, 64), new THREE.MeshStandardMaterial({ color: '#abc994', roughness: .95 }));
    ground.position.y = -.18; ground.receiveShadow = true; this.arena.add(ground);
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.7, 2.75, 80), new THREE.MeshBasicMaterial({ color: '#e4e6c8', side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = .005; this.arena.add(ring);
    const center = new THREE.Mesh(new THREE.RingGeometry(.65, .72, 64), new THREE.MeshBasicMaterial({ color: '#e4e6c8', side: THREE.DoubleSide }));
    center.rotation.x = -Math.PI / 2; center.position.y = .008; this.arena.add(center);
    this.scene.add(this.arena); this.arena.visible = false;
    this.marker = new THREE.Mesh(new THREE.RingGeometry(.33, .4, 40), new THREE.MeshBasicMaterial({ color: '#fff4ba', transparent: true, opacity: .8, side: THREE.DoubleSide }));
    this.marker.rotation.x = -Math.PI / 2; this.marker.position.y = .03; this.scene.add(this.marker);
    this.scene.add(this.foodGroup);
    this.canvas.addEventListener('pointerdown', event => { this.pointerStart = { x: event.clientX, y: event.clientY }; });
    this.canvas.addEventListener('pointerup', event => this.pickField(event));
    this.observer = new ResizeObserver(() => this.resize());
    this.renderer.setAnimationLoop(now => this.frame(now));
    this.canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); this.error('3D 화면 연결이 끊겼어요. 페이지를 새로고침해 주세요.'); });
  }

  private attach(host: HTMLElement, mode: SceneMode, key: string) {
    if (this.host !== host) {
      this.observer.disconnect(); this.host = host; this.observer.observe(host);
      host.classList.add('has-webgl'); host.append(this.canvas, this.notice);
    }
    this.canvas.id = mode === 'map' ? 'map-canvas' : mode === 'battle' ? 'battle-canvas' : 'pokemon-canvas';
    this.canvas.dataset.mode = mode;
    const changed = this.mode !== mode || this.sceneKey !== key;
    if (changed) {
      this.followingField = false;
      this.epoch++; this.pending.clear(); this.desired.clear(); this.clearActors();
      this.mode = mode; this.sceneKey = key; this.lastTurn = -1; this.lastHp.clear();
      this.controls.autoRotate = mode === 'specimen'; this.controls.autoRotateSpeed = .7;
      if (mode === 'map') { this.camera.position.set(19, 25, 27); this.controls.target.set(0, 0, 0); this.controls.minDistance = 12; this.controls.maxDistance = 55; }
      else if (mode === 'battle') { this.camera.position.set(7.5, 4.7, 9.5); this.controls.target.set(0, .9, 0); this.controls.minDistance = 5; this.controls.maxDistance = 20; }
      else { this.camera.position.set(3.4, 2.1, 4.7); this.controls.target.set(0, .95, 0); this.controls.minDistance = 2.6; this.controls.maxDistance = 10; }
      this.controls.update();
    }
    this.arena.visible = mode !== 'map'; this.marker.visible = mode === 'map'; if (this.world) this.world.visible = mode === 'map';
    this.foodGroup.visible = mode === 'map' && !!this.field;
    this.resize();
  }
  showMap(host: HTMLElement, game: GameState, position: MapPosition, field?: FieldScene) {
    host.querySelector('canvas:not(.game-webgl)')?.remove();
    this.field = field;
    this.attach(host, 'map', `map-${game.regionId}`);
    this.desired.clear();
    const lead = game.player.team[0], pos = new THREE.Vector3(position.x - 11.5, .03, position.y - 7);
    this.want('trainer', 0, pos, 0, 1.25);
    if (field) {
      for (const entity of field.entities) this.want(`field-${entity.id}`, entity.speciesId, new THREE.Vector3(entity.x - 11.5, .03, entity.y - 7), 0, 1.3);
      this.drawFood(field.foods);
      this.canvas.style.cursor = field.placingFood ? 'crosshair' : 'grab';
      this.canvas.dataset.fieldPositions = JSON.stringify(field.entities.map(e => [e.id, e.x, e.y]));
    } else this.want('companion', lead.speciesId, pos.clone().add(new THREE.Vector3(-.9, 0, .55)), 0, 1.05);
    this.marker.position.set(pos.x, .035, pos.z);
    if (!this.worldTask) this.worldTask = this.load('/models/world.glb').then(asset => {
      const scene = asset.scene.clone(true); scene.name = 'Blender world';
      scene.traverse(obj => { if (obj instanceof THREE.Light || obj instanceof THREE.Camera) obj.visible = false; if (obj instanceof THREE.Mesh) { obj.castShadow = true; obj.receiveShadow = true; } });
      this.world = scene; this.scene.add(scene); scene.visible = this.mode === 'map'; this.ready();
    }).catch(error => { this.worldTask = undefined; this.error(`지형을 불러오지 못했어요: ${error.message}`); });
    this.synchronize();
  }
  showBattle(host: HTMLElement, game: GameState) {
    if (!game.battle) return;
    const b = game.battle, self = b.player.team[b.player.activeIndex], enemy = b.enemy.team[b.enemy.activeIndex];
    this.attach(host, 'battle', `battle-${b.kind}-${b.enemy.team[0].instanceId}`);
    this.desired.clear();
    const species = (id: string, original: number) => b.transformations?.[id]?.speciesId ?? original;
    const formUrl = (monster: typeof self) => getPokemonFormModelSource(b.transformations?.[monster.instanceId]?.formIdentifier ?? monster.regionalForm)?.url;
    this.want('player', species(self.instanceId, self.speciesId), new THREE.Vector3(-2.15, .01, 1), 2, 1.95, formUrl(self));
    this.want('enemy', species(enemy.instanceId, enemy.speciesId), new THREE.Vector3(2.15, .01, -1), -1.15, 1.95, formUrl(enemy));
    if (this.lastTurn >= 0 && b.turn !== this.lastTurn) {
      this.hitTime = performance.now();
      for (const [key, mon] of [['player', self], ['enemy', enemy]] as const) {
        const actor = this.actors.get(key); if (actor) this.play(actor, mon.hp < (this.lastHp.get(key) ?? mon.hp) ? 'damage' : 'attack', true);
      }
    }
    this.lastTurn = b.turn; this.lastHp.set('player', self.hp); this.lastHp.set('enemy', enemy.hp);
    this.synchronize();
  }
  showSpecimen(host: HTMLElement, id: number, formIdentifier?: string) {
    const source = getPokemonFormModelSource(formIdentifier);
    this.attach(host, 'specimen', `specimen-${formIdentifier ?? id}`);
    this.desired.clear(); this.want('specimen', id, new THREE.Vector3(0, .01, 0), .25, 2.1, source?.url); this.synchronize();
  }
  detach() { this.host = undefined; this.observer.disconnect(); this.canvas.remove(); this.notice.remove(); }
  followSelected() {
    if (!this.field || this.mode !== 'map') return;
    const selected = this.actors.get(`field-${this.field.selectedId}`); if (!selected) return;
    this.followingField = true; this.controls.minDistance = 4;
    this.controls.target.copy(selected.group.position).add(new THREE.Vector3(0, .7, 0));
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3(6, 8, 10)); this.controls.update();
  }
  showOverview() {
    this.followingField = false; this.controls.minDistance = 12;
    this.controls.target.set(0, 0, 0); this.camera.position.set(19, 25, 27); this.controls.update();
  }
  private drawFood(foods: FieldScene['foods']) {
    const key = foods.map(f => `${f.x},${f.y}`).join(';');
    if (key === this.foodKey) return; this.foodKey = key; this.foodGroup.clear();
    for (const food of foods) {
      const berry = new THREE.Mesh(this.fruitGeometry, this.fruitMaterial); berry.position.set(food.x - 11.5, .27, food.y - 7); berry.castShadow = true;
      const leaf = new THREE.Mesh(this.leafGeometry, this.leafMaterial); leaf.scale.set(.6, .4, 1.8); leaf.position.set(0, .22, 0); leaf.rotation.z = .5; berry.add(leaf); this.foodGroup.add(berry);
    }
  }
  private pickField(event: PointerEvent) {
    if (!this.field || this.mode !== 'map' || Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 6) return;
    const rect = this.canvas.getBoundingClientRect(), pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(pointer, this.camera);
    if (this.field.placingFood) {
      const point = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      if (point) this.field.onFood(Math.round(point.x + 11.5), Math.round(point.z + 7));
    } else {
      const fieldActors = [...this.actors.entries()].filter(([key]) => key.startsWith('field-'));
      const hits = ray.intersectObjects(fieldActors.map(([, actor]) => actor.group), true);
      const hit = hits[0]; if (!hit) return;
      for (const [key, actor] of fieldActors) { let object: THREE.Object3D | null = hit.object; while (object) { if (object === actor.group) { this.field.onSelect(key.slice(6)); return; } object = object.parent; } }
    }
  }
  private want(key: string, id: number, position: THREE.Vector3, heading: number, height: number, url = id ? pokemonModelUrl(id) : '/models/trainer.glb') {
    this.desired.set(key, { id, url, position, heading, height });
  }
  private synchronize() {
    for (const [key, actor] of this.actors) if (this.desired.get(key)?.url !== actor.url) { this.removeActor(actor); this.actors.delete(key); }
    for (const [key, spec] of this.desired) {
      const actor = this.actors.get(key);
      if (actor) { actor.target.copy(spec.position); actor.heading = spec.heading; continue; }
      if (this.pending.get(key)?.url === spec.url) continue;
      const token = ++this.epoch; this.pending.set(key, { token, url: spec.url });
      this.notice.hidden = true;
      const url = spec.url;
      void this.load(url).then(asset => {
        if (this.disposed || this.pending.get(key)?.token !== token || this.desired.get(key)?.url !== spec.url) { this.trimCache(); return; }
        const model = clone(asset.scene), group = new THREE.Group(); group.add(model);
        if (spec.id) normalizePokemonMaterials(model, { speciesId: spec.id, types: getSpecies(spec.id).types });
        model.traverse(obj => { if (obj instanceof THREE.Mesh) { obj.castShadow = true; obj.receiveShadow = true; obj.frustumCulled = false; } });
        const mixer = new THREE.AnimationMixer(model);
        const { clip } = selectPokemonMotionClip(asset.animations, 'idle');
        const action = clip ? mixer.clipAction(clip).play() : undefined; mixer.setTime(0);
        model.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model, true), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
        if (![size.x, size.y, size.z].every(Number.isFinite) || size.length() === 0) throw new Error('모델 크기가 올바르지 않습니다.');
        model.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
        const scale = Math.min(spec.height / Math.max(size.y, .001), spec.height * 2.15 / Math.max(size.x, size.z, .001));
        group.scale.setScalar(scale); group.position.copy(this.desired.get(key)!.position); group.rotation.y = spec.heading;
        const newActor: Actor = { id: spec.id, url, group, model, mixer, clips: asset.animations, action, target: this.desired.get(key)!.position.clone(), heading: spec.heading, restingY: group.position.y };
        this.actors.set(key, newActor); this.scene.add(group); this.pending.delete(key); this.ready(); this.trimCache();
      }).catch(error => { if (this.pending.get(key)?.token === token) { this.pending.delete(key); this.error(`3D 모델을 불러오지 못했어요: ${error.message}`); } });
    }
    this.ready(); this.trimCache();
  }
  private play(actor: Actor, kind: PokemonMotionKind, once = false) {
    const { clip, matched } = selectPokemonMotionClip(actor.clips, kind);
    if (!clip) return;
    const next = actor.mixer.clipAction(clip);
    if (actor.action === next && next.isRunning()) return;
    if (actor.action) actor.action.fadeOut(.16);
    const playOnce = once && matched;
    next.reset().setLoop(playOnce ? THREE.LoopOnce : THREE.LoopRepeat, playOnce ? 1 : Infinity).fadeIn(.16).play(); next.clampWhenFinished = playOnce; actor.action = next;
  }
  private resize() {
    if (!this.host) return;
    const width = this.host.clientWidth, height = this.host.clientHeight;
    if (width < 1 || height < 1) return;
    this.renderer.setSize(width, height, false); this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
  }
  private ready() {
    const ready = this.pending.size === 0 && this.actors.size === this.desired.size && (this.mode !== 'map' || !!this.world);
    this.canvas.dataset.ready = String(ready); this.canvas.dataset.actorCount = String(this.actors.size);
    this.canvas.dataset.species = [...this.actors.values()].filter(a => a.id).map(a => a.id).join(',');
    this.canvas.dataset.modelUrls = [...this.actors.values()].filter(a => a.id).map(a => a.url).join(',');
    if (ready) this.notice.hidden = true;
  }
  private error(message: string) { this.notice.textContent = message; this.notice.hidden = false; this.canvas.dataset.ready = 'error'; }
  private frame(now: number) {
    const delta = Math.min((now - this.then) / 1000 || 0, .05); this.then = now;
    if (!this.host?.isConnected || document.hidden || this.disposed || renderingSuspended()) return;
    for (const actor of this.actors.values()) {
      const distance = actor.group.position.distanceTo(actor.target);
      if (this.mode === 'map') {
        if (distance > .035) { actor.heading = Math.atan2(actor.target.x - actor.group.position.x, actor.target.z - actor.group.position.z); this.play(actor, 'walk'); }
        else this.play(actor, 'idle');
      } else if (now - this.hitTime > 1150) this.play(actor, 'idle');
      actor.group.position.lerp(actor.target, 1 - Math.exp(-delta * 9));
      const angle = Math.atan2(Math.sin(actor.heading - actor.group.rotation.y), Math.cos(actor.heading - actor.group.rotation.y)); actor.group.rotation.y += angle * Math.min(delta * 9, 1);
      actor.mixer.update(delta);
    }
    if (this.mode === 'map' && this.field) {
      const selected = this.actors.get(`field-${this.field.selectedId}`);
      if (selected) this.marker.position.set(selected.group.position.x, .04, selected.group.position.z);
      if (selected && this.followingField) {
        this.followOffset.copy(selected.group.position); this.followOffset.y += .7;
        this.followOffset.sub(this.controls.target).multiplyScalar(Math.min(1, delta * 5));
        this.controls.target.add(this.followOffset); this.camera.position.add(this.followOffset);
      }
      this.marker.scale.setScalar(1.2 + Math.sin(now / 280) * .08);
    }
    this.controls.update(delta); this.renderer.render(this.scene, this.camera);
    this.canvas.dataset.drawCalls = String(this.renderer.info.render.calls); this.canvas.dataset.triangles = String(this.renderer.info.render.triangles);
    this.canvas.dataset.cachedAssets = String(modelCacheStats().cachedModels);
    this.canvas.dataset.animationTime = String(this.actors.values().next().value?.mixer.time ?? 0);
  }
  dispose() { this.disposed = true; this.renderer.setAnimationLoop(null); this.observer.disconnect(); this.controls.dispose(); this.clearActors(); for (const lease of this.leases.values()) lease.release(); this.leases.clear(); this.renderer.dispose(); }
  private removeActor(actor: Actor) {
    actor.mixer.stopAllAction(); actor.mixer.uncacheRoot(actor.model); this.scene.remove(actor.group);
    disposeNormalizedPokemonMaterials(actor.model);
    const skeletons = new Set<THREE.Skeleton>();
    actor.model.traverse(object => { if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton); });
    for (const skeleton of skeletons) skeleton.dispose();
  }
  private clearActors() { for (const actor of this.actors.values()) this.removeActor(actor); this.actors.clear(); }
  private trimCache() {
    const protectedUrls = new Set(['/models/world.glb', '/models/trainer.glb', ...[...this.desired.values(), ...this.actors.values()].map(a => a.url)]);
    for (const [url, lease] of this.leases) {
      if (!protectedUrls.has(url)) { lease.release(); this.leases.delete(url); }
    }
  }
}

let singleton: PokemonScene | undefined;
export function getPokemonScene() { return singleton ??= new PokemonScene(); }
export function detachPokemonScene() { singleton?.detach(); }
