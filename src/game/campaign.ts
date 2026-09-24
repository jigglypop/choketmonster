import type { GameState } from './engine';
import { KANTO_GYMS, type KantoGym, type KantoLocation } from '../openworld/kanto';
import { HOENN_GYMS } from '../openworld/hoenn';
import { SINNOH_GYMS } from '../openworld/sinnoh';
import { UNOVA_GYMS } from '../openworld/unova';
import { KALOS_GYMS } from '../openworld/kalos';
import { ALOLA_GYMS } from '../openworld/alola';
import { GALAR_GYMS } from '../openworld/galar';
import { HISUI_GYMS } from '../openworld/hisui';
import { PALDEA_GYMS } from '../openworld/paldea';

export type ExpansionCampaignRegion = 'hoenn' | 'sinnoh' | 'unova' | 'kalos' | 'alola' | 'galar' | 'hisui' | 'paldea';
export type CampaignRegion = 'johto' | 'kanto' | ExpansionCampaignRegion;
export const CAMPAIGN_REGIONS: readonly CampaignRegion[] = ['johto', 'kanto', 'hoenn', 'sinnoh', 'unova', 'kalos', 'alola', 'galar', 'hisui', 'paldea'];
export type CampaignProgress = {
  startRegion: 'johto' | 'kanto';
  johtoBadges: number[];
  johtoLeague: number;
  kantoLeague: number;
  redDefeated: boolean;
  expansion?: Partial<Record<ExpansionCampaignRegion, { badges: number[]; league: number }>>;
};
export type CampaignTrainer = {
  id: string; name: string; region: CampaignRegion; locationId: string;
  kind: 'elite' | 'champion' | 'red'; team: ReadonlyArray<readonly [number, number]>;
};

