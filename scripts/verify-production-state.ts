import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createGame } from '../src/game/engine.ts';
import { packSave, defaultView } from '../src/game/storage.ts';
import type { Graph } from '../src/core/brain.ts';

// This deployment check deliberately restarts only this project's API service.
// Account passwords and cookies remain in memory; artifacts contain receipts only.
const base = 'https://d3b0jo8g1tseoa.cloudfront.net';
const region = 'ap-northeast-2', instance = 'i-0edb04b57d4e1361b';
const aws = (...args: string[]) => JSON.parse(execFileSync('aws', [...args, '--output', 'json'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, AWS_PAGER: '' } }));
assert.equal(aws('sts', 'get-caller-identity').Account, '960243570517');
const suffix = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 5)}`;
const username = `persist_${suffix}`, password = `Persistence-${crypto.randomUUID()}!`;
let cookie = '';
async function api(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', origin: base, cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, `${path}: ${response.status} ${await response.clone().text()}`);
  return { data: await response.json(), wallMs: performance.now() - started, response };
}
const registered = await api('/api/auth/register', { username, password });
const setCookie = registered.response.headers.get('set-cookie') ?? '';
assert.match(setCookie, /;\s*Secure(?:;|$)/i);
assert.match(setCookie, /;\s*HttpOnly(?:;|$)/i);
cookie = setCookie.split(';')[0];
const graph = JSON.parse(await readFile('public/data/connectome.json', 'utf8')) as Graph;
const game = createGame(1, suffix), save = packSave(game, graph, defaultView());
const slot = 'persistence-check', creature = game.player.team[0].instanceId;
const write = await api(`/api/saves/${slot}`, { save, revision: 0, requestId: crypto.randomUUID() }, 'PUT');
const samples: Array<{ updates: number; computeMs: number; wallMs: number }> = [];
const step = (learning: boolean, reward: number | null) => ({
  requestId: crypto.randomUUID(), episodeId: `persist-${suffix}`,
  inputs: [1, .8, .7, 0, .1, .02, 0, 0, 1, .7, .5, .2],
  available: [true, true, true, true, true], reward, learning, terminal: false,
});
for (let i = 0; i < 12; i++) {
  const result = await api(`/api/brains/${creature}/step`, step(true, i === 0 ? null : .25));
  assert.equal(result.data.nodes, 166700); assert.equal(result.data.edges, 25582938);
  samples.push({ updates: result.data.updates, computeMs: result.data.elapsedMs, wallMs: result.wallMs });
}
const before = samples.at(-1)!.updates;
assert.ok(before > 0);
const frozen = await api(`/api/brains/${creature}/step`, step(false, .5));
assert.equal(frozen.data.updates, before);
await mkdir('artifacts', { recursive: true });
const commands = ['set -eu', 'systemctl restart choketmon', 'for i in $(seq 1 30); do if curl -fsS http://127.0.0.1:8080/api/health; then break; fi; sleep 1; done', 'systemctl is-active choketmon', 'systemctl show choketmon --property=MemoryCurrent --property=MainPID'];
const parameterPath = 'artifacts/production-restart-parameters.json';
await writeFile(parameterPath, JSON.stringify({ commands, executionTimeout: ['120'] }));
const commandId = aws('ssm', 'send-command', '--region', region, '--instance-ids', instance, '--document-name', 'AWS-RunShellScript', '--parameters', `file://${parameterPath}`, '--comment', 'Choketmon persistence verification service restart').Command.CommandId;
await writeFile('artifacts/production-restart-pending.json', JSON.stringify({ commandId, instance, username, before }, null, 2));
console.log(`Restart verification submitted: ${commandId}`);
let invocation: { Status: string; StandardOutputContent?: string; StandardErrorContent?: string } | undefined;
for (let i = 0; i < 40; i++) {
  await new Promise(resolve => setTimeout(resolve, 3000));
  invocation = aws('ssm', 'get-command-invocation', '--region', region, '--command-id', commandId, '--instance-id', instance);
  if (!['Pending', 'InProgress', 'Delayed'].includes(invocation!.Status)) break;
}
assert.equal(invocation?.Status, 'Success');
const me = await api('/api/auth/me'); assert.equal(me.data.user.username, username);
const restored = await api(`/api/saves/${slot}`);
assert.equal(restored.data.revision, write.data.revision);
assert.deepEqual(restored.data.save, save);
const after = await api(`/api/brains/${creature}/step`, step(true, .25));
assert.equal(after.data.updates, before + 1);
const replayBody = step(false, null);
const replay = await api(`/api/brains/${creature}/step`, replayBody);
const retry = await api(`/api/brains/${creature}/step`, replayBody);
assert.deepEqual(retry.data, replay.data);
const percentile = (numbers: number[], ratio: number) => [...numbers].sort((a, b) => a - b)[Math.min(numbers.length - 1, Math.ceil(numbers.length * ratio) - 1)];
const report = {
  checkedAt: new Date().toISOString(), passed: true, baseUrl: base, instance, account: username,
  graphId: after.data.graphId, nodes: after.data.nodes, edges: after.data.edges,
  checks: { secureHttpOnlyCookie: true, learned: before > 0, evaluationUpdateCountFrozen: true, sessionSurvivesRestart: true, exactSaveSurvivesRestart: true, learnedStateSurvivesRestart: true, idempotentRetry: true },
  learning: { updatesBeforeRestart: before, updatesAfterRestart: after.data.updates },
  timing: { count: samples.length, computeMedianMs: percentile(samples.map(s => s.computeMs), .5), computeP95Ms: percentile(samples.map(s => s.computeMs), .95), requestMedianMs: percentile(samples.map(s => s.wallMs), .5), requestP95Ms: percentile(samples.map(s => s.wallMs), .95), samples, note: 'Sequential requests on t3.small through CloudFront; not a concurrent load test.' },
  restart: { commandId, status: invocation!.Status, output: invocation!.StandardOutputContent },
};
await writeFile('artifacts/rust-production-persistence.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: report.passed, ...report.learning, timing: { medianMs: report.timing.computeMedianMs, p95Ms: report.timing.computeP95Ms }, report: 'artifacts/rust-production-persistence.json' }));
