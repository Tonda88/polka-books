/**
 * Поисковые провайдеры для интернет-поиска книг.
 *
 * Используются только официальные API. Парсинг выдачи Google/Яндекса
 * не выполняется. Провайдеры включаются автоматически, если на сервере
 * заданы ключи (переменные окружения), поэтому секреты не попадают в APK.
 *
 * Без ключей всегда доступен Marginalia (официальный публичный API).
 */
const FETCH_TIMEOUT = 20_000;
const MAX_RESULTS = 20;

function withTimeout(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
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
  const response = await fetch(url, {
    signal: withTimeout(options.timeout ?? FETCH_TIMEOUT),
    headers: {
      Accept: 'application/json',
      'User-Agent': 'PolkaBooks/1.4 (+https://github.com/Tonda88/polka-books)',
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Провайдеры
// ---------------------------------------------------------------------------

const marginalia = {
  id: 'marginalia',
  name: 'Marginalia',
  requiresKey: false,
  note: 'Официальный открытый поисковый API (индекс независимого веба)',
  available: () => true,
  async search(query, limit) {
    const count = Math.min(limit ?? MAX_RESULTS, MAX_RESULTS);
    const url = `https://api.marginalia.nu/public/search/${encodeURIComponent(query)}?count=${count}`;
    const data = await fetchJson(url, { timeout: 8000 });
    return (data.results ?? []).map((item) => normalizeResult('marginalia', item)).filter(Boolean);
  },
};

const google = {
  id: 'google',
  name: 'Google (Custom Search)',
  requiresKey: true,
  note: 'Официальный Google Custom Search JSON API',
  available: () => Boolean(process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX),
  async search(query, limit) {
    const key = process.env.GOOGLE_CSE_KEY;
    const cx = process.env.GOOGLE_CSE_CX;
    const num = Math.min(limit ?? 10, 10);
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=${num}&hl=ru`;
    const data = await fetchJson(url);
    return (data.items ?? []).map((item) => normalizeResult('google', item)).filter(Boolean);
  },
};

const bing = {
  id: 'bing',
  name: 'Bing',
  requiresKey: true,
  note: 'Официальный Bing Web Search API (Azure)',
  available: () => Boolean(process.env.BING_SEARCH_KEY),
  async search(query, limit) {
    const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${Math.min(limit ?? 10, 20)}&mkt=ru-RU`;
    const data = await fetchJson(url, { headers: { 'Ocp-Apim-Subscription-Key': process.env.BING_SEARCH_KEY } });
    return (data.webPages?.value ?? []).map((item) => normalizeResult('bing', item)).filter(Boolean);
  },
};

const brave = {
  id: 'brave',
  name: 'Brave Search',
  requiresKey: true,
  note: 'Официальный Brave Search API',
  available: () => Boolean(process.env.BRAVE_SEARCH_KEY),
  async search(query, limit) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(limit ?? 10, 20)}&country=ru`;
    const data = await fetchJson(url, {
      headers: { 'X-Subscription-Token': process.env.BRAVE_SEARCH_KEY, Accept: 'application/json' },
    });
    return (data.web?.results ?? []).map((item) => normalizeResult('brave', item)).filter(Boolean);
  },
};

const yandex = {
  id: 'yandex',
  name: 'Яндекс',
  requiresKey: true,
  note: 'Официальный Яндекс XML API поиска',
  available: () => Boolean(process.env.YANDEX_XML_USER && process.env.YANDEX_XML_KEY),
  async search(query, limit) {
    const params = new URLSearchParams({
      user: process.env.YANDEX_XML_USER,
      key: process.env.YANDEX_XML_KEY,
      query,
      lr: process.env.YANDEX_XML_LR ?? '213',
      sortby: 'rlv',
      filter: 'none',
      maxpassages: '2',
      groupby: 'attr=d.mode=deep.groups-on-page=10.docs-in-group=1',
      page: '0',
    });
    const response = await fetch(`https://yandex.ru/search/xml?${params.toString()}`, {
      signal: withTimeout(FETCH_TIMEOUT),
      headers: { 'User-Agent': 'PolkaBooks/1.4' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    const results = [];
    const docRegex = /<doc>([\s\S]*?)<\/doc>/g;
    let match;
    while ((match = docRegex.exec(xml)) !== null) {
      const block = match[1];
      const url = /<url>([\s\S]*?)<\/url>/.exec(block)?.[1] ?? '';
      const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? '';
      const passages = [...block.matchAll(/<passage>([\s\S]*?)<\/passage>/g)].map((item) => clean(item[1])).join(' ');
      const normalized = normalizeResult('yandex', { url, title, snippet: passages });
      if (normalized) results.push(normalized);
    }
    return results.slice(0, limit ?? MAX_RESULTS);
  },
};

const searx = {
  id: 'searx',
  name: 'SearXNG (свой инстанс)',
  requiresKey: false,
  note: 'Собственный инстанс SearXNG с включённым JSON API',
  available: () => Boolean(process.env.SEARX_URL),
  async search(query, limit) {
    const base = process.env.SEARX_URL.replace(/\/+$/, '');
    const data = await fetchJson(`${base}/search?q=${encodeURIComponent(query)}&format=json&language=ru`);
    return (data.results ?? [])
      .map((item) => normalizeResult('searx', item))
      .filter(Boolean)
      .slice(0, limit ?? MAX_RESULTS);
  },
};


const librivox = {
  id: 'librivox',
  name: 'LibriVox',
  requiresKey: false,
  note: 'Бесплатные аудиокниги — официальный JSON API, без ключа',
  available: () => true,
  async search(query, limit) {
    // Пробуем по названию, потом по автору если пусто.
    async function fetch_lv(params) {
      const url = `https://librivox.org/api/feed/audiobooks?${params}&format=json&limit=${Math.min(limit ?? 10, 20)}`;
      const data = await fetchJson(url, { timeout: 12_000 });
      return data.books ?? [];
    }
    let books = await fetch_lv(`title=${encodeURIComponent(query)}`);
    if (books.length === 0) books = await fetch_lv(`author=${encodeURIComponent(query)}`);
    return books.map((item) => {
      const authors = Array.isArray(item.authors)
        ? item.authors.map((a) => [a.first_name, a.last_name].filter(Boolean).join(' ')).join(', ')
        : '';
      return normalizeResult('librivox', {
        url: item.url_librivox ?? `https://librivox.org/${item.id ?? ''}`,
        title: item.title ?? '',
        snippet: [authors, item.language, item.num_sections ? `${item.num_sections} глав` : ''].filter(Boolean).join(' · '),
      });
    }).filter(Boolean);
  },
};


  id: 'crossref',
  name: 'Crossref',
  requiresKey: false,
  note: 'Официальный открытый API метаданных книг (DOI) — без ключа',
  available: () => true,
  async search(query, limit) {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&filter=type:book&rows=${Math.min(limit ?? 10, 20)}&select=DOI,title,author,publisher,issued,URL,ISBN,type`;
    const response = await fetch(url, {
      signal: withTimeout(20_000),
      headers: { 'User-Agent': 'PolkaBooks/1.4 (mailto:polka@example.com)', Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return (data.message?.items ?? []).map((item) => {
      const authors = (item.author ?? [])
        .map((author) => [author.given, author.family].filter(Boolean).join(' '))
        .filter(Boolean);
      const year = item.issued?.['date-parts']?.[0]?.[0];
      const result = normalizeResult('crossref', {
        url: item.URL ?? (item.DOI ? `https://doi.org/${item.DOI}` : ''),
        title: Array.isArray(item.title) ? item.title[0] : item.title,
        snippet: [authors.join(', '), item.publisher, year ? String(year) : ''].filter(Boolean).join(' · '),
      });
      if (!result) return null;
      return { ...result, isbn: Array.isArray(item.ISBN) ? item.ISBN[0] : item.ISBN, kind: 'metadata' };
    }).filter(Boolean);
  },
};

