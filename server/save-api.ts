import type { IncomingMessage, ServerResponse } from 'node:http';
import { SaveStore } from './save-store';
import { unpackSave } from '../src/game/storage';

const MAX_BODY = 20_000_000;
const route = /^\/api\/storage\/v1\/profiles\/([A-Za-z0-9_-]{8,80})\/saves\/([A-Za-z0-9_.-]{1,120})$/;
const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
};
const validSave = (value: unknown) => { try { unpackSave(value); return true; } catch { return false; } };

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Save body exceeds 20 MB'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 }); }
}

export function createSaveApi(store: SaveStore) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost'), match = route.exec(url.pathname);
    if (!match) return false;
    const [, profileId, slot] = match;
    if (request.method === 'GET') {
      const stored = store.get(profileId, slot);
      if (!stored) json(response, 404, { error: 'save_not_found' }); else json(response, 200, stored);
      return true;
    }
    if (request.method !== 'PUT') { response.setHeader('allow', 'GET, PUT'); json(response, 405, { error: 'method_not_allowed' }); return true; }
    if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { json(response, 415, { error: 'json_required' }); return true; }
    try {
      const body = await readBody(request) as { save?: unknown; revision?: unknown; requestId?: unknown };
      if (!validSave(body?.save)) { json(response, 422, { error: 'invalid_save' }); return true; }
      if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1) { json(response, 422, { error: 'invalid_revision' }); return true; }
      if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(body.requestId)) { json(response, 422, { error: 'invalid_request_id' }); return true; }
      json(response, 200, store.put(profileId, slot, body.save, body.revision as number, body.requestId));
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500;
      json(response, status, { error: status === 500 ? 'storage_error' : (error as Error).message });
    }
    return true;
  };
}
