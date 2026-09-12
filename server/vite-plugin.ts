import type { Plugin } from 'vite';
import { SaveStore } from './save-store';
import { createSaveApi } from './save-api';

export function choketmonServer(): Plugin {
  let store: SaveStore | undefined;
  return {
    name: 'choketmon-save-server',
    configureServer(server) {
      store = new SaveStore(); const api = createSaveApi(store);
      server.middlewares.use((request, response, next) => { void api(request, response).then(handled => { if (!handled) next(); }); });
      server.httpServer?.once('close', () => { store?.close(); store = undefined; });
    }
  };
}
