/**
 * Реестр книжных источников.
 *
 * Чтобы добавить новый источник: создайте адаптер в src/catalog/sources/
 * и зарегистрируйте его здесь одной строкой. Остальной код (поиск,
 * объединение, UI) менять не нужно.
 */
import type { BookSource, SourceHealth } from './types';
import { hasServerGoogleKey } from './proxy';
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

/**
 * Источники, доступные прямо сейчас.
 *
 * Google Books требует ключ, но источник включается и без ключа пользователя,
 * если ключ настроен на сервере (серверный прокси). Отсутствие ключа никогда
 * не блокирует остальные источники и запуск приложения.
 */
export function enabledSources(options: { googleKey?: string | null } = {}): BookSource[] {
  const keyAvailable = Boolean(options.googleKey) || hasServerGoogleKey();
  return [...registry.values()].filter((source) => {
    if (source.capabilities.requiresKey && !keyAvailable) return false;
    return true;
  });
}

/** Причина, по которой источник выключен (для подсказки в UI). */
export function disabledReason(source: BookSource, options: { googleKey?: string | null } = {}): string | null {
  if (!source.capabilities.requiresKey) return null;
  if (options.googleKey) return null;
  if (hasServerGoogleKey()) return null;
  return 'Нужен API-ключ: добавьте свой в Профиле или настройте ключ на сервере';
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
