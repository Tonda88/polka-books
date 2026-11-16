/**
 * Конфиг Vite для проверки каталога в Node.
 *
 * Собирает чистые модули каталога (без React и IndexedDB) в ESM-бандл
 * tmp/catalog-bundle/, который импортирует scripts/check-catalog.mjs.
 *
 * Запуск: node node_modules/vite/bin/vite.js build --config scripts/vite.catalog.config.mjs
 * (или просто `node scripts/check-catalog.mjs` — он соберёт сам).
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  root: projectRoot,
  build: {
    lib: {
      entry: {
        classify: 'src/catalog/classify.ts',
        normalize: 'src/catalog/normalize.ts',
        covers: 'src/catalog/covers.ts',
        limits: 'src/catalog/limits.ts',
        availability: 'src/catalog/availability.ts',
        aggregate: 'src/catalog/aggregate.ts',
        registry: 'src/catalog/registry.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    outDir: 'tmp/catalog-bundle',
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
