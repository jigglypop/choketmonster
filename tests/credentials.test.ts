import { describe, expect, it } from 'vitest';
import { codePointLength, validateCredentials } from '../src/game/credentials';

describe('account credential validation', () => {
  it('counts Unicode code points rather than UTF-16 units', () => {
    expect(codePointLength('😀'.repeat(10))).toBe(10);
    expect(validateCredentials('register', ' Valid_User ', '😀'.repeat(10), '😀'.repeat(10))).toEqual({
      username: 'valid_user', errors: {},
    });
    expect(validateCredentials('register', 'valid_user', '😀'.repeat(128), '😀'.repeat(128)).errors).toEqual({});
  });

  it('rejects registration passwords outside 10-128 code points and whitespace-only values', () => {
    expect(validateCredentials('register', 'valid_user', '가'.repeat(9), '가'.repeat(9)).errors.password).toContain('10~128자');
    expect(validateCredentials('register', 'valid_user', '가'.repeat(129), '가'.repeat(129)).errors.password).toContain('10~128자');
    expect(validateCredentials('register', 'valid_user', ' '.repeat(10), ' '.repeat(10)).errors.password).toContain('공백만');
  });

  it('keeps legacy login passwords unchanged and only blocks empty or oversized values', () => {
    expect(validateCredentials('login', 'legacy_user', '짧음').errors).toEqual({});
    expect(validateCredentials('login', 'legacy_user', '  pass  ').errors).toEqual({});
    expect(validateCredentials('login', 'legacy_user', '').errors.password).toContain('입력');
    expect(validateCredentials('login', 'legacy_user', '😀'.repeat(129)).errors.password).toContain('128자 이하');
  });

  it('reports confirmation mismatch and clears it after correction', () => {
    expect(validateCredentials('register', 'valid_user', 'long-password', 'other-password').errors.passwordConfirmation).toContain('일치');
    expect(validateCredentials('register', 'valid_user', 'long-password', 'long-password').errors.passwordConfirmation).toBeUndefined();
  });
});
