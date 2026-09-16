import type { User } from './account';
import type { GameState } from './engine';
import { isLegendarySpecies } from './legendary';
import { pokemonSpriteUrl } from './assets';
import { confirmAction } from '../ui/confirm-action';
import './ranked.css';

type League = 'standard' | 'open';
type Tier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'master';
type Standing = { rank: number; userId: string; username: string; rating: number; wins: number; losses: number; tier: Tier };
type RankedMove = { id: number; name: string; type: string; power: number; accuracy: number; damageClass: string };
type Fighter = { instanceId: string; speciesId: number; nickname: string; level: number; hp: number; maxHp: number; types: string[]; moves: RankedMove[]; status?: string | null };
type Side = { userId: string; username: string; activeIndex: number; team: Fighter[] };
type RankedMatch = {
  id: string; league: League; status: 'active' | 'completed'; turn: number; deadlineAt: string;
  selfSide: Side; opponentSide: Side; events: string[]; awaitingOpponent: boolean;
  winnerId?: string | null; resultReason?: string | null; ratingChange: number;
};
type RankedView = {
  league: League;
  rules: { level: number; teamSize: number; legendaryAllowed: boolean; turnSeconds: number };
  leaderboard: Standing[];
  me: null | { rating: number; wins: number; losses: number; tier: Tier; queued: boolean };
  currentMatch: RankedMatch | null;
};

export type RankedPanelOptions = {
  game(): GameState;
  currentAccount(): User | null;
  prepare(): Promise<void>;
  openAccount?(): void;
  notify(message: string, error?: boolean): void;
};

const leagueCopy = {
  standard: { name: '스탠더드', note: '전설·환상 사용 불가' },
  open: { name: '오픈', note: '전설·환상 사용 가능' },
} as const;
const tierName: Record<Tier, string> = { bronze: '브론즈', silver: '실버', gold: '골드', platinum: '플래티넘', master: '마스터' };
const escape = (value: unknown) => String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]!);

async function request<T>(path: string, user: User, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15_000), ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), 'x-choketmon-profile': user.id, ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(body.message ?? `랭크전 서버 오류 (${response.status})`);
  return body;
}

