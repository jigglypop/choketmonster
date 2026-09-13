import { currentAccount, getAccount, login, logout, onAccountChange, register, type User } from './account';
import { activateSaveProfile, checkpointSave, onSaveStorageStatus, resolveSaveConflict, startCheckpointAutosave } from './storage';

export type AccountSwitch = { from: User | null; to: User | null; reason: 'initialize' | 'login' | 'register' | 'logout' | 'recovery'; save?: unknown };
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
  host.insertAdjacentHTML('beforeend', `<dialog class="save-recovery-dialog"><div class="account-dialog-card"><span class="kicker">SAVE RECOVERY</span><h2>서로 다른 저장을 발견했습니다</h2><p>이 기기와 서버의 진행을 모두 백업했습니다. 계속 사용할 진행을 선택하기 전에는 서버 저장을 덮어쓰지 않습니다.</p><dl class="save-recovery-times"><div><dt>이 기기</dt><dd data-device-time>-</dd></div><div><dt>서버</dt><dd data-server-time>-</dd></div></dl><div class="account-actions"><button type="button" value="device">이 기기 진행 사용</button><button type="button" value="server" class="primary">서버 진행 불러오기</button></div><p class="account-error" role="alert" hidden></p></div></dialog>`);
  const dialog = host.querySelector<HTMLDialogElement>('.account-dialog')!, form = dialog.querySelector<HTMLFormElement>('form')!;
  const open = host.querySelector<HTMLButtonElement>('[data-open-auth]')!, logoutButton = host.querySelector<HTMLButtonElement>('.logout-button')!, name = host.querySelector<HTMLElement>('.account-name')!, error = host.querySelector<HTMLElement>('.account-error')!;
  const recoveryDialog = host.querySelector<HTMLDialogElement>('.save-recovery-dialog')!, recoveryError = recoveryDialog.querySelector<HTMLElement>('.account-error')!;
  let busy = false, disposed = false, switchInFlight = true, recoveryPending = false, recoveryPreparationFailed = false, recoveryReady: Promise<void> | undefined;
  const setBusy = (value: boolean) => { busy = value; for (const button of host.querySelectorAll<HTMLButtonElement>('button')) button.disabled = value; };
  const showError = (reason: unknown) => { const message = reason instanceof Error ? reason.message : String(reason); error.textContent = message; error.hidden = false; options.notify?.(message, true); };
  const render = (user: User | null) => { open.hidden = Boolean(user); name.hidden = !user; logoutButton.hidden = !user; name.textContent = user ? `${user.username} 계정` : ''; };
  const unsubscribe = onAccountChange(render), stopAutosave = startCheckpointAutosave(options.checkpointIntervalMs);
  const prepareRecovery = () => {
    if (disposed || switchInFlight || !recoveryPending || recoveryReady) return;
      recoveryPreparationFailed = false;
      const user = currentAccount(), change: AccountSwitch = { from: user, to: user, reason: 'recovery' };
      recoveryReady = Promise.resolve(options.beforeSwitch?.(change)).catch(async failure => {
        recoveryPreparationFailed = true;
        try { await options.onSwitchError?.(change, failure); } catch { /* Preserve the original error. */ }
        recoveryError.textContent = failure instanceof Error ? failure.message : String(failure); recoveryError.hidden = false;
        throw failure;
      });
      // The button awaits and reports this failure. This catch prevents an
      // unhandled rejection while the user is still reading the dialog.
      void recoveryReady.catch(() => {});
  };
  const finishSwitch = () => {
    switchInFlight = false;
    if (recoveryPending && !recoveryDialog.open && !dialog.open) recoveryDialog.showModal();
    prepareRecovery();
  };
  const unsubscribeStorage = onSaveStorageStatus(status => {
    if (disposed || status.state !== 'conflict' || !status.conflict) return;
    recoveryPending = true;
    const display = (value: string) => value ? new Date(value).toLocaleString('ko-KR') : '시간 기록 없음';
    recoveryDialog.querySelector<HTMLElement>('[data-device-time]')!.textContent = display(status.conflict.deviceSavedAt);
    recoveryDialog.querySelector<HTMLElement>('[data-server-time]')!.textContent = display(status.conflict.serverSavedAt);
    recoveryError.hidden = true;
    if (!switchInFlight && !dialog.open && !recoveryDialog.open) recoveryDialog.showModal();
    prepareRecovery();
  });
  recoveryDialog.addEventListener('cancel', event => event.preventDefault());
  for (const button of recoveryDialog.querySelectorAll<HTMLButtonElement>('button[value]')) button.onclick = () => {
    if (busy) return;
    void (async () => {
      setBusy(true); recoveryError.hidden = true;
      try {
        await recoveryReady;
        const save = await resolveSaveConflict(button.value === 'device' ? 'device' : 'server');
        const user = currentAccount();
        await options.afterSwitch?.({ from: user, to: user, reason: 'recovery', save });
        recoveryDialog.close();
        recoveryReady = undefined; recoveryPending = false; recoveryPreparationFailed = false;
        options.notify?.(button.value === 'device' ? '이 기기 진행을 서버에 저장했습니다.' : '서버 진행을 이 기기에 불러왔습니다.');
      } catch (failure) {
        const user = currentAccount(), change: AccountSwitch = { from: user, to: user, reason: 'recovery' };
        if (!recoveryPreparationFailed) try { await options.onSwitchError?.(change, failure); } catch { /* Preserve the original error. */ }
        recoveryError.textContent = failure instanceof Error ? failure.message : String(failure); recoveryError.hidden = false;
        options.notify?.(recoveryError.textContent, true);
      } finally { setBusy(false); }
    })();
  };
  open.onclick = () => { error.hidden = true; dialog.showModal(); };
  dialog.querySelector<HTMLButtonElement>('.account-close')!.onclick = () => dialog.close();
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null, reason = submitter?.value === 'register' ? 'register' : 'login';
    void (async () => {
      setBusy(true); switchInFlight = true; error.hidden = true;
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
      finally { setBusy(false); finishSwitch(); }
    })();
  });
  logoutButton.onclick = () => {
    if (busy) return;
    void (async () => {
      setBusy(true); switchInFlight = true;
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
      finally { setBusy(false); finishSwitch(); }
    })();
  };
  setBusy(true);
  const ready = getAccount().then(async user => {
    if (disposed) return null;
    const save = await activateSaveProfile(user);
    if (!disposed) await options.afterSwitch?.({ from: null, to: user, reason: 'initialize', save });
    return user;
  }).catch(reason => { showError(reason); throw reason; }).finally(() => { if (!disposed) { setBusy(false); finishSwitch(); } });
  return {
    ready,
    open() { if (!disposed && !busy) { error.hidden = true; dialog.showModal(); } },
    checkpoint: () => checkpointSave('manual'),
    destroy() { disposed = true; unsubscribe(); unsubscribeStorage(); stopAutosave(); dialog.remove(); recoveryDialog.remove(); host.querySelector('.account-panel')?.remove(); },
  };
}
