import { getSpecies } from '../data/pokemon';
import { regionalWildLevels, type CampaignRegion } from '../game/campaign';
import type { GameState } from '../game/engine';
import type { WorldAtlas } from './atlas';
import type { KantoLocation } from './kanto';
import { fieldItemsAtLocation } from './item-sources';
import { mapKindLabel, mapKindSymbol } from './map-presentation';
import { regionalEncounters } from './simulation';

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const searchCache = new Map<string, string>();
export type MapFilter = 'all' | 'items' | 'town' | 'cave' | 'unvisited';

export function filterMapLocations(atlas: WorldAtlas, query: string, filter: MapFilter, visited: readonly string[]): KantoLocation[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return atlas.locations.filter(location => {
    const items = fieldItemsAtLocation(atlas.id, location.id);
    if (filter === 'items' && !items.length) return false;
    if ((filter === 'town' || filter === 'cave') && location.kind !== filter) return false;
    if (filter === 'unvisited' && (location.kind !== 'town' || visited.includes(location.id))) return false;
    if (!words.length) return true;
    const key = `${atlas.id}:${location.id}`;
    if (!searchCache.has(key)) {
      const species = regionalEncounters(location.id, 8, atlas.id).map(getSpecies);
      searchCache.set(key, [location.name, mapKindLabel(location.kind), ...species.flatMap(item => [item.name, item.englishName, String(item.id)]), ...items.map(source => source.item.name)].join(' ').toLocaleLowerCase());
    }
    return words.every(word => searchCache.get(key)!.includes(word));
  });
}

export function mapLocationDetails(atlas: WorldAtlas, location: KantoLocation | undefined, game: GameState, reason: string, visited: readonly string[]): string {
  if (!location) return '';
  const species = regionalEncounters(location.id, 8, atlas.id), levels = regionalWildLevels(game, atlas.id as CampaignRegion, location);
  const items = fieldItemsAtLocation(atlas.id, location.id);
  return `<section class="map-location-detail" data-map-detail="${location.id}"><header><div><small>${mapKindLabel(location.kind)}${location.requiredBadges ? ` · 배지 ${location.requiredBadges}` : ''}</small><h3>${escape(location.name)}</h3></div><button id="world-map-go" ${reason || game.battle || game.captureOffer ? 'disabled' : ''}>길찾기</button></header>${reason ? `<p class="map-lock-reason">${escape(reason)}</p>` : ''}${location.kind === 'town' ? `<p>${visited.includes(location.id) ? '방문한 마을 · 순간이동 가능' : '미방문 마을'}</p>` : ''}${species.length ? `<details open><summary>출현 포켓몬 · Lv.${levels.minLevel}–${levels.maxLevel}</summary><div class="map-species-list">${species.map(id => `<span>${escape(getSpecies(id).name)}</span>`).join('')}</div></details>` : ''}${items.length ? `<details open><summary>도구 획득처</summary><div class="map-item-sources">${items.map(source => `<article data-map-item="${escape(source.item.id)}"><strong>${escape(source.item.name)}</strong>${source.roadside.length ? '<span>길가에서 줍기</span>' : ''}${source.captures.map(capture => `<small>${capture.speciesIds.map(id => escape(getSpecies(id).name)).join(' · ')} 포획 · ${Number((capture.chance * 100).toFixed(2))}%</small>`).join('')}</article>`).join('')}</div></details>` : ''}</section>`;
}

export function mapLocationList(atlas: WorldAtlas, locations: readonly KantoLocation[], selectedId: string, currentId: string, destinationId: string | undefined, lockReasons: ReadonlyMap<string, string>): string {
  return `<div class="kanto-zone-list" aria-label="지도 검색 결과"><small class="map-results-count">${locations.length}곳</small>${locations.map(location => {
    const items = fieldItemsAtLocation(atlas.id, location.id), reason = lockReasons.get(location.id);
    return `<button data-map-list-location="${location.id}" aria-pressed="${selectedId === location.id}" class="${currentId === location.id ? 'current' : ''} ${destinationId === location.id ? 'destination' : ''} ${reason ? 'locked' : ''}"><strong>${reason ? '🔒 ' : ''}${mapKindSymbol(location.kind)} ${escape(location.name)}</strong><small>${mapKindLabel(location.kind)}${destinationId === location.id ? ' · 다음 목적지' : ''}${items.length ? ` · 도구 ${items.length}종` : ''}</small></button>`;
  }).join('') || '<p class="map-empty">검색 결과가 없습니다.</p>'}</div>`;
}
