import type { GameState } from './engine';
import { KANTO_GYMS, type KantoGym, type KantoLocation } from '../openworld/kanto';

export type CampaignRegion = 'johto' | 'kanto';
export type CampaignProgress = {
  startRegion: CampaignRegion;
  johtoBadges: number[];
  johtoLeague: number;
  kantoLeague: number;
  redDefeated: boolean;
};
export type CampaignTrainer = {
  id: string; name: string; region: CampaignRegion; locationId: string;
  kind: 'elite' | 'champion' | 'red'; team: ReadonlyArray<readonly [number, number]>;
};

/** Authored campaign balance; teams and levels are not a reproduction of a cartridge. */
export const JOHTO_CAMPAIGN_GYMS: readonly KantoGym[] = [
  { locationId: 'violet', badge: 1, badgeName: '윙배지', name: '비상', speciesId: 17, level: 10 },
  { locationId: 'azalea', badge: 2, badgeName: '인섹트배지', name: '호일', speciesId: 123, level: 16 },
  { locationId: 'goldenrod', badge: 3, badgeName: '레귤러배지', name: '꼭두', speciesId: 241, level: 21 },
  { locationId: 'ecruteak', badge: 4, badgeName: '팬텀배지', name: '유빈', speciesId: 94, level: 26 },
  { locationId: 'cianwood', badge: 5, badgeName: '쇼크배지', name: '사도', speciesId: 62, level: 30 },
  { locationId: 'olivine', badge: 6, badgeName: '스틸배지', name: '규리', speciesId: 208, level: 34 },
  { locationId: 'mahogany', badge: 7, badgeName: '아이스배지', name: '류옹', speciesId: 221, level: 38 },
  { locationId: 'blackthorn', badge: 8, badgeName: '라이징배지', name: '이향', speciesId: 230, level: 42 },
];

export const CAMPAIGN_TRAINERS: readonly CampaignTrainer[] = [
  { id: 'johto-will', name: '사천왕 일목', region: 'johto', locationId: 'tohjo-falls', kind: 'elite', team: [[178,42],[124,42],[103,43],[80,43],[178,44]] },
  { id: 'johto-koga', name: '사천왕 독수', region: 'johto', locationId: 'tohjo-falls', kind: 'elite', team: [[168,43],[49,43],[205,44],[89,44],[169,45]] },
  { id: 'johto-bruno', name: '사천왕 시바', region: 'johto', locationId: 'tohjo-falls', kind: 'elite', team: [[237,44],[106,44],[107,45],[95,45],[68,46]] },
  { id: 'johto-karen', name: '사천왕 카렌', region: 'johto', locationId: 'tohjo-falls', kind: 'elite', team: [[197,45],[45,45],[94,46],[198,46],[229,47]] },
  { id: 'johto-lance', name: '챔피언 목호', region: 'johto', locationId: 'tohjo-falls', kind: 'champion', team: [[130,47],[149,48],[6,48],[142,49],[149,49],[149,50]] },
  { id: 'kanto-lorelei', name: '사천왕 칸나', region: 'kanto', locationId: 'indigo-plateau', kind: 'elite', team: [[87,70],[91,70],[80,71],[124,71],[131,72]] },
  { id: 'kanto-bruno', name: '사천왕 시바', region: 'kanto', locationId: 'indigo-plateau', kind: 'elite', team: [[95,71],[107,71],[106,72],[95,72],[68,73]] },
  { id: 'kanto-agatha', name: '사천왕 국화', region: 'kanto', locationId: 'indigo-plateau', kind: 'elite', team: [[94,72],[42,72],[93,73],[24,73],[94,74]] },
  { id: 'kanto-lance', name: '사천왕 목호', region: 'kanto', locationId: 'indigo-plateau', kind: 'elite', team: [[130,73],[148,73],[148,74],[142,74],[149,75]] },
  { id: 'kanto-blue', name: '챔피언 그린', region: 'kanto', locationId: 'indigo-plateau', kind: 'champion', team: [[18,75],[65,75],[112,76],[103,76],[130,77],[6,78]] },
  { id: 'red', name: '레드', region: 'johto', locationId: 'mt-silver', kind: 'red', team: [[25,88],[196,82],[143,84],[3,84],[6,84],[9,84]] },
];

