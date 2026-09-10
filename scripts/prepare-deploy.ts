import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const source = resolve('dist');
const target = resolve('artifacts', `deploy-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(target, { recursive: true });
const excluded = (path: string) => /^(models\/pokemon\/\d+\.glb|pokemon\/(back\/)?\d+\.png)$/.test(path.replaceAll(sep, '/'));
await cp(source, target, { recursive: true, filter: path => !excluded(relative(source, path)) });
const files: { path: string; bytes: number; sha256: string }[] = [];
async function walk(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await walk(file);
    else { const bytes = await readFile(file); files.push({ path: relative(target, file).replaceAll(sep, '/'), bytes: (await stat(file)).size, sha256: createHash('sha256').update(bytes).digest('hex') }); }
  }
}
await walk(target);
if (!files.some(file => file.path === 'index.html') || files.some(file => excluded(file.path))) throw new Error('Invalid deployment payload');
await writeFile('artifacts/deploy-latest.json', JSON.stringify({ directory: target, bytes: files.reduce((n, file) => n + file.bytes, 0), files }, null, 2));
console.log(JSON.stringify({ directory: target, files: files.length, bytes: files.reduce((n, file) => n + file.bytes, 0) }));
