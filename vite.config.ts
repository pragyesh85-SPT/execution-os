import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// base './' so the same build works from the local hub server, Electron and the Android WebView.
export default defineConfig({
  base: './',
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version), __CARD_HTML__: JSON.stringify('<!doctype html><title>card</title><div id=root></div>') },
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
    // Tests build times with local-time Date constructors and the rescue-v1 fixture was recorded in IST,
    // so pin the zone to get the same results on CI runners (UTC) and on any developer machine.
    env: { TZ: 'Asia/Kolkata' },
  },
} as any);
