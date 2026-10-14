/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Relative base so the same build works from any Pages path (/:repo/, /tools/, previews).
export default defineConfig({
  base: './',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    reportCompressedSize: false,
  },
  server: { port: 5173, host: '127.0.0.1' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
  },
});
