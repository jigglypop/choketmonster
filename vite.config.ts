import { defineConfig, loadEnv } from 'vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
// CloudFront compresses objects only up to 10 MB. Leaf libraries (three, React, Rapier) and the
// generated Pokémon catalog get chunks that import nothing back from the app, so chunk imports stay
// acyclic and no module runs before its dependencies.
const vendorChunks: Record<string, string> = { three: 'three', react: 'react', 'react-dom': 'react', scheduler: 'react', '@dimforge/rapier3d-compat': 'rapier' };
/** The catalog and everything it imports at runtime (sprite URLs, model sources). */
const pokemonData = new Set([
  'src/data/pokemon.ts', 'src/data/pokemon-versions.ts', 'src/data/pokemon-combat-forms.ts', 'src/data/pokemon-abilities.generated.ts',
  'src/data/evolution-rules.ts', 'src/data/breeding.generated.ts', 'src/game/assets.ts', 'src/data/pokemon-models.ts', 'src/data/pokemon-home-runtime-sources.ts',
]);
// The production API and development API use the same Rust/PostgreSQL service.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const origin = new URL(env.VITE_PUBLIC_SITE_URL || 'https://chocketmon.com').origin;
  const hash = createHash('sha256').update(readFileSync('public/chocketmon.png')).digest('hex').slice(0, 12);
  return {
  plugins: [{ name: 'share-metadata', transformIndexHtml: html => html.replaceAll('__PUBLIC_SITE_URL__', origin).replaceAll('__SHARE_IMAGE_HASH__', hash) }],
  build: { rollupOptions: { output: { manualChunks(id, { getModuleInfo }) {
    const path = id.replaceAll('\\', '/');
    // Library code also calls the preload helper; in the entry chunk it would make the libraries import the app.
    if (path === '\0vite/preload-helper.js') return 'preload-helper';
    // react-dom is the lowest-level CommonJS package, so its chunk owns the shared helper.
    if (path === '\0commonjsHelpers.js') return 'react';
    const packageAt = path.lastIndexOf('/node_modules/');
    if (packageAt >= 0) {
      // Modules reached only through import() stay lazy in their own chunks.
      const info = getModuleInfo(id);
      if (info && !info.importers.length && info.dynamicImporters.length) return undefined;
      const [scope, name] = path.slice(packageAt + '/node_modules/'.length).split('/');
      return vendorChunks[scope.startsWith('@') ? `${scope}/${name}` : scope] ?? 'vendor';
    }
    const source = /\/(src\/.+)$/.exec(path.split('?')[0])?.[1];
    return source && pokemonData.has(source) ? 'pokemon-data' : undefined;
  } } } },
  server: { proxy: {
    '/api/trades/live': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8080', changeOrigin: false, ws: true },
    '/api/realtime': { target: process.env.REALTIME_PROXY_TARGET ?? process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8080', changeOrigin: false, ws: true },
    '/api': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8080', changeOrigin: false },
  } },
  };
});