const openalex = {
  id: 'openalex',
  name: 'OpenAlex',
  requiresKey: false,
  note: 'Официальный открытый индекс книг и научных изданий — без ключа',
  available: () => true,
  async search(query, limit) {
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&filter=type:book&per-page=${Math.min(limit ?? 10, 25)}&select=id,title,publication_year,doi,primary_location,biblio`;
    const data = await fetchJson(url, { timeout: 20_000 });
    return (data.results ?? []).map((item) => {
      const source = item.primary_location?.source?.display_name;
      const result = normalizeResult('openalex', {
        url: item.doi ? `https://doi.org/${item.doi.replace(/^https?:\/\/doi.org\//, '')}` : item.id,
        title: item.title,
        snippet: [source, item.publication_year ? String(item.publication_year) : ''].filter(Boolean).join(' · '),
      });
      if (!result) return null;
      return { ...result, kind: 'metadata' };
    }).filter(Boolean);
  },
};


const openlibrary = {
  id: 'openlibrary',
  name: 'Open Library',
  requiresKey: false,
  note: 'Открытый каталог книг: метаданные и ссылки на разрешённые файлы',
  available: () => true,
  async search(query, limit) {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${Math.min(limit ?? 10, 20)}&fields=key,title,author_name,first_publish_year,language,cover_i,ia,ebook_access,subject`;
    const data = await fetchJson(url, { timeout: 12_000 });
    return (data.docs ?? []).map((item) => {
      const cover = item.cover_i ? `https://covers.openlibrary.org/b/id/${item.cover_i}-L.jpg` : undefined;
      const ia = Array.isArray(item.ia) ? item.ia[0] : undefined;
      const pageUrl = ia
        ? `https://archive.org/details/${encodeURIComponent(ia)}`
        : `https://openlibrary.org${item.key ?? ''}`;
      const result = normalizeResult('openlibrary', {
        url: pageUrl,
        title: item.title,
        snippet: [
          (item.author_name ?? []).slice(0, 2).join(', '),
          item.first_publish_year ? String(item.first_publish_year) : '',
          item.ebook_access === 'public' ? 'открытый доступ' : '',
        ].filter(Boolean).join(' · '),
      });
      if (!result) return null;
      return { ...result, coverUrl: cover, kind: 'library', access: item.ebook_access };
    }).filter(Boolean);
  },
};

