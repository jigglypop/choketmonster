import { getAccount, login, register, type User } from '../game/account';
import { validateCredentials, type AuthMode } from '../game/credentials';
import { startupLoading } from './loading-screen';

/** The game module and saved adventure are opened only after authentication. */
export async function requireStartupAccount(): Promise<User> {
  const form = document.querySelector<HTMLFormElement>('#startup-auth')!;
  const stages = document.querySelector<HTMLElement>('[data-loading-stages]')!;
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const error = form.querySelector<HTMLElement>('[data-auth-error]')!;
  const password = form.elements.namedItem('password') as HTMLInputElement;
  const confirmation = form.querySelector<HTMLElement>('[data-auth-confirm]')!;
  const modes = [...form.querySelectorAll<HTMLButtonElement>('[data-auth-mode]')];
  let mode: AuthMode = 'login', busy = true;
  const showError = (failure: unknown) => { error.textContent = failure instanceof Error ? failure.message : String(failure); error.hidden = false; };
  const ready = (user: User) => {
    form.hidden = true; stages.hidden = false; startupLoading?.status('게임 준비 중'); return user;
  };
  try {
    const user = await getAccount();
    if (user) return ready(user);
  } catch (failure) { showError(failure); }
  busy = false; submit.disabled = false; startupLoading?.status('');
  modes.forEach(button => button.onclick = () => {
    if (busy) return;
    mode = button.dataset.authMode as AuthMode;
    modes.forEach(candidate => candidate.setAttribute('aria-pressed', String(candidate === button)));
    confirmation.hidden = mode !== 'register';
    password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    submit.textContent = mode === 'register' ? '회원가입' : '로그인'; error.hidden = true;
  });
  modes.forEach(button => { button.disabled = false; });
  return new Promise<User>(resolve => {
    form.onsubmit = event => {
      event.preventDefault(); if (busy) return;
      const values = new FormData(form), passwordValue = String(values.get('password') ?? '');
      const validated = validateCredentials(mode, String(values.get('username') ?? ''), passwordValue, String(values.get('passwordConfirmation') ?? ''));
      const firstError = Object.values(validated.errors)[0];
      if (firstError) { showError(firstError); return; }
      busy = true; submit.disabled = true; error.hidden = true;
      void (mode === 'register' ? register : login)(validated.username, passwordValue).then(user => {
        form.reset(); resolve(ready(user));
      }).catch(showError).finally(() => { busy = false; submit.disabled = false; });
    };
  });
}
