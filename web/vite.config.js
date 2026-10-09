import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The shop's web login, served by the server at /web/. Dev: proxy /api to a test server
// (WEB_DEV_API, e.g. the rehearsal tunnel http://127.0.0.1:3999) -- never the live one.
export default defineConfig({
  plugins: [react()],
  base: '/web/',
  server: {
    port: 5174,
    proxy: { '/api': process.env.WEB_DEV_API || 'http://127.0.0.1:3999' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
