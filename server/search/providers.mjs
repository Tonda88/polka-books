/**
 * Поисковые провайдеры для интернет-поиска книг — v1.6.1.
 *
 * Основной: Яндекс Search API (Yandex Cloud Search API v2).
 *   Endpoint: POST https://searchapi.api.cloud.yandex.net/v2/web/search
 *   Auth:     Authorization: Api-Key <YANDEX_API_KEY>
 *   Body:     { query: { query_text: "...", search_type: 1 } }
 *   search_type: 1 = SEARCH_TYPE_WEB (русскоязычная выдача), 2 = SEARCH_TYPE_RU
 *
 * Резервный: SearXNG (свой инстанс через SEARX_URL) или публичные узлы на клиенте.
 *
 * Старые каталоги (Open Library, Crossref, OpenAlex, Gutenberg, LibriVox)
 * в основном поиске НЕ участвуют — они остаются только в /catalogs и импорте.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Минимальная загрузка .env без внешних зависимостей.
try {
  const here = dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(resolve(here, '..', '.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
} catch { /* .env необязателен */ }

const FETCH_TIMEOUT = 20_000;
const MAX_RESULTS = 20;
const YANDEX_ENDPOINT = 'https://searchapi.api.cloud.yandex.net/v2/web/search';
const yandexConfig = () => ({
  key: process.env.YANDEX_API_KEY?.trim() ?? '',
  folderId: process.env.YANDEX_FOLDER_ID?.trim() ?? '',
});

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