export function mountRankedPanel(options: RankedPanelOptions) {
  let host: HTMLElement | undefined;
  let league: League = 'standard';
  let view: RankedView | undefined;
  let timer = 0;
  let busy = false;
  let generation = 0;
  let dismissedMatchId: string | undefined;
  const activeSession = () => Boolean(view?.me?.queued || view?.currentMatch?.status === 'active');

  const user = () => options.currentAccount();
  const standing = (id: string) => view?.leaderboard.find(item => item.userId === id);
  const tierFor = (id: string, self = false): Tier => standing(id)?.tier ?? (self ? view?.me?.tier : undefined) ?? 'bronze';
  const stop = () => { if (timer) window.clearTimeout(timer); timer = 0; };
  const schedule = () => {
    stop();
    if (!host || (!view?.me?.queued && view?.currentMatch?.status !== 'active')) return;
    timer = window.setTimeout(() => void load(false), view.currentMatch?.awaitingOpponent ? 1_500 : 2_500);
  };
  const active = (side: Side) => side.team[side.activeIndex];
  const trainerName = (side: Side, self = false) => {
    const tier = tierFor(side.userId, self);
    return `<strong class="ranked-trainer rank-tier-${tier}">${escape(side.username)}<small>${tierName[tier]}</small></strong>`;
  };
  const fighterCard = (side: Side, self: boolean) => {
    const fighter = active(side), hp = Math.max(0, Math.min(100, fighter.hp / fighter.maxHp * 100));
    return `<article class="ranked-fighter ${self ? 'is-self' : 'is-opponent'}">${trainerName(side, self)}
      <img src="${pokemonSpriteUrl(fighter.speciesId)}" alt=""><div><span>Lv.50</span><h3>${escape(fighter.nickname)}</h3><small>${fighter.types.map(escape).join(' · ')}${fighter.status ? ` · ${escape(fighter.status)}` : ''}</small>
      <div class="ranked-hp"><i style="width:${hp}%"></i></div><b>HP ${fighter.hp} / ${fighter.maxHp}</b></div></article>`;
  };
  const battle = (match: RankedMatch) => {
    const self = active(match.selfSide), completed = match.status !== 'active';
    const result = match.winnerId == null ? '무승부' : match.winnerId === match.selfSide.userId ? '승리' : '패배';
    return `<section class="ranked-match" aria-label="진행 중인 랭크전">
      <header><div><span>TURN ${match.turn}</span><h2>${escape(leagueCopy[match.league].name)} 랭크전</h2></div><time data-ranked-deadline="${escape(match.deadlineAt)}"></time></header>
      <div class="ranked-versus">${fighterCard(match.selfSide, true)}<b>VS</b>${fighterCard(match.opponentSide, false)}</div>
      <div class="ranked-events">${match.events.map(event => `<p>${escape(event)}</p>`).join('') || '<p>행동을 선택해 주세요.</p>'}</div>
      ${completed ? `<div class="ranked-result"><strong>${result}</strong><span>레이팅 ${match.ratingChange >= 0 ? '+' : ''}${match.ratingChange}</span><button data-ranked-refresh>순위 확인</button></div>`
        : `<div class="ranked-actions" ${match.awaitingOpponent || busy ? 'inert' : ''}>
          <div class="ranked-moves">${self.moves.map((move, index) => `<button data-ranked-move="${index}" ${match.awaitingOpponent || self.hp <= 0 ? 'disabled' : ''}><strong>${escape(move.name)}</strong><small>${escape(move.type)} · ${move.power ? `위력 ${move.power}` : '변화'} · 명중 ${move.accuracy || '—'}</small></button>`).join('')}</div>
          <details><summary>포켓몬 교체</summary><div>${match.selfSide.team.map((fighter, index) => `<button data-ranked-switch="${index}" ${match.awaitingOpponent || index === match.selfSide.activeIndex || fighter.hp <= 0 ? 'disabled' : ''}>${escape(fighter.nickname)} · HP ${fighter.hp}/${fighter.maxHp}</button>`).join('')}</div></details>
          <button class="ranked-surrender" data-ranked-surrender ${match.awaitingOpponent ? 'disabled' : ''}>항복</button>
          ${match.awaitingOpponent ? '<p class="ranked-wait">행동 제출 완료 · 상대 선택을 기다립니다.</p>' : ''}
        </div>`}
    </section>`;
  };
  const render = () => {
    if (!host) return;
    const account = user();
    const restricted = options.game().player.team.filter(monster => isLegendarySpecies(monster.speciesId));
    if (!account) {
      host.innerHTML = `<section class="ranked-page"><header><span class="kicker">TRAINER RANKED</span><h1>트레이너 랭크전</h1><p>서버에 저장된 현재 팀으로 다른 트레이너와 대전합니다.</p></header><div class="ranked-login"><strong>계정 연결이 필요합니다.</strong><button data-ranked-login>가입 / 로그인</button></div></section>`;
      host.querySelector<HTMLButtonElement>('[data-ranked-login]')!.onclick = () => options.openAccount?.(); return;
    }
    const me = view?.me, match = view?.currentMatch;
    host.innerHTML = `<section class="ranked-page">
      <header class="ranked-heading"><div><span class="kicker">TRAINER RANKED</span><h1>트레이너 랭크전</h1><p>저장된 팀을 Lv.50으로 맞춰 겨룹니다. 원래 HP·경험치·회로 기억은 바뀌지 않습니다.</p></div>
      ${me ? `<div class="ranked-own">${trainerName({ userId: account.id, username: account.username, activeIndex: 0, team: [] }, true)}<b>${me.rating}점</b><span>${me.wins}승 ${me.losses}패</span></div>` : ''}</header>
      <nav class="ranked-leagues" aria-label="랭크 리그">${(['standard', 'open'] as League[]).map(id => `<button data-ranked-league="${id}" class="${league === id ? 'active' : ''}" ${busy || activeSession() ? 'disabled' : ''}><strong>${leagueCopy[id].name}</strong><small>${leagueCopy[id].note}</small></button>`).join('')}</nav>
      ${match && (match.status === 'active' || match.id !== dismissedMatchId) ? battle(match) : `<div class="ranked-lobby"><section><h2>${leagueCopy[league].name} 리그</h2><p>${league === 'standard' ? '전설·환상 포켓몬을 제외한 팀만 참가할 수 있습니다.' : '보유한 모든 포켓몬을 사용할 수 있습니다.'}</p>
        ${league === 'standard' && restricted.length ? `<p class="ranked-restricted">현재 팀에 제한 포켓몬 ${restricted.length}마리가 있어 참가할 수 없습니다.</p>` : ''}
        <button class="primary" data-ranked-queue ${busy || me?.queued || (league === 'standard' && restricted.length) ? 'disabled' : ''}>${me?.queued ? '상대를 찾는 중…' : '매칭 시작'}</button>
        ${me?.queued ? `<button data-ranked-cancel ${busy ? 'disabled' : ''}>매칭 취소</button>` : ''}<small>턴마다 90초 · 동시에 행동 선택 · 팀 최대 6마리</small></section>
        <section class="ranked-board"><header><h2>${leagueCopy[league].name} 순위</h2><button data-ranked-refresh>새로고침</button></header>
          <ol>${(view?.leaderboard ?? []).map(row => `<li><span>${row.rank}</span><strong class="ranked-trainer rank-tier-${row.tier}">${escape(row.username)}<small>${tierName[row.tier]}</small></strong><b>${row.rating}</b><small>${row.wins}승 ${row.losses}패</small></li>`).join('') || '<li class="ranked-empty">아직 순위 기록이 없습니다.</li>'}</ol></section></div>`}
      <p class="ranked-boundary">피해·회복·상태 판정과 지구던지기·나이트헤드·분노의앞니, 잠자기·흑안개·클리어스모그·치료방울·아로마테라피·고속스핀 효과를 서버가 처리합니다. 그 밖의 일부 특수 규칙·전용 연출은 아직 적용되지 않습니다.</p>
    </section>`;
    bind(); updateDeadline();
  };
  const fail = (error: unknown) => options.notify(error instanceof Error ? error.message : String(error), true);
  const load = async (announce = true) => {
    if (busy) return;
    const account = user(), expected = ++generation; if (!account || !host) { render(); return; }
    try {
      const next = await request<RankedView>(`/api/ranked?league=${league}`, account);
      if (expected !== generation || !host || account.id !== user()?.id || league !== next.league) return;
      view = next; render(); schedule();
    } catch (error) { if (expected !== generation) return; if (announce) fail(error); schedule(); }
  };
  const mutate = async (path: string, body: unknown, prepare = false) => {
    const account = user(); if (!account) throw new Error('계정 연결이 필요합니다.');
    if (busy) throw new Error('이전 요청을 처리 중입니다.');
    const expected = ++generation;
    busy = true; stop(); render();
    try {
      if (prepare) await options.prepare();
      if (expected !== generation || account.id !== user()?.id) throw new Error('화면이나 계정이 변경되어 요청을 중단했습니다.');
      const result = await request<RankedView | { match: RankedMatch } | { cancelled: boolean }>(path, account, { method: 'POST', body: JSON.stringify(body) });
      if (expected !== generation || account.id !== user()?.id) throw new Error('화면이나 계정이 변경되었습니다. 대전 상태를 다시 확인해 주세요.');
      return result;
    }
    finally { busy = false; }
  };
  const submit = async (body: { turn: number; moveIndex?: number; switchIndex?: number; surrender?: boolean }) => {
    const match = view?.currentMatch; if (busy || !match || match.status !== 'active') return;
    try {
      const response = await mutate(`/api/ranked/matches/${encodeURIComponent(match.id)}/action`, body) as { match: RankedMatch };
      if (view) view.currentMatch = response.match; render(); schedule();
    } catch (error) { fail(error); await load(false); }
  };
  const bind = () => {
    if (!host) return;
    host.querySelectorAll<HTMLButtonElement>('[data-ranked-league]').forEach(button => button.onclick = () => { if (busy || activeSession()) return; stop(); league = button.dataset.rankedLeague as League; view = undefined; generation++; render(); void load(); });
    host.querySelectorAll<HTMLButtonElement>('[data-ranked-refresh]').forEach(button => button.onclick = () => {
      if (view?.currentMatch?.status === 'completed') { dismissedMatchId = view.currentMatch.id; render(); }
      void load();
    });
    host.querySelector<HTMLButtonElement>('[data-ranked-queue]')?.addEventListener('click', () => void (async () => {
      if (busy) return;
      try { const next = await mutate('/api/ranked/queue', { league }, true) as RankedView; view = next; render(); schedule(); }
      catch (error) { fail(error); render(); }
    })());
    host.querySelector<HTMLButtonElement>('[data-ranked-cancel]')?.addEventListener('click', () => void (async () => {
      try { await mutate('/api/ranked/cancel', { league }); await load(false); }
      catch (error) { fail(error); render(); }
    })());
    host.querySelectorAll<HTMLButtonElement>('[data-ranked-move]').forEach(button => button.onclick = () => void submit({ turn: view!.currentMatch!.turn, moveIndex: Number(button.dataset.rankedMove) }));
    host.querySelectorAll<HTMLButtonElement>('[data-ranked-switch]').forEach(button => button.onclick = () => void submit({ turn: view!.currentMatch!.turn, switchIndex: Number(button.dataset.rankedSwitch) }));
    host.querySelector<HTMLButtonElement>('[data-ranked-surrender]')?.addEventListener('click', () => void (async () => {
      const matchId = view?.currentMatch?.id;
      if (await confirmAction({ title: '랭크전 항복', message: '현재 대전을 항복할까요?', detail: '패배와 레이팅 변동이 즉시 기록됩니다.', confirmLabel: '항복', destructive: true }) && view?.currentMatch?.id === matchId) await submit({ turn: view!.currentMatch!.turn, surrender: true });
    })());
  };
  const updateDeadline = () => {
    if (!host) return;
    const time = host.querySelector<HTMLTimeElement>('[data-ranked-deadline]'); if (!time) return;
    const seconds = Math.max(0, Math.ceil((Date.parse(time.dataset.rankedDeadline!) - Date.now()) / 1000));
    time.textContent = view?.currentMatch?.status === 'active' ? `${seconds}초 남음` : '대전 종료';
  };
  const clock = window.setInterval(updateDeadline, 1_000);
  return {
    mount(nextHost: HTMLElement) { if (host === nextHost) { render(); return; } host = nextHost; generation++; view = undefined; render(); void load(); },
    unmount() { stop(); generation++; host = undefined; },
    hasActiveSession() { return busy || activeSession(); },
    destroy() { stop(); window.clearInterval(clock); host = undefined; generation++; },
  };
}