const gutenberg = {
  id: 'gutenberg',
  name: 'Project Gutenberg (зеркало IA)',
  requiresKey: false,
  note: 'Общественное достояние: официальная коллекция Gutenberg в Internet Archive',
  available: () => true,
  async search(query, limit) {
    const params = new URLSearchParams({
      q: `collection:gutenberg AND mediatype:texts AND (${query})`,
      rows: String(Math.min(limit ?? 10, 20)),
      page: '1',
      output: 'json',
    });
    params.append('fl[]', 'identifier');
    params.append('fl[]', 'title');
    params.append('fl[]', 'creator');
    params.append('fl[]', 'year');
    params.append('fl[]', 'language');
    const data = await fetchJson(`https://archive.org/advancedsearch.php?${params.toString()}`, { timeout: 12_000 });
    return (data.response?.docs ?? []).map((item) => {
      const result = normalizeResult('gutenberg', {
        url: `https://archive.org/details/${encodeURIComponent(item.identifier)}`,
        title: item.title ?? item.identifier,
        snippet: [item.creator, item.year ? String(item.year) : '', item.language ? String(item.language) : '']
          .filter(Boolean)
          .join(' · '),
      });
      if (!result) return null;
      return { ...result, kind: 'library' };
    }).filter(Boolean);
  },
};

export const PROVIDERS = { marginalia, crossref, openalex, openlibrary, gutenberg, librivox, google, bing, brave, yandex, searx };

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
  // Книжные домены и явные файлы чуть важнее.
  if (/\.(epub|fb2|pdf|txt|mobi|azw3)(\?|$)/i.test(result.url)) score += 2;
  if (/\.(mp3|m4a|ogg|aac|opus)(\?|$)/i.test(result.url)) score += 1.5;
  if (/(standardebooks|gutenberg|archive\.org|litres|flibusta|royallib|bookz|knijky|lib\.ru|wikisource|librivox\.org)/i.test(result.url)) {
    score += 1.5;
  }
  // Открытые библиотеки с разрешёнными файлами — выше чисто метаданных.
  if (result.kind === 'library') score += 2;
  if (result.kind === 'metadata') score -= 0.5;
  return score;
}

/**
 * Поиск по всем доступным провайдерам с объединением и удалением дублей.
 */
export async function searchWeb(query, options = {}) {
  const cleanQuery = String(query ?? '').trim();
  if (!cleanQuery) return { query: cleanQuery, results: [], errors: [], engines: [] };

  const requested = Array.isArray(options.engines) && options.engines.length > 0
    ? options.engines
    : Object.keys(PROVIDERS);
  const engines = requested
    .map((id) => PROVIDERS[id])
    .filter((provider) => provider && provider.available());

  const errors = [];
  const started = Date.now();
  // Общий бюджет поиска: медленный провайдер не должен задерживать выдачу.
  const budgetMs = options.budgetMs ?? 12_000;
  const settled = await Promise.all(
    engines.map(async (provider) => {
      try {
        const results = await Promise.race([
          provider.search(cleanQuery, options.limit ?? MAX_RESULTS),
          new Promise((resolve) => setTimeout(() => resolve([{ __timeout: true, engine: provider.id }]), budgetMs)),
        ]);
        if (results.length === 1 && results[0]?.__timeout) {
          errors.push({ engine: provider.id, name: provider.name, message: 'Не ответил вовремя' });
          return [];
        }
        return results;
      } catch (error) {
        errors.push({ engine: provider.id, name: provider.name, message: error instanceof Error ? error.message : 'Ошибка' });
        return [];
      }
    }),
  );

  const seen = new Set();
  const merged = [];
  for (const item of settled.flat()) {
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
    engines: engines.map((provider) => provider.id),
    tookMs: Date.now() - started,
  };
}
