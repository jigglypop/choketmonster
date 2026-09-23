import type { BattleState } from '../game/engine';
import type { KantoLocation } from '../openworld/kanto';

export type MusicScene = {
  started: boolean;
  location?: Pick<KantoLocation, 'id' | 'kind'>;
  sceneId?: string;
  battle?: Pick<BattleState, 'kind'>;
  champion?: boolean;
  captureOffer?: boolean;
};

const titles = {
  opening: '오프닝', pallet: '태초마을', pewter: '회색시티', cerulean: '블루시티',
  vermilion: '갈색시티', lavender: '보라타운', celadon: '무지개시티', cinnabar: '홍련섬',
  route1: '1번 도로', route3: '3번 도로', route11: '11번 도로', route24: '24번 도로',
  forest: '상록숲', cave: '동굴', surf: '파도타기', tower: '포켓몬타워',
  mansion: '포켓몬저택', 'victory-road': '챔피언로드', gym: '체육관',
  'wild-battle': '야생 포켓몬 배틀', 'trainer-battle': '트레이너 배틀',
  'gym-battle': '체육관 배틀', 'champion-battle': '챔피언 배틀', 'wild-victory': '야생 배틀 승리',
} as const;
export type MusicCue = keyof typeof titles;

export type ScheduledMusicCue = { cue: MusicCue; nextUpdateAt?: number };

/**
 * Keeps the surrounding area's music uninterrupted while battles and capture
 * decisions are presented, except gym and league hall battles, which play their own themes.
 * Location changes still select their normal cue.
 */
export class SceneMusicDirector {
  private scene: MusicScene = { started: false };
  private cue: MusicCue = 'opening';

  update(scene: MusicScene): ScheduledMusicCue {
    this.scene = scene;
    return this.resolve();
  }

  resolve(): ScheduledMusicCue {
    this.cue = selectMusicCue(this.scene);
    return { cue: this.cue };
  }
}

// Red/Green music is an authored selection for the game's other regions, too.
// It is not represented as those regions' original soundtrack.
const places: Record<string, MusicCue> = {
  pallet: 'pallet', 'new-bark': 'pallet', viridian: 'pewter', pewter: 'pewter',
  cerulean: 'cerulean', vermilion: 'vermilion', lavender: 'lavender', celadon: 'celadon',
  saffron: 'pewter', fuchsia: 'cerulean', cinnabar: 'cinnabar',
  'pokemon-tower': 'tower', 'sprout-tower': 'tower', 'pokemon-mansion': 'mansion',
  'victory-road': 'victory-road', 'indigo-plateau': 'victory-road',
  'route-3': 'route3', 'route-4': 'route3', 'route-9': 'route3', 'route-10-north': 'route3',
  'route-11': 'route11', 'route-12': 'route11', 'route-13': 'route11', 'route-14': 'route11',
  'route-15': 'route11', 'route-24': 'route24', 'route-25': 'route24',
};

export function selectMusicCue(scene: MusicScene): MusicCue {
  if (!scene.started) return 'opening';
  if (scene.battle?.kind === 'gym') return 'gym-battle';
  if (scene.sceneId?.startsWith('league:')) return scene.battle ? 'champion-battle' : 'gym';
  if (scene.sceneId?.startsWith('gym:')) return 'gym';
  if (scene.sceneId?.startsWith('cave:')) return scene.sceneId.endsWith(':victory-road') ? 'victory-road' : 'cave';
  const location = scene.location;
  if (!location) return 'route1';
  if (places[location.id]) return places[location.id];
  if (location.kind === 'cave') return 'cave';
  if (location.kind === 'forest') return 'forest';
  if (location.kind === 'sea') return 'surf';
  if (location.kind === 'town') return 'pallet';
  return 'route1';
}

export function sceneMusicTrack(cue: MusicCue) {
  return { cue, name: `레드·그린 · ${titles[cue]}`, url: `/audio/pokemon-rg/${cue}.mp3` };
}
