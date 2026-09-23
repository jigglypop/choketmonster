import { getSpecies } from '../data/pokemon';
import { HELD_TOOL_DESCRIPTIONS, type HeldTool } from '../game/engine';
import { getWorldAtlas } from '../openworld/atlas';
import { getFieldItemSources } from '../openworld/item-sources';
import type { FieldItem } from '../openworld/field-item-drops';
import './item-sources.css';

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const percent = (chance: number) => `${Number((chance * 100).toFixed(2))}%`;
const TOOL_GROUPS = [['battle', '장착 도구'], ['berry', '열매'], ['support', '보조'], ['mega-stone', '메가진화석']] as const;

/** Equipment picker grouped by catalog category, with the equipped tool's effect below it. */
export function heldToolSelectHtml(heldTool: string | undefined, items: readonly FieldItem[], inventory: Readonly<Record<string, number>>, disabled: boolean): string {
  const option = (item: FieldItem) => `<option value="${escape(item.id)}" ${heldTool === item.id ? 'selected' : ''} ${heldTool !== item.id && !inventory[item.id] ? 'disabled' : ''}>${escape(item.name)}</option>`;
  const groups = TOOL_GROUPS.map(([group, label]) => {
    const rows = items.filter(item => (item.kind === 'mega-stone' ? 'mega-stone' : item.category) === group);
    return rows.length ? `<optgroup label="${label}">${rows.map(option).join('')}</optgroup>` : '';
  }).join('');
  const description = heldTool ? HELD_TOOL_DESCRIPTIONS[heldTool as HeldTool] : undefined;
  return `<label class="equipment-field"><span>도구</span><select id="monster-tool" ${disabled ? 'disabled' : ''}><option value="">없음</option>${groups}</select></label>${description ? `<p class="equipment-description" id="monster-tool-description">${escape(description)}</p>` : ''}`;
}

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
