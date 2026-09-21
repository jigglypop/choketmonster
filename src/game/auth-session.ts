export const AUTH_SESSION_EXPIRED = 'choketmon-session-expired';
export class AuthSessionExpiredError extends Error {
  constructor() { super('다시 로그인해 주세요.'); }
}
export function expiredAuthSession(): AuthSessionExpiredError {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED));
  return new AuthSessionExpiredError();
}
