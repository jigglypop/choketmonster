import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const source = resolve('dist');
const target = resolve('artifacts', `deploy-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const git = (args: string[]) => {
  try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
  catch { return undefined; }
};
const gitCommit = process.env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']);
const builtAt = new Date().toISOString();
if (!gitCommit || !/^[a-f0-9]{40}$/i.test(gitCommit)) throw new Error('A 40-character git commit is required for deployment');
await mkdir(target, { recursive: true });
const excluded = (path: string) => {
  const normalized = path.replaceAll(sep, '/');
  return /^(models\/pokemon\/\d+\.glb|models\/trainer\/[^/]+\.glb|pokemon\/(back\/)?[^/]+\.png)$/.test(normalized)
    || /(^|\/)[^/]+\.(gb|gbc|gba|rom)$/i.test(normalized);
};
await cp(source, target, { recursive: true, filter: path => !excluded(relative(source, path)) });
await writeFile(join(target, 'version.json'), JSON.stringify({ gitCommit, builtAt }, null, 2) + '\n');
const files: { path: string; bytes: number; sha256: string }[] = [];
async function walk(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await walk(file);
    else { const bytes = await readFile(file); files.push({ path: relative(target, file).replaceAll(sep, '/'), bytes: (await stat(file)).size, sha256: createHash('sha256').update(bytes).digest('hex') }); }
  }
}
await walk(target);
files.sort((a, b) => a.path.localeCompare(b.path));
if (!files.some(file => file.path === 'index.html') || files.some(file => excluded(file.path))) throw new Error('Invalid deployment payload');
const receipt = {
  schemaVersion: 2,
  createdAt: new Date().toISOString(),
  directory: target,
  bytes: files.reduce((n, file) => n + file.bytes, 0),
  manifestSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  source: { gitCommit, gitDirty: Boolean(git(['status', '--porcelain'])), builtAt },
  exclusions: ['models/pokemon/{id}.glb', 'models/trainer/{name}.glb', 'pokemon/{spriteKey}.png', 'pokemon/back/{spriteKey}.png', '*.gb', '*.gbc', '*.gba', '*.rom'],
  files,
};
const archivedReceipt = `${target}.json`;
await writeFile(archivedReceipt, JSON.stringify(receipt, null, 2));
await writeFile('artifacts/deploy-latest.json', JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ directory: target, receipt: archivedReceipt, files: files.length, bytes: receipt.bytes, manifestSha256: receipt.manifestSha256 }));
