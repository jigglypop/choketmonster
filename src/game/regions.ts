export type Region = {
  id: string;
  name: string;
  minBadges: number;
  encounterIds: readonly number[];
  gym?: { badge: number; leader: string; speciesId: number; level: number };
};

const habitat = (name: string) => POKEMON.filter((species) => species.habitat === name).map((species) => species.id);

/**
 * Every Kanto species has a direct, repeatable encounter source. Late legendary
 * areas are gated behind badge progress, but no species depends on a paid or
 * multiplayer service.
 */
export const REGIONS: readonly Region[] = [
  { id: 'safari-meadow', name: '사파리 초원', minBadges: 0, encounterIds: habitat('grassland'), gym: { badge: 1, leader: '초원 관장', speciesId: 20, level: 12 } },
  { id: 'verdant-forest', name: '상록숲', minBadges: 1, encounterIds: habitat('forest'), gym: { badge: 2, leader: '숲 관장', speciesId: 12, level: 20 } },
  { id: 'azure-shore', name: '푸른 물가', minBadges: 2, encounterIds: habitat('waters-edge'), gym: { badge: 3, leader: '물가 관장', speciesId: 55, level: 28 } },
  { id: 'silph-city', name: '실프 시티', minBadges: 3, encounterIds: habitat('urban'), gym: { badge: 4, leader: '도시 관장', speciesId: 65, level: 36 } },
  { id: 'moon-cavern', name: '달맞이 동굴', minBadges: 4, encounterIds: habitat('cave'), gym: { badge: 5, leader: '동굴 관장', speciesId: 76, level: 44 } },
  { id: 'rough-badlands', name: '거친 황무지', minBadges: 5, encounterIds: habitat('rough-terrain'), gym: { badge: 6, leader: '황무지 관장', speciesId: 105, level: 52 } },
  { id: 'crown-mountain', name: '왕관산', minBadges: 6, encounterIds: habitat('mountain'), gym: { badge: 7, leader: '산악 관장', speciesId: 112, level: 60 } },
  { id: 'seafoam-depths', name: '쌍둥이섬 심층', minBadges: 7, encounterIds: habitat('sea'), gym: { badge: 8, leader: '해양 관장', speciesId: 130, level: 68 } },
  { id: 'cerulean-cave', name: '미지의 동굴', minBadges: 8, encounterIds: habitat('rare') },
] as const;

export function getRegion(id: string): Region {
  const region = REGIONS.find((candidate) => candidate.id === id);
  if (!region) throw new Error(`알 수 없는 지역입니다: ${id}`);
  return region;
}

export function speciesEncounterSources(speciesId: number): Region[] {
  return REGIONS.filter((region) => region.encounterIds.includes(speciesId));
}

export function assertAllSpeciesReachable(): true {
  const covered = new Set(REGIONS.flatMap((region) => [...region.encounterIds]));
  const missing = Array.from({ length: 151 }, (_, index) => index + 1).filter((id) => !covered.has(id));
  if (missing.length) throw new Error(`야생 출현 경로가 없는 종: ${missing.join(', ')}`);
  return true;
}
import { POKEMON } from '../data/pokemon';
