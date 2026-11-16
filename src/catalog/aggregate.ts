/**
 * Объединение результатов из нескольких источников:
 * параллельный поиск, нормализация, удаление дублей, ранжирование.
 */
import { toSourceError } from './http';
import { isLikelyDuplicate, normalizeIsbn, normalizeTitle } from './normalize';
import { enabledSources, listSources } from './registry';
import type {
  BookSource,
  CatalogBook,
  SearchQuery,
  SearchResult,
  SourceContext,
  SourceError,
} from './types';

export interface AggregateOptions {
  status?: (message: string) => void;
  /** Поиск только по конкретным источникам. */
  sourceIds?: string[];
  googleKey?: string | null;
  signal?: AbortSignal;
  /** Минимальное число записей на источник. */
  perSourceLimit?: number;
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

function relevanceScore(book: CatalogBook, query: SearchQuery): number {
  const tokens = [query.text, query.title, query.author, query.subject]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 2);
  if (tokens.length === 0) return 0;
  const title = book.title.toLowerCase();
  const author = book.authors.join(' ').toLowerCase();
  const subjects = book.subjects.join(' ').toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 3;
    if (author.includes(token)) score += 2;
    if (subjects.includes(token)) score += 0.5;
  }
  // Бонус за скачиваемость и популярность.
  if (book.files.some((file) => !file.requiresAuth)) score += 0.5;
  if (book.ratingsCount) score += Math.min(1, Math.log10(book.ratingsCount + 1) / 4);
  return score;
}

/** Чередование источников, чтобы одна библиотека не занимала всю витрину. */
function interleave(groups: CatalogBook[][]): CatalogBook[] {
  const result: CatalogBook[] = [];
  const maxLength = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < maxLength; index += 1) {
    for (const group of groups) {
      if (group[index]) result.push(group[index]);
    }
  }
  return result;
}

function sortBooks(books: CatalogBook[], sort: SearchQuery['sort']): CatalogBook[] {
  const copy = [...books];
  switch (sort) {
    case 'newest':
      return copy.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    case 'popular':
      return copy.sort((a, b) => (b.ratingsCount ?? 0) - (a.ratingsCount ?? 0));
    case 'rating':
      return copy.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    default:
      return copy;
  }
}

/** Оценка «полезности» записи: скачиваемые файлы > метаданные > обложка. */
function quality(book: CatalogBook): number {
  let score = 0;
  if (book.files.length > 0) score += 60;
  if (book.files.some((file) => !file.requiresAuth)) score += 25;
  if (book.access === 'download') score += 20;
  if (book.coverUrl) score += 8;
  if (book.description && book.description.length > 80) score += 8;
  if (book.year) score += 3;
  if (book.authors.length > 0) score += 5;
  if (book.audio?.tracks.length) score += 30;
  if (book.rating) score += 4;
  score += Math.min(20, book.subjects.length * 2);
  return score;
}

