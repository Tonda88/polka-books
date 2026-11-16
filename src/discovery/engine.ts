/**
 * InternetSearchEngine + SearchResultAggregator + BookPageAnalyzer (клиент).
 *
 * Ввод: строка поиска. Шаги:
 *  1. серверный агрегатор находит страницы через поисковые API;
 *  2. страницы анализируются, из них извлекаются книги и файлы;
 *  3. одинаковые результаты сливаются;
 *  4. каждый файл проверяется — можно ли его скачать (и если нет, почему).
 */
import { analyzePage, fetchProviders, probeFile, searchWeb } from './api';
import type {
  BookCandidate,
  BookFile,
  FileAccess,
  InternetSearchResult,
  ProviderStatus,
  SearchHit,
} from './types';

const ANALYZE_LIMIT = 6;
const FORMAT_PRIORITY = ['epub', 'fb2', 'pdf', 'txt', 'mobi', 'azw3', 'djvu'];

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
    result.push({
      url: file.url,
      format: file.format,
      label: file.label,
      access: 'unavailable',
      message: 'Не проверено',
    });
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
  // Открытые библиотеки анализируем в первую очередь, затем обычные страницы.
  return interesting
    .slice()
    .sort((a, b) => {
      const rank = (hit: SearchHit) => (hit.kind === 'library' ? 0 : hit.kind === 'metadata' ? 2 : 1);
      return rank(a) - rank(b);
    })
    .slice(0, ANALYZE_LIMIT);
}

function accessFromProbe(answer: { ok: boolean; reason?: string; status?: number; message?: string }): {
  access: FileAccess;
  message: string;
} {
  if (answer.ok) return { access: 'ok', message: 'Файл доступен' };
  const reason = answer.reason ?? 'unavailable';
  const access: FileAccess =
    reason === 'requiresAuth' || reason === 'purchase' || reason === 'missing' || reason === 'blocked'
      ? (reason as FileAccess)
      : 'unavailable';
  return { access, message: answer.message ?? 'Скачивание недоступно' };
}

/**
 * Главная функция: поиск книг по всему интернету.
 */
export async function internetSearch(
  query: string,
  options: { signal?: AbortSignal; onProgress?: (stage: string, percent: number) => void } = {},
): Promise<InternetSearchResult> {
  const started = Date.now();
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    return { query: '', books: [], providers: [], unavailable: [], errors: [], tookMs: 0 };
  }

  options.onProgress?.('Поиск в интернете…', 5);
  const [{ providers, online }, answer] = await Promise.all([
    fetchProviders({ signal: options.signal }),
    searchWeb(cleanQuery, { signal: options.signal, limit: 12 }),
  ]);
  if (!online) {
    return {
      query: cleanQuery,
      books: [],
      providers: [],
      unavailable: [],
      errors: [{ engine: 'server', message: 'Сервер интернет-поиска недоступен' }],
      tookMs: Date.now() - started,
    };
  }

  options.onProgress?.('Анализируем найденные страницы…', 25);
  const targets = hitsToAnalyze(answer.results);
  const analyzed = await mapWithLimit(targets, 3, async (hit) => {
    try {
      const page = await analyzePage(hit.url, { signal: options.signal });
      return { hit, page };
    } catch {
      return { hit, page: { ok: false } };
    }
  });

  options.onProgress?.('Собираем книги и файлы…', 55);
  const candidates: BookCandidate[] = [];
  for (const { hit, page } of analyzed) {
    if (!page.ok) {
      // Страница не открылась — показываем как результат без файлов.
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
        reason: page.error ?? 'Страница не открылась',
        confidence: 0.2,
      });
      continue;
    }
    const files = pickFiles(page.files ?? []);
    const title = page.title?.trim() || hit.title || '';
    const authors = page.authors?.length ? page.authors : [];
    const hasBookData = Boolean(page.isBook || files.length > 0 || isbnOf(page));
    if (!hasBookData) {
      candidates.push({
        id: hit.url,
        title: title || hit.url,
        authors,
        description: page.description || hit.snippet,
        coverUrl: page.coverUrl ?? hit.coverUrl,
        language: page.language,
        year: page.year,
        isbn: isbnOf(page),
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

  // ---- агрегация дубликатов: страница, ISBN, название+автор ----
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

  // ---- проверяем ссылки на файлы, чтобы не показывать фиктивную кнопку ----
  const probeTargets: Array<{ candidate: BookCandidate; file: BookFile }> = [];
  for (const candidate of merged) {
    for (const file of candidate.files.slice(0, 3)) {
      probeTargets.push({ candidate, file });
    }
  }
  options.onProgress?.('Проверяем файлы…', 75);
  await mapWithLimit(probeTargets, 4, async ({ file }) => {
    try {
      const answer = await probeFile(file.url, { signal: options.signal });
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
      .filter((file) => file.access !== 'invalid')
      .sort(
        (a, b) =>
          (a.access === 'ok' ? 0 : 1) - (b.access === 'ok' ? 0 : 1) ||
          (FORMAT_PRIORITY.indexOf(a.format) + 1 || 99) - (FORMAT_PRIORITY.indexOf(b.format) + 1 || 99),
      );
    candidate.downloadable = candidate.files.some((file) => file.access === 'ok');
    if (candidate.files.length > 0 && !candidate.downloadable) {
      const first = candidate.files[0];
      candidate.reason = first.message;
    }
  }

  merged.sort(
    (a, b) =>
      Number(b.downloadable) - Number(a.downloadable) ||
      b.confidence - a.confidence ||
      Number(Boolean(b.coverUrl)) - Number(Boolean(a.coverUrl)),
  );

  options.onProgress?.('Готово', 100);
  const unavailable: ProviderStatus[] = providers.filter((provider) => !provider.available);
  return {
    query: cleanQuery,
    books: merged,
    providers,
    unavailable,
    errors: answer.errors,
    tookMs: Date.now() - started,
  };
}

function isbnOf(page: { isbn?: string }): string | undefined {
  return page.isbn;
}
