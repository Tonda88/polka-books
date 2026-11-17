/**
 * Настройки сервера интернет-поиска.
 *
 * Поисковые API требуют ключей, а ключи нельзя держать в APK — поэтому
 * запросы идут на сервер (server/serve.mjs). Пользователь может указать
 * адрес своего сервера; по умолчанию используется текущий origin (ПК).
 */
const STORAGE_KEY = 'polka:search-server';

export function defaultServerUrl(): string {
  if (typeof window === 'undefined') return '';
  const { origin, protocol } = window.location;
  if (protocol === 'http:' || protocol === 'https:') return origin;
  return '';
}

export function getSearchServer(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null && raw.trim() !== '') return raw.trim().replace(/\/+$/, '');
  } catch {
    /* localStorage недоступен */
  }
  return defaultServerUrl();
}

export function setSearchServer(url: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, url.trim().replace(/\/+$/, ''));
  } catch {
    /* ignore */
  }
}

/** База API: либо сервер пользователя, либо текущий origin. */
export function apiBase(): string {
  return getSearchServer();
}

export function apiUrl(path: string): string {
  return `${apiBase()}${path}`;
}

/**
 * База локального прокси: сам APK (127.0.0.1) или сервер, с которого открыто
 * приложение. Через неё идут /api/page (анализ страниц) и /api/fetch (файлы),
 * поэтому встроенный режим работает и без внешнего сервера поиска.
 */
export function localBase(): string {
  if (typeof window === 'undefined') return '';
  const { origin, protocol } = window.location;
  if (protocol === 'http:' || protocol === 'https:') return origin;
  return '';
}

export function localUrl(path: string): string {
  return `${localBase()}${path}`;
}
