/**
 * Интернет-поиск: клиент серверного агрегатора.
 *
 * Мы не парсим выдачу поисковиков. Сервер вызывает официальные поисковые
 * API (Google CSE, Bing, Brave, Яндекс, Marginalia, Crossref, OpenAlex,
 * открытые библиотеки), а приложение анализирует найденные страницы.
 */
import { apiUrl } from './config';
import type { ProviderStatus, SearchAnswer } from './types';

export class SearchUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchUnavailableError';
  }
}

async function requestJson<T>(path: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const base = apiUrl('');
  if (!base) {
    throw new SearchUnavailableError(
      'Не настроен сервер поиска. Укажите адрес сервера (например http://192.168.0.10:4173) в настройках.',
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), options.timeoutMs ?? 60_000);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(apiUrl(path), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = `Сервер ответил ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        /* не JSON */
      }
      throw new SearchUnavailableError(message);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof SearchUnavailableError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new SearchUnavailableError('Сервер поиска не ответил вовремя');
    }
    throw new SearchUnavailableError(
      'Не удалось связаться с сервером поиска. Проверьте адрес сервера и интернет.',
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Проверка доступности сервера и списка провайдеров. */
export async function fetchProviders(options: { signal?: AbortSignal } = {}): Promise<{
  providers: ProviderStatus[];
  online: boolean;
}> {
  try {
    const data = await requestJson<{ providers: ProviderStatus[] }>('/api/search/status', {
      signal: options.signal,
      timeoutMs: 8_000,
    });
    return { providers: data.providers ?? [], online: true };
  } catch {
    return { providers: [], online: false };
  }
}

/** Веб-поиск по всем доступным провайдерам. */
export async function searchWeb(
  query: string,
  options: { signal?: AbortSignal; limit?: number; engines?: string[] } = {},
): Promise<SearchAnswer> {
  const params = new URLSearchParams({ q: query, limit: String(options.limit ?? 12) });
  if (options.engines && options.engines.length > 0) params.set('engines', options.engines.join(','));
  return requestJson<SearchAnswer>(`/api/search?${params.toString()}`, {
    signal: options.signal,
    timeoutMs: 25_000,
  });
}

export interface AnalyzedPage {
  ok: boolean;
  url?: string;
  title?: string;
  authors?: string[];
  description?: string;
  coverUrl?: string;
  language?: string;
  year?: number;
  isbn?: string;
  files?: Array<{ url: string; format: string; label?: string }>;
  isBook?: boolean;
  bookScore?: number;
  error?: string;
}

/** Анализ конкретной страницы: метаданные книги и файлы. */
export async function analyzePage(
  url: string,
  options: { signal?: AbortSignal } = {},
): Promise<AnalyzedPage> {
  return requestJson<AnalyzedPage>(`/api/analyze?url=${encodeURIComponent(url)}`, {
    signal: options.signal,
    timeoutMs: 25_000,
  });
}

export interface ProbeAnswer {
  ok: boolean;
  url: string;
  status?: number;
  sizeBytes?: number;
  mime?: string;
  format?: string;
  reason?: string;
  message?: string;
}

/** Проверка доступности файла до скачивания. */
export async function probeFile(url: string, options: { signal?: AbortSignal } = {}): Promise<ProbeAnswer> {
  return requestJson<ProbeAnswer>(`/api/probe?url=${encodeURIComponent(url)}`, {
    signal: options.signal,
    timeoutMs: 20_000,
  });
}

/** URL прокси-скачивания конкретного файла. */
export function proxyFileUrl(url: string): string {
  return apiUrl(`/api/fetch?url=${encodeURIComponent(url)}`);
}
