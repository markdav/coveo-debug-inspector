import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  publicDir: 'extension/public',
  build: {
    outDir: 'dist-extension',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        devtools: resolve(import.meta.dirname, 'extension/devtools.html'),
        panel: resolve(import.meta.dirname, 'extension/panel.html'),
      },
    },
  },
});