/** Johto gym leaders; parties (GYM_TEAMS in gym-teams.ts) and aces follow Pokémon Crystal. */
export const JOHTO_CAMPAIGN_GYMS: readonly KantoGym[] = [
  { locationId: 'violet', badge: 1, badgeName: '윙배지', name: '비상', speciesId: 17, level: 9 },
  { locationId: 'azalea', badge: 2, badgeName: '인섹트배지', name: '호일', speciesId: 123, level: 16 },
  { locationId: 'goldenrod', badge: 3, badgeName: '레귤러배지', name: '꼭두', speciesId: 241, level: 20 },
  { locationId: 'ecruteak', badge: 4, badgeName: '팬텀배지', name: '유빈', speciesId: 94, level: 25 },
  { locationId: 'cianwood', badge: 5, badgeName: '쇼크배지', name: '사도', speciesId: 62, level: 30 },
  { locationId: 'olivine', badge: 6, badgeName: '스틸배지', name: '규리', speciesId: 208, level: 35 },
  { locationId: 'mahogany', badge: 7, badgeName: '아이스배지', name: '류옹', speciesId: 221, level: 31 },
  { locationId: 'blackthorn', badge: 8, badgeName: '라이징배지', name: '이향', speciesId: 230, level: 40 },
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
  { id: 'hoenn-sidney', name: '사천왕 혁진', region: 'hoenn', locationId: 'ever-grande-city', kind: 'elite', team: [[262,46],[275,48],[332,48],[319,48],[359,49]] },
  { id: 'hoenn-phoebe', name: '사천왕 회연', region: 'hoenn', locationId: 'ever-grande-city', kind: 'elite', team: [[356,48],[354,49],[302,50],[354,49],[356,51]] },
  { id: 'hoenn-glacia', name: '사천왕 미혜', region: 'hoenn', locationId: 'ever-grande-city', kind: 'elite', team: [[364,50],[362,50],[364,52],[362,52],[365,53]] },
  { id: 'hoenn-drake', name: '사천왕 권수', region: 'hoenn', locationId: 'ever-grande-city', kind: 'elite', team: [[372,52],[334,54],[230,53],[330,53],[373,55]] },
  { id: 'hoenn-wallace', name: '챔피언 윤진', region: 'hoenn', locationId: 'ever-grande-city', kind: 'champion', team: [[321,57],[73,55],[272,56],[340,56],[130,56],[350,58]] },
  { id: 'sinnoh-aaron', name: '사천왕 충호', region: 'sinnoh', locationId: 'sinnoh-pokemon-league', kind: 'elite', team: [[469,49],[212,49],[416,50],[214,51],[452,53]] },
  { id: 'sinnoh-bertha', name: '사천왕 들국화', region: 'sinnoh', locationId: 'sinnoh-pokemon-league', kind: 'elite', team: [[340,50],[472,53],[450,52],[76,52],[464,55]] },
  { id: 'sinnoh-flint', name: '사천왕 대엽', region: 'sinnoh', locationId: 'sinnoh-pokemon-league', kind: 'elite', team: [[229,52],[136,55],[78,53],[392,55],[467,57]] },
  { id: 'sinnoh-lucian', name: '사천왕 오엽', region: 'sinnoh', locationId: 'sinnoh-pokemon-league', kind: 'elite', team: [[122,53],[437,54],[196,55],[65,56],[475,59]] },
  { id: 'sinnoh-cynthia', name: '챔피언 난천', region: 'sinnoh', locationId: 'sinnoh-pokemon-league', kind: 'champion', team: [[442,58],[407,58],[468,60],[448,60],[350,58],[445,62]] },
  { id: 'unova-shauntal', name: '사천왕 망초', region: 'unova', locationId: 'unova-pokemon-league', kind: 'elite', team: [[563,48],[593,48],[623,48],[609,50]] },
  { id: 'unova-grimsley', name: '사천왕 블래리', region: 'unova', locationId: 'unova-pokemon-league', kind: 'elite', team: [[560,48],[553,48],[510,48],[625,50]] },
  { id: 'unova-caitlin', name: '사천왕 카틀레야', region: 'unova', locationId: 'unova-pokemon-league', kind: 'elite', team: [[579,48],[518,48],[561,48],[576,50]] },
  { id: 'unova-marshal', name: '사천왕 연무', region: 'unova', locationId: 'unova-pokemon-league', kind: 'elite', team: [[538,48],[539,48],[620,48],[534,50]] },
  { id: 'unova-alder', name: '챔피언 노간주', region: 'unova', locationId: 'unova-pokemon-league', kind: 'champion', team: [[617,60],[589,60],[621,60],[584,60],[626,60],[637,62]] },
  {id:'kalos-malus',name:'사천왕 파키라',region:'kalos',locationId:'kalos-pokemon-league',kind:'elite',team:[[668,63],[324,63],[609,63],[663,65]]},
  {id:'kalos-siebold',name:'사천왕 즈미',region:'kalos',locationId:'kalos-pokemon-league',kind:'elite',team:[[693,63],[130,63],[121,63],[689,65]]},
  {id:'kalos-wikstrom',name:'사천왕 간피',region:'kalos',locationId:'kalos-pokemon-league',kind:'elite',team:[[707,63],[476,63],[212,63],[681,65]]},
  {id:'kalos-drashna',name:'사천왕 드라세나',region:'kalos',locationId:'kalos-pokemon-league',kind:'elite',team:[[691,63],[621,63],[334,63],[715,65]]},
  {id:'kalos-diantha',name:'챔피언 카르네',region:'kalos',locationId:'kalos-pokemon-league',kind:'champion',team:[[701,64],[697,65],[699,65],[706,66],[711,66],[282,68]]},
  {id:'alola-molayne',name:'사천왕 멀레인',region:'alola',locationId:'alola-pokemon-league',kind:'elite',team:[[707,66],[376,66],[625,66],[801,67],[51,68]]},
  {id:'alola-olivia',name:'사천왕 라이치',region:'alola',locationId:'alola-pokemon-league',kind:'elite',team:[[348,66],[76,66],[346,66],[745,67],[719,68]]},
  {id:'alola-acerola',name:'사천왕 아세로라',region:'alola',locationId:'alola-pokemon-league',kind:'elite',team:[[354,66],[478,66],[426,66],[781,67],[778,68]]},
  {id:'alola-kahili',name:'사천왕 카일리',region:'alola',locationId:'alola-pokemon-league',kind:'elite',team:[[628,66],[741,66],[227,66],[630,67],[733,68]]},
  {id:'alola-champion',name:'알로라 챔피언',region:'alola',locationId:'alola-pokemon-league',kind:'champion',team:[[745,68],[784,68],[730,68],[724,68],[791,69],[800,70]]},
  {id:'galar-marnie',name:'챔피언컵 마리',region:'galar',locationId:'galar-pokemon-league',kind:'elite',team:[[510,66],[454,66],[560,67],[877,67],[262,68]]},
  {id:'galar-hop',name:'챔피언컵 호브',region:'galar',locationId:'galar-pokemon-league',kind:'elite',team:[[832,67],[823,67],[855,68],[143,68],[818,69]]},
  {id:'galar-bede',name:'챔피언컵 비트',region:'galar',locationId:'galar-pokemon-league',kind:'elite',team:[[208,68],[282,68],[858,69],[869,70]]},
  {id:'galar-raihan',name:'챔피언컵 금랑',region:'galar',locationId:'galar-pokemon-league',kind:'elite',team:[[526,69],[330,69],[844,70],[884,71]]},
  {id:'galar-leon',name:'챔피언 단델',region:'galar',locationId:'galar-pokemon-league',kind:'champion',team:[[681,70],[887,70],[812,71],[464,71],[537,72],[6,74]]},
  // Legends: Arceus has no regional League. These are authored Survey Corps final trials.
  {id:'hisui-mai',name:'조사대 결승 미도',region:'hisui',locationId:'temple-of-sinnoh',kind:'elite',team:[[446,68],[899,69],[470,70]]},
  {id:'hisui-irida',name:'조사대 결승 주혜',region:'hisui',locationId:'temple-of-sinnoh',kind:'elite',team:[[136,69],[196,69],[700,70],[471,72]]},
  {id:'hisui-adaman',name:'조사대 결승 찬석',region:'hisui',locationId:'temple-of-sinnoh',kind:'elite',team:[[134,69],[197,69],[470,70],[901,72]]},
  {id:'hisui-kamado',name:'조사대 결승 전목',region:'hisui',locationId:'temple-of-sinnoh',kind:'elite',team:[[143,70],[462,70],[628,71],[901,73]]},
  {id:'hisui-volo',name:'신오신전 월로',region:'hisui',locationId:'temple-of-sinnoh',kind:'champion',team:[[442,72],[407,72],[468,73],[448,73],[350,73],[445,75]]},
  {id:'paldea-rika',name:'사천왕 칠리',region:'paldea',locationId:'paldea-pokemon-league',kind:'elite',team:[[980,68],[51,68],[323,69],[340,69],[340,70]]},
  {id:'paldea-poppy',name:'사천왕 뽀삐',region:'paldea',locationId:'paldea-pokemon-league',kind:'elite',team:[[208,69],[823,69],[437,70],[53,70],[959,71]]},
  {id:'paldea-larry',name:'사천왕 청목',region:'paldea',locationId:'paldea-pokemon-league',kind:'elite',team:[[357,70],[741,70],[334,71],[973,71],[18,72]]},
  {id:'paldea-hassel',name:'사천왕 팔자크',region:'paldea',locationId:'paldea-pokemon-league',kind:'elite',team:[[691,71],[691,71],[715,72],[612,72],[998,73]]},
  {id:'paldea-geeta',name:'톱 챔피언 테사',region:'paldea',locationId:'paldea-pokemon-league',kind:'champion',team:[[576,72],[673,72],[975,73],[983,73],[454,74],[452,76]]},
];

