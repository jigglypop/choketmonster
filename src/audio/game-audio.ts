export type GameSoundEvent = 'encounter' | 'creature' | 'attack' | 'capture' | 'victory' | 'heal' | 'select';

export type GameAudioSettings = {
  musicVolume: number;
  effectsVolume: number;
  muted: boolean;
};

export type GameSoundOptions = {
  /** National Pokédex ID for the original species cry. */
  speciesId?: number;
};

const STORAGE_KEY = 'choketmon-audio-v1';
const DEFAULT_SETTINGS: GameAudioSettings = { musicVolume: .34, effectsVolume: .62, muted: false };
type AudioWindow = Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext };

function clampVolume(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

export function normalizeGameAudioSettings(value: unknown): GameAudioSettings {
  const input = value && typeof value === 'object' ? value as Partial<GameAudioSettings> : {};
  return {
    musicVolume: clampVolume(input.musicVolume, DEFAULT_SETTINGS.musicVolume),
    effectsVolume: clampVolume(input.effectsVolume, DEFAULT_SETTINGS.effectsVolume),
    muted: typeof input.muted === 'boolean' ? input.muted : DEFAULT_SETTINGS.muted,
  };
}

export function creatureVoiceNotes(speciesId = 1): readonly [number, number, number] {
  const id = Math.max(1, Math.floor(Number.isFinite(speciesId) ? speciesId : 1));
  const root = 49 + id % 19;
  return [root, root + 3 + id % 5, root + 7 + Math.floor(id / 7) % 5];
}

function loadSettings(): GameAudioSettings {
  try { return normalizeGameAudioSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')); }
  catch { return { ...DEFAULT_SETTINGS }; }
}

function midi(note: number): number { return 440 * 2 ** ((note - 69) / 12); }

class GameAudioEngine {
  private context?: AudioContext;
  private master?: GainNode;
  private effectsBus?: GainNode;
  private unlocked = false;
  private effectNodes = new Set<OscillatorNode>();
  private cryNodes = new Set<AudioBufferSourceNode>();
  private cryBuffers = new Map<number, Promise<AudioBuffer | null>>();
  private crySerial = 0;
  private listeners = new Set<(settings: GameAudioSettings) => void>();
  private settings = loadSettings();

  getSettings = (): GameAudioSettings => ({ ...this.settings });

  subscribe = (listener: (settings: GameAudioSettings) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setSettings = (change: Partial<GameAudioSettings>): GameAudioSettings => {
    this.settings = normalizeGameAudioSettings({ ...this.settings, ...change });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings)); } catch { /* Session-only fallback. */ }
    this.applyLevels();
    if (this.settings.muted) this.stopPlayback();
    for (const listener of this.listeners) listener(this.getSettings());
    return this.getSettings();
  };

  unlock = async (): Promise<boolean> => {
    if (typeof window === 'undefined') return false;
    this.ensureContext();
    if (!this.context) return false;
    try {
      if (this.context.state !== 'running') await this.context.resume();
      this.unlocked = this.context.state === 'running';
      return this.unlocked;
    } catch { return false; }
  };

  play = (event: GameSoundEvent, options: GameSoundOptions = {}): void => {
    const context = this.context;
    if (!this.unlocked || !context || context.state !== 'running' || this.settings.muted || document.hidden) return;
    const now = context.currentTime;
    const voice = creatureVoiceNotes(options.speciesId);
    if (event === 'encounter' || event === 'creature') {
      void this.playCry(options.speciesId ?? 1);
      return;
    }
    if (event === 'attack') {
      this.tone(voice[2] + 12, now, .08, 'square', .15, -18);
      this.tone(voice[0] - 12, now + .045, .16, 'sawtooth', .12, -10);
      return;
    }
    const patterns: Record<Exclude<GameSoundEvent, 'encounter' | 'creature' | 'attack'>, readonly number[]> = {
      capture: [72, 76, 79, 84], victory: [67, 72, 76, 79, 84], heal: [72, 76, 79, 84, 88], select: [79],
    };
    const spacing = event === 'select' ? .04 : .09;
    patterns[event].forEach((note, index) => this.tone(note, now + index * spacing, event === 'select' ? .055 : .13, 'square', event === 'victory' ? .13 : .1));
  };

  private async playCry(speciesId: number): Promise<void> {
    const context = this.context, destination = this.effectsBus, serial = ++this.crySerial;
    if (!context || !destination || !Number.isInteger(speciesId) || speciesId < 1 || speciesId > 1025) return;
    let pending = this.cryBuffers.get(speciesId);
    if (!pending) {
      // Cache only a small working set. The immutable source is recorded in docs/audio-sources.md.
      pending = fetch(pokemonCryUrl(speciesId), { signal: AbortSignal.timeout(8000) })
        .then(async response => response.ok ? context.decodeAudioData(await response.arrayBuffer()) : null).catch(() => null);
      this.cryBuffers.set(speciesId, pending);
      if (this.cryBuffers.size > 32) this.cryBuffers.delete(this.cryBuffers.keys().next().value!);
    }
    const buffer = await pending;
    if (!buffer || this.context !== context || serial !== this.crySerial || this.settings.muted || document.hidden || context.state !== 'running') return;
    for (const previous of this.cryNodes) { try { previous.stop(); } catch { /* Ended. */ } }
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(destination);
    source.onended = () => { this.cryNodes.delete(source); source.disconnect(); };
    this.cryNodes.add(source); source.start();
  }

  handleVisibility = (): void => {
    if (document.hidden) {
      this.stopPlayback();
      void this.context?.suspend();
    } else if (this.unlocked && !this.settings.muted) {
      void this.context?.resume();
    }
  };

  destroy = (): void => {
    this.stopPlayback();
    const context = this.context;
    this.context = undefined;
    this.master = undefined;
    this.effectsBus = undefined;
    this.unlocked = false;
    if (context && context.state !== 'closed') void context.close();
  };

  private ensureContext(): void {
    if (this.context) return;
    const Constructor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
    if (!Constructor) return;
    this.context = new Constructor();
    this.master = this.context.createGain();
    this.effectsBus = this.context.createGain();
    this.effectsBus.connect(this.master);
    this.master.connect(this.context.destination);
    this.applyLevels();
  }

  private applyLevels(): void {
    if (!this.context || !this.master || !this.effectsBus) return;
    const now = this.context.currentTime;
    this.master.gain.setTargetAtTime(this.settings.muted ? 0 : .78, now, .015);
    this.effectsBus.gain.setTargetAtTime(this.settings.effectsVolume, now, .015);
  }

  private tone(note: number, start: number, duration: number, type: OscillatorType, level: number, bend = 0): void {
    const context = this.context;
    const destination = this.effectsBus;
    if (!context || !destination) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const nodes = this.effectNodes;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(midi(note), start);
    if (bend) oscillator.frequency.exponentialRampToValueAtTime(midi(note + bend), start + duration);
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime(level, start + Math.min(.012, duration / 3));
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    oscillator.connect(gain).connect(destination);
    nodes.add(oscillator);
    oscillator.onended = () => { nodes.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(start);
    oscillator.stop(start + duration + .01);
  }

  private stopPlayback(): void {
    this.crySerial++;
    for (const node of [...this.effectNodes, ...this.cryNodes]) {
      try { node.stop(); } catch { /* Already ended. */ }
    }
    this.cryNodes.clear();
    this.effectNodes.clear();
  }
}

export function pokemonCryUrl(speciesId: number): string {
  return `https://raw.githubusercontent.com/PokeAPI/cries/ef687b18f0ce17169b4b4c09175819f7ade92f0f/cries/pokemon/latest/${speciesId}.ogg`;
}

let engine: GameAudioEngine | undefined;
let attachments = 0;
function audio(): GameAudioEngine { return engine ??= new GameAudioEngine(); }

/**
 * Attach once at the game shell. The first pointer or non-modifier key gesture
 * unlocks WebAudio; the returned function stops and disposes audio on unmount.
 */
export function attachGameAudio(target: Document | HTMLElement = document): () => void {
  const instance = audio();
  const owner = target instanceof Document ? target : target.ownerDocument;
  const unlock = (event: Event) => {
    if (event instanceof KeyboardEvent && ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
    void instance.unlock();
  };
  target.addEventListener('pointerdown', unlock, { passive: true });
  target.addEventListener('keydown', unlock);
  owner.addEventListener('visibilitychange', instance.handleVisibility);
  attachments++;
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    target.removeEventListener('pointerdown', unlock);
    target.removeEventListener('keydown', unlock);
    owner.removeEventListener('visibilitychange', instance.handleVisibility);
    attachments = Math.max(0, attachments - 1);
    if (!attachments) { instance.destroy(); engine = undefined; }
  };
}

export function resumeGameAudio(): Promise<boolean> { return audio().unlock(); }
export function playGameSound(event: GameSoundEvent, options?: GameSoundOptions): void { audio().play(event, options); }
export function getGameAudioSettings(): GameAudioSettings { return audio().getSettings(); }
export function setGameAudioSettings(change: Partial<GameAudioSettings>): GameAudioSettings { return audio().setSettings(change); }
export function subscribeGameAudioSettings(listener: (settings: GameAudioSettings) => void): () => void { return audio().subscribe(listener); }
