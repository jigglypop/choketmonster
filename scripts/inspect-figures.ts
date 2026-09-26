// Blender inspection of trainer figures: rig, skin weights, clips, arm pose and weight budget, plus a review sheet.
// pnpm exec tsx scripts/inspect-figures.ts [--out dir] [figure.glb ...]   (default: every figure in public/models/trainer/web)
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import sharp from 'sharp';

type Clip = { name: string; moving: boolean; armDrop: [number | null, number | null]; hipsDrift: number };
type Report = { file: string; verdict: 'pass' | 'fail'; problems: string[]; warnings: string[]; triangles: number; megabytes: number;
  images: Array<{ width: number; height: number }>; hipsWeightShare?: number; jointSpread?: number; facingYaw?: number; clips: Clip[]; renders: string[] };

/** BLENDER_EXECUTABLE, else the newest Blender under Program Files. */
export function blenderExecutable(): string {
  if (process.env.BLENDER_EXECUTABLE && existsSync(process.env.BLENDER_EXECUTABLE)) return process.env.BLENDER_EXECUTABLE;
  const root = 'C:\\Program Files\\Blender Foundation';
  const versions = existsSync(root) ? readdirSync(root).filter(name => existsSync(join(root, name, 'blender.exe'))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
  if (!versions.length) throw new Error('Blender not found: set BLENDER_EXECUTABLE');
  return join(root, versions.at(-1)!, 'blender.exe');
}

/** Runs the Blender inspector over `files` and returns one report per figure, in order. */
export async function inspectFigures(files: readonly string[], out: string): Promise<Report[]> {
  const run = spawnSync(blenderExecutable(), ['-b', '--factory-startup', '-P', resolve('scripts/inspect-figure-blender.py'), '--', '--out', resolve(out), ...files.map(file => resolve(file))],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const inspected = (run.stdout ?? '').split('\n').filter(line => line.startsWith('INSPECTED')).length;
  if (inspected < files.length) throw new Error(`Blender inspected ${inspected} of ${files.length} figures\n${(run.stderr || run.stdout).slice(-3000)}`);
  const reports = files.map(file => JSON.parse(readFileSync(join(out, `${basename(file, '.glb')}.json`), 'utf8')) as Report);
  for (const report of reports) await sheet(report, out);
  return reports;
}

/** One strip per figure: front, side, back, then three moments of every clip. */
async function sheet(report: Report, out: string) {
  const name = basename(report.file, '.glb'), order = ['front', 'side', 'back'];
  const renders = [...order.map(label => `${name}-${label}.png`), ...report.renders.filter(file => !order.some(label => file === `${name}-${label}.png`))];
  const tile = { width: 180, height: 240 };
  const tiles = await Promise.all(renders.map(file => sharp(join(out, file)).resize(tile.width, tile.height).png().toBuffer()));
  await sharp({ create: { width: tile.width * tiles.length, height: tile.height, channels: 3, background: '#20242a' } })
    .composite(tiles.map((input, index) => ({ input, left: index * tile.width, top: 0 }))).png().toFile(join(out, `${name}-sheet.png`));
}

export function printReports(reports: readonly Report[]) {
  for (const report of reports) {
    const texture = Math.max(0, ...report.images.map(image => Math.max(image.width, image.height)));
    const clips = report.clips.map(clip => `${clip.name}${clip.moving ? '' : '(still)'} arms ${clip.armDrop.map(value => value ?? '-').join('/')}`).join('; ');
    console.log(`${report.verdict === 'pass' ? 'PASS' : 'FAIL'} ${basename(report.file)}  ${report.megabytes} MB, ${report.triangles} tris, texture ${texture}px, hips weight ${report.hipsWeightShare ?? '-'}, facing ${report.facingYaw ?? '-'}°`);
    if (clips) console.log(`     clips: ${clips}`);
    for (const problem of report.problems) console.log(`     problem: ${problem}`);
    for (const warning of report.warnings) console.log(`     warning: ${warning}`);
  }
}

if (import.meta.url === `file:///${resolve(process.argv[1]).replaceAll('\\', '/')}`) {
  const args = process.argv.slice(2), outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args[outIndex + 1] : 'artifacts/figure-inspection';
  const given = args.filter((arg, index) => arg.endsWith('.glb') && args[index - 1] !== '--out');
  const files = given.length ? given : readdirSync('public/models/trainer/web').filter(file => file.endsWith('.glb')).map(file => join('public/models/trainer/web', file));
  const reports = await inspectFigures(files, out);
  printReports(reports);
  console.log(`sheets: ${resolve(out)}`);
  if (reports.some(report => report.verdict === 'fail')) process.exitCode = 1;
}
