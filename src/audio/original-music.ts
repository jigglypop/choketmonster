import { getGameAudioSettings, subscribeGameAudioSettings } from './game-audio';
import { SceneMusicDirector, sceneMusicTrack, type MusicCue, type MusicScene } from './scene-music';
import './audio.css';

const DB_NAME = 'choketmon-local-music-v1';
const STORE_NAME = 'tracks';
const TRACK_KEY = 'selected';
const PAUSED_KEY = 'choketmon-music-paused-v1';
const SELECT_EVENT = 'choketmon:music-select';
const REMOVE_EVENT = 'choketmon:music-remove';
const QUERY_EVENT = 'choketmon:music-query';
const STATUS_EVENT = 'choketmon:music-status';
const MUSIC_FADE_MS = 1_000;

type StoredTrack = { blob: Blob; name: string; type: string; size: number; lastModified: number };
type MusicStatus = { message: string; hasFile: boolean; name?: string; playing: boolean; state: 'empty' | 'loading' | 'ready' | 'playing' | 'paused' | 'blocked' | 'error' };

function openMusicDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('음악 저장소를 열지 못했습니다.'));
    request.onblocked = () => reject(new Error('다른 탭이 음악 저장소를 사용하고 있습니다.'));
  });
}

async function readStoredTrack(): Promise<StoredTrack | null> {
  const db = await openMusicDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(TRACK_KEY);
      request.onsuccess = () => resolve((request.result as StoredTrack | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

async function writeStoredTrack(track: StoredTrack): Promise<void> {
  const db = await openMusicDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(track, TRACK_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('음악 파일 저장이 중단되었습니다.'));
    });
  } finally { db.close(); }
}

async function deleteStoredTrack(): Promise<void> {
  const db = await openMusicDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(TRACK_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('음악 파일 제거가 중단되었습니다.'));
    });
  } finally { db.close(); }
}

function validateAudio(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = new Audio();
    const timeout = window.setTimeout(() => finish(new Error('음악 파일을 읽는 시간이 너무 오래 걸립니다.')), 10_000);
    const finish = (error?: Error) => {
      window.clearTimeout(timeout); probe.onloadedmetadata = null; probe.onerror = null; probe.removeAttribute('src'); probe.load();
      if (error) reject(error); else resolve();
    };
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => finish();
    probe.onerror = () => finish(new Error('이 음악 파일은 브라우저에서 재생할 수 없거나 손상되었습니다.'));
    probe.src = url; probe.load();
  });
}

