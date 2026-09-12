import { defineConfig } from 'vite';
// The production API and development API use the same Rust/PostgreSQL service.
export default defineConfig({
  server: { proxy: { '/api': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8080', changeOrigin: false } } },
});
