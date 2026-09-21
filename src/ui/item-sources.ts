import { getSpecies } from '../data/pokemon';
import { getWorldAtlas } from '../openworld/atlas';
import { getFieldItemSources } from '../openworld/item-sources';
import type { FieldItem } from '../openworld/field-item-drops';
import './item-sources.css';

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const percent = (chance: number) => `${Number((chance * 100).toFixed(2))}%`;

export function itemSourceDetailsHtml(items: readonly FieldItem[]): string {
  return `<details class="item-source-guide"><summary>도구 획득처</summary><div>${items.map(item => {
    const source = getFieldItemSources(item.id); if (!source) return '';
    const locations = new Map<string, Set<string>>();
    for (const place of source.roadside) {
      const names = locations.get(place.regionId) ?? new Set<string>();
      names.add(`${place.name}${place.requiredBadges ? ` (배지 ${place.requiredBadges})` : ''}`); locations.set(place.regionId, names);
    }
    return `<details data-item-source="${escape(item.id)}"><summary>${escape(item.name)}</summary><div class="item-source-method"><b>포획 보상</b>${source.captures.map(capture => `<p>${capture.speciesIds.map(id => escape(getSpecies(id).name)).join(' · ')} <strong>${percent(capture.chance)}</strong></p>`).join('') || '<p>없음</p>'}</div><div class="item-source-method"><b>길가에서 줍기</b>${[...locations].map(([region, names]) => `<p><strong>${escape(getWorldAtlas(region).name)}</strong> ${[...names].map(escape).join(' · ')}</p>`).join('') || '<p>없음</p>'}</div></details>`;
  }).join('')}</div></details>`;
}
