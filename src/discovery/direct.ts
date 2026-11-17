/**
 * Встроенный режим поиска: провайдеры, доступные прямо с телефона.
 *
 * Работают без сервера, если у API открыт CORS:
 *  - Google Custom Search — со своим ключом пользователя (хранится на устройстве);
 *  - Bing Web Search — со своим ключом;
 *  - Crossref, OpenAlex, Open Library, Project Gutenberg (IA) — без ключа.
 *
 * Страницы сайтов для анализа отдаёт локальный прокси APK (`/api/page`),
 * поэтому анализ работает и без внешнего сервера.
 */
import { localBase } from './config';
import type { SearchHit } from './types';
import { analyzeHtml, type PageAnalysis } from './html';

export interface DirectKeys {
  googleCseKey?: string | null;
  googleCseCx?: string | null;
  bingKey?: string | null;
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

/** Доступные на устройстве провайдеры (по фактическим ключам). */
export function directProviders(keys: DirectKeys): DirectProviderInfo[] {
  return [
    {
      id: 'google',
      name: 'Google (CSE)',
      requiresKey: true,
      available: Boolean(keys.googleCseKey && keys.googleCseCx),
      note: 'Свой ключ Google Custom Search',
    },
    {
      id: 'bing',
      name: 'Bing',
      requiresKey: true,
      available: Boolean(keys.bingKey),
      note: 'Свой ключ Bing Web Search',
    },
    { id: 'crossref', name: 'Crossref', requiresKey: false, available: true, note: 'Открытый индекс книг' },
    { id: 'openalex', name: 'OpenAlex', requiresKey: false, available: true, note: 'Открытый индекс изданий' },
    { id: 'openlibrary', name: 'Open Library', requiresKey: false, available: true, note: 'Открытый каталог' },
    { id: 'gutenberg', name: 'Gutenberg (IA)', requiresKey: false, available: true, note: 'Общественное достояние' },
  ];
}

/** Поиск через один провайдер прямо с устройства. */
export async function searchDirect(query: string, keys: DirectKeys, limit = 12): Promise<SearchHit[]> {
  const providers = directProviders(keys).filter((provider) => provider.available);
  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        switch (provider.id) {
          case 'google': {
            const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(keys.googleCseKey ?? '')}&cx=${encodeURIComponent(keys.googleCseCx ?? '')}&q=${encodeURIComponent(query)}&num=10&hl=ru`;
            const data = await fetchJson<{ items?: Array<{ link?: string; title?: string; snippet?: string }> }>(url);
            return (data.items ?? [])
              .map((item) => hit('google', item.link, item.title, item.snippet ?? ''))
              .filter((item): item is SearchHit => Boolean(item));
          }
          case 'bing': {
            const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=10&mkt=ru-RU`;
            const data = await fetchJson<{ webPages?: { value?: Array<{ url?: string; name?: string; snippet?: string }> } }>(
              url,
              { 'Ocp-Apim-Subscription-Key': keys.bingKey ?? '' },
            );
            return (data.webPages?.value ?? [])
              .map((item) => hit('bing', item.url, item.name, item.snippet ?? ''))
              .filter((item): item is SearchHit => Boolean(item));
          }
          case 'crossref': {
            const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&filter=type:book&rows=10&select=DOI,title,author,publisher,issued,URL,ISBN`;
            const data = await fetchJson<{ message?: { items?: Array<Record<string, unknown>> } }>(
              url,
              { 'User-Agent': 'PolkaBooks/1.4 (mailto:polka@example.com)' },
            );
            return (data.message?.items ?? [])
              .map((item) => {
                const authors = ((item.author as Array<{ given?: string; family?: string }>) ?? [])
                  .map((author) => [author.given, author.family].filter(Boolean).join(' '))
                  .filter(Boolean);
                const year = ((item.issued as { 'date-parts'?: number[][] })?.['date-parts']?.[0] ?? [])[0];
                const title = Array.isArray(item.title) ? String(item.title[0]) : String(item.title ?? '');
                return hit('crossref', String(item.URL ?? ''), title, [authors.join(', '), item.publisher, year].filter(Boolean).join(' · '), {
                  kind: 'metadata',
                });
              })
              .filter((item): item is SearchHit => Boolean(item));
          }
          case 'openalex': {
            const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&filter=type:book&per-page=10&select=id,title,publication_year,doi,primary_location`;
            const data = await fetchJson<{ results?: Array<Record<string, unknown>> }>(url);
            return (data.results ?? [])
              .map((item) => {
                const doi = typeof item.doi === 'string' ? item.doi : undefined;
                const source = (item.primary_location as { source?: { display_name?: string } })?.source?.display_name;
                return hit(
                  'openalex',
                  doi ?? (typeof item.id === 'string' ? item.id : undefined),
                  typeof item.title === 'string' ? item.title : '',
                  [source, item.publication_year].filter(Boolean).join(' · '),
                  { kind: 'metadata' },
                );
              })
              .filter((item): item is SearchHit => Boolean(item));
          }
          case 'openlibrary': {
            const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=10&fields=key,title,author_name,first_publish_year,cover_i,ia,ebook_access`;
            const data = await fetchJson<{ docs?: Array<Record<string, unknown>> }>(url);
            return (data.docs ?? [])
              .map((item) => {
                const ia = Array.isArray(item.ia) ? String(item.ia[0]) : undefined;
                const pageUrl = ia ? `https://archive.org/details/${encodeURIComponent(ia)}` : `https://openlibrary.org${String(item.key ?? '')}`;
                const cover = item.cover_i ? `https://covers.openlibrary.org/b/id/${item.cover_i}-L.jpg` : undefined;
                return hit(
                  'openlibrary',
                  pageUrl,
                  typeof item.title === 'string' ? item.title : '',
                  [
                    (item.author_name as string[] | undefined)?.slice(0, 2).join(', '),
                    item.first_publish_year,
                    item.ebook_access === 'public' ? 'открытый доступ' : '',
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  { coverUrl: cover, kind: 'library' },
                );
              })
              .filter((item): item is SearchHit => Boolean(item));
          }
          case 'gutenberg': {
            const params = new URLSearchParams({
              q: `collection:gutenberg AND mediatype:texts AND (${query})`,
              rows: '10',
              page: '1',
              output: 'json',
            });
            params.append('fl[]', 'identifier');
            params.append('fl[]', 'title');
            params.append('fl[]', 'creator');
            params.append('fl[]', 'year');
            const data = await fetchJson<{ response?: { docs?: Array<Record<string, unknown>> } }>(
              `https://archive.org/advancedsearch.php?${params.toString()}`,
            );
            return (data.response?.docs ?? [])
              .map((item) =>
                hit(
                  'gutenberg',
                  `https://archive.org/details/${encodeURIComponent(String(item.identifier ?? ''))}`,
                  typeof item.title === 'string' ? item.title : String(item.identifier ?? ''),
                  [item.creator, item.year].filter(Boolean).join(' · '),
                  { kind: 'library' },
                ),
              )
              .filter((item): item is SearchHit => Boolean(item));
          }
          default:
            return [];
        }
      } catch {
        return [];
      }
    }),
  );

  const seen = new Set<string>();
  const merged: SearchHit[] = [];
  for (const item of results.flat()) {
    const key = item.url.replace(/[#?].*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  const rank = (item: SearchHit) => (item.kind === 'library' ? 0 : item.kind === 'metadata' ? 2 : 1);
  return merged.sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

/** Загружает HTML страницы через локальный прокси приложения. */
export async function fetchPageHtml(url: string, timeout = 15_000): Promise<string | null> {
  const base = localBase();
  if (!base) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${base}/api/page?url=${encodeURIComponent(url)}`, {
      signal: controller.signal,
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') ?? '';
    if (!/html/i.test(contentType)) return null;
    return (await response.text()).slice(0, 3 * 1024 * 1024);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Анализ страницы на устройстве. */
export async function analyzePageLocal(url: string): Promise<PageAnalysis | null> {
  const html = await fetchPageHtml(url);
  if (!html) return null;
  try {
    return analyzeHtml(html, url);
  } catch {
    return null;
  }
}

/** Есть ли локальный прокси страниц (APK или свой сервер). */
let pageProxyReady: boolean | null = null;

export async function hasPageProxy(): Promise<boolean> {
  if (pageProxyReady !== null) return pageProxyReady;
  const base = localBase();
  if (!base) return false;
  try {
    const response = await fetch(`${base}/api/page?url=${encodeURIComponent('https://example.com')}`, {
      signal: AbortSignal.timeout(6000),
    });
    pageProxyReady = response.ok;
    return response.ok;
  } catch {
    return false;
  }
}
