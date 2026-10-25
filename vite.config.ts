import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// base './' so the same build works from the local hub server, Electron and the Android WebView.
export default defineConfig({
  base: './',
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4747' },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
} as any);