/** Сливает две записи об одной книге, сохраняя максимум данных. */
function mergeBooks(primary: CatalogBook, secondary: CatalogBook): CatalogBook {
  const base = quality(primary) >= quality(secondary) ? primary : secondary;
  const other = base === primary ? secondary : primary;

  const files = [...base.files];
  for (const file of other.files) {
    if (!files.some((item) => item.url === file.url || item.format === file.format)) files.push(file);
  }
  // Сначала бесплатные форматы, затем по «читабельности».
  const formatRank: Record<string, number> = { epub: 0, fb2: 1, pdf: 2, txt: 3, mobi: 4, html: 5, audio: 6, djvu: 7, unknown: 9 };
  files.sort((a, b) => {
    if (Boolean(a.requiresAuth) !== Boolean(b.requiresAuth)) return a.requiresAuth ? 1 : -1;
    return (formatRank[a.format] ?? 9) - (formatRank[b.format] ?? 9);
  });

  const isbn = [...new Set([...(base.isbn ?? []), ...(other.isbn ?? [])].map((value) => normalizeIsbn(value)).filter(Boolean) as string[])];

  return {
    ...base,
    title: base.title.length >= other.title.length ? base.title : other.title,
    authors: base.authors.length > 0 ? base.authors : other.authors,
    year: base.year ?? other.year,
    description:
      (base.description?.length ?? 0) >= (other.description?.length ?? 0) ? base.description : other.description,
    subjects: [...new Set([...base.subjects, ...other.subjects])].slice(0, 12),
    publishers: [...new Set([...(base.publishers ?? []), ...(other.publishers ?? [])])],
    languages: [...new Set([...(base.languages ?? []), ...(other.languages ?? [])])],
    isbn: isbn.length > 0 ? isbn : undefined,
    coverUrl: base.coverUrl ?? other.coverUrl,
    rating: base.rating ?? other.rating,
    ratingsCount: base.ratingsCount ?? other.ratingsCount,
    files,
    audio: base.audio ?? other.audio,
    access: base.files.length > 0 || base.access === 'download' ? base.access : other.access,
    accessUrl: base.accessUrl ?? other.accessUrl,
    accessNote: base.accessNote ?? other.accessNote,
    fetchedAt: Math.max(base.fetchedAt, other.fetchedAt),
  };
}

/** Удаляет дубли, объединяя данные, но сохраняя источник-первоисточник. */
export function dedupeBooks(books: CatalogBook[]): CatalogBook[] {
  const sorted = [...books].sort((a, b) => quality(b) - quality(a));
  const result: CatalogBook[] = [];
  for (const book of sorted) {
    const duplicateIndex = result.findIndex((existing) => isLikelyDuplicate(existing, book));
    if (duplicateIndex === -1) {
      result.push(book);
    } else {
      result[duplicateIndex] = mergeBooks(result[duplicateIndex], book);
    }
  }
  return result;
}

function prepareQuery(query: SearchQuery): SearchQuery {
  return {
    ...query,
    text: query.text?.trim() || undefined,
    title: query.title?.trim() || undefined,
    author: query.author?.trim() || undefined,
    isbn: query.isbn?.replace(/[^0-9Xx]/g, '') || undefined,
    subject: query.subject?.trim() || undefined,
  };
}

/**
 * Ищет книгу сразу по всем включённым источникам.
 * Ошибки отдельных источников не ломают выдачу — они возвращаются в errors.
 */
export async function searchAll(query: SearchQuery, options: AggregateOptions = {}): Promise<SearchResult> {
  const started = performance.now();
  const prepared = prepareQuery(query);
  const limit = prepared.limit ?? 20;
  const perSourceLimit = options.perSourceLimit ?? limit;
  const ctx: SourceContext = {
    signal: options.signal,
    limit: perSourceLimit,
    apiKey: options.googleKey ?? undefined,
    online: isOnline(),
  };

  const all = listSources();
  const candidates = options.sourceIds
    ? all.filter((source) => options.sourceIds?.includes(source.id))
    : enabledSources({ googleKey: options.googleKey });

  if (!ctx.online) {
    return { books: [], errors: [], perSource: {}, tookMs: 0 };
  }

  const perSource: Record<string, number> = {};
  const errors: SourceError[] = [];

  // ISBN — самый точный запрос: сначала спрашиваем источники с byIsbn.
  const runSource = async (source: BookSource): Promise<CatalogBook[]> => {
    options.status?.(`Ищем в ${source.name}…`);
    try {
      if (prepared.isbn && source.byIsbn) {
        const byIsbn = await source.byIsbn(prepared.isbn, ctx);
        if (byIsbn.length > 0) {
          perSource[source.id] = byIsbn.length;
          return byIsbn;
        }
      }
      const books = await source.search({ ...prepared, limit: perSourceLimit }, ctx);
      perSource[source.id] = books.length;
      return books;
    } catch (error) {
      errors.push(toSourceError(source.id, source.name, error));
      perSource[source.id] = 0;
      return [];
    }
  };

  const settled = await Promise.all(candidates.map(runSource));
  const merged = dedupeBooks(settled.flat());
  const ranked =
    prepared.sort === 'relevance' || !prepared.sort
      ? [...merged].sort((a, b) => relevanceScore(b, prepared) - relevanceScore(a, prepared))
      : sortBooks(merged, prepared.sort);

  return {
    books: ranked.slice(0, limit),
    errors,
    perSource,
    tookMs: Math.round(performance.now() - started),
  };
}

