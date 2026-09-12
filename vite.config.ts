import { defineConfig, loadEnv } from 'vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
// The production API and development API use the same Rust/PostgreSQL service.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const origin = new URL(env.VITE_PUBLIC_SITE_URL || 'https://d3b0jo8g1tseoa.cloudfront.net').origin;
  const hash = createHash('sha256').update(readFileSync('public/chocketmon.png')).digest('hex').slice(0, 12);
  return {
  plugins: [{ name: 'share-metadata', transformIndexHtml: html => html.replaceAll('__PUBLIC_SITE_URL__', origin).replaceAll('__SHARE_IMAGE_HASH__', hash) }],
  server: { proxy: { '/api': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8080', changeOrigin: false } } },
  };
});
