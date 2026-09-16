import type { CampaignRegion } from './campaign';
import { campaignTravelReason, getRegionalBadges } from './campaign';
import type { GameState, Monster } from './engine';

export const REGIONAL_STARTERS: Readonly<Record<CampaignRegion, readonly [number, number, number]>> = {
  kanto: [1, 4, 7], johto: [152, 155, 158], hoenn: [252, 255, 258], sinnoh: [387, 390, 393],
  unova: [495, 498, 501], kalos: [650, 653, 656], alola: [722, 725, 728],
  galar: [810, 813, 816], hisui: [722, 155, 501], paldea: [906, 909, 912],
};

const LEVEL_CAPS = [20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

export function isCampaignRegion(value: unknown): value is CampaignRegion {
  return typeof value === 'string' && Object.hasOwn(REGIONAL_STARTERS, value);
}

export function claimedRegionalStarters(game: GameState): CampaignRegion[] {
  return game.claimedRegionalStarters ?? [game.campaign?.startRegion ?? 'kanto'];
}

export function needsRegionalStarter(game: GameState, region: CampaignRegion): boolean {
  return !claimedRegionalStarters(game).includes(region);
}

export function regionalLevelCap(game: GameState, region: CampaignRegion): number {
  const badges = getRegionalBadges(game, region);
  return LEVEL_CAPS[Math.max(0, Math.min(8, badges))];
}

export function monsterRegionalUseReason(game: GameState, region: CampaignRegion, monster: Monster): string | undefined {
  if (campaignTravelReason(game, region)) return campaignTravelReason(game, region);
  if (needsRegionalStarter(game, region)) return `${region} 지방 스타팅 포켓몬을 먼저 선택하세요.`;
  const badges = getRegionalBadges(game, region);
  if (monster.originRegion !== region && badges < 1) return '현지 배지 1개를 얻기 전에는 다른 지방 출신 포켓몬을 사용할 수 없습니다.';
  const cap = regionalLevelCap(game, region);
  if (monster.level > cap) return `현지 배지 기준 사용 가능 레벨은 Lv.${cap}까지입니다.`;
}

export function usableRegionalTeam(game: GameState, region: CampaignRegion): Monster[] {
  return game.player.team.filter(monster => monster.hp > 0 && !monsterRegionalUseReason(game, region, monster));
}
