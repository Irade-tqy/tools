/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// Relative base so the same build works from any Pages path (/:repo/, /tools/, previews).
export default defineConfig({
  base: './',
  publicDir: 'public',
  plugins: [{
    name: 'static-tool-routes',
    closeBundle() {
      const html = readFileSync('dist/index.html', 'utf8').replaceAll('./assets/', '../assets/');
      for (const route of ['chat', 'paste']) {
        mkdirSync(`dist/${route}`, { recursive: true });
        writeFileSync(`dist/${route}/index.html`, html);
      }
    },
  }],
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
