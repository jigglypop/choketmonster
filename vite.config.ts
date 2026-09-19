import { defineConfig, loadEnv } from 'vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// The production API and development API use the same Rust/PostgreSQL service.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const origin = new URL(env.VITE_PUBLIC_SITE_URL || 'https://chocketmon.com').origin;
  const hash = createHash('sha256').update(readFileSync('public/chocketmon.png')).digest('hex').slice(0, 12);
  return {
  resolve: { alias: [{ find: /^three\/tsl$/, replacement: fileURLToPath(new URL('./src/three/tsl-compat.ts', import.meta.url)) }] },
  plugins: [{ name: 'share-metadata', transformIndexHtml: html => html.replaceAll('__PUBLIC_SITE_URL__', origin).replaceAll('__SHARE_IMAGE_HASH__', hash) }],
  server: { proxy: {
    '/api/trades/live': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8080', changeOrigin: false, ws: true },
    '/api/realtime': { target: process.env.REALTIME_PROXY_TARGET ?? process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8080', changeOrigin: false, ws: true },
    '/api': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8080', changeOrigin: false },
  } },
  };
});
