// Trainer figures from reference sheets, end to end:
//   (GPT Image reference views) → Tripo multiview model → rig check → Mixamo rig → clips → Blender inspection → web figure.
//
// pnpm exec tsx scripts/tripo-trainers.ts --dry-run [id ...]         plan: views found, stages done, credits to spend
// pnpm exec tsx scripts/tripo-trainers.ts [id ...]                   run or resume; state per figure in assets/trainer-source/tripo/<id>/
// pnpm exec tsx scripts/tripo-trainers.ts --publish [id ...]         also optimize a passing figure into public/models/trainer/web/
// pnpm exec tsx scripts/tripo-trainers.ts --views <id> "<character>" GPT Image front/left/back/right sheets for a new figure
//
// Keys come from .env: TRIPO_API_KEY, OPENAI_API_KEY (and optional TRIPO_V3_BASE_URL, TRIPO_MODEL_VERSION, OPENAI_IMAGE_MODEL,
// AVATAR_IMAGE_TLS_MAX_VERSION=1.2 for hosts that reset TLS 1.3 uploads). Every paid call is recorded before it is waited on,
// so a rerun polls the task it already paid for instead of creating another.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { basename, join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { inspectFigures, printReports } from './inspect-figures';

if (existsSync('.env')) process.loadEnvFile('.env');
const MANIFEST = 'scripts/trainer-figures.json', REFERENCE = 'assets/trainer-source/reference', WORK = 'assets/trainer-source/tripo';
const TRIPO = process.env.TRIPO_V3_BASE_URL ?? 'https://openapi.tripo3d.ai/v3';
const MODEL = process.env.TRIPO_MODEL_VERSION ?? 'v3.1-20260211';
/** Faces for a figure a road shows a dozen of; the web step simplifies anything past 20k. */
const FACE_LIMIT = 12_000;
/** Rig v1.0 is biped-only and carries the 90+ `preset:biped:*` motions; one retarget returns them in one GLB. */
const ANIMATIONS = ['preset:biped:idle', 'preset:biped:walk', 'preset:biped:run', 'preset:biped:wave_goodbye_01', 'preset:biped:look_around'];
/** Game names for the clips, matched by the words in Tripo's names, else by request order. */
const CLIP_NAMES: Array<[RegExp, string]> = [[/idle/i, 'Idle'], [/walk/i, 'Walking'], [/run/i, 'Running'], [/wave|goodbye/i, 'Wave_Goodbye'], [/look/i, 'Look_Around']];
/** Credits: multiview or image generation with texture 30, rig check 0, rig 25, 10 per clip ($1 buys 100). */
const CREDITS = { model: 30, rigCheck: 0, rig: 25, retarget: 10 * ANIMATIONS.length };

type Views = Partial<Record<'front' | 'left' | 'back' | 'right', string>>;
type Figure = { id: string; figure?: string; views: Views };
type Stage = { task?: string; status?: string; output?: Record<string, unknown>; file?: string };
type State = { uploads: Record<string, string>; model: Stage; rigCheck: Stage; rig: Stage; retarget: Stage; inspection?: { verdict: string; problems: string[] }; published?: string };

const manifest = () => JSON.parse(readFileSync(MANIFEST, 'utf8')) as { $comment: string; figures: Figure[] };
const stateFile = (id: string) => join(WORK, id, 'state.json');
const load = (id: string): State => existsSync(stateFile(id)) ? JSON.parse(readFileSync(stateFile(id), 'utf8')) : { uploads: {}, model: {}, rigCheck: {}, rig: {}, retarget: {} };
const save = (id: string, state: State) => { mkdirSync(join(WORK, id), { recursive: true }); writeFileSync(stateFile(id), JSON.stringify(state, null, 2) + '\n'); };
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

function key(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}

