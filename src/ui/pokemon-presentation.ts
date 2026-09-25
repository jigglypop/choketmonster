import { getSpecies } from '../data/pokemon';
import { getCombatForm, getMegaCombatForms, type PokemonCombatFormProfile } from '../data/pokemon-combat-forms';
import { pokemonSpriteUrl } from '../game/assets';
import { getPokemonFormModelSource } from '../data/pokemon-form-models';
import type { GameState, Monster } from '../game/engine';

export const POKEMON_TYPE_LABELS: Record<string, string> = { normal: '노말', fire: '불꽃', water: '물', electric: '전기', grass: '풀', ice: '얼음', fighting: '격투', poison: '독', ground: '땅', flying: '비행', psychic: '에스퍼', bug: '벌레', rock: '바위', ghost: '고스트', dragon: '드래곤', dark: '악', steel: '강철', fairy: '페어리' };
const escape = (text: unknown) => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Mega forms read "Ⓜ리자몽 X": the mark stands for "메가", followed by the species and its X/Y/Z letter. */
export function formDisplayName(form: { identifier: string; name: string; speciesId: number }): string {
  if (!/-mega(?:-[xyz])?$/.test(form.identifier)) return form.name;
  const letter = /-mega-([xyz])$/.exec(form.identifier)?.[1].toUpperCase();
  return `Ⓜ${getSpecies(form.speciesId).name}${letter ? ` ${letter}` : ''}`;
}
export const combatFormSprite = (form: PokemonCombatFormProfile) => form.frontSprite ? pokemonSpriteUrl(form.frontSprite.split('/').at(-1)!.replace(/\.png$/, '')) : undefined;

export function fieldMegaForm(monster: Monster): PokemonCombatFormProfile | undefined {
  const preference = monster.preferredTransformation;
  if (preference?.kind !== 'mega' || monster.heldTool !== `mega-stone:${preference.formIdentifier}`) return undefined;
  const form = getCombatForm(preference.formIdentifier);
  return form?.kind === 'mega' && form.speciesId === monster.speciesId && getPokemonFormModelSource(form.identifier) ? form : undefined;
}

export function pokemonPresentation(monster: Monster, battle?: GameState['battle']) {
  const transformation = battle?.transformations?.[monster.instanceId];
  const identifier = transformation?.formIdentifier ?? (!battle ? fieldMegaForm(monster)?.identifier : undefined) ?? monster.regionalForm;
  const form = identifier ? getCombatForm(identifier) : undefined;
  const species = getSpecies(transformation?.speciesId ?? monster.speciesId);
  const sprite = (form && combatFormSprite(form)) ?? pokemonSpriteUrl(species.id);
  return { form, transformation, name: (form && formDisplayName(form)) || monster.nickname, sprite,
    types: transformation?.types ?? form?.types ?? species.types, stats: transformation?.stats ?? monster.stats };
}

export function battleTransformationsHtml(state: GameState, disabled = false): string {
  const battle = state.battle;
  if (!battle) return '';
  const monster = battle.player.team[battle.player.activeIndex], presentation = pokemonPresentation(monster, battle);
  if (presentation.transformation?.kind === 'mega') return `<div class="battle-transformation-active" data-transformation-active="mega">${escape(presentation.name)}</div>`;
  if (presentation.transformation) return '';
  const blocked = disabled || battle.awaitingSwitch || monster.hp <= 0;
  const megas = getMegaCombatForms(monster.speciesId).filter(form => getPokemonFormModelSource(form.identifier) && monster.heldTool === `mega-stone:${form.identifier}`);
  return megas.length ? `<div class="battle-transformations"><div><select data-mega-form aria-label="메가진화 모습" ${blocked || battle.playerMegaUsed ? 'disabled' : ''}>${megas.map(form => `<option value="${escape(form.identifier)}">${escape(formDisplayName(form))}</option>`).join('')}</select><button data-battle-transformation="mega" ${blocked || battle.playerMegaUsed ? 'disabled' : ''}>메가진화</button></div></div>` : '';
}
