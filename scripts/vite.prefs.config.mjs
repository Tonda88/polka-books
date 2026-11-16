/**
 * Конфиг Vite для проверки движка предпочтений в Node.
 * Собирает чистые модули src/prefs/engine.ts в tmp/prefs-bundle/engine.js.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  root: projectRoot,
  build: {
    lib: {
      entry: { engine: 'src/prefs/engine.ts' },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    outDir: 'tmp/prefs-bundle',
    emptyOutDir: true,
    minify: false,
    target: 'es2022',
  },
});