/** Local selection overrides the configured default track. Blobs are never uploaded. */
export function mountOriginalMusic(button: HTMLButtonElement): { open(): void; setScene(scene: MusicScene): void; destroy(): void } {
  const input = document.createElement('input');
  input.id = 'game-music-file'; input.type = 'file'; input.accept = 'audio/*,video/mp4,.mp4,.mp3,.m4a,.aac,.ogg,.wav,.flac'; input.hidden = true;
  const createAudio = () => {
    const element = document.createElement('audio');
    element.preload = 'auto'; element.loop = true; element.hidden = true;
    return element;
  };
  let audio = createAudio();
  audio.id = 'game-music-audio';
  const feedback = document.createElement('output');
  feedback.id = 'game-music-feedback'; feedback.setAttribute('role', 'status'); feedback.hidden = true;
  document.body.append(input, audio, feedback);

  let track: { name: string } | null = null;
  let customTrack = false;
  let restoring = true;
  let selecting = false;
  let sceneCue: MusicCue = 'opening';
  const sceneDirector = new SceneMusicDirector();
  let installedCue: MusicCue | undefined;
  let failedCue: MusicCue | undefined;
  let failedCueRetryAt = 0;
  let sceneTimer = 0;
  let fadeTimer = 0;
  let fadingAudio: HTMLAudioElement | undefined;
  const cuePositions = new Map<MusicCue, number>();
  let objectUrl: string | undefined;
  let disposed = false;
  let generation = 0;
  let wantsPlayback = sessionStorage.getItem(PAUSED_KEY) !== '1';
  let playbackRequested = true;
  let playbackGeneration = 0;
  let playAttempt: Promise<void> | undefined;
  let persistence = Promise.resolve<void>(undefined);
  let feedbackTimer = 0;
  let current: MusicStatus = { message: 'BGM 파일을 선택하세요.', hasFile: false, playing: false, state: 'empty' };

  const persist = (operation: () => Promise<void>): Promise<void> => {
    const result = persistence.catch(() => undefined).then(operation);
    persistence = result.catch(() => undefined);
    return result;
  };

  const emit = (next: MusicStatus, announce = false) => {
    next.hasFile = customTrack;
    current = next;
    document.dispatchEvent(new CustomEvent<MusicStatus>(STATUS_EVENT, { detail: next }));
    if (announce) {
      feedback.textContent = next.message; feedback.hidden = false;
      window.clearTimeout(feedbackTimer);
      feedbackTimer = window.setTimeout(() => { feedback.hidden = true; }, 4500);
    }
  };
  const syncButton = () => {
    const playing = !audio.paused && !audio.ended && Boolean(track);
    button.textContent = track ? (playing ? '♪ BGM 정지' : '♪ BGM 재생') : '♪ BGM 선택';
    const action = track ? (playing ? 'BGM 정지' : 'BGM 재생') : 'BGM 오디오 파일 선택';
    button.setAttribute('aria-label', action);
    button.title = action;
    button.setAttribute('aria-pressed', String(playing));
    button.dataset.music = track ? (playing ? 'playing' : 'ready') : 'empty';
  };
  const syncSettings = () => {
    const settings = getGameAudioSettings();
    audio.volume = settings.musicVolume;
    audio.muted = settings.muted;
    audio.dataset.volume = String(audio.volume);
    audio.dataset.muted = String(audio.muted);
    if (fadingAudio) fadingAudio.muted = settings.muted;
  };
  const stopFadingAudio = () => {
    window.clearInterval(fadeTimer); fadeTimer = 0;
    if (!fadingAudio) return;
    fadingAudio.pause(); fadingAudio.removeAttribute('src'); fadingAudio.load(); fadingAudio.remove(); fadingAudio = undefined;
    syncSettings();
  };
  const restoreCuePosition = (element: HTMLAudioElement, cue: MusicCue) => {
    const position = cuePositions.get(cue);
    if (!position) return;
    const restore = () => {
      if (Number.isFinite(element.duration) && element.duration > 0) element.currentTime = position % element.duration;
    };
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) restore();
    else element.addEventListener('loadedmetadata', restore, { once: true });
  };
  const releaseUrl = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
  };
  const installTrack = async (next: StoredTrack, token: number): Promise<boolean> => {
    const candidateUrl = URL.createObjectURL(next.blob);
    try { await validateAudio(candidateUrl); }
    catch (error) {
      URL.revokeObjectURL(candidateUrl);
      if (token === generation) emit({ message: error instanceof Error ? error.message : '음악 파일을 읽지 못했습니다.', hasFile: Boolean(track), name: track?.name, playing: false, state: 'error' }, true);
      return false;
    }
    if (disposed || token !== generation) { URL.revokeObjectURL(candidateUrl); return false; }
    playbackGeneration++; playAttempt = undefined; stopFadingAudio();
    audio.pause(); audio.removeAttribute('src'); audio.load(); releaseUrl();
    customTrack = true; installedCue = undefined; delete audio.dataset.cue;
    objectUrl = candidateUrl; track = next; audio.src = candidateUrl; audio.load(); syncSettings(); syncButton();
    emit({ message: '선택한 BGM 준비 완료', hasFile: true, name: next.name, playing: false, state: 'ready' });
    if (wantsPlayback && playbackRequested) void attemptPlay();
    return true;
  };
  const attemptPlay = (): Promise<void> => {
    if (disposed || !track || !wantsPlayback || document.hidden || (!audio.paused && !audio.ended)) return Promise.resolve();
    playbackRequested = true;
    if (playAttempt) return playAttempt;
    const token = generation, playToken = playbackGeneration, selected = track;
    let request: Promise<void>;
    try { request = audio.play(); }
    catch (error) { request = Promise.reject(error); }
    const attempt = request.then(() => {
      if (disposed || token !== generation || playToken !== playbackGeneration || track !== selected) return;
      if (!wantsPlayback) { audio.pause(); return; }
      if (document.hidden || audio.paused) return;
      syncButton();
      emit({ message: 'BGM 재생 중', hasFile: true, name: selected.name, playing: true, state: 'playing' });
    }).catch(error => {
      if (disposed || token !== generation || playToken !== playbackGeneration || track !== selected || !wantsPlayback) return;
      const blocked = error instanceof DOMException && error.name === 'NotAllowedError';
      syncButton();
      emit({ message: blocked ? '화면을 누르거나 키를 입력하면 음악이 시작됩니다.' : '음악을 재생하지 못했습니다. BGM 재생 버튼으로 다시 시도해 주세요.', hasFile: true, name: selected.name, playing: false, state: blocked ? 'blocked' : 'error' }, !blocked);
    });
    playAttempt = attempt;
    void attempt.finally(() => { if (playAttempt === attempt) playAttempt = undefined; });
    return attempt;
  };
  const installScene = () => {
    if (disposed || selecting || customTrack || installedCue === sceneCue || (failedCue === sceneCue && Date.now() < failedCueRetryAt)) return;
    generation++; playbackGeneration++; playAttempt = undefined;
    const next = sceneMusicTrack(sceneCue);
    const previous = audio;
    const previousCue = installedCue;
    const canCrossfade = wantsPlayback && !document.hidden && !previous.paused && Boolean(previousCue);
    if (previousCue && Number.isFinite(previous.currentTime)) cuePositions.set(previousCue, previous.currentTime);
    stopFadingAudio(); releaseUrl();
    track = next; installedCue = sceneCue;

    if (canCrossfade) {
      const incoming = createAudio();
      incoming.onplay = () => syncButton();
      incoming.onpause = () => syncButton();
      incoming.onerror = () => emit({ message: '음악 파일 재생 중 오류가 발생했습니다. 이전 곡을 유지하거나 잠시 뒤 다시 시도합니다.', hasFile: Boolean(track), name: track?.name, playing: false, state: 'error' }, true);
      previous.removeAttribute('id'); incoming.id = 'game-music-audio';
      incoming.dataset.cue = sceneCue; incoming.src = next.url;
      incoming.muted = getGameAudioSettings().muted; incoming.volume = 0;
      previous.after(incoming); audio = incoming; fadingAudio = previous;
      restoreCuePosition(incoming, sceneCue); incoming.load(); syncButton();
      const token = playbackGeneration;
      let request: Promise<void>;
      try { request = incoming.play(); } catch (error) { request = Promise.reject(error); }
      void request.then(() => {
        if (disposed || token !== playbackGeneration || audio !== incoming || fadingAudio !== previous) return;
        failedCue = undefined; failedCueRetryAt = 0;
        const startedAt = performance.now();
        fadeTimer = window.setInterval(() => {
          if (disposed || audio !== incoming || fadingAudio !== previous || incoming.paused) { stopFadingAudio(); return; }
          const progress = Math.min(1, (performance.now() - startedAt) / MUSIC_FADE_MS);
          const volume = getGameAudioSettings().musicVolume;
          incoming.volume = volume * progress;
          previous.volume = volume * (1 - progress);
          if (progress >= 1) stopFadingAudio();
        }, 50);
        syncButton();
        emit({ message: '장면에 맞춰 BGM을 부드럽게 전환하는 중', hasFile: false, name: next.name, playing: true, state: 'playing' });
      }).catch(() => {
        if (disposed || audio !== incoming || fadingAudio !== previous) return;
        incoming.pause(); incoming.remove();
        previous.id = 'game-music-audio'; audio = previous; fadingAudio = undefined;
        track = previousCue ? sceneMusicTrack(previousCue) : null; installedCue = previousCue;
        failedCue = next.cue; failedCueRetryAt = Date.now() + 30_000;
        syncSettings(); syncButton();
        emit({ message: '다음 BGM을 불러오지 못해 이전 곡을 계속 재생합니다.', hasFile: false, name: track?.name, playing: !audio.paused, state: 'error' }, true);
      });
    } else {
      previous.pause(); previous.src = next.url; previous.dataset.cue = sceneCue;
      restoreCuePosition(previous, sceneCue); previous.load(); syncSettings(); syncButton();
    }
    emit({ message: '장면에 맞춰 자동 재생', hasFile: false, name: next.name, playing: false, state: 'ready' });
    if (wantsPlayback && !canCrossfade) void attemptPlay();
  };
  const setScene = (scene: MusicScene) => {
    window.clearTimeout(sceneTimer);
    const scheduled = sceneDirector.update(scene);
    sceneCue = scheduled.cue;
    if (scheduled.nextUpdateAt !== undefined) {
      sceneTimer = window.setTimeout(() => {
        const resolved = sceneDirector.resolve();
        sceneCue = resolved.cue;
        if (!restoring) installScene();
      }, Math.max(0, scheduled.nextUpdateAt - Date.now()));
    }
    if (!restoring) installScene();
  };
  const pause = (announce = false) => {
    wantsPlayback = false; playbackGeneration++; playAttempt = undefined;
    sessionStorage.setItem(PAUSED_KEY, '1'); audio.pause(); stopFadingAudio(); syncButton();
    if (track) emit({ message: 'BGM 정지', hasFile: true, name: track.name, playing: false, state: 'paused' }, announce);
  };
  const choose = () => input.click();
  const remove = async () => {
    const token = ++generation;
    try {
      await persist(deleteStoredTrack);
      if (disposed || token !== generation) return;
      customTrack = false; installedCue = undefined; installScene();
      emit({ message: '선택한 파일을 제거하고 장면별 음악으로 돌아왔습니다.', hasFile: false, name: track?.name, playing: !audio.paused, state: audio.paused ? 'ready' : 'playing' }, true);
    } catch {
      if (disposed || token !== generation) return;
      emit({ message: '음악 파일을 제거하지 못했습니다. 잠시 후 다시 시도해 주세요.', hasFile: true, name: track?.name, playing: !audio.paused, state: 'error' }, true);
    }
  };

  input.onchange = async () => {
    const file = input.files?.[0]; input.value = '';
    if (!file) return;
    const fallbackTypes: Record<string, string> = { mp4: 'audio/mp4', m4a: 'audio/mp4', mp3: 'audio/mpeg', aac: 'audio/aac', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' };
    const type = (!file.type || file.type === 'application/octet-stream') ? fallbackTypes[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? '' : file.type;
    const supported = (type.startsWith('audio/') || type === 'video/mp4') && (audio.canPlayType(type) !== '' || type === 'audio/flac');
    if (!supported) { emit({ message: '지원하는 음악 파일(MP4, MP3, M4A, AAC, OGG, WAV, FLAC)을 선택해 주세요.', hasFile: Boolean(track), name: track?.name, playing: false, state: 'error' }, true); return; }
    const token = ++generation;
    selecting = true;
    emit({ message: '선택한 BGM 파일을 읽는 중…', hasFile: Boolean(track), name: track?.name, playing: false, state: 'loading' });
    let next: StoredTrack;
    try {
      const bytes = await file.arrayBuffer();
      next = { blob: new Blob([bytes], { type }), name: file.name, type, size: file.size, lastModified: file.lastModified };
    } catch {
      if (token !== generation || disposed) return;
      selecting = false;
      emit({ message: '선택한 음악 파일을 읽지 못했습니다. 파일 접근 권한을 확인해 주세요.', hasFile: Boolean(track), name: track?.name, playing: false, state: 'error' }, true); return;
    }
    if (token !== generation || disposed) return;
    wantsPlayback = true; playbackRequested = true; sessionStorage.removeItem(PAUSED_KEY);
    const installed = await installTrack(next, token);
    if (token !== generation || disposed) return;
    selecting = false;
    if (!installed) { installScene(); return; }
    try {
      await persist(() => writeStoredTrack(next));
      if (disposed || token !== generation || track !== next) return;
      emit({ message: '선택한 BGM을 이 기기에 저장했습니다.', hasFile: true, name: next.name, playing: !audio.paused, state: audio.paused ? 'ready' : 'playing' }, true);
    } catch {
      if (disposed || token !== generation || track !== next) return;
      emit({ message: '선택한 BGM은 지금 재생할 수 있지만 이 기기에 저장하지 못했습니다. 저장 공간을 확인해 주세요.', hasFile: true, name: next.name, playing: !audio.paused, state: 'error' }, true);
    }
    void attemptPlay();
  };

  button.onclick = () => {
    if (!track) { choose(); return; }
    if (!audio.paused && !audio.ended) pause(true);
    else { wantsPlayback = true; playbackRequested = true; sessionStorage.removeItem(PAUSED_KEY); void attemptPlay(); }
  };
  audio.onplay = () => syncButton();
  audio.onpause = () => syncButton();
  audio.onerror = () => emit({ message: '음악 파일 재생 중 오류가 발생했습니다. 화면 설정에서 파일을 다시 선택해 주세요.', hasFile: Boolean(track), name: track?.name, playing: false, state: 'error' }, true);

  const onGameInput = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('#game-sound-toggle, #interface-settings, #game-music-file')) return;
    playbackRequested = true;
    if (wantsPlayback) void attemptPlay();
  };
  const onVisibility = () => {
    if (document.hidden) { playbackGeneration++; playAttempt = undefined; audio.pause(); stopFadingAudio(); }
    else if (wantsPlayback && playbackRequested) void attemptPlay();
  };
  const onSelect = () => choose();
  const onRemove = () => { void remove(); };
  const onQuery = () => emit(current);
  for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) document.addEventListener(type, onGameInput, true);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener(SELECT_EVENT, onSelect);
  document.addEventListener(REMOVE_EVENT, onRemove);
  document.addEventListener(QUERY_EVENT, onQuery);
  const unsubscribe = subscribeGameAudioSettings(syncSettings);
  syncSettings(); syncButton();

  const restoreToken = generation;
  emit({ message: '이 기기에 저장된 BGM을 확인하는 중…', hasFile: false, playing: false, state: 'loading' });
  void readStoredTrack().then(async saved => {
    if (disposed || restoreToken !== generation) return;
    if (saved) await installTrack(saved, restoreToken);
  }).catch(() => {
    // Private/storage-restricted browsing still gets the bundled soundtrack.
  }).finally(() => { restoring = false; if (!disposed) installScene(); });

  return {
    setScene,
    open: () => { if (track) { wantsPlayback = true; playbackRequested = true; sessionStorage.removeItem(PAUSED_KEY); void attemptPlay(); } else choose(); },
    destroy: () => {
      disposed = true; generation++; playbackGeneration++; playAttempt = undefined;
      window.clearTimeout(feedbackTimer); window.clearTimeout(sceneTimer); stopFadingAudio(); unsubscribe(); audio.pause(); audio.removeAttribute('src'); audio.load(); releaseUrl();
      for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) document.removeEventListener(type, onGameInput, true);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener(SELECT_EVENT, onSelect);
      document.removeEventListener(REMOVE_EVENT, onRemove);
      document.removeEventListener(QUERY_EVENT, onQuery);
      input.remove(); audio.remove(); feedback.remove();
    },
  };
}
