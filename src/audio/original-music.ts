import { getGameAudioSettings, setGameAudioSettings, subscribeGameAudioSettings } from './game-audio';
import './audio.css';

export const RED_MUSIC = { id: 'mbffVF79imM', title: '레드전 · 금·은·크리스탈 원곡', url: 'https://www.youtube.com/watch?v=mbffVF79imM' } as const;
const PAUSED_KEY = 'choketmon-music-paused-v1';
const HIDDEN_KEY = 'choketmon-music-hidden-v1';
type Player = { playVideo(): void; pauseVideo(): void; seekTo(seconds: number, allowSeekAhead: boolean): void; setVolume(volume: number): void; mute(): void; unMute(): void; isMuted(): boolean; getPlayerState(): number; destroy(): void };
type PlayerOptions = { width: number; height: number; videoId: string; playerVars: Record<string, string | number>; events: { onReady(event: { target: Player }): void; onStateChange(event: { data: number }): void; onError(event: { data: number; target: Player }): void; onAutoplayBlocked(): void } };
type YouTubeWindow = Window & { YT?: { Player: new (element: HTMLElement, options: PlayerOptions) => Player }; onYouTubeIframeAPIReady?: () => void };

let apiPromise: Promise<NonNullable<YouTubeWindow['YT']>> | undefined;
function loadApi(): Promise<NonNullable<YouTubeWindow['YT']>> {
  const scope = window as YouTubeWindow;
  if (scope.YT?.Player) return Promise.resolve(scope.YT);
  return apiPromise ??= new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://www.youtube.com/iframe_api"]');
    const script = existing ?? document.createElement('script');
    const timeout = window.setTimeout(() => { script.remove(); apiPromise = undefined; reject(new Error('음악 서비스에 연결하지 못했습니다.')); }, 15_000);
    const previous = scope.onYouTubeIframeAPIReady;
    scope.onYouTubeIframeAPIReady = () => { previous?.(); window.clearTimeout(timeout); if (scope.YT) resolve(scope.YT); };
    script.onerror = () => { window.clearTimeout(timeout); script.remove(); apiPromise = undefined; reject(new Error('음악 서비스를 불러오지 못했습니다.')); };
    if (!existing) { script.src = 'https://www.youtube.com/iframe_api'; script.async = true; document.head.append(script); }
  });
}

