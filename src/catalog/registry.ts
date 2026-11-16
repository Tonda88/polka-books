/**
 * Реестр книжных источников.
 *
 * Чтобы добавить новый источник: создайте адаптер в src/catalog/sources/
 * и зарегистрируйте его здесь одной строкой. Остальной код (поиск,
 * объединение, UI) менять не нужно.
 */
import type { BookSource, SourceHealth } from './types';
import { googleBooksSource } from './sources/googleBooks';
import { openLibrarySource } from './sources/openLibrary';
import { internetArchiveSource } from './sources/internetArchive';
import { gutenbergSource } from './sources/gutenberg';
import { librivoxSource } from './sources/librivox';
import { localLibrarySource } from './sources/localLibrary';

const registry = new Map<string, BookSource>();

export function registerSource(source: BookSource): void {
  if (registry.has(source.id)) {
    console.warn(`Источник «${source.id}» уже зарегистрирован — пропускаем`);
    return;
  }
  registry.set(source.id, source);
}

export function getSource(id: string): BookSource | undefined {
  return registry.get(id);
}

export function listSources(): BookSource[] {
  return [...registry.values()];
}

/** Источники, доступные прямо сейчас (например, Google Books без ключа отключён). */
export function enabledSources(options: { googleKey?: string | null } = {}): BookSource[] {
  return [...registry.values()].filter((source) => {
    if (source.capabilities.requiresKey && !options.googleKey) return false;
    return true;
  });
}

export async function checkSources(
  ids?: string[],
  signal?: AbortSignal,
): Promise<Record<string, SourceHealth>> {
  const targets = ids
    ? ids.map((id) => registry.get(id)).filter((source): source is BookSource => Boolean(source))
    : [...registry.values()];
  const result: Record<string, SourceHealth> = {};
  await Promise.all(
    targets.map(async (source) => {
      if (!source.health) {
        result[source.id] = { ok: true, checkedAt: Date.now() };
        return;
      }
      try {
        result[source.id] = await source.health({ signal, online: true });
      } catch (error) {
        result[source.id] = {
          ok: false,
          note: error instanceof Error ? error.message : 'Недоступен',
          checkedAt: Date.now(),
        };
      }
    }),
  );
  return result;
}

// --- регистрация источников -------------------------------------------------
registerSource(localLibrarySource);
registerSource(openLibrarySource);
registerSource(internetArchiveSource);
registerSource(gutenbergSource);
registerSource(librivoxSource);
registerSource(googleBooksSource);
