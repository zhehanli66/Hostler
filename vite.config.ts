import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname, 'ui'),
  base: './',
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(__dirname, 'shared') } },
  build: { outDir: path.resolve(__dirname, 'dist/ui'), emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:7788', ws: true },
      '/api': { target: 'http://127.0.0.1:7788' },
    },
  },
});