/** The original recording stays in a visible provider player; no OST file is copied into the game. */
export function mountOriginalMusic(button: HTMLButtonElement): { open(): void; destroy(): void } {
  const panel = document.createElement('section');
  panel.id = 'game-music-panel';
  panel.dataset.playback = 'loading';
  const startsHidden = sessionStorage.getItem(HIDDEN_KEY) === '1';
  const startsPaused = startsHidden || sessionStorage.getItem(PAUSED_KEY) === '1';
  panel.hidden = startsHidden;
  panel.dataset.intent = startsPaused ? 'stopped' : 'auto';
  panel.setAttribute('aria-label', '원곡 음악 플레이어');
  panel.innerHTML = `<div id="game-music-video"></div><div class="music-footer"><details id="game-music-details"><summary><strong>${RED_MUSIC.title}</strong><span>설정</span></summary><div class="music-actions"><button id="game-music-play">재생</button><label>음량 <input id="game-music-volume" aria-label="BGM 음량" type="range" min="0" max="100"></label><button id="game-music-mute" aria-label="모든 소리 끄기">음소거</button></div><small id="game-music-status" role="status">첫 게임 조작에서 원곡을 재생합니다.</small><a href="${RED_MUSIC.url}" target="_blank" rel="noopener noreferrer">YouTube에서 듣기 ↗</a></details><button id="game-music-close" aria-label="음악 끄고 플레이어 닫기">×</button></div>`;
  document.body.append(panel);

  const details = panel.querySelector<HTMLDetailsElement>('#game-music-details')!;
  const volume = panel.querySelector<HTMLInputElement>('#game-music-volume')!;
  const status = panel.querySelector<HTMLElement>('#game-music-status')!;
  const play = panel.querySelector<HTMLButtonElement>('#game-music-play')!;
  const mute = panel.querySelector<HTMLButtonElement>('#game-music-mute')!;
  const close = panel.querySelector<HTMLButtonElement>('#game-music-close')!;
  let player: Player | undefined;
  let playerReady = false;
  let preparing: Promise<void> | undefined;
  let disposed = false;
  let wantsPlayback = !startsPaused;
  let playbackRequested = false;
  let pausedForVisibility = false;
  let providerRetriesRemaining = 2;

  const setStatus = (message: string, playback?: string) => {
    status.textContent = message;
    if (playback) panel.dataset.playback = playback;
  };
  const sync = () => {
    const settings = getGameAudioSettings();
    volume.value = String(Math.round(settings.musicVolume * 100));
    if (playerReady) player?.setVolume(settings.musicVolume * 100);
    button.textContent = settings.muted ? '♪ 끔' : '♪ BGM';
    button.setAttribute('aria-label', '음악 플레이어 설정');
    button.setAttribute('aria-expanded', String(details.open));
    mute.textContent = settings.muted ? '소리 켜기' : '음소거';
    mute.setAttribute('aria-pressed', String(settings.muted));
    if (playerReady) { if (settings.muted) player?.mute(); else player?.unMute(); }
    panel.dataset.muted = String(settings.muted);
  };
  const requestPlay = () => {
    if (!wantsPlayback || document.hidden || disposed) return;
    playbackRequested = true;
    panel.dataset.intent = 'play';
    if (!player) { void prepare(); return; }
    if (!playerReady) return;
    if (player?.getPlayerState() === 1) return;
    player?.playVideo();
  };
  const requestFromGameInput = (event: Event) => {
    if (!wantsPlayback || panel.hidden || document.hidden) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('#game-music-panel, #game-sound-toggle, #interface-settings')) return;
    requestPlay();
  };
  function prepare(): Promise<void> {
    if (disposed || player) return Promise.resolve();
    if (preparing) return preparing;
    preparing = (async () => {
      try {
        const api = await loadApi();
        if (disposed || player) return;
        player = new api.Player(panel.querySelector<HTMLElement>('#game-music-video')!, {
        width: 200, height: 200, videoId: RED_MUSIC.id,
        playerVars: { origin: location.origin, playsinline: 1, controls: 1, rel: 0 },
        events: {
          onReady: event => {
            player = event.target;
            playerReady = true;
            sync();
            setStatus(startsPaused && !playbackRequested ? '음악을 일시 정지했습니다.' : playbackRequested ? '원곡 재생을 시작하는 중…' : '첫 게임 조작에서 원곡을 재생합니다.', 'ready');
            if (playbackRequested) requestPlay();
          },
          onStateChange: event => {
            panel.dataset.playback = String(event.data);
            if (event.data === 1) {
              pausedForVisibility = false;
              panel.dataset.providerMuted = String(player?.isMuted() ?? getGameAudioSettings().muted);
              play.textContent = '일시 정지';
              setStatus('레드전 원곡 재생 중');
            } else if (event.data === 2) {
              play.textContent = '재생';
              if (!pausedForVisibility) {
                wantsPlayback = false;
                sessionStorage.setItem(PAUSED_KEY, '1');
                panel.dataset.intent = 'stopped';
                setStatus('음악을 일시 정지했습니다.');
              }
            } else if (event.data === 3) {
              setStatus('음악 불러오는 중…');
            } else if (event.data === 0 && wantsPlayback && !document.hidden) {
              player?.seekTo(0, true);
              requestPlay();
            }
          },
          onError: event => {
            event.target.destroy();
            if (player === event.target) player = undefined;
            playerReady = false;
            if (!panel.querySelector('#game-music-video')) {
              const mount = document.createElement('div'); mount.id = 'game-music-video'; panel.prepend(mount);
            }
            if (providerRetriesRemaining > 0) {
              providerRetriesRemaining--;
              panel.dataset.intent = 'retry';
              setStatus(`YouTube 오류 ${event.data}. 다음 게임 조작에서 다시 연결합니다.`, 'error');
            } else {
              wantsPlayback = false;
              panel.dataset.intent = 'error';
              setStatus(`원곡 재생이 제한되었습니다 (YouTube 오류 ${event.data}). 링크에서 확인해 주세요.`, 'error');
            }
          },
          onAutoplayBlocked: () => {
            panel.dataset.intent = 'blocked';
            setStatus('브라우저가 재생을 막았습니다. 영상의 재생 버튼을 눌러 주세요.', 'blocked');
          },
        },
        });
      } catch (error) {
        player = undefined;
        playerReady = false;
        panel.dataset.intent = 'error';
        setStatus(error instanceof Error ? error.message : '음악 연결을 확인해 주세요.', 'error');
      } finally {
        preparing = undefined;
      }
    })();
    return preparing;
  }

  button.onclick = () => {
    if (panel.hidden) {
      panel.hidden = false;
      wantsPlayback = true;
      sessionStorage.removeItem(HIDDEN_KEY);
      sessionStorage.removeItem(PAUSED_KEY);
      requestPlay();
    } else {
      details.open = !details.open;
    }
    sync();
  };
  details.ontoggle = sync;
  close.onclick = () => {
    wantsPlayback = false;
    sessionStorage.setItem(PAUSED_KEY, '1');
    sessionStorage.setItem(HIDDEN_KEY, '1');
    panel.dataset.intent = 'stopped';
    if (playerReady) player?.pauseVideo();
    panel.hidden = true;
    details.open = false;
    sync();
  };
  play.onclick = () => {
    if (playerReady && player?.getPlayerState() === 1) {
      wantsPlayback = false;
      sessionStorage.setItem(PAUSED_KEY, '1');
      panel.dataset.intent = 'stopped';
      player.pauseVideo();
    } else {
      wantsPlayback = true;
      providerRetriesRemaining = 2;
      sessionStorage.removeItem(PAUSED_KEY);
      requestPlay();
    }
  };
  volume.oninput = () => setGameAudioSettings({ musicVolume: Number(volume.value) / 100 });
  mute.onclick = () => setGameAudioSettings({ muted: !getGameAudioSettings().muted });
  const unsubscribe = subscribeGameAudioSettings(sync);
  const visibility = () => {
    if (document.hidden) {
      panel.dataset.visibility = 'hidden';
      if (playerReady && player?.getPlayerState() === 1) {
        pausedForVisibility = true;
        player.pauseVideo();
      }
    } else if (wantsPlayback && (pausedForVisibility || playbackRequested)) {
      panel.dataset.visibility = 'visible';
      requestPlay();
    }
  };
  const online = () => { if (wantsPlayback && playbackRequested) requestPlay(); };
  document.addEventListener('pointerdown', requestFromGameInput, true);
  document.addEventListener('pointerup', requestFromGameInput, true);
  document.addEventListener('touchend', requestFromGameInput, true);
  document.addEventListener('click', requestFromGameInput, true);
  document.addEventListener('keydown', requestFromGameInput, true);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('online', online);
  sync();
  void prepare();

  return {
    open: () => { panel.hidden = false; details.open = true; wantsPlayback = true; sessionStorage.removeItem(HIDDEN_KEY); sessionStorage.removeItem(PAUSED_KEY); requestPlay(); sync(); },
    destroy: () => {
      disposed = true;
      unsubscribe();
      document.removeEventListener('pointerdown', requestFromGameInput, true);
      document.removeEventListener('pointerup', requestFromGameInput, true);
      document.removeEventListener('touchend', requestFromGameInput, true);
      document.removeEventListener('click', requestFromGameInput, true);
      document.removeEventListener('keydown', requestFromGameInput, true);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', online);
      player?.destroy();
      panel.remove();
    },
  };
}
