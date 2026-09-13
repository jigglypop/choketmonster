import { currentAccount, getAccount, login, logout, onAccountChange, register, type User } from './account';
import { activateSaveProfile, checkpointSave, startCheckpointAutosave } from './storage';

export type AccountSwitch = { from: User | null; to: User | null; reason: 'initialize' | 'login' | 'register' | 'logout'; save?: unknown };
export type AccountPanelOptions = {
  container: HTMLElement;
  beforeSwitch?: (change: AccountSwitch) => void | Promise<void>;
  afterSwitch?: (change: AccountSwitch) => void | Promise<void>;
  onSwitchError?: (change: AccountSwitch, error: unknown) => void | Promise<void>;
  notify?: (message: string, error?: boolean) => void;
  checkpointIntervalMs?: number;
};

const field = (form: HTMLFormElement, name: string) => (new FormData(form).get(name) ?? '').toString();

/** Mounts account controls. Callbacks let main capture/apply live game state without importing it here. */
export function mountAccountPanel(options: AccountPanelOptions) {
  const host = options.container;
  host.insertAdjacentHTML('beforeend', `<div class="account-panel"><button type="button" class="quiet account-button" data-open-auth>계정 연결</button><span class="account-name" hidden></span><button type="button" class="quiet logout-button" hidden>로그아웃</button></div>
    <dialog class="account-dialog"><form method="dialog" class="account-dialog-card"><button type="button" class="account-close" aria-label="닫기">×</button><span class="kicker">TRAINER ACCOUNT</span><h2>계정에 모험 보관</h2><p>플레이 중에는 이 기기에 저장하고, 로그인·로그아웃·60초 체크포인트에만 서버와 동기화합니다.</p><label>아이디<input name="username" autocomplete="username" minlength="3" maxlength="32" required></label><label>비밀번호<input name="password" type="password" autocomplete="current-password" minlength="10" maxlength="128" required></label><div class="account-actions"><button type="submit" value="login" class="primary">로그인</button><button type="submit" value="register">가입</button></div><p class="account-error" role="alert" hidden></p></form></dialog>`);
  const dialog = host.querySelector<HTMLDialogElement>('.account-dialog')!, form = dialog.querySelector<HTMLFormElement>('form')!;
  const open = host.querySelector<HTMLButtonElement>('[data-open-auth]')!, logoutButton = host.querySelector<HTMLButtonElement>('.logout-button')!, name = host.querySelector<HTMLElement>('.account-name')!, error = host.querySelector<HTMLElement>('.account-error')!;
  let busy = false, disposed = false;
  const setBusy = (value: boolean) => { busy = value; for (const button of host.querySelectorAll<HTMLButtonElement>('button')) button.disabled = value; };
  const showError = (reason: unknown) => { const message = reason instanceof Error ? reason.message : String(reason); error.textContent = message; error.hidden = false; options.notify?.(message, true); };
  const render = (user: User | null) => { open.hidden = Boolean(user); name.hidden = !user; logoutButton.hidden = !user; name.textContent = user ? `${user.username} 계정` : ''; };
  const unsubscribe = onAccountChange(render), stopAutosave = startCheckpointAutosave(options.checkpointIntervalMs);
  open.onclick = () => { error.hidden = true; dialog.showModal(); };
  dialog.querySelector<HTMLButtonElement>('.account-close')!.onclick = () => dialog.close();
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null, reason = submitter?.value === 'register' ? 'register' : 'login';
    void (async () => {
      setBusy(true); error.hidden = true;
      const from = currentAccount(), change: AccountSwitch = { from, to: null, reason };
      try {
        await options.beforeSwitch?.(change);
        if (from) await checkpointSave('logout');
        const username = field(form, 'username').trim(), password = field(form, 'password');
        const user = reason === 'register' ? await register(username, password) : await login(username, password);
        const save = await activateSaveProfile(user);
        if (disposed) return;
        await options.afterSwitch?.({ from, to: user, reason, save });
        dialog.close(); form.reset(); options.notify?.(`${user.username} 계정에 연결했습니다.`);
      } catch (failure) {
        // The caller distinguishes a failed authentication from a committed account
        // switch. A failed IndexedDB read must never be presented as an empty save.
        try { await options.onSwitchError?.(change, failure); } catch { /* Preserve the original error. */ }
        showError(failure);
      }
      finally { setBusy(false); }
    })();
  });
  logoutButton.onclick = () => {
    if (busy) return;
    void (async () => {
      setBusy(true);
      const from = currentAccount(), change: AccountSwitch = { from, to: null, reason: 'logout' };
      try {
        await options.beforeSwitch?.(change);
        await checkpointSave('logout');
        await logout();
        const save = await activateSaveProfile(null, { continueLocally: true });
        if (disposed) return;
        await options.afterSwitch?.({ from, to: null, reason: 'logout', save });
        options.notify?.('로그아웃했습니다. 방금 하던 모험을 이 기기에서 이어갑니다.');
      } catch (failure) {
        try { await options.onSwitchError?.(change, failure); } catch { /* Preserve the original error. */ }
        showError(failure);
      }
      finally { setBusy(false); }
    })();
  };
  const ready = getAccount().then(async user => {
    if (disposed) return null;
    const save = await activateSaveProfile(user);
    if (!disposed) await options.afterSwitch?.({ from: null, to: user, reason: 'initialize', save });
    return user;
  }).catch(reason => { showError(reason); return null; });
  return { ready, checkpoint: () => checkpointSave('manual'), destroy() { disposed = true; unsubscribe(); stopAutosave(); dialog.remove(); host.querySelector('.account-panel')?.remove(); } };
}
