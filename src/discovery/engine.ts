/**
 * InternetSearchEngine + SearchResultAggregator.
 *
 * Два режима:
 *  - «серверный» — агрегатор поисковых API на своём сервере (ключи Google/Bing/
 *    Яндекс/Brave хранятся на сервере);
 *  - «встроенный» — поиск прямо с телефона через провайдеры с открытым CORS
 *    (Google CSE и Bing со своим ключом, Crossref, OpenAlex, Open Library,
 *    Gutenberg). Страницы анализируются локально через прокси приложения.
 */
import { analyzePage, fetchProviders, probeFile, searchWeb } from './api';
import { analyzePageLocal, directProviders, hasPageProxy, type DirectKeys } from './direct';
import { searchOnDevice } from './searx';
import { localUrl } from './config';
import type { BookCandidate, BookFile, FileAccess, InternetSearchResult, ProviderStatus, SearchHit } from './types';

const ANALYZE_LIMIT = 6;
const FORMAT_PRIORITY = ['epub', 'fb2', 'pdf', 'txt', 'mobi', 'azw3', 'djvu'];

/** Жанры по словам в названии/описании — для фильтра найденных книг. */
const GENRE_RULES: Array<[string, RegExp]> = [
  ['Фэнтези', /фэнтези|фентези|fantasy|маги[яию]|дракон|ведьмак|эльф|волшеб/i],
  ['Фантастика', /фантастик|sci-?fi|космос|звездолёт|робот|антиутоп|постапокал/i],
  ['Детектив', /детектив|расследован|сыщик|убийств|преступлен|mystery|thriller/i],
  ['Роман', /роман\b|любовн|love story|romance|мелодрам/i],
  ['Классика', /классик|classics?|литературн.*наслед/i],
  ['Приключения', /приключен|путешеств|adventure/i],
  ['Ужасы', /ужас|хоррор|horror|мистик/i],
  ['Нон-фикшн', /нон-?фикшн|биограф|истори[яию]|наук[аи]|философ|психолог|non-?fiction/i],
  ['Поэзия', /поэзи|поэма|стихотвор|poetry|poems?/i],
  ['Детская', /детск|сказк|children|fairy tale/i],
];

function inferGenres(...parts: Array<string | undefined>): string[] {
  const text = parts.filter(Boolean).join(' ');
  return GENRE_RULES.filter(([, rule]) => rule.test(text)).map(([label]) => label).slice(0, 4);
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[«»"'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function candidateKey(title: string, authors: string[]): string {
  return `${normalize(title)}::${normalize(authors[0] ?? '')}`;
}

function pickFiles(files: Array<{ url: string; format: string; label?: string }>): BookFile[] {
  const seen = new Set<string>();
  const result: BookFile[] = [];
  for (const file of files) {
    const key = file.url.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ url: file.url, format: file.format, label: file.label, access: 'unavailable', message: 'Не проверено' });
  }
  return result.sort(
    (a, b) => (FORMAT_PRIORITY.indexOf(a.format) + 1 || 99) - (FORMAT_PRIORITY.indexOf(b.format) + 1 || 99),
  );
}

