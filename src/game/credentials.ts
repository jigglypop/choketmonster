export type AuthMode = 'login' | 'register';
export type CredentialField = 'username' | 'password' | 'passwordConfirmation';
export type CredentialErrors = Partial<Record<CredentialField, string>>;

export const USERNAME_HELP = '영문, 숫자, 밑줄(_), 하이픈(-) 3~32자';
export const REGISTER_PASSWORD_HELP = '공백만으로 만들 수 없으며, 조합 제한 없이 10~128자';
export const LOGIN_PASSWORD_HELP = '기존 비밀번호를 그대로 입력하세요.';

export const codePointLength = (value: string) => Array.from(value).length;

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function validateCredentials(
  mode: AuthMode,
  usernameInput: string,
  password: string,
  passwordConfirmation = '',
): { username: string; errors: CredentialErrors } {
  const username = normalizeUsername(usernameInput);
  const errors: CredentialErrors = {};
  if (!/^[a-z0-9_-]{3,32}$/.test(username)) {
    errors.username = `아이디는 ${USERNAME_HELP}로 입력해 주세요.`;
  }

  const passwordLength = codePointLength(password);
  if (mode === 'register') {
    if (passwordLength < 10 || passwordLength > 128) {
      errors.password = `비밀번호는 ${REGISTER_PASSWORD_HELP}로 입력해 주세요.`;
    } else if (password.trim().length === 0) {
      errors.password = '비밀번호를 공백만으로 만들 수 없습니다.';
    }
    if (passwordConfirmation !== password) {
      errors.passwordConfirmation = '비밀번호가 일치하지 않습니다.';
    }
  } else if (passwordLength === 0) {
    errors.password = '비밀번호를 입력해 주세요.';
  } else if (passwordLength > 128) {
    errors.password = '비밀번호는 128자 이하로 입력해 주세요.';
  }
  return { username, errors };
}