function clean(text) {
  return String(text ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeResult(engine, item) {
  const url = item.url ?? item.link ?? '';
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return {
    engine,
    url,
    title: clean(item.title ?? item.name ?? ''),
    snippet: clean(item.snippet ?? item.description ?? item.abstract ?? ''),
  };
}

async function fetchJson(url, options = {}) {
  const timed = timeoutSignal(options.timeout ?? FETCH_TIMEOUT);
  try {
    const response = await fetch(url, {
      signal: timed.signal,
      method: options.method ?? 'GET',
      body: options.body,
      headers: {
      Accept: 'application/json',
      'User-Agent': 'PolkaBooks/1.6 (+https://github.com/Tonda88/polka-books)',
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    let detail = '';
    try {
      const parsed = await response.json();
      detail = parsed?.message ?? parsed?.error?.message ?? '';
    } catch { /* не JSON */ }
    throw new Error(detail ? `HTTP ${response.status}: ${detail.slice(0, 200)}` : `HTTP ${response.status}`);
  }
    return response.json();
  } finally {
    timed.cancel();
  }
}

// ---------------------------------------------------------------------------
// ПРОВАЙДЕРЫ
// ---------------------------------------------------------------------------

/** 1. Яндекс Search API — ОСНОВНОЙ поисковик. */
const yandex = {
  id: 'yandex',
  name: 'Яндекс',
  requiresKey: true,
  note: 'Яндекс Search API (Yandex Cloud) — основной поисковик',
  available: () => {
    const config = yandexConfig();
    return Boolean(config.key && config.folderId);
  },
  async search(query, limit) {
    const config = yandexConfig();
    if (!config.key || !config.folderId) {
      throw new Error('Не заданы YANDEX_API_KEY и YANDEX_FOLDER_ID');
    }
    const body = {
      query: {
        queryText: String(query).slice(0, 400),
        searchType: 'SEARCH_TYPE_RU',
      },
      folderId: config.folderId,
    };
    // Пагинация: Яндекс отдаёт максимум 250 документов, берём первые страницы.
    const data = await fetchJson(YANDEX_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      timeout: 15_000,
    });
    // Структура ответа: { rawData: base64(XML) } либо { documents: [...] }
    const payload = data.result ?? data;
    const docs = payload.documents ?? payload.results ?? payload.items ?? [];
    const mapped = docs.map((item) => {
      const url = item.url ?? item.link;
      const title = item.title ?? item.name;
      const snippet = item.snippet ?? item.description ?? '';
      return normalizeResult('yandex', { url, title, snippet });
    }).filter(Boolean);
    if (mapped.length) return mapped.slice(0, limit ?? MAX_RESULTS);

    // Некоторые конфигурации отдают XML в base64 (rawData).
    if (typeof payload.rawData === 'string' && payload.rawData.length > 0) {
      const xml = Buffer.from(payload.rawData, 'base64').toString('utf8');
      const results = [];
      const docRe = /<doc>([\s\S]*?)<\/doc>/g;
      let m;
      while ((m = docRe.exec(xml)) !== null) {
        const block = m[1];
        const url = /<url>([\s\S]*?)<\/url>/.exec(block)?.[1] ?? '';
        const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? '';
        const passages = [...block.matchAll(/<passage>([\s\S]*?)<\/passage>/g)].map((p) => p[1]).join(' ');
        const r = normalizeResult('yandex', { url, title, snippet: passages });
        if (r) results.push(r);
      }
      return results.slice(0, limit ?? MAX_RESULTS);
    }
    return [];
  },
};

/** 2. SearXNG — РЕЗЕРВНЫЙ (только свой инстанс). Публичные узлы отключили JSON. */
const searx = {
  id: 'searx',
  name: 'SearXNG (резерв)',
  requiresKey: false,
  note: 'Свой инстанс SearXNG (SEARX_URL) — публичные узлы не отдают JSON',
  available: () => Boolean(process.env.SEARX_URL),
  async search(query, limit) {
    const base = process.env.SEARX_URL.replace(/\/+$/, '');
    const data = await fetchJson(`${base}/search?q=${encodeURIComponent(query)}&format=json&language=ru`, { timeout: 15_000 });
    return (data.results ?? []).map((item) => normalizeResult('searx', item)).filter(Boolean).slice(0, limit ?? MAX_RESULTS);
  },
};

export const PROVIDERS = { yandex, searx };

export function providerStatus() {
  return Object.values(PROVIDERS).map((provider) => ({
    id: provider.id,
    name: provider.name,
    requiresKey: provider.requiresKey,
    note: provider.note,
    available: provider.available(),
  }));
}

function relevance(query, result) {
  const tokens = query.toLowerCase().split(/\s+/).filter((token) => token.length > 2);
  const haystack = `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
  let score = 0;
  for (const token of tokens) if (haystack.includes(token)) score += 1;
  if (/\.(epub|fb2|pdf|txt|mobi|azw3)(\?|$)/i.test(result.url)) score += 2;
  if (/\.(mp3|m4a|ogg|aac|opus)(\?|$)/i.test(result.url)) score += 1.5;
  if (/(archive\.org|librivox\.org|standardebooks|gutenberg|flibusta|royallib|bookz|knijky|lib\.ru|wikisource)/i.test(result.url)) {
    score += 1.5;
  }
  return score;
}

/**
 * Поиск: Яндекс (основной) → SearXNG (резерв при недоступности/пустоте).
 */
export async function searchWeb(query, options = {}) {
  const cleanQuery = String(query ?? '').trim();
  if (!cleanQuery) return { query: cleanQuery, results: [], errors: [], engines: [] };

  const errors = [];
  const started = Date.now();
  const budgetMs = options.budgetMs ?? 15_000;

  let allResults = [];

  // --- 1. Яндекс ---
  if (PROVIDERS.yandex.available()) {
    try {
      const results = await Promise.race([
        PROVIDERS.yandex.search(cleanQuery, options.limit ?? MAX_RESULTS),
        new Promise((resolve) => setTimeout(() => resolve([{ __timeout: true }]), budgetMs)),
      ]);
      if (results.length === 1 && results[0]?.__timeout) {
        errors.push({ engine: 'yandex', name: 'Яндекс', message: 'Не ответил вовремя' });
      } else {
        allResults = results;
      }
    } catch (error) {
      errors.push({ engine: 'yandex', name: 'Яндекс', message: error instanceof Error ? error.message : 'Ошибка' });
    }
  } else {
    errors.push({ engine: 'yandex', name: 'Яндекс', message: 'На сервере не заданы YANDEX_API_KEY и YANDEX_FOLDER_ID' });
  }

  // --- 2. SearXNG, только если Яндекс не дал результатов ---
  if (allResults.length === 0) {
    if (PROVIDERS.searx.available()) {
      try {
        const results = await Promise.race([
          PROVIDERS.searx.search(cleanQuery, options.limit ?? MAX_RESULTS),
          new Promise((resolve) => setTimeout(() => resolve([{ __timeout: true }]), budgetMs)),
        ]);
        if (!(results.length === 1 && results[0]?.__timeout)) {
          allResults = results;
        } else {
          errors.push({ engine: 'searx', name: 'SearXNG', message: 'Не ответил вовремя' });
        }
      } catch (error) {
        errors.push({ engine: 'searx', name: 'SearXNG', message: error instanceof Error ? error.message : 'Ошибка' });
      }
    }
  }

  const seen = new Set();
  const merged = [];
  for (const item of allResults) {
    const key = item.url.replace(/[#?].*$/, '').replace(/^https?:\/\/www\./, 'https://');
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...item, score: relevance(cleanQuery, item) });
  }
  merged.sort((a, b) => b.score - a.score);

  return {
    query: cleanQuery,
    results: merged.slice(0, options.limit ?? MAX_RESULTS),
    errors,
    engines: Object.keys(PROVIDERS).filter((id) => PROVIDERS[id].available()),
    tookMs: Date.now() - started,
  };
}
