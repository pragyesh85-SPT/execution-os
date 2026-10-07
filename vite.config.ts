import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so the same build works from the local hub server, Electron and the Android WebView.
export default defineConfig({
  base: './',
  plugins: [react()],
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
