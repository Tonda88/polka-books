/**
 * HTTP-слой для книжных API: таймауты, повторные попытки, понятные ошибки.
 * Все запросы идут напрямую к официальным API (у них открыт CORS) —
 * без сторонних прокси и без обхода ограничений.
 */
import type { SourceError } from './types';
import { isProxyAvailable } from './proxy';

export class ApiError extends Error {
  status?: number;
  retryable: boolean;

  constructor(message: string, status?: number, retryable = true) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryable = retryable;
  }
}

export interface FetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** Ответ уже в виде ArrayBuffer (файлы). */
  binary?: boolean;
}

/** Отмена запроса пользователем/новым поиском — это не сбой источника. */
export function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

const DEFAULT_TIMEOUT = 12_000;
const DEFAULT_RETRIES = 1;

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function describeError(error: unknown, status?: number): ApiError {
  if (status === 429) {
    return new ApiError('Источник ограничил частоту запросов (429). Попробуйте позже.', 429, true);
  }
  if (status === 401 || status === 403) {
    return new ApiError('Источник требует ключ или запретил доступ (401/403).', status, false);
  }
  if (status && status >= 500) {
    return new ApiError(`Источник временно недоступен (${status}).`, status, true);
  }
  if (status && status >= 400) {
    return new ApiError(`Источник отклонил запрос (${status}).`, status, false);
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new ApiError('Источник не ответил вовремя. Проверьте интернет.', undefined, true);
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ApiError('Запрос отменён.', undefined, false);
  }
  return new ApiError(error instanceof Error ? error.message : 'Неизвестная ошибка сети', undefined, true);
}

export async function fetchWithRetry(url: string, options: FetchOptions = {}): Promise<Response> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  let lastError: ApiError | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const { signal, cancel } = combineSignals(options.signal, timeoutMs);
    try {
      const response = await fetch(url, {
        signal,
        headers: {
          Accept: options.binary ? '*/*' : 'application/json',
          ...options.headers,
        },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw describeError(null, response.status);
      return response;
    } catch (error) {
      // Внешняя отмена (новый запрос, уход с экрана) — не ошибка источника.
      if (options.signal?.aborted || isAbortError(error)) {
        throw error instanceof Error ? error : new DOMException('aborted', 'AbortError');
      }
      lastError = describeError(error, (error as ApiError)?.status);
      if (!lastError.retryable || attempt === retries) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    } finally {
      cancel();
    }
  }
  throw lastError ?? new ApiError('Не удалось выполнить запрос');
}


/** Домены, для которых возможен фолбэк через наш серверный прокси. */
const PROXY_HOSTS = ['archive.org', 'openlibrary.org', 'covers.openlibrary.org', 'gutenberg.org', 'librivox.org'];

function canUseProxy(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PROXY_HOSTS.some((allowed) => host === allowed || host.endsWith('.' + allowed));
  } catch {
    return false;
  }
}

/**
 * Internet Archive периодически отвечает без CORS-заголовков (и тогда браузер
 * блокирует запрос), хотя сам API доступен. Пробуем ещё раз через наш
 * серверный прокси: на ПК его даёт server/serve.mjs, в APK — LocalServer.
 */
async function fetchJsonViaProxy<T>(url: string, options: FetchOptions): Promise<T> {
  const proxied = `/api/fetch?url=${encodeURIComponent(url)}`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('timeout', 'TimeoutError')),
    options.timeoutMs ?? DEFAULT_TIMEOUT,
  );
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(proxied, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new ApiError(`Прокси источника ответил ${response.status}`, response.status, true);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const parse = async (response: Response): Promise<T> => {
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError('Источник вернул некорректный JSON', response.status, false);
    }
  };

  try {
    return await parse(await fetchWithRetry(url, options));
  } catch (error) {
    if (isAbortError(error)) throw error;
    // Сетевой сбой или CORS — пробуем через серверный прокси, если он доступен.
    const status = error instanceof ApiError ? error.status : undefined;
    const networkFailure = !status || status >= 500;
    if (networkFailure && canUseProxy(url) && (await isProxyAvailable())) {
      return fetchJsonViaProxy<T>(url, options);
    }
    throw error;
  }
}

export function toSourceError(sourceId: string, sourceName: string, error: unknown): SourceError {
  if (error instanceof ApiError) {
    return {
      sourceId,
      sourceName,
      message: error.message,
      retryable: error.retryable,
      status: error.status,
    };
  }
  return {
    sourceId,
    sourceName,
    message: error instanceof Error ? error.message : 'Неизвестная ошибка',
    retryable: false,
  };
}

/** Безопасно собирает URL с параметрами. */
export function buildUrl(base: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}
