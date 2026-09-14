import { getGameAudioSettings, setGameAudioSettings, subscribeGameAudioSettings } from './game-audio';
import './audio.css';

export const RED_MUSIC = { id: 'mbffVF79imM', title: '레드전 · 금·은·크리스탈 원곡', url: 'https://www.youtube.com/watch?v=mbffVF79imM' } as const;
type Player = { playVideo(): void; pauseVideo(): void; seekTo(seconds: number, allowSeekAhead: boolean): void; setVolume(volume: number): void; mute(): void; unMute(): void; getPlayerState(): number; destroy(): void };
type PlayerOptions = { width: number; height: number; videoId: string; playerVars: Record<string, string | number>; events: { onReady(event: { target: Player }): void; onStateChange(event: { data: number }): void; onError(event: { data: number }): void; onAutoplayBlocked(): void } };
type YouTubeWindow = Window & { YT?: { Player: new (element: HTMLElement, options: PlayerOptions) => Player }; onYouTubeIframeAPIReady?: () => void };
let apiPromise: Promise<NonNullable<YouTubeWindow['YT']>> | undefined;
function loadApi(): Promise<NonNullable<YouTubeWindow['YT']>> {
  const scope = window as YouTubeWindow;
  if (scope.YT?.Player) return Promise.resolve(scope.YT);
  return apiPromise ??= new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => { apiPromise = undefined; reject(new Error('음악 서비스에 연결하지 못했습니다.')); }, 15_000);
    const previous = scope.onYouTubeIframeAPIReady;
    scope.onYouTubeIframeAPIReady = () => { previous?.(); window.clearTimeout(timeout); if (scope.YT) resolve(scope.YT); };
    const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api'; script.async = true;
    script.onerror = () => { window.clearTimeout(timeout); apiPromise = undefined; reject(new Error('음악 서비스를 불러오지 못했습니다.')); };
    document.head.append(script);
  });
}

/** Original recording is streamed through its visible provider player; no OST file is copied into the game. */
export function mountOriginalMusic(button: HTMLButtonElement): { open(): void; destroy(): void } {
  const panel = document.createElement('section'); panel.id = 'game-music-panel'; panel.hidden = true; panel.setAttribute('aria-label', '원곡 음악 플레이어');
  panel.innerHTML = `<header><strong>${RED_MUSIC.title}</strong><button id="game-music-close" aria-label="음악 플레이어 닫기">×</button></header><div id="game-music-video"></div><div class="music-actions"><button id="game-music-play">재생</button><label>음량 <input id="game-music-volume" aria-label="BGM 음량" type="range" min="0" max="100"></label><button id="game-music-mute" aria-label="모든 소리 끄기">음소거</button></div><small id="game-music-status" role="status">레드전 원곡을 불러옵니다.</small><a href="${RED_MUSIC.url}" target="_blank" rel="noopener noreferrer">YouTube에서 듣기 ↗</a>`;
  document.body.append(panel);
  const volume = panel.querySelector<HTMLInputElement>('#game-music-volume')!, status = panel.querySelector<HTMLElement>('#game-music-status')!, play = panel.querySelector<HTMLButtonElement>('#game-music-play')!, mute = panel.querySelector<HTMLButtonElement>('#game-music-mute')!;
  let player: Player | undefined, loading = false, disposed = false, dismissed = false, wanted = true;
  const sync = () => {
    const settings = getGameAudioSettings(); volume.value = String(Math.round(settings.musicVolume * 100)); player?.setVolume(settings.musicVolume * 100);
    button.textContent = settings.muted ? '♪ 끔' : '♪ BGM'; button.setAttribute('aria-label', '음악 재생과 음량');
    mute.textContent = settings.muted ? '소리 켜기' : '음소거'; mute.setAttribute('aria-pressed', String(settings.muted));
    if (settings.muted) player?.mute(); else player?.unMute();
  };
  const requestPlay = () => { wanted = true; player?.playVideo(); };
  const open = async () => {
    if (disposed) return;
    dismissed = false; panel.hidden = false; button.setAttribute('aria-expanded', 'true');
    if (player) { requestPlay(); return; }
    if (loading) return;
    loading = true;
    try {
      const api = await loadApi(); if (disposed) return;
      player = new api.Player(panel.querySelector<HTMLElement>('#game-music-video')!, {
        width: 320, height: 200, videoId: RED_MUSIC.id,
        playerVars: { origin: location.origin, playsinline: 1, controls: 1, rel: 0 },
        events: {
          onReady: event => { player = event.target; sync(); if (!panel.hidden && !document.hidden && wanted) requestPlay(); },
          onStateChange: event => {
            panel.dataset.playback = String(event.data);
            play.textContent = event.data === 1 ? '일시 정지' : '재생';
            status.textContent = event.data === 1 ? '레드전 원곡 재생 중' : event.data === 3 ? '음악 불러오는 중…' : '재생 버튼으로 원곡을 들으세요.';
            if (event.data === 0 && wanted && !panel.hidden && !document.hidden) { player?.seekTo(0, true); requestPlay(); }
          },
          onError: () => { status.textContent = '원곡 재생이 제한되었습니다. YouTube 링크에서 확인해 주세요.'; panel.dataset.playback = 'error'; },
          onAutoplayBlocked: () => { status.textContent = '재생 버튼을 눌러 음악을 시작하세요.'; },
        },
      });
    } catch (error) { status.textContent = error instanceof Error ? error.message : '음악 연결을 확인해 주세요.'; }
    finally { loading = false; }
  };
  button.onclick = () => void open(); button.setAttribute('aria-expanded', 'false');
  panel.querySelector<HTMLButtonElement>('#game-music-close')!.onclick = () => { dismissed = true; wanted = false; player?.pauseVideo(); panel.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  play.onclick = () => { if (player?.getPlayerState() === 1) { wanted = false; player.pauseVideo(); } else if (player) requestPlay(); else void open(); };
  volume.oninput = () => setGameAudioSettings({ musicVolume: Number(volume.value) / 100 });
  mute.onclick = () => setGameAudioSettings({ muted: !getGameAudioSettings().muted });
  const unsubscribe = subscribeGameAudioSettings(sync); sync();
  const firstGesture = (event: Event) => { if (event instanceof KeyboardEvent && ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return; document.removeEventListener('pointerdown', firstGesture); document.removeEventListener('keydown', firstGesture); if (!dismissed && !getGameAudioSettings().muted) void open(); };
  document.addEventListener('pointerdown', firstGesture, { passive: true }); document.addEventListener('keydown', firstGesture);
  const visibility = () => { if (document.hidden) player?.pauseVideo(); else if (wanted && !panel.hidden) requestPlay(); };
  document.addEventListener('visibilitychange', visibility);
  return { open: () => void open(), destroy: () => { disposed = true; unsubscribe(); document.removeEventListener('pointerdown', firstGesture); document.removeEventListener('keydown', firstGesture); document.removeEventListener('visibilitychange', visibility); player?.destroy(); panel.remove(); } };
}
