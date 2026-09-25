import { getSpecies } from '../data/pokemon';
import { pokemonSpriteUrl } from '../game/assets';

export type GymChallenge = {
  kind: 'gym' | 'elite' | 'champion' | 'red';
  /** Leader or league trainer name. */
  name: string;
  place: string;
  badge?: { number: number; name: string };
  /** [national dex id, level] per Pokémon; the last is the ace. */
  team: ReadonlyArray<readonly [number, number]>;
};

const KICKER: Record<GymChallenge['kind'], string> = { gym: '체육관 도전', elite: '사천왕 도전', champion: '챔피언 도전', red: '최종 도전' };

/** Asks before a gym, Elite Four or Champion battle, naming the opponent, the badge and the party. */
export function confirmGymChallenge(challenge: GymChallenge): Promise<boolean> {
  const dialog = document.createElement('dialog');
  dialog.className = 'confirmation-dialog gym-victory-dialog gym-challenge-dialog';
  dialog.setAttribute('aria-labelledby', 'gym-challenge-title');
  dialog.setAttribute('aria-describedby', 'gym-challenge-place');
  dialog.innerHTML = `<span class="gym-victory-kicker"></span>
    <div class="gym-victory-emblem" aria-hidden="true"></div>
    <h2 id="gym-challenge-title"></h2><p id="gym-challenge-place"></p>
    <ol class="gym-challenge-team" aria-label="상대 포켓몬"></ol>
    <form method="dialog"><button value="cancel" class="confirmation-cancel">취소</button><button value="confirm" class="confirmation-accept" autofocus>도전</button></form>`;
  dialog.querySelector('.gym-victory-kicker')!.textContent = KICKER[challenge.kind];
  const emblem = dialog.querySelector<HTMLElement>('.gym-victory-emblem')!;
  emblem.textContent = challenge.badge ? String(challenge.badge.number) : '★';
  emblem.classList.toggle('is-league', !challenge.badge);
  dialog.querySelector('#gym-challenge-title')!.textContent = challenge.kind === 'gym' ? `관장 ${challenge.name}` : challenge.name;
  dialog.querySelector('#gym-challenge-place')!.textContent = challenge.badge ? `${challenge.place} · ${challenge.badge.name}` : challenge.place;
  const team = dialog.querySelector('.gym-challenge-team')!;
  for (const [speciesId, level] of challenge.team) {
    const item = document.createElement('li'), image = document.createElement('img'), label = document.createElement('span');
    image.src = pokemonSpriteUrl(speciesId); image.alt = ''; image.loading = 'lazy';
    label.textContent = `Lv.${level}`;
    item.title = `${getSpecies(speciesId).name} Lv.${level}`;
    item.append(image, label); team.append(item);
  }
  return new Promise(resolve => {
    dialog.addEventListener('close', () => { const accepted = dialog.returnValue === 'confirm'; dialog.remove(); resolve(accepted); }, { once: true });
    document.body.append(dialog); dialog.showModal();
  });
}