export function campaignProgress(game: GameState): CampaignProgress {
  return game.campaign ?? { startRegion: 'kanto', johtoBadges: [], johtoLeague: 0, kantoLeague: game.championDefeated ? 5 : 0, redDefeated: false };
}
export function getRegionalBadges(game: GameState, region: string): number {
  if (isExpansionCampaignRegion(region)) return campaignProgress(game).expansion?.[region]?.badges.length ?? 0;
  return region === 'johto' ? campaignProgress(game).johtoBadges.length : game.player.badges;
}
export function getCampaignGyms(_game: GameState, region: string): readonly KantoGym[] {
  if (region === 'hoenn') return HOENN_GYMS;
  if (region === 'sinnoh') return SINNOH_GYMS;
  if (region === 'unova') return UNOVA_GYMS;
  if (region === 'kalos') return KALOS_GYMS;
  if (region === 'alola') return ALOLA_GYMS;
  if (region === 'galar') return GALAR_GYMS;
  if (region === 'hisui') return HISUI_GYMS;
  if (region === 'paldea') return PALDEA_GYMS;
  if (region === 'johto') return JOHTO_CAMPAIGN_GYMS;
  if (region !== 'kanto') return [];
  return KANTO_GYMS;
}
export function campaignTravelReason(game: GameState, region: string): string | undefined {
  const progress = campaignProgress(game);
  if (region === 'kalos' && (progress.expansion?.unova?.league ?? 0) < 5) return '하나 리그를 클리어한 뒤 칼로스로 여행할 수 있습니다.';
  if (region === 'alola' && (progress.expansion?.kalos?.league ?? 0) < 5) return '칼로스 리그를 클리어한 뒤 알로라로 여행할 수 있습니다.';
  if (region === 'galar' && (progress.expansion?.alola?.league ?? 0) < 5) return '알로라 최종전을 완료해야 가라르로 이동할 수 있습니다.';
  if (region === 'hisui' && (progress.expansion?.galar?.league ?? 0) < 5) return '가라르 챔피언컵을 완료해야 히스이 조사 임무를 시작할 수 있습니다.';
  if (region === 'paldea' && (progress.expansion?.hisui?.league ?? 0) < 5) return '히스이 조사대 결승을 완료해야 팔데아로 이동할 수 있습니다.';
  if (region === 'kanto' && progress.startRegion === 'johto' && progress.johtoLeague < 5)
    return '성도 배지 8개와 성도 사천왕·챔피언 클리어 후 관동으로 여행할 수 있습니다.';
  if (region === 'hoenn' && progress.kantoLeague < 5) return '관동 사천왕·챔피언 클리어 후 호연으로 여행할 수 있습니다.';
  if (region === 'sinnoh' && (progress.expansion?.hoenn?.league ?? 0) < 5) return '호연 사천왕·챔피언 클리어 후 신오로 여행할 수 있습니다.';
  if (region === 'unova' && (progress.expansion?.sinnoh?.league ?? 0) < 5) return '신오 사천왕·챔피언 클리어 후 하나로 여행할 수 있습니다.';
}
/**
 * Order for going somewhere new: a Kanto start clears Kanto, then Johto, then Hoenn onwards.
 * Travel uses this. Save validation keeps campaignTravelReason, so a region that already
 * has progress (or is where an older save stands) still loads and stays open.
 */