async function mapWithLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function hitsToAnalyze(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const interesting = hits.filter((hit) => {
    const key = hit.url.replace(/[#?].*$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const rank = (hit: SearchHit) => (hit.kind === 'library' ? 0 : hit.kind === 'metadata' ? 2 : 1);
  return interesting.slice().sort((a, b) => rank(a) - rank(b)).slice(0, ANALYZE_LIMIT);
}

function accessFromProbe(answer: { ok: boolean; reason?: string; message?: string }): { access: FileAccess; message: string } {
  if (answer.ok) return { access: 'ok', message: 'Файл доступен' };
  const reason = answer.reason ?? 'unavailable';
  const access: FileAccess =
    reason === 'requiresAuth' || reason === 'purchase' || reason === 'missing' || reason === 'blocked'
      ? (reason as FileAccess)
      : 'unavailable';
  return { access, message: answer.message ?? 'Скачивание недоступно' };
}

/** Проверка файла напрямую с устройства (когда сервера нет). */
async function probeFileDirect(url: string): Promise<{ ok: boolean; reason?: string; message?: string; sizeBytes?: number; format?: string; mime?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    // На Android используем встроенный локальный прокси для HEAD/Range:
    // многие книжные хосты не отдают CORS на файлах, но разрешают скачать.
    const local = localUrl(`/api/fetch?url=${encodeURIComponent(url)}`);
    let response = await fetch(local, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
    if (!response.ok || response.status === 405) {
      response = await fetch(local, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: controller.signal,
        redirect: 'follow',
      });
    }
    if (!response.ok && response.status !== 206) {
      const status = response.status;
      const reason = status === 401 || status === 403 ? 'requiresAuth' : status === 404 || status === 410 ? 'missing' : 'unavailable';
      return { ok: false, reason, message: `Источник ответил ${status}` };
    }
    const mime = response.headers.get('content-type') ?? '';
    if (/text\/html/i.test(mime)) {
      return { ok: false, reason: 'blocked', message: 'Сайт отдаёт страницу вместо файла' };
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    const extension = url.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
    return { ok: true, sizeBytes: length > 0 ? length : undefined, mime, format: extension };
  } catch {
    // CORS или сеть: проверка невозможна, но это не значит «файла нет».
    return {
      ok: false,
      reason: 'blocked',
      message: 'Сайт не разрешает автоматическую проверку — откройте страницу источника',
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface SearchOptions {
  signal?: AbortSignal;
  onProgress?: (stage: string, percent: number) => void;
  /** Свои ключи Google CSE / Bing (хранятся на устройстве). */
  keys?: DirectKeys;
  /** Принудительно встроенный режим (без сервера). */
  forceDirect?: boolean;
}

/**
 * Главная функция: поиск книг по всему интернету.
 */
export async function internetSearch(query: string, options: SearchOptions = {}): Promise<InternetSearchResult> {
  const started = Date.now();
  let searxInstances: Array<{ url: string; success: number; checkedAt: number }> = [];
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    return { query: '', books: [], providers: [], unavailable: [], errors: [], tookMs: 0, mode: 'direct' };
  }

  options.onProgress?.('Поиск в интернете…', 5);

  // --- выбор режима ---
  let mode: 'server' | 'direct' = 'direct';
  let providers: ProviderStatus[] = [];
  if (!options.forceDirect) {
    const status = await fetchProviders({ signal: options.signal });
    if (status.online && status.providers.length > 0) {
      mode = 'server';
      providers = status.providers;
    }
  }

  let hits: SearchHit[] = [];
  let errors: Array<{ engine: string; message: string }> = [];
  let unavailable: ProviderStatus[] = [];

  if (mode === 'server') {
    const answer = await searchWeb(cleanQuery, { signal: options.signal, limit: 12 });
    hits = answer.results;
    errors = answer.errors;
    unavailable = providers.filter((provider) => !provider.available);
  } else {
    const keys = options.keys ?? {};
    const localProviders = directProviders(keys);
    providers = localProviders.map((provider) => ({
      id: provider.id,
      name: provider.name,
      requiresKey: provider.requiresKey,
      note: provider.note,
      available: provider.available,
    }));
    unavailable = providers.filter((provider) => !provider.available);
    const deviceAnswer = await searchOnDevice(cleanQuery, keys, { signal: options.signal, limit: 12 });
    searxInstances = deviceAnswer.instances;
    hits = deviceAnswer.hits;
    errors = deviceAnswer.errors.map((message) => ({ engine: 'searxng', message }));
    if (hits.length === 0) {
      errors.push({ engine: 'direct', message: 'Провайдеры не вернули результатов' });
    }
  }

  const pageAnalysisAvailable = mode === 'server' ? true : await hasPageProxy();

  options.onProgress?.('Анализируем найденные страницы…', 25);
  const targets = hitsToAnalyze(hits);
  const analyzed = await mapWithLimit(targets, 3, async (hit) => {
    if (mode === 'server') {
      try {
        const page = await analyzePage(hit.url, { signal: options.signal });
        return { hit, page };
      } catch {
        return { hit, page: { ok: false as const } };
      }
    }
    if (!pageAnalysisAvailable) return { hit, page: { ok: false as const } };
    const local = await analyzePageLocal(hit.url);
    if (!local) return { hit, page: { ok: false as const } };
    return {
      hit,
      page: {
        ok: true as const,
        title: local.title,
        authors: local.authors,
        description: local.description,
        coverUrl: local.coverUrl,
        language: local.language,
        year: local.year,
        isbn: local.isbn,
        files: local.files,
        isBook: local.isBook,
        bookScore: local.bookScore,
      },
    };
  });

  options.onProgress?.('Собираем книги и файлы…', 55);
  const candidates: BookCandidate[] = [];
  for (const { hit, page } of analyzed) {
    if (!page.ok) {
      candidates.push({
        id: hit.url,
        title: hit.title || hit.url,
        authors: [],
        description: hit.snippet,
        coverUrl: hit.coverUrl,
        pageUrl: hit.url,
        engine: hit.engine,
        files: [],
        downloadable: false,
        reason: pageAnalysisAvailable
          ? 'Страница не открылась'
          : 'Страницу нельзя проанализировать на этом устройстве — откройте источник',
        confidence: 0.2,
      });
      continue;
    }
    const files = pickFiles(page.files ?? []);
    const title = page.title?.trim() || hit.title || '';
    const authors = page.authors?.length ? page.authors : [];
    const hasBookData = Boolean(page.isBook || files.length > 0 || page.isbn);
    if (!hasBookData) {
      candidates.push({
        id: hit.url,
        title: title || hit.url,
        authors,
        description: page.description || hit.snippet,
        coverUrl: page.coverUrl ?? hit.coverUrl,
        language: page.language,
        year: page.year,
        isbn: page.isbn,
        pageUrl: hit.url,
        engine: hit.engine,
        files,
        downloadable: false,
        reason: 'На странице не найден файл книги',
        confidence: 0.25,
      });
      continue;
    }
    const confidence = Math.min(
      1,
      0.35 +
        (files.length > 0 ? 0.3 : 0) +
        (authors.length > 0 ? 0.15 : 0) +
        (page.isbn ? 0.1 : 0) +
        (page.year ? 0.05 : 0) +
        Math.min(0.1, (page.bookScore ?? 0) / 20),
    );
    candidates.push({
      id: hit.url,
      title: title || hit.title,
      authors,
      description: page.description || hit.snippet,
      coverUrl: page.coverUrl ?? hit.coverUrl,
      language: page.language,
      year: page.year,
      isbn: page.isbn,
      pageUrl: hit.url,
      engine: hit.engine,
      files,
      downloadable: files.length > 0,
      reason: files.length === 0 ? 'Файл для скачивания не найден' : undefined,
      confidence,
    });
  }

  // ---- агрегация дубликатов ----
  const merged: BookCandidate[] = [];
  const byUrl = new Map<string, BookCandidate>();
  const byKey = new Map<string, BookCandidate>();
  for (const candidate of candidates) {
    const urlKey = candidate.pageUrl.replace(/[#?].*$/, '');
    const existing =
      byUrl.get(urlKey) ??
      (candidate.isbn ? merged.find((item) => item.isbn && item.isbn === candidate.isbn) : undefined) ??
      byKey.get(candidateKey(candidate.title, candidate.authors));
    if (existing) {
      const files = pickFiles([...existing.files, ...candidate.files]);
      existing.files = files;
      existing.downloadable = files.length > 0;
      existing.description = existing.description || candidate.description;
      existing.coverUrl = existing.coverUrl ?? candidate.coverUrl;
      existing.authors = existing.authors.length > 0 ? existing.authors : candidate.authors;
      existing.language = existing.language ?? candidate.language;
      existing.year = existing.year ?? candidate.year;
      existing.isbn = existing.isbn ?? candidate.isbn;
      continue;
    }
    merged.push(candidate);
    byUrl.set(urlKey, candidate);
    if (candidate.authors.length > 0) byKey.set(candidateKey(candidate.title, candidate.authors), candidate);
  }

  // ---- проверка ссылок на файлы ----
  for (const candidate of merged) {
    candidate.genres = inferGenres(candidate.title, candidate.description, candidate.authors.join(' '));
  }

  const probeTargets: Array<{ file: BookFile }> = [];
  for (const candidate of merged) {
    for (const file of candidate.files.slice(0, 2)) {
      if (probeTargets.length >= 10) break;
      probeTargets.push({ file });
    }
    if (probeTargets.length >= 10) break;
  }
  options.onProgress?.('Проверяем файлы…', 75);
  await mapWithLimit(probeTargets, 4, async ({ file }) => {
    try {
      const answer = mode === 'server' ? await probeFile(file.url, { signal: options.signal }) : await probeFileDirect(file.url);
      const status = accessFromProbe(answer);
      file.access = status.access;
      file.message = status.message;
      file.sizeBytes = answer.sizeBytes;
      file.mime = answer.mime;
      if (!file.format && answer.format) file.format = answer.format;
    } catch {
      file.access = 'unavailable';
      file.message = 'Не удалось проверить файл';
    }
  });

  for (const candidate of merged) {
    candidate.files = candidate.files
      .sort(
        (a, b) =>
          (a.access === 'ok' ? 0 : 1) - (b.access === 'ok' ? 0 : 1) ||
          (FORMAT_PRIORITY.indexOf(a.format) + 1 || 99) - (FORMAT_PRIORITY.indexOf(b.format) + 1 || 99),
      );
    candidate.downloadable = candidate.files.some((file) => file.access === 'ok');
    if (candidate.files.length > 0 && !candidate.downloadable) {
      candidate.reason = candidate.files[0].message;
    }
  }

  merged.sort(
    (a, b) =>
      Number(b.downloadable) - Number(a.downloadable) ||
      b.confidence - a.confidence ||
      Number(Boolean(b.coverUrl)) - Number(Boolean(a.coverUrl)),
  );

  options.onProgress?.('Готово', 100);
  return {
    query: cleanQuery,
    books: merged,
    providers,
    unavailable,
    errors,
    tookMs: Date.now() - started,
    mode,
    pageAnalysis: pageAnalysisAvailable,
    searxInstances,
  };
}