async function tripo<T>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const response = await fetch(`${TRIPO}${path}`, {
    method: init.method ?? (init.body || init.form ? 'POST' : 'GET'),
    headers: { Authorization: `Bearer ${key('TRIPO_API_KEY')}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.form ?? (init.body ? JSON.stringify(init.body) : undefined),
  });
  const json = await response.json().catch(() => ({})) as { code?: number; message?: string; data?: T };
  if (response.status === 429) { await sleep(Number(response.headers.get('retry-after') ?? 10) * 1000); return tripo(path, init); }
  if (!response.ok || json.code !== 0 || !json.data) throw new Error(`Tripo ${path}: HTTP ${response.status} ${json.code ?? ''} ${json.message ?? ''}`);
  return json.data;
}

async function upload(file: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(file)], { type: 'image/png' }), basename(file));
  return (await tripo<{ file_token: string }>('/files', { form })).file_token;
}

/** Polls a task to its end. Output URLs live five minutes, so the caller downloads at once. */
async function wait(task: string, label: string): Promise<{ status: string; output: Record<string, unknown> }> {
  const started = Date.now();
  for (;;) {
    const data = await tripo<{ status: string; progress?: number; output?: Record<string, unknown> }>(`/tasks/${task}`);
    if (!['queued', 'running'].includes(data.status)) {
      if (data.status !== 'success') throw new Error(`${label} task ${task} ended ${data.status}`);
      return { status: data.status, output: data.output ?? {} };
    }
    if (Date.now() - started > 20 * 60_000) throw new Error(`${label} task ${task} still ${data.status} after 20 minutes; rerun to keep polling`);
    process.stdout.write(`\r  ${label} ${data.status} ${data.progress ?? 0}%   `);
    await sleep(4000);
  }
}

async function download(url: string, file: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download ${file}: HTTP ${response.status}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

/** Runs one paid stage once: creates its task (recorded before waiting), waits, and downloads its model if it has one. */
async function stage(id: string, state: State, name: 'model' | 'rigCheck' | 'rig' | 'retarget', create: () => Promise<string>, file?: string) {
  const current = state[name];
  if (current.status === 'success' && (!file || (current.file && existsSync(current.file)))) return current;
  if (!current.task) { current.task = await create(); save(id, state); }
  const { status, output } = await wait(current.task, `${id} ${name}`);
  process.stdout.write('\n');
  Object.assign(current, { status, output });
  if (file) {
    const url = output.model_url ?? output.model ?? output.pbr_model;
    if (typeof url !== 'string') throw new Error(`${id} ${name}: no model URL in ${JSON.stringify(output)}`);
    await download(url, file); current.file = file;
  }
  save(id, state);
  return current;
}

async function build(figure: Figure, publish: boolean) {
  const { id } = figure, state = load(id), dir = join(WORK, id);
  mkdirSync(dir, { recursive: true });
  const views = Object.entries(figure.views) as Array<[keyof Views, string]>;
  for (const [view, file] of views) if (!state.uploads[view]) { state.uploads[view] = await upload(join(REFERENCE, file)); save(id, state); }
  await stage(id, state, 'model', async () => {
    const common = { model: MODEL, texture: true, pbr: true, face_limit: FACE_LIMIT, texture_quality: 'standard' };
    if (views.length === 1) return (await tripo<{ task_id: string }>('/generation/image-to-model', { body: { input: state.uploads.front, ...common } })).task_id;
    const inputs = (['front', 'left', 'back', 'right'] as const).filter(view => state.uploads[view]).map(view => ({ [view]: state.uploads[view] }));
    return (await tripo<{ task_id: string }>('/generation/multiview-to-model', { body: { inputs, ...common } })).task_id;
  }, join(dir, 'model.glb'));
  const check = await stage(id, state, 'rigCheck', async () => (await tripo<{ task_id: string }>('/animations/rig-check', { body: { input: state.model.task } })).task_id);
  if (check.output?.riggable === false || (check.output?.rig_type && check.output.rig_type !== 'biped')) throw new Error(`${id}: rig check says ${JSON.stringify(check.output)}`);
  await stage(id, state, 'rig', async () => (await tripo<{ task_id: string }>('/animations/rig', { body: { input: state.model.task, rig_type: 'biped', spec: 'mixamo', out_format: 'glb' } })).task_id, join(dir, 'rigged.glb'));
  await stage(id, state, 'retarget', async () => (await tripo<{ task_id: string }>('/animations/retarget', {
    body: { input: state.rig.task, animations: ANIMATIONS, out_format: 'glb', bake_animation: true, export_with_geometry: true, animate_in_place: true },
  })).task_id, join(dir, 'animated.glb'));

  // Game clip names, then the Blender inspection; a failing figure stops here.
  const named = join(dir, `${figure.figure ?? id}.glb`);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS), document = await io.read(state.retarget.file!);
  document.getRoot().listAnimations().forEach((animation, index) => {
    const match = CLIP_NAMES.find(([pattern]) => pattern.test(animation.getName())) ?? CLIP_NAMES[index];
    if (match) animation.setName(match[1]);
  });
  await io.write(named, document);
  const [report] = await inspectFigures([named], join(dir, 'inspection'));
  printReports([report]);
  state.inspection = { verdict: report.verdict, problems: report.problems }; save(id, state);
  if (report.verdict !== 'pass' || !publish) return;
  // The web figure: the optimizer's master folder, then its build (normal maps, meshopt, budget, stubs dropped).
  const master = join('assets/trainer-source/web', basename(named));
  writeFileSync(master, readFileSync(named));
  const optimize = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/optimize-figures.ts', basename(named, '.glb')], { stdio: 'inherit' });
  if (optimize.status !== 0) throw new Error(`${id}: optimize-figures failed`);
  state.published = join('public/models/trainer/web', basename(named)); save(id, state);
}

/** POST multipart over https, pinned to TLS 1.2 when AVATAR_IMAGE_TLS_MAX_VERSION=1.2 (hosts that reset TLS 1.3 uploads). */
function postMultipart(url: string, fields: Record<string, string>, files: Array<{ field: string; path: string }>): Promise<unknown> {
  const boundary = `----choketmon${Date.now().toString(16)}`, parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  for (const { field, path } of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${basename(path)}"\r\nContent-Type: image/png\r\n\r\n`), readFileSync(path), Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts), target = new URL(url);
  return new Promise((done, fail) => {
    const call = request({ hostname: target.hostname, path: target.pathname, method: 'POST', maxVersion: process.env.AVATAR_IMAGE_TLS_MAX_VERSION === '1.2' ? 'TLSv1.2' : undefined,
      headers: { Authorization: `Bearer ${key('OPENAI_API_KEY')}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { const json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if ((response.statusCode ?? 500) >= 400) fail(new Error(`OpenAI ${response.statusCode}: ${JSON.stringify(json.error ?? json)}`)); else done(json); });
    });
    call.on('error', fail); call.end(body);
  });
}

/**
 * Reference sheets for a new figure: a front T pose drawn in the style of an existing sheet, then its left, back and right
 * views drawn from that front, so all four show one character. Added to the manifest for the Tripo run.
 */
async function drawViews(id: string, character: string) {
  const model = process.env.OPENAI_IMAGE_MODEL ?? process.env.AVATAR_IMAGE_MODEL ?? 'gpt-image-1';
  const endpoint = `${process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1'}/images/edits`;
  const style = 'Chibi game character sheet in exactly the reference image\'s rendering style, proportions and line quality: full body, standing in a T pose with both arms straight out to the sides, feet slightly apart, plain white background, no text, no shadow on the ground.';
  const draw = async (view: keyof Views, prompt: string, reference: string) => {
    const file = join(REFERENCE, `${id}-${view}.png`);
    if (existsSync(file)) return file;
    const result = await postMultipart(endpoint, { model, prompt, size: '1024x1536', quality: 'high', n: '1' }, [{ field: 'image[]', path: reference }]) as { data?: Array<{ b64_json?: string }> };
    const image = result.data?.[0]?.b64_json;
    if (!image) throw new Error(`OpenAI returned no image for ${id} ${view}`);
    writeFileSync(file, Buffer.from(image, 'base64'));
    console.log(`  drew ${file}`);
    return file;
  };
  const front = await draw('front', `${style} Front view, facing the viewer. Character: ${character}`, join(REFERENCE, '41.png'));
  const same = 'The same character as the reference image, identical outfit, colours, hair and proportions, same T pose and white background.';
  await draw('left', `${same} Left side view: the character faces the left edge of the image.`, front);
  await draw('back', `${same} Back view: the character faces away from the viewer.`, front);
  await draw('right', `${same} Right side view: the character faces the right edge of the image.`, front);
  const list = manifest();
  if (!list.figures.some(figure => figure.id === id)) {
    list.figures.push({ id, views: { front: `${id}-front.png`, left: `${id}-left.png`, back: `${id}-back.png`, right: `${id}-right.png` } });
    writeFileSync(MANIFEST, JSON.stringify(list, null, 2) + '\n');
  }
}

function plan(figures: readonly Figure[]) {
  let credits = 0;
  for (const figure of figures) {
    const state = load(figure.id), missing = Object.values(figure.views).filter(file => !existsSync(join(REFERENCE, file)));
    const left = (Object.keys(CREDITS) as Array<keyof typeof CREDITS>).filter(name => state[name].status !== 'success');
    const cost = left.reduce((sum, name) => sum + CREDITS[name], 0);
    credits += cost;
    console.log(`${figure.id.padEnd(9)} views ${Object.keys(figure.views).join('/')}${missing.length ? ` MISSING ${missing.join(', ')}` : ''}  to run: ${left.join(', ') || 'nothing'} (${cost} credits)${state.inspection ? `  inspection ${state.inspection.verdict}` : ''}${state.published ? `  published ${state.published}` : ''}`);
  }
  console.log(`total ${credits} credits (about $${(credits / 100).toFixed(2)})`);
}

const args = process.argv.slice(2);
if (args[0] === '--views') {
  const [, id, character] = args;
  if (!id || !character) throw new Error('usage: --views <id> "<character description>"');
  await drawViews(id, character);
} else {
  const ids = args.filter(arg => !arg.startsWith('--')), all = manifest().figures;
  const figures = ids.length ? ids.map(id => all.find(figure => figure.id === id) ?? (() => { throw new Error(`unknown figure ${id}`); })()) : all;
  if (args.includes('--dry-run')) plan(figures);
  else for (const figure of figures) {
    try { await build(figure, args.includes('--publish')); } catch (error) { console.error(`${figure.id}: ${(error as Error).message}`); process.exitCode = 1; }
  }
}
