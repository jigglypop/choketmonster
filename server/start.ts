import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { SaveStore } from './save-store';
import { createSaveApi } from './save-api';

const host = '127.0.0.1', port = Number(process.env.PORT || 4173), root = resolve('dist');
if (!existsSync(root)) throw new Error('dist 폴더가 없습니다. 먼저 pnpm build를 실행하세요.');
const store = new SaveStore(), api = createSaveApi(store);
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary' };
const server = createServer(async (request, response) => {
  if (await api(request, response)) return;
  const pathname = decodeURIComponent(new URL(request.url ?? '/', `http://${host}`).pathname);
  let file = resolve(root, `.${pathname}`); if (file !== root && !file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = resolve(root, 'index.html');
  response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }); createReadStream(file).pipe(response);
});
server.listen(port, host, () => console.log(`choketmon: http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => { store.close(); process.exit(0); }));
