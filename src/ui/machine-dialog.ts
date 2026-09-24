import { getMove, getSpecies } from '../data/pokemon';
import { pokemonSpriteUrl } from '../game/assets';
import { availableMonsterMoveIds, canLearnTechnicalMachine, replaceMonsterMove, type GameState, type Monster } from '../game/engine';
import { getMoveLayout } from '../game/move-layout';
import { technicalMachines } from '../game/technical-machines';
import { POKEMON_TYPE_LABELS } from './pokemon-presentation';
import './machine-dialog.css';

const escape = (text: unknown) => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export type MachineDialogOptions = {
  game: GameState;
  /** Pokémon selected first; a box Pokémon is listed ahead of the team. */
  instanceId?: string;
  /** Machine selected first. */
  moveId?: number;
  /** Runs after a slot changed; the caller saves and redraws. */
  applied(monster: Monster): void | Promise<void>;
  notify(message: string, error?: boolean): void;
};

/** Places owned technical machine moves into a Pokémon's four slots. Machines are kept after use. */
export function openMachineDialog(options: MachineDialogOptions): void {
  document.querySelector('dialog.machine-dialog')?.remove();
  const { game } = options;
  const extra = [...game.player.team, ...game.player.box].find(monster => monster.instanceId === options.instanceId);
  const members = extra && !game.player.team.includes(extra) ? [extra, ...game.player.team] : [...game.player.team];
  let selectedId = extra?.instanceId ?? members[0]?.instanceId, machineId = options.moveId, slot: number | undefined, busy = false;
  const dialog = document.createElement('dialog');
  dialog.className = 'machine-dialog';
  dialog.setAttribute('aria-label', '기술머신');
  document.body.append(dialog);

  const owned = () => technicalMachines().filter(machine => (game.technicalMachines?.[String(machine.moveId)] ?? 0) > 0);
  const monster = () => members.find(item => item.instanceId === selectedId);
  const moveMeta = (moveId: number) => {
    const move = getMove(moveId);
    return `${POKEMON_TYPE_LABELS[move.type] ?? move.type} · ${move.damageClass === 'status' ? '변화' : `위력 ${move.power || '—'}`}`;
  };
  const render = () => {
    const current = monster(), layout = current ? getMoveLayout(current) : [];
    const learnable = new Set(current ? availableMonsterMoveIds(current, game.technicalMachines) : []);
    if (slot === undefined || slot > layout.length || slot > 3) slot = layout.length < 4 ? layout.length : undefined;
    const machines = owned().map(machine => {
      const move = getMove(machine.moveId), equipped = layout.some(entry => entry.moveId === machine.moveId);
      const able = !!current && !equipped && learnable.has(machine.moveId) && canLearnTechnicalMachine(current, machine.moveId);
      return { machine, move, equipped, able };
    }).sort((a, b) => Number(b.able) - Number(a.able) || Number(b.equipped) - Number(a.equipped));
    if (machineId !== undefined && !machines.some(row => row.machine.moveId === machineId && row.able)) machineId = undefined;
    const slots = [...layout.map((entry, index) => {
      const move = getMove(entry.moveId);
      return `<button type="button" class="machine-slot type-${move.type}" data-machine-slot="${index}" aria-pressed="${slot === index}"><b>${index + 1}</b><span><strong>${escape(move.name)}</strong><small>${moveMeta(entry.moveId)}</small></span></button>`;
    }), ...(layout.length < 4 ? [`<button type="button" class="machine-slot machine-slot-empty" data-machine-slot="${layout.length}" aria-pressed="${slot === layout.length}"><b>${layout.length + 1}</b><span><strong>빈 기술 칸</strong></span></button>`] : [])].join('');
    const list = machines.map(({ machine, move, equipped, able }) => `<button type="button" class="machine-card type-${move.type}" data-machine="${machine.moveId}" aria-pressed="${machineId === machine.moveId}" ${able ? '' : 'disabled'}>
      <i class="machine-card-type">${escape(POKEMON_TYPE_LABELS[move.type] ?? move.type)}</i><strong>${escape(move.name)}</strong><small>${move.damageClass === 'status' ? '변화' : `위력 ${move.power || '—'}`}</small><b>${equipped ? '✓' : `×${game.technicalMachines![String(machine.moveId)]}`}</b></button>`).join('');
    const target = slot !== undefined ? layout[slot] : undefined;
    dialog.innerHTML = `<div class="machine-card-sheet">
      <header><h2>기술머신</h2><button type="button" class="machine-close" aria-label="닫기">×</button></header>
      <nav class="machine-members" aria-label="포켓몬">${members.map(item => `<button type="button" data-machine-member="${escape(item.instanceId)}" aria-pressed="${item.instanceId === selectedId}"><img src="${pokemonSpriteUrl(item.speciesId)}" alt=""><span>${escape(item.nickname || getSpecies(item.speciesId).name)}</span><small>Lv.${item.level}</small></button>`).join('')}</nav>
      <section class="machine-slots" aria-label="기술 배치">${slots}</section>
      <section class="machine-list" aria-label="기술머신">${list || '<p class="machine-empty">없음</p>'}</section>
      <footer><button type="button" class="machine-apply" ${machineId !== undefined && slot !== undefined && !busy ? '' : 'disabled'}>${target ? '교체' : '배치'}</button></footer>
    </div>`;
    dialog.querySelector<HTMLButtonElement>('.machine-close')!.onclick = () => dialog.close();
    dialog.querySelectorAll<HTMLButtonElement>('[data-machine-member]').forEach(button => button.onclick = () => { selectedId = button.dataset.machineMember!; slot = undefined; render(); });
    dialog.querySelectorAll<HTMLButtonElement>('[data-machine-slot]').forEach(button => button.onclick = () => { slot = Number(button.dataset.machineSlot); render(); });
    dialog.querySelectorAll<HTMLButtonElement>('[data-machine]').forEach(button => button.onclick = () => { machineId = Number(button.dataset.machine); render(); });
    dialog.querySelector<HTMLButtonElement>('.machine-apply')!.onclick = async () => {
      const current = monster();
      if (!current || machineId === undefined || slot === undefined || busy) return;
      busy = true;
      try {
        replaceMonsterMove(game, current.instanceId, slot, machineId);
        const name = getMove(machineId).name;
        machineId = undefined;
        await options.applied(current);
        options.notify(`${current.nickname}은(는) ${name}을(를) 배웠다.`);
      } catch (error) { options.notify(error instanceof Error ? error.message : String(error), true); }
      finally { busy = false; if (dialog.isConnected) render(); }
    };
  };
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  render();
  dialog.showModal();
}