export function campaignEntryReason(game: GameState, region: string): string | undefined {
  const reason = campaignTravelReason(game, region); if (reason) return reason;
  const progress = campaignProgress(game);
  if (progress.startRegion !== 'kanto') return undefined;
  const hoenn = progress.expansion?.hoenn;
  if (region === 'johto' && progress.kantoLeague < 5 && !progress.johtoBadges.length && !progress.johtoLeague)
    return '관동 사천왕·챔피언 클리어 후 성도로 여행할 수 있습니다.';
  if (region === 'hoenn' && progress.johtoLeague < 5 && !hoenn?.badges.length && !hoenn?.league)
    return '성도 사천왕·챔피언 클리어 후 호연으로 여행할 수 있습니다.';
}
/** The region the campaign continues in after this one. */
export function onwardCampaignRegion(game: GameState, region: string): CampaignRegion | undefined {
  const order: readonly CampaignRegion[] = campaignProgress(game).startRegion === 'johto' ? CAMPAIGN_REGIONS : ['kanto', 'johto', ...CAMPAIGN_REGIONS.filter(item => item !== 'kanto' && item !== 'johto')];
  const index = order.indexOf(region as CampaignRegion);
  return index >= 0 ? order[index + 1] : undefined;
}
export function canChallengeRed(game: GameState): boolean {
  const progress = campaignProgress(game);
  return game.player.badges === 8 && progress.johtoBadges.length === 8 && progress.kantoLeague === 5 && progress.johtoLeague === 5;
}
export function getNextCampaignTrainer(game: GameState, region: string): CampaignTrainer | undefined {
  if (!CAMPAIGN_REGIONS.includes(region as CampaignRegion)) return undefined;
  const progress = campaignProgress(game), stage = region === 'johto' ? progress.johtoLeague : isExpansionCampaignRegion(region) ? progress.expansion?.[region]?.league ?? 0 : progress.kantoLeague;
  if (stage < 5) return CAMPAIGN_TRAINERS.filter(trainer => trainer.region === region && trainer.kind !== 'red')[stage];
  if (region === 'johto' && canChallengeRed(game) && !progress.redDefeated) return CAMPAIGN_TRAINERS.find(trainer => trainer.id === 'red');
}

