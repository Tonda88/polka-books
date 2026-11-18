/**
 * Встроенный режим поиска (direct mode) — работа без сервера.
 *
 * Основной резервный источник: SearXNG через официальный реестр searx.space.
 * Ключи пользователя: Google CSE, Bing — для опционального расширения.
 * Яндекс XML API (пользовательский ключ) — опционально.
 *
 * Страницы сайтов для анализа отдаёт локальный прокси APK (`/api/page`).
 */
import { localBase } from './config';
import { analyzeHtml, type PageAnalysis } from './html';
import type { SearchHit } from './types';

export interface DirectKeys {
  googleCseKey?: string | null;
  googleCseCx?: string | null;
  bingKey?: string | null;
  yandexXmlUser?: string | null;
  yandexXmlKey?: string | null;
  yandexXmlLr?: string | null;
}

export interface DirectProviderInfo {
  id: string;
  name: string;
  requiresKey: boolean;
  available: boolean;
  note: string;
}

const TIMEOUT = 12_000;

async function fetchJson<T>(url: string, headers: Record<string, string> = {}, timeout = TIMEOUT): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', ...headers } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function hit(engine: string, url: string | undefined, title: string | undefined, snippet: string, extra: Partial<SearchHit> = {}): SearchHit | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return { engine, url, title: (title ?? '').slice(0, 300), snippet: snippet.slice(0, 500), ...extra };
}

/** Провайдеры для UI — что доступно на устройстве. */
export function directProviders(keys: DirectKeys): DirectProviderInfo[] {
  const providers: DirectProviderInfo[] = [
    {
      id: 'searxng',
      name: 'SearXNG (официальный реестр)',
      requiresKey: false,
      available: true,
      note: 'Публичные узлы из searx.space с JSON API, health-check и кэш',
    },
  ];
  if (keys.googleCseKey && keys.googleCseCx) {
    providers.push({
      id: 'google',
      name: 'Google (CSE)',
      requiresKey: true,
      available: true,
      note: 'Свой ключ Google Custom Search',
    });
  }
  if (keys.bingKey) {
    providers.push({
      id: 'bing',
      name: 'Bing',
      requiresKey: true,
      available: true,
      note: 'Свой ключ Bing Web Search',
    });
  }
  if (keys.yandexXmlUser && keys.yandexXmlKey) {
    providers.push({
      id: 'yandex',
      name: 'Яндекс (XML)',
      requiresKey: true,
      available: true,
      note: 'Яндекс XML API (пользовательский ключ)',
    });
  }
  return providers;
}

/** Поиск через direct-провайдеры с ключами пользователя. */
export async function searchDirect(query: string, keys: DirectKeys, limit = 12): Promise<SearchHit[]> {
  const results: SearchHit[][] = [];

  // 1. Google CSE
  if (keys.googleCseKey && keys.googleCseCx) {
    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(keys.googleCseKey)}&cx=${encodeURIComponent(keys.googleCseCx)}&q=${encodeURIComponent(query)}&num=10&hl=ru`;
      const data = await fetchJson<{ items?: Array<{ link?: string; title?: string; snippet?: string }> }>(url);
      results.push(
        (data.items ?? [])
          .map((item) => hit('google', item.link, item.title, item.snippet ?? ''))
          .filter((item): item is SearchHit => Boolean(item)),
      );
    } catch { /* ignore */ }
  }

  // 2. Bing
  if (keys.bingKey) {
    try {
      const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=10&mkt=ru-RU`;
      const data = await fetchJson<{ webPages?: { value?: Array<{ url?: string; name?: string; snippet?: string }> } }>(
        url,
        { 'Ocp-Apim-Subscription-Key': keys.bingKey },
      );
      results.push(
        (data.webPages?.value ?? [])
          .map((item) => hit('bing', item.url, item.name, item.snippet ?? ''))
          .filter((item): item is SearchHit => Boolean(item)),
      );
    } catch { /* ignore */ }
  }

  // 3. Яндекс XML (через прокси, так как CORS может не работать)
  if (keys.yandexXmlUser && keys.yandexXmlKey) {
    try {
      const params = new URLSearchParams({
        user: keys.yandexXmlUser,
        key: keys.yandexXmlKey,
        query,
        lr: keys.yandexXmlLr ?? '213',
        sortby: 'rlv',
        filter: 'none',
        maxpassages: '2',
        groupby: 'attr=d.mode=deep.groups-on-page=10.docs-in-group=1',
        page: '0',
      });
      const proxyUrl = `${localBase()}/api/page?url=${encodeURIComponent(`https://yandex.ru/search/xml?${params.toString()}`)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT);
      let xml = '';
      try {
        const response = await fetch(proxyUrl, { signal: controller.signal, headers: { Accept: 'text/xml, text/html, */*' } });
        if (response.ok) xml = await response.text();
      } finally {
        clearTimeout(timer);
      }
      if (xml) {
        const yandexResults: SearchHit[] = [];
        const docRe = /<doc>([\s\S]*?)<\/doc>/g;
        let m: RegExpExecArray | null;
        while ((m = docRe.exec(xml)) !== null) {
          const block = m[1];
          const url = /<url>([\s\S]*?)<\/url>/.exec(block)?.[1] ?? '';
          const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? '';
          const passages = [...block.matchAll(/<passage>([\s\S]*?)<\/passage>/g)].map((p) => p[1]).join(' ');
          const r = hit('yandex', url, title, passages.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
          if (r) yandexResults.push(r);
        }
        results.push(yandexResults.slice(0, limit));
      }
    } catch { /* ignore */ }
  }

  // SearXNG добавляется уровнем выше в searchOnDevice(). Не вызываем его здесь,
  // иначе получится рекурсивный цикл searchOnDevice → searchDirect → searchOnDevice.

  // Дедупликация и объединение
  const seen = new Set<string>();
  const merged: SearchHit[] = [];
  for (const item of results.flat()) {
    const key = item.url.replace(/[#?].*$/, '').replace(/^https?:\/\/www\./, 'https://');
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }
  return merged.slice(0, limit);
}

/** Экспорт для UI — список используемых SearXNG инстансов. */
export type { SearxInstance } from './searx';
export { searchOnDevice } from './searx';

// --- Функции для engine.ts (анализ страниц через локальный прокси) ---

export async function analyzePageLocal(url: string): Promise<PageAnalysis | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${localBase()}/api/page?url=${encodeURIComponent(url)}`, {
      signal: controller.signal,
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') ?? '';
    if (!/html/i.test(contentType)) return null;
    const html = (await response.text()).slice(0, 3 * 1024 * 1024);
    return analyzeHtml(html, url);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function hasPageProxy(): Promise<boolean> {
  try {
    const response = await fetch(`${localBase()}/api/page?url=${encodeURIComponent('https://example.com')}`, {
      signal: AbortSignal.timeout(6000),
    });
    return response.ok;
  } catch {
    return false;
  }
}