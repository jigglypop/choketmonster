import type { PokemonType } from '../game/contracts';
import type { GameState, Monster, PreferredTransformation } from '../game/engine';
import { getMegaCombatForms } from '../data/pokemon-combat-forms';
import { getPokemonFormModelSource } from '../data/pokemon-form-models';
import { POKEMON_TYPE_LABELS } from './pokemon-presentation';

export function transformationSettingsHtml(monster: Monster, disabled: boolean, inventory?: GameState['inventory']): string {
  const preference = monster.preferredTransformation;
  const selected = preference?.kind === 'mega' ? `mega:${preference.formIdentifier}` : preference?.kind === 'tera' ? `tera:${preference.teraType}` : '';
  const options = [
    { value: '', label: '없음', disabled: false },
    ...getMegaCombatForms(monster.speciesId).filter(form => getPokemonFormModelSource(form.identifier)).map(form => {
      const stone = `mega-stone:${form.identifier}` as const;
      const available = monster.heldTool === stone || Boolean(inventory?.[stone]);
      return { value: `mega:${form.identifier}`, label: `${form.name}${available ? '' : ' · 진화석 없음'}`, disabled: !available };
    }),
    ...Object.entries(POKEMON_TYPE_LABELS).map(([type, label]) => ({ value: `tera:${type}`, label: `${label} 테라스탈`, disabled: false })),
  ];
  return `<label class="equipment-field"><span>자동 변신</span><select id="monster-transformation" ${disabled ? 'disabled' : ''}>${options.map(option => `<option value="${option.value}" ${option.value === selected ? 'selected' : ''} ${option.disabled ? 'disabled' : ''}>${option.label}</option>`).join('')}</select></label>`;
}

export function transformationPreference(value: string): PreferredTransformation | undefined {
  if (!value) return undefined;
  const [kind, target] = value.split(':');
  if (kind === 'mega') return { kind, formIdentifier: target };
  if (kind === 'tera') return { kind, teraType: target as PokemonType };
  throw new Error('설정할 수 없는 변신입니다.');
}
