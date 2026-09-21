import { currentAccount, getAccount, login, logout, onAccountChange, register, type User } from './account';
import { LOGIN_PASSWORD_HELP, REGISTER_PASSWORD_HELP, USERNAME_HELP, validateCredentials, type AuthMode, type CredentialField } from './credentials';
import { activateSaveProfile, checkpointSave, onSaveStorageStatus, resolveSaveConflict, startCheckpointAutosave } from './storage';

export type AccountSwitch = { from: User | null; to: User | null; reason: 'initialize' | 'login' | 'register' | 'logout' | 'recovery'; save?: unknown };
export type AccountPanelOptions = {
  container: HTMLElement;
  beforeSwitch?: (change: AccountSwitch) => void | Promise<void>;
  afterSwitch?: (change: AccountSwitch) => void | Promise<void>;
  onSwitchError?: (change: AccountSwitch, error: unknown) => void | Promise<void>;
  notify?: (message: string, error?: boolean) => void;
  checkpointIntervalMs?: number;
  requireLogin?: boolean;
  canClose?: () => boolean;
};

const field = (form: HTMLFormElement, name: string) => (new FormData(form).get(name) ?? '').toString();

/** Mounts account controls. Callbacks let main capture/apply live game state without importing it here. */
export function mountAccountPanel(options: AccountPanelOptions) {
  const host = options.container;
  host.insertAdjacentHTML('beforeend', `<div class="account-panel"><button type="button" class="quiet account-button" data-open-auth>계정 연결</button><span class="account-name" hidden></span><button type="button" class="quiet logout-button" hidden>로그아웃</button></div>
    <dialog class="account-dialog"><form method="dialog" class="account-dialog-card" novalidate><button type="button" class="account-close" aria-label="닫기">×</button><span class="kicker">TRAINER ACCOUNT</span><h2>계정에 모험 보관</h2><p>플레이 중에는 이 기기에 저장하고, 로그인·로그아웃·60초 체크포인트에만 서버와 동기화합니다.</p><div class="account-mode" role="group" aria-label="계정 작업"><button type="button" value="login" aria-pressed="true">로그인</button><button type="button" value="register" aria-pressed="false">회원가입</button></div><label for="account-username">아이디</label><input id="account-username" name="username" autocomplete="username" aria-describedby="account-username-help account-username-error"><small id="account-username-help" class="account-help">${USERNAME_HELP}</small><small id="account-username-error" class="account-field-error" hidden></small><label for="account-password">비밀번호</label><div class="account-password-row"><input id="account-password" name="password" type="password" autocomplete="current-password" aria-describedby="account-password-help account-password-error"><button type="button" class="account-password-toggle" aria-pressed="false">표시</button></div><small id="account-password-help" class="account-help">${LOGIN_PASSWORD_HELP}</small><small id="account-password-error" class="account-field-error" hidden></small><div class="account-confirm" hidden><label for="account-password-confirmation">비밀번호 확인</label><input id="account-password-confirmation" name="passwordConfirmation" type="password" autocomplete="new-password" aria-describedby="account-password-confirmation-help account-password-confirmation-error"><small id="account-password-confirmation-help" class="account-help">같은 비밀번호를 한 번 더 입력하세요.</small><small id="account-password-confirmation-error" class="account-field-error" hidden></small></div><button type="submit" class="primary account-submit">로그인</button><p class="account-error" role="alert" hidden></p></form></dialog>`);
  host.insertAdjacentHTML('beforeend', `<dialog class="save-recovery-dialog"><div class="account-dialog-card"><span class="kicker">SAVE RECOVERY</span><h2>서로 다른 저장을 발견했습니다</h2><p>이 기기와 서버의 진행을 모두 백업했습니다. 계속 사용할 진행을 선택하기 전에는 서버 저장을 덮어쓰지 않습니다.</p><dl class="save-recovery-times"><div><dt>이 기기</dt><dd data-device-time>-</dd></div><div><dt>서버</dt><dd data-server-time>-</dd></div></dl><div class="account-actions"><button type="button" value="device">이 기기 진행 사용</button><button type="button" value="server" class="primary">서버 진행 불러오기</button></div><p class="account-error" role="alert" hidden></p></div></dialog>`);
  const dialog = host.querySelector<HTMLDialogElement>('.account-dialog')!, form = dialog.querySelector<HTMLFormElement>('form')!;
  const open = host.querySelector<HTMLButtonElement>('[data-open-auth]')!, logoutButton = host.querySelector<HTMLButtonElement>('.logout-button')!, name = host.querySelector<HTMLElement>('.account-name')!, error = host.querySelector<HTMLElement>('.account-error')!;
  const usernameInput = form.elements.namedItem('username') as HTMLInputElement;
  const passwordInput = form.elements.namedItem('password') as HTMLInputElement;
  const confirmationInput = form.elements.namedItem('passwordConfirmation') as HTMLInputElement;
  const confirmation = form.querySelector<HTMLElement>('.account-confirm')!;
  const passwordHelp = form.querySelector<HTMLElement>('#account-password-help')!;
  const submitButton = form.querySelector<HTMLButtonElement>('.account-submit')!;
  const passwordToggle = form.querySelector<HTMLButtonElement>('.account-password-toggle')!;
  const modeButtons = [...form.querySelectorAll<HTMLButtonElement>('.account-mode button')];
  const recoveryDialog = host.querySelector<HTMLDialogElement>('.save-recovery-dialog')!, recoveryError = recoveryDialog.querySelector<HTMLElement>('.account-error')!;
  let authMode: AuthMode = 'login';
  let busy = false, disposed = false, switchInFlight = true, recoveryPending = false, recoveryPreparationFailed = false, recoveryReady: Promise<void> | undefined;
  const setBusy = (value: boolean) => { busy = value; for (const button of host.querySelectorAll<HTMLButtonElement>('button')) button.disabled = value; };
  const showError = (reason: unknown) => { const message = reason instanceof Error ? reason.message : String(reason); error.textContent = message; error.hidden = false; options.notify?.(message, true); };
  const fieldInputs: Record<CredentialField, HTMLInputElement> = { username: usernameInput, password: passwordInput, passwordConfirmation: confirmationInput };
  const errorElement = (key: CredentialField) => form.querySelector<HTMLElement>(`#account-${key === 'passwordConfirmation' ? 'password-confirmation' : key}-error`)!;
  const clearFieldError = (key: CredentialField) => {
    fieldInputs[key].removeAttribute('aria-invalid');
    const message = errorElement(key); message.textContent = ''; message.hidden = true;
  };
  const showFieldErrors = (errors: ReturnType<typeof validateCredentials>['errors']) => {
    const keys = Object.keys(fieldInputs) as CredentialField[];
    keys.forEach(key => {
      clearFieldError(key);
      if (!errors[key]) return;
      fieldInputs[key].setAttribute('aria-invalid', 'true');
      const message = errorElement(key); message.textContent = errors[key]!; message.hidden = false;
    });
    const first = keys.find(key => errors[key]);
    if (first) fieldInputs[first].focus();
  };
  const setPasswordVisible = (visible: boolean) => {
    passwordInput.type = visible ? 'text' : 'password'; confirmationInput.type = visible ? 'text' : 'password';
    passwordToggle.textContent = visible ? '숨기기' : '표시'; passwordToggle.setAttribute('aria-pressed', String(visible));
  };
  const setMode = (mode: AuthMode) => {
    authMode = mode; error.hidden = true;
    modeButtons.forEach(button => button.setAttribute('aria-pressed', String(button.value === mode)));
    confirmation.hidden = mode !== 'register'; confirmationInput.disabled = mode !== 'register';
    passwordInput.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    passwordHelp.textContent = mode === 'register' ? REGISTER_PASSWORD_HELP : LOGIN_PASSWORD_HELP;
    submitButton.textContent = mode === 'register' ? '회원가입' : '로그인';
    setPasswordVisible(false);
    (Object.keys(fieldInputs) as CredentialField[]).forEach(clearFieldError);
  };
  modeButtons.forEach(button => button.onclick = () => setMode(button.value as AuthMode));
  passwordToggle.onclick = () => setPasswordVisible(passwordInput.type !== 'text');
  (Object.keys(fieldInputs) as CredentialField[]).forEach(key => fieldInputs[key].addEventListener('input', () => { clearFieldError(key); error.hidden = true; }));
  setMode('login');
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
  open.onclick = () => { error.hidden = true; dialog.showModal(); usernameInput.focus(); };
  const canClose = () => (!options.requireLogin || Boolean(currentAccount())) && (options.canClose?.() ?? true);
  dialog.addEventListener('cancel', event => { if (!canClose()) event.preventDefault(); });
  dialog.querySelector<HTMLButtonElement>('.account-close')!.onclick = () => { if (!canClose()) return; setPasswordVisible(false); dialog.close(); };
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    const reason = authMode;
    const validation = validateCredentials(reason, field(form, 'username'), field(form, 'password'), field(form, 'passwordConfirmation'));
    if (Object.keys(validation.errors).length) { showFieldErrors(validation.errors); return; }
    void (async () => {
      setBusy(true); switchInFlight = true; error.hidden = true;
      const from = currentAccount(), change: AccountSwitch = { from, to: null, reason };
      try {
        const username = validation.username, password = field(form, 'password');
        // A realtime-ticket 401 leaves the local account active so its game and
        // outbox stay recoverable. Re-entering that account's credentials must
        // authenticate before any server checkpoint, because the old cookie is
        // precisely what expired. Other account switches retain the normal
        // checkpoint-before-authentication handoff.
        const sameAccountRelogin = reason === 'login' && Boolean(from) && username.toLowerCase() === from!.username.toLowerCase();
        await options.beforeSwitch?.(change);
        if (from && !sameAccountRelogin) await checkpointSave('logout');
        const user = reason === 'register' ? await register(username, password) : await login(username, password);
        if (sameAccountRelogin && user.id !== from!.id) throw new Error('로그인한 계정이 현재 계정과 일치하지 않습니다.');
        const save = await activateSaveProfile(user);
        if (disposed) return;
        await options.afterSwitch?.({ from, to: user, reason, save });
        dialog.close(); form.reset(); setPasswordVisible(false); setMode('login'); options.notify?.(`${user.username} 계정에 연결했습니다.`);
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
        // beforeSwitch has already captured the exact adventure in the account
        // slot. Let a healthy server checkpoint finish quickly, but do not let
        // an offline or expired save request prevent session termination.
        const checkpoint = checkpointSave('logout').then(() => true).catch(() => false);
        await Promise.race([checkpoint, new Promise<boolean>(resolve => window.setTimeout(() => resolve(false), 1000))]);
        const { serverCleared } = await logout();
        const save = await activateSaveProfile(null, { continueLocally: !options.requireLogin });
        if (disposed) return;
        await options.afterSwitch?.({ from, to: null, reason: 'logout', save });
        options.notify?.(serverCleared ? (options.requireLogin ? '로그아웃했습니다.' : '로그아웃했습니다. 방금 하던 모험은 이 기기에서 이어갑니다.') : '이 기기에서 로그아웃했습니다. 새로고침 시 서버 세션 종료를 다시 시도합니다.');
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
    if (options.requireLogin && !user) { location.reload(); return null; }
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
