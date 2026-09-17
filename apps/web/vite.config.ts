import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * In development the SPA runs on Vite's dev server and proxies `/api` — including the
 * WebSocket upgrade — to `wrangler dev`. In production both are served by the one Worker
 * from the same origin, which is why the client never needs CORS or a configurable API URL:
 * it always talks to its own origin.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
