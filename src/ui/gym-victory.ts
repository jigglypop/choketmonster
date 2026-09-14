import { REGIONS } from '../game/regions';
import type { GymVictory } from '../game/engine';
import { KANTO_GATES, KANTO_GYMS, KANTO_LOCATIONS } from '../openworld/kanto';
import { JOHTO_CAMPAIGN_GYMS } from '../game/campaign';
import { JOHTO_LOCATIONS } from '../openworld/johto';

/** Acknowledgment only: the battle engine has already granted and saved the reward. */
export function showGymVictory(victory: GymVictory, world = true): Promise<void> {
  const region = victory.region ?? 'kanto';
  const gyms = region === 'johto' ? JOHTO_CAMPAIGN_GYMS : KANTO_GYMS;
  const locations = region === 'johto' ? JOHTO_LOCATIONS : KANTO_LOCATIONS;
  const gym = world ? gyms.find(item => item.badge === victory.badge) : undefined;
  const classic = REGIONS.find(item => item.gym?.badge === victory.badge);
  const classicNext = REGIONS.find(item => item.gym?.badge === victory.badge + 1);
  const next = gyms.find(item => item.badge === victory.badge + 1);
  const locationName = (id: string) => locations.find(item => item.id === id)?.name ?? id;
  const dialog = document.createElement('dialog');
  dialog.className = 'confirmation-dialog gym-victory-dialog';
  dialog.setAttribute('aria-labelledby', 'gym-victory-title');
  dialog.setAttribute('aria-describedby', 'gym-victory-message');
  dialog.innerHTML = `<span class="gym-victory-kicker">체육관 클리어</span>
    <div class="gym-victory-emblem" aria-hidden="true">${victory.badge}</div>
    <h2 id="gym-victory-title"></h2><p id="gym-victory-message"></p>
    <div class="gym-victory-reward">상금 <strong>₩${victory.money.toLocaleString('ko-KR')}</strong></div>
    <ol class="gym-victory-progress" aria-label="획득한 배지"></ol>
    <section class="gym-victory-unlocks"><h3>새로 열린 길</h3><ul></ul></section>
    <p class="gym-victory-next"></p><form method="dialog"><button class="confirmation-accept" autofocus>모험 계속하기</button></form>`;
  dialog.querySelector('#gym-victory-title')!.textContent = `${gym?.badgeName ?? `${victory.badge}번째 배지`} 획득!`;
  dialog.querySelector('#gym-victory-message')!.textContent = gym ? `${locationName(gym.locationId)} 관장 ${gym.name}에게 승리했습니다.` : `${classic?.name ?? '체육관'}의 ${classic?.gym?.leader ?? '관장'}에게 승리했습니다.`;
  for (const item of gyms) {
    const badge = document.createElement('li');
    badge.textContent = String(item.badge);
    badge.classList.toggle('earned', item.badge <= victory.badge);
    badge.classList.toggle('latest', item.badge === victory.badge);
    badge.setAttribute('aria-label', `${world ? item.badgeName : `${item.badge}번째 배지`} ${item.badge <= victory.badge ? '획득' : '미획득'}`);
    dialog.querySelector('ol')!.append(badge);
  }
  const unlocked = world && region === 'kanto' ? KANTO_GATES.filter(gate => gate.requiredBadges === victory.badge) : [];
  dialog.querySelector<HTMLElement>('.gym-victory-unlocks')!.hidden = !unlocked.length;
  for (const gate of unlocked) {
    const item = document.createElement('li'); item.textContent = `${locationName(gate.from)} → ${locationName(gate.to)}`;
    dialog.querySelector('ul')!.append(item);
  }
  dialog.querySelector('.gym-victory-next')!.textContent = !world
    ? classicNext ? `다음 도전 · ${classicNext.name}의 ${classicNext.gym!.leader}` : '8개 배지를 모두 모았습니다! 이제 챔피언에게 도전할 수 있습니다.'
    : next
    ? `다음 도전 · ${locationName(next.locationId)}의 ${next.name}`
    : `8개 배지를 모두 모았습니다! 다음 목표는 ${region === 'johto' ? '동성폭포' : '석영고원'}입니다.`;
  return new Promise(resolve => {
    dialog.addEventListener('close', () => { dialog.remove(); resolve(); }, { once: true });
    document.body.append(dialog); dialog.showModal();
  });
}
