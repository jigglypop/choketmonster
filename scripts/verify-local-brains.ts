import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type NeuralStep = {
  creatureId: string; requestId: string; episodeId: string; inputs: number[]; available: boolean[];
  reward: number | null; learning: boolean; terminal: boolean; checkpoint?: string; checkpointId?: string;
  history?: HistoryStep[]; returnCheckpoint: boolean;
};
type HistoryStep = Omit<NeuralStep, 'creatureId' | 'checkpoint' | 'checkpointId' | 'history' | 'returnCheckpoint'>;
type Decision = {
  creatureId: string; requestId: string;
  decision: { action: number; updates: number; activity: number; elapsedMs: number; graphId: string; nodes: number; edges: number };
  checkpoint?: string;
};
type Check = { name: string; passed: boolean; detail: string };
type CallMetric = { name: string; status: number; elapsedMs: number; requestBytes: number; responseBytes: number };

const arg = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const baseUrl = (arg('--base-url') ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const output = resolve(arg('--out') ?? 'artifacts/local-brains-api.json');
const origin = arg('--origin') ?? 'http://127.0.0.1:5173';
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const clientId = createHash('sha256').update(`local-brains-primary-${suffix}`).digest('hex');
const freshClientId = createHash('sha256').update(`local-brains-fresh-${suffix}`).digest('hex');
const replayClientId = createHash('sha256').update(`local-brains-replay-${suffix}`).digest('hex');
const partialClientId = createHash('sha256').update(`local-brains-partial-${suffix}`).digest('hex');
const creature = '9007199254740993';
const otherCreature = '18446744073709551614';
const episode = `battle-${suffix}`;
const checks: Check[] = [];
const calls: CallMetric[] = [];

function check(name: string, passed: boolean, detail: string) {
  checks.push({ name, passed, detail });
}

function input(turn: number) {
  return Array.from({ length: 12 }, (_, index) => Number((((turn + 1) * (index + 2) % 17) / 16 - .5).toFixed(6)));
}

function current(turn: number, requestId = `req-${suffix}-${turn}`): NeuralStep {
  return {
    creatureId: creature, requestId, episodeId: episode, inputs: input(turn),
    available: [true, true, true, true, false], reward: turn === 1 ? null : .2,
    learning: true, terminal: false, returnCheckpoint: false,
  };
}

function historical(step: NeuralStep): HistoryStep {
  const { requestId, episodeId, inputs, available, reward, learning, terminal } = step;
  return { requestId, episodeId, inputs, available, reward, learning, terminal };
}

async function post(name: string, body: unknown) {
  const started = performance.now();
  const encodedBody = JSON.stringify(body);
  const response = await fetch(`${baseUrl}/api/local-brains/step-batch`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: encodedBody,
    signal: AbortSignal.timeout(120_000),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const elapsedMs = Number((performance.now() - started).toFixed(3));
  calls.push({ name, status: response.status, elapsedMs, requestBytes: Buffer.byteLength(encodedBody), responseBytes: bytes.byteLength });
  let value: Record<string, unknown> = {};
  try { value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>; } catch { /* recorded below */ }
  return { status: response.status, value, raw: new TextDecoder().decode(bytes) };
}

function decisions(call: Awaited<ReturnType<typeof post>>) {
  return (call.value.decisions ?? []) as Decision[];
}

type PgSnapshot = { neuralStates: number; neuralRequests: number; writes: { table: string; inserted: number; updated: number; deleted: number }[] };
const checkLocalDatabase = !process.argv.includes('--skip-db');
function pgCounts(): PgSnapshot | null {
  if (!checkLocalDatabase) return null;
  if (!['http://127.0.0.1:8080', 'http://localhost:8080'].includes(baseUrl)) throw new Error('Remote verification must use --skip-db; local PostgreSQL statistics cannot verify a remote database.');
  const psql = 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe';
  try {
    const text = execFileSync(psql, ['-h', '127.0.0.1', '-p', '55432', '-U', 'choketmon', '-d', 'choketmon', '-tAc',
      "SELECT json_build_object('neuralStates',(SELECT count(*) FROM neural_states),'neuralRequests',(SELECT count(*) FROM neural_requests),'writes',(SELECT json_agg(t) FROM (SELECT relname AS table,n_tup_ins AS inserted,n_tup_upd AS updated,n_tup_del AS deleted FROM pg_stat_user_tables WHERE relname IN ('neural_states','neural_requests','saves') ORDER BY relname) t))"], { encoding: 'utf8' }).trim();
    const value = JSON.parse(text) as PgSnapshot;
    return Number.isFinite(value.neuralStates) && Number.isFinite(value.neuralRequests) && Array.isArray(value.writes) ? value : null;
  } catch { return null; }
}

async function main() {
  const startedAt = new Date().toISOString();
  const pgBefore = pgCounts();
  const first = current(1);
  const secondCreature: NeuralStep = { ...current(1, `req-${suffix}-other-1`), creatureId: otherCreature };
  const initialBody = { clientId, steps: [first, secondCreature] };
  const initial = await post('two-creature batch', initialBody);
  const initialDecisions = decisions(initial);
  check('two distinct creatures use the real graph', initial.status === 200 && initialDecisions.length === 2
    && initialDecisions.every(row => row.decision.nodes === 166_700 && row.decision.edges === 25_582_938),
  `status=${initial.status}, decisions=${initialDecisions.length}`);
  check('wait remains masked', initialDecisions.every(row => row.decision.action >= 0 && row.decision.action < 4),
    `actions=${initialDecisions.map(row => row.decision.action).join(',')}`);

  const duplicate = await post('idempotent duplicate', initialBody);
  check('duplicate returns the exact cached response', duplicate.status === 200 && duplicate.raw === initial.raw,
    `status=${duplicate.status}, byteExact=${duplicate.raw === initial.raw}`);
  const conflicting = structuredClone(initialBody); conflicting.steps[0].inputs[0] += .01;
  const conflict = await post('conflicting duplicate', conflicting);
  check('same requestId with different body conflicts', conflict.status === 409, `status=${conflict.status}`);

  const history: HistoryStep[] = [historical(first)];
  let checkpoint = '';
  let checkpointId = '';
  let eighth: Decision | undefined;
  for (let turn = 2; turn <= 8; turn++) {
    const step = current(turn);
    step.history = structuredClone(history);
    step.returnCheckpoint = turn === 8;
    const call = await post(`learning turn ${turn}`, { clientId, steps: [step] });
    const decision = decisions(call)[0];
    check(`learning turn ${turn}`, call.status === 200 && decision?.decision.action < 4,
      `status=${call.status}, action=${decision?.decision.action}, updates=${decision?.decision.updates}`);
    if (turn === 8 && decision) {
      eighth = decision; checkpoint = decision.checkpoint ?? ''; checkpointId = step.requestId;
    }
    history.push(historical(step));
  }
  check('rewards update the learned readout', eighth?.decision.updates === 7,
    `updates=${eighth?.decision.updates}`);
  check('the eighth step returns a bounded checkpoint', checkpoint.length > 100_000 && checkpoint.length < 2_000_008,
    `base64Bytes=${checkpoint.length}`);

  const ninth = current(9);
  ninth.checkpointId = checkpointId; ninth.returnCheckpoint = true;
  const cachedNinth = await post('cached checkpoint continuation', { clientId, steps: [ninth] });
  const coldNinth = await post('cold checkpoint id only', { clientId: freshClientId, steps: [ninth] });
  check('cold cache asks for checkpoint data', coldNinth.status === 428 && coldNinth.value.code === 'CHECKPOINT_REQUIRED',
    `status=${coldNinth.status}, code=${String(coldNinth.value.code)}`);
  const ninthWithCheckpoint = { ...ninth, checkpoint };
  const freshNinth = await post('checkpoint-only fresh-client continuation', { clientId: freshClientId, steps: [ninthWithCheckpoint] });
  const cachedNinthDecision = decisions(cachedNinth)[0], freshNinthDecision = decisions(freshNinth)[0];
  check('checkpoint envelope resumes the same episode without reset', cachedNinth.status === 200 && freshNinth.status === 200
    && cachedNinthDecision?.checkpoint === freshNinthDecision?.checkpoint
    && JSON.stringify({ ...cachedNinthDecision?.decision, elapsedMs: 0 }) === JSON.stringify({ ...freshNinthDecision?.decision, elapsedMs: 0 }),
  `checkpointByteExact=${cachedNinthDecision?.checkpoint === freshNinthDecision?.checkpoint}`);

  const tenth = current(10);
  tenth.checkpointId = checkpointId;
  tenth.history = [historical(ninth)]; tenth.returnCheckpoint = true;
  const cachedTenth = await post('cached next step', { clientId, steps: [tenth] });
  const replayedTenth = await post('fresh-client checkpoint plus history replay', { clientId: replayClientId, steps: [{ ...tenth, checkpoint }] });
  const cachedTenthDecision = decisions(cachedTenth)[0], replayedTenthDecision = decisions(replayedTenth)[0];
  check('cache miss replays checkpoint and history exactly', cachedTenth.status === 200 && replayedTenth.status === 200
    && cachedTenthDecision?.checkpoint === replayedTenthDecision?.checkpoint
    && JSON.stringify({ ...cachedTenthDecision?.decision, elapsedMs: 0 }) === JSON.stringify({ ...replayedTenthDecision?.decision, elapsedMs: 0 }),
  `checkpointByteExact=${cachedTenthDecision?.checkpoint === replayedTenthDecision?.checkpoint}`);

  const partialFirst: NeuralStep = { ...current(1, `req-${suffix}-partial-first`), creatureId: '18446744073709551613' };
  const partialSecond: NeuralStep = { ...ninth, requestId: `req-${suffix}-partial-second` };
  const partialMiss = await post('partial batch checkpoint miss', { clientId: partialClientId, steps: [partialFirst, partialSecond] });
  check('partial batch returns checkpoint required', partialMiss.status === 428 && partialMiss.value.code === 'CHECKPOINT_REQUIRED',
    `status=${partialMiss.status}, code=${String(partialMiss.value.code)}`);
  const partialRetry = await post('partial batch retry with checkpoint', {
    clientId: partialClientId, steps: [partialFirst, { ...partialSecond, checkpoint }],
  });
  const partialRetryFirst = decisions(partialRetry)[0];
  const partialFirstRetry = await post('partial first-item idempotency receipt', { clientId: partialClientId, steps: [partialFirst] });
  check('partial success is idempotent across full-batch retry', partialRetry.status === 200 && partialFirstRetry.status === 200
    && JSON.stringify(partialRetryFirst) === JSON.stringify(decisions(partialFirstRetry)[0]),
  `batchStatus=${partialRetry.status}, receiptStatus=${partialFirstRetry.status}`);

  const terminal: NeuralStep = {
    ...current(11), requestId: `req-${suffix}-terminal`, reward: 1, terminal: true,
    checkpointId, history: [historical(ninth), historical(tenth)], returnCheckpoint: true,
  };
  const terminalCall = await post('terminal reward flush', { clientId, steps: [terminal] });
  const terminalDecision = decisions(terminalCall)[0];
  check('terminal flush updates then resets activity', terminalCall.status === 200 && terminalDecision?.decision.action === 4
    && terminalDecision.decision.activity === 0 && terminalDecision.decision.updates === 10 && !!terminalDecision.checkpoint,
  `status=${terminalCall.status}, action=${terminalDecision?.decision.action}, activity=${terminalDecision?.decision.activity}, updates=${terminalDecision?.decision.updates}`);

  if (checkLocalDatabase) await new Promise(resolve => setTimeout(resolve, 1500));
  const pgAfter = pgCounts();
  if (checkLocalDatabase) check('anonymous neural API does not write PostgreSQL brain/save tables', !!pgBefore && !!pgAfter
    && JSON.stringify(pgBefore) === JSON.stringify(pgAfter),
  `before=${JSON.stringify(pgBefore)}, after=${JSON.stringify(pgAfter)}`);

  const report = {
    schema: 1, suite: 'choketmon-local-brains-api', startedAt, completedAt: new Date().toISOString(), baseUrl,
    passed: checks.every(row => row.passed), checks, calls,
    summary: {
      checks: checks.length, passedChecks: checks.filter(row => row.passed).length,
      totalElapsedMs: Number(calls.reduce((sum, row) => sum + row.elapsedMs, 0).toFixed(3)),
      totalRequestBytes: calls.reduce((sum, row) => sum + row.requestBytes, 0),
      totalResponseBytes: calls.reduce((sum, row) => sum + row.responseBytes, 0),
      checkpointBase64Bytes: checkpoint.length, pgBefore, pgAfter, databaseVerified: checkLocalDatabase,
    },
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.passed ? 'PASS' : 'FAIL'} ${report.summary.passedChecks}/${report.summary.checks}; report: ${output}`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