export function isExpansionCampaignRegion(region: string): region is ExpansionCampaignRegion {
  return region === 'hoenn' || region === 'sinnoh' || region === 'unova' || region === 'kalos' || region === 'alola' || region === 'galar' || region === 'hisui' || region === 'paldea';
}
export function recordCampaignGymVictory(game: GameState, region: CampaignRegion, badge: number): void {
  game.campaign ??= campaignProgress(game);
  if (isExpansionCampaignRegion(region)) {
    const progress = game.campaign.expansion ??= {};
    const local = progress[region] ??= { badges: [], league: 0 };
    local.badges = [...new Set([...local.badges, badge])].sort((a, b) => a - b);
  } else if (region === 'johto') game.campaign.johtoBadges = [...new Set([...game.campaign.johtoBadges, badge])].sort((a, b) => a - b);
  else { game.defeatedGyms = [...new Set([...game.defeatedGyms, badge])].sort((a, b) => a - b); game.player.badges = game.defeatedGyms.length; }
}
export function recordCampaignLeagueVictory(game: GameState, trainer: CampaignTrainer): void {
  game.campaign ??= campaignProgress(game);
  if (trainer.kind === 'red') game.campaign.redDefeated = true;
  else if (isExpansionCampaignRegion(trainer.region)) {
    const progress = game.campaign.expansion ??= {};
    const local = progress[trainer.region] ??= { badges: [], league: 0 }; local.league++;
  } else if (trainer.region === 'johto') game.campaign.johtoLeague++;
  else { game.campaign.kantoLeague++; game.championDefeated = game.campaign.kantoLeague === 5; }
}
export function validateExpansionCampaign(game: GameState): void {
  const expansion = game.campaign?.expansion;
  if (expansion === undefined) return;
  if (!expansion || typeof expansion !== 'object' || Array.isArray(expansion)) throw new Error('추가 지방 진행이 손상되었습니다.');
  for (const [region, local] of Object.entries(expansion)) {
    if (!isExpansionCampaignRegion(region) || !local || !Array.isArray(local.badges) || local.badges.length > 8
      || local.badges.some((badge, index) => badge !== index + 1) || !Number.isInteger(local.league) || local.league < 0 || local.league > 5
      || (local.league > 0 && local.badges.length !== 8) || ((local.badges.length > 0 || local.league > 0) && campaignTravelReason(game, region)))
      throw new Error('추가 지방 배지·리그 진행이 손상되었습니다.');
  }
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
  return { minLevel: location.minLevel, maxLevel: location.maxLevel };
}
