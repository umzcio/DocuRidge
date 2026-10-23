import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Render the real builder in a browser without a database, mail, or AI provider.
// Only its server-action boundary is replaced; submitted PDF bytes are captured.
export default defineConfig({
  envDir: __dirname,
  define: { 'process.env': JSON.stringify({ NODE_ENV: 'development' }) },
  plugins: [react(), {
    name: 'capture-builder-action',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/DocuRidge/pdf.worker.mjs') req.url = '/pdf.worker.mjs';
        if (req.url === '/') req.url = '/tests/pdf-preparation/index.html';
        next();
      });
    },
  }],
  resolve: { alias: { '@': path.resolve(__dirname, '../../src'), './actions': path.resolve(__dirname, 'capture-action.ts') } },
  server: { host: '127.0.0.1', port: 4179, strictPort: true },
});
