import type { CampaignRegion } from './campaign';
import { campaignTravelReason, getRegionalBadges } from './campaign';
import type { GameState, Monster } from './engine';
import { levelCapForBadges } from '../data/wild-levels';

export const REGIONAL_STARTERS: Readonly<Record<CampaignRegion, readonly [number, number, number]>> = {
  kanto: [1, 4, 7], johto: [152, 155, 158], hoenn: [252, 255, 258], sinnoh: [387, 390, 393],
  unova: [495, 498, 501], kalos: [650, 653, 656], alola: [722, 725, 728],
  galar: [810, 813, 816], hisui: [722, 155, 501], paldea: [906, 909, 912],
};

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
  return levelCapForBadges(getRegionalBadges(game, region));
}

export function monsterRegionalUseReason(game: GameState, region: CampaignRegion, monster: Monster): string | undefined {
  if (campaignTravelReason(game, region)) return campaignTravelReason(game, region);
  if (needsRegionalStarter(game, region)) return `${region} 지방 스타팅 포켓몬을 먼저 선택하세요.`;
  const badges = getRegionalBadges(game, region);
  if (monster.originRegion !== region && badges < 1) return '현지 배지 1개를 얻기 전에는 다른 지방 출신 포켓몬을 사용할 수 없습니다.';
  const cap = regionalLevelCap(game, region);
  if (monster.level > cap) return `현지 배지 기준 사용 가능 레벨은 Lv.${cap}까지입니다.`;
}

/** Short card tag for a monster that sits out in this region, such as its level cap. */
export function monsterRegionalUseTag(game: GameState, region: CampaignRegion, monster: Monster): string | undefined {
  if (!monsterRegionalUseReason(game, region, monster)) return undefined;
  if (campaignTravelReason(game, region) || needsRegionalStarter(game, region)) return '사용 불가';
  if (monster.originRegion !== region && getRegionalBadges(game, region) < 1) return '타지방 출신';
  return `Lv.${regionalLevelCap(game, region)} 초과`;
}

export function usableRegionalTeam(game: GameState, region: CampaignRegion): Monster[] {
  return game.player.team.filter(monster => monster.hp > 0 && !monsterRegionalUseReason(game, region, monster));
}