/** Новинки: свежие поступления из источников, у которых есть newest(). */
export async function newestBooks(options: AggregateOptions & { limit?: number } = {}): Promise<SearchResult> {
  return collectFromSources('newest', options, 'Новинки');
}

/** Популярные книги. */
export async function popularBooks(options: AggregateOptions & { limit?: number } = {}): Promise<SearchResult> {
  return collectFromSources('popular', options, 'Популярное');
}

/** Книги жанра/темы. */
export async function subjectBooks(
  subject: string,
  options: AggregateOptions & { limit?: number } = {},
): Promise<SearchResult> {
  const started = performance.now();
  const ctx: SourceContext = {
    signal: options.signal,
    limit: options.perSourceLimit ?? options.limit ?? 20,
    apiKey: options.googleKey ?? undefined,
    online: isOnline(),
  };
  if (!ctx.online) return { books: [], errors: [], perSource: {}, tookMs: 0 };

  const sources = listSources().filter((source) => source.capabilities.bySubject && source.bySubject);
  const perSource: Record<string, number> = {};
  const errors: SourceError[] = [];
  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        const books = await source.bySubject!(subject, ctx);
        perSource[source.id] = books.length;
        return books;
      } catch (error) {
        errors.push(toSourceError(source.id, source.name, error));
        perSource[source.id] = 0;
        return [];
      }
    }),
  );
  const merged = dedupeBooks(interleave(results));
  return {
    books: merged.slice(0, options.limit ?? 20),
    errors,
    perSource,
    tookMs: Math.round(performance.now() - started),
  };
}

/** Какие источники показываем в витринах «Новинки» и «Популярное». */
const VENUE_SOURCES: Record<'newest' | 'popular', string[]> = {
  // Свежие поступления: современные издания Open Library и новые тексты Gutenberg.
  newest: ['openlibrary', 'gutenberg'],
  // Популярное: тренды Open Library, известные аудиокниги LibriVox, топ Gutenberg и встроенная библиотека.
  popular: ['openlibrary', 'librivox', 'gutenberg', 'local'],
};

async function collectFromSources(
  mode: 'newest' | 'popular',
  options: AggregateOptions & { limit?: number },
  label: string,
): Promise<SearchResult> {
  const started = performance.now();
  const ctx: SourceContext = {
    signal: options.signal,
    limit: options.perSourceLimit ?? options.limit ?? 20,
    apiKey: options.googleKey ?? undefined,
    online: isOnline(),
  };
  if (!ctx.online) return { books: [], errors: [], perSource: {}, tookMs: 0 };

  options.status?.(`Загружаем: ${label.toLowerCase()}…`);
  const allowed = VENUE_SOURCES[mode];
  const sources = listSources().filter(
    (source) =>
      allowed.includes(source.id) &&
      source.capabilities[mode] &&
      (mode === 'newest' ? source.newest : source.popular),
  );
  const perSource: Record<string, number> = {};
  const errors: SourceError[] = [];
  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        const books = await (mode === 'newest' ? source.newest!(ctx) : source.popular!(ctx));
        perSource[source.id] = books.length;
        return books;
      } catch (error) {
        errors.push(toSourceError(source.id, source.name, error));
        perSource[source.id] = 0;
        return [];
      }
    }),
  );
  const merged = dedupeBooks(interleave(results));
  return {
    books: merged.slice(0, options.limit ?? 20),
    errors,
    perSource,
    tookMs: Math.round(performance.now() - started),
  };
}

/** Точный поиск по названию — для «похожих книг» и рекомендаций. */
export function queryKey(query: SearchQuery): string {
  return normalizeTitle([query.text, query.title, query.author, query.isbn, query.subject].filter(Boolean).join(' '));
}
