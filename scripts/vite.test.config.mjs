/**
 * Конфиг Vite для проверки парсеров в Node.
 *
 * Собирает чистые модули загрузок (без React и IndexedDB) в ESM-бандл
 * tmp/test-bundle/, который импортирует scripts/check-formats.mjs.
 *
 * Запуск: node node_modules/vite/bin/vite.js build --config scripts/vite.test.config.mjs
 * (или просто `node scripts/check-formats.mjs` — он соберёт сам).
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  root: projectRoot,
  build: {
    lib: {
      entry: {
        parsers: 'src/downloads/parsers/index.ts',
        detect: 'src/downloads/detect.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    outDir: 'tmp/test-bundle',
    emptyOutDir: true,
    minify: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
      },
    },
  },
});