export function campaignProgress(game: GameState): CampaignProgress {
  return game.campaign ?? { startRegion: 'kanto', johtoBadges: [], johtoLeague: 0, kantoLeague: game.championDefeated ? 5 : 0, redDefeated: false };
}
export function getRegionalBadges(game: GameState, region: string): number {
  return region === 'johto' ? campaignProgress(game).johtoBadges.length : game.player.badges;
}
export function getCampaignGyms(game: GameState, region: string): readonly KantoGym[] {
  if (region === 'johto') return JOHTO_CAMPAIGN_GYMS;
  if (region !== 'kanto') return [];
  return campaignProgress(game).startRegion === 'johto'
    ? KANTO_GYMS.map((gym, index) => ({ ...gym, level: 54 + index * 2 })) : KANTO_GYMS;
}
export function campaignTravelReason(game: GameState, region: string): string | undefined {
  const progress = campaignProgress(game);
  if (region === 'kanto' && progress.startRegion === 'johto' && progress.johtoLeague < 5)
    return '성도 배지 8개와 성도 사천왕·챔피언 클리어 후 관동으로 여행할 수 있습니다.';
}
export function canChallengeRed(game: GameState): boolean {
  const progress = campaignProgress(game);
  return game.player.badges === 8 && progress.johtoBadges.length === 8 && progress.kantoLeague === 5 && progress.johtoLeague === 5;
}
export function getNextCampaignTrainer(game: GameState, region: string): CampaignTrainer | undefined {
  if (region !== 'kanto' && region !== 'johto') return undefined;
  const progress = campaignProgress(game), stage = region === 'johto' ? progress.johtoLeague : progress.kantoLeague;
  if (stage < 5) return CAMPAIGN_TRAINERS.filter(trainer => trainer.region === region && trainer.kind !== 'red')[stage];
  if (region === 'johto' && canChallengeRed(game) && !progress.redDefeated) return CAMPAIGN_TRAINERS.find(trainer => trainer.id === 'red');
}

// Local encounter identities and weights stay fixed. These level bands are game rules.
const johtoBands: Record<string, readonly [number, number]> = {
  'route-32': [8,12], 'union-cave': [10,14], 'route-33': [10,14], 'slowpoke-well': [11,15],
  'ilex-forest': [14,18], 'route-34': [16,20], 'route-35': [18,23], 'national-park': [18,23],
  'route-36': [20,24], 'route-37': [22,26], 'burned-tower': [23,28], 'bell-tower': [28,34],
  'route-38': [26,30], 'route-39': [27,31], 'route-40': [28,32], 'route-41': [29,33],
  'whirl-islands': [30,35], 'route-42-west': [30,34], 'mt-mortar': [31,36], 'route-42-east': [32,36],
  'route-43': [33,37], 'lake-of-rage': [34,38], 'route-44': [35,39], 'ice-path': [36,40],
  'route-45': [37,41], 'dark-cave-east': [33,38], 'dragons-den': [39,43],
  'route-27': [40,45], 'tohjo-falls': [42,47],
};
export function regionalWildLevels(game: GameState, region: string, location: KantoLocation): { minLevel: number; maxLevel: number } {
  if (region === 'johto' && location.id === 'mt-silver' && canChallengeRed(game)) return { minLevel: 72, maxLevel: 80 };
  if (region === 'johto' && johtoBands[location.id]) {
    const [minLevel, maxLevel] = johtoBands[location.id]; return { minLevel, maxLevel };
  }
  if (region === 'kanto' && campaignProgress(game).startRegion === 'johto') {
    return { minLevel: Math.min(72, 46 + Math.floor(location.minLevel * .4)), maxLevel: Math.min(76, 50 + Math.floor(location.maxLevel * .4)) };
  }
  return { minLevel: location.minLevel, maxLevel: location.maxLevel };
}
