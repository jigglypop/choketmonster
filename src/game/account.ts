export type User = { id: string; username: string };
let account: User | null = null;
let initialized: Promise<User | null> | undefined;
const listeners = new Set<(user: User | null) => void>();
const announce = (user: User | null) => { account = user; for (const listener of listeners) listener(user); return user; };
export function currentAccount() { return account; }
export function onAccountChange(listener: (user: User | null) => void) { listeners.add(listener); listener(account); return () => { listeners.delete(listener); }; }
export function getAccount(): Promise<User | null> {
  return initialized ??= fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) })
    .then(async response => response.ok ? announce((await response.json()).user ?? null) : announce(null)).catch(() => announce(null));
}
async function authenticate(mode: 'login' | 'register', username: string, password: string): Promise<User> {
  const response = await fetch(`/api/auth/${mode}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? '계정 요청에 실패했습니다. 잠시 후 다시 시도해 주세요.');
  const user = announce(body.user)!; initialized = Promise.resolve(user); return user;
}
export const login = (username: string, password: string) => authenticate('login', username, password);
export const register = (username: string, password: string) => authenticate('register', username, password);
export async function logout() {
  const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('로그아웃에 실패했습니다. 다시 시도해 주세요.');
  announce(null); initialized = Promise.resolve(null);
}
