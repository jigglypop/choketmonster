import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

type Check = { name: string; status: number; passed: boolean; message?: string };
const value = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const baseUrl = (value('--base-url') ?? process.env.BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const origin = value('--origin') ?? process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
const output = resolve(value('--out') ?? 'artifacts/credentials-verification.json');
const username = `test_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`.slice(0, 32).toLowerCase();
const password = '암호😀테스트abcd'; // 10 Unicode code points; never print this value.
const checks: Check[] = [];

async function auth(path: 'register' | 'login', requestPassword: string) {
  const response = await fetch(`${baseUrl}/api/auth/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ username, password: requestPassword }), signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  return { status: response.status, message: body.message };
}

async function main() {
  let result = await auth('register', password);
  checks.push({ name: '10-code-point Unicode registration succeeds', ...result, passed: result.status === 200 || result.status === 201 });
  result = await auth('login', `${password}x`);
  checks.push({ name: 'wrong password stays generic 401', ...result, passed: result.status === 401 && result.message === '아이디 또는 비밀번호가 올바르지 않습니다.' });
  result = await auth('login', password);
  checks.push({ name: 'Unicode password logs in unchanged', ...result, passed: result.status === 200 });
  result = await auth('login', '');
  checks.push({ name: 'empty login password is rejected', ...result, passed: result.status === 422 });
  result = await auth('login', '😀'.repeat(129));
  checks.push({ name: '129-code-point login password is rejected', ...result, passed: result.status === 422 });

  const report = { schema: 1, suite: 'choketmon-credentials', baseUrl, checkedAt: new Date().toISOString(), username, passed: checks.every(check => check.passed), checks };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
