/**
 * Open Library — основной метаисточник.
 *
 * Поиск: /search.json (все поля задаются через fields).
 * Популярное: /trending/daily.json.
 * Жанры: /subjects/<slug>.json?published_in=2020-2024.
 * ISBN: /api/books?bibkeys=ISBN:...&jscmd=data.
 *
 * Все запросы идут с открытым CORS напрямую к openlibrary.org.
 */
import { buildUrl, fetchJson } from '../http';
import { cleanText, makeId, normalizeIsbn, toYear, uniqueStrings } from '../normalize';
import type {
  AccessMode,
  BookFormat,
  BookSource,
  CatalogBook,
  DownloadFile,
  SearchQuery,
  SourceContext,
  SourceHealth,
} from '../types';

const SOURCE_ID = 'openlibrary';
const SOURCE_NAME = 'Open Library';
const BASE = 'https://openlibrary.org';
const SEARCH_URL = `${BASE}/search.json`;
const TRENDING_URL = `${BASE}/trending/daily.json`;
const SUBJECT_URL = `${BASE}/subjects/`;
const ISBN_URL = `${BASE}/api/books`;
const IMAGE_BASE = 'https://archive.org/details/';

/** Поля выдачи поиска — ровно те, что нужны нормализации. */
const SEARCH_FIELDS = [
  'key',
  'title',
  'author_name',
  'first_publish_year',
  'isbn',
  'cover_i',
  'subject',
  'edition_count',
  'ratings_average',
  'ratings_count',
  'ebook_access',
  'publisher',
  'language',
  'ia',
  'series',
].join(',');

/** Лимит записей на запрос: 1..30, по умолчанию 20. */
function limitOf(ctx: SourceContext): number {
  const value = ctx.limit ?? 20;
  return Math.min(30, Math.max(1, Math.trunc(value)));
}

// --- ответы API -------------------------------------------------------------

interface OlSearchDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  isbn?: string[];
  cover_i?: number;
  subject?: string[];
  edition_count?: number;
  ratings_average?: number;
  ratings_count?: number;
  ebook_access?: string;
  publisher?: string[];
  language?: string[];
  ia?: string[];
  series?: string[];
}

interface OlSearchResponse {
  docs?: OlSearchDoc[];
  numFound?: number;
}

interface OlSubjectWork {
  key?: string;
  title?: string;
  author_name?: string[];
  authors?: Array<{ name?: string }>;
  first_publish_year?: number;
  cover_id?: number;
  cover_i?: number;
  edition_count?: number;
  subject?: string[];
  ia?: string[];
  ebook_access?: string;
  availability?: { status?: string };
}

interface OlSubjectResponse {
  works?: OlSubjectWork[];
}

interface OlEditionRecord {
  url?: string;
  key?: string;
  title?: string;
  subtitle?: string;
  authors?: Array<{ name?: string }>;
  publishers?: Array<{ name?: string }>;
  publish_date?: string;
  publish_year?: number;
  subjects?: Array<{ name?: string }>;
  cover?: { small?: string; medium?: string; large?: string };
  identifiers?: { isbn_10?: string[]; isbn_13?: string[] };
  ebooks?: Array<{
    preview_url?: string;
    availability?: string;
    formats?: Record<string, { url?: string; size?: string | number } | undefined>;
  }>;
}

type OlIsbnResponse = Record<string, OlEditionRecord | undefined>;

// --- нормализация -----------------------------------------------------------

/** cover_i / cover_id → ссылка на обложку Open Library. */
function coverUrlOf(coverId?: number): string | undefined {
  return typeof coverId === 'number' && coverId > 0
    ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`
    : undefined;
}

/** ebook_access → режим доступа. */
function accessOf(ebookAccess?: string): AccessMode {
  switch (ebookAccess) {
    case 'public':
      return 'download';
    case 'borrowable':
      return 'borrow';
    default:
      // printdisabled / no_ebook и всё остальное — точный режим неизвестен.
      return 'unknown';
  }
}

/** ebook_access в ответах subjects иногда отсутствует — выводим из availability. */
function subjectAccess(work: OlSubjectWork): AccessMode {
  if (work.ebook_access) return accessOf(work.ebook_access);
  const status = work.availability?.status;
  if (status === 'open') return 'download';
  if (status === 'borrowable') return 'borrow';
  return 'unknown';
}

/** Ключ работы (/works/OL...W) или издания (/books/OL...M) → чистый id. */
function keyOf(value?: string): string | undefined {
  if (!value) return undefined;
  return value.replace(/^\/(works|books)\//, '').trim() || undefined;
}

/** Ссылки на Internet Archive для книг в открытом доступе. */
function archiveFiles(ia?: string[]): DownloadFile[] {
  const ids = uniqueStrings(ia ?? []).slice(0, 3);
  return ids.map((id) => ({
    url: `${IMAGE_BASE}${encodeURIComponent(id)}`,
    format: 'html',
    label: 'Открытый доступ в Internet Archive',
    requiresAuth: false,
  }));
}

interface BookDraft {
  externalId: string;
  title: string;
  authors?: string[];
  year?: number;
  isbn?: string[];
  coverId?: number;
  coverUrl?: string;
  subjects?: string[];
  rating?: number;
  ratingsCount?: number;
  ebookAccess?: string;
  access?: AccessMode;
  publishers?: string[];
  languages?: string[];
  ia?: string[];
  series?: string[];
  pageUrl?: string;
  files?: DownloadFile[];
}

/** Ссылки Open Library приходят по http — переводим на https. */
function httpsUrl(value?: string): string | undefined {
  return value ? value.replace(/^http:\/\//i, 'https://') : undefined;
}

/** Собирает CatalogBook из нормализованных полей. */
function buildBook(draft: BookDraft): CatalogBook {
  const access = draft.access ?? accessOf(draft.ebookAccess);
  const pageUrl = draft.pageUrl ?? `${BASE}/works/${draft.externalId}`;
  const publicFiles = draft.files ?? (access === 'download' ? archiveFiles(draft.ia) : []);
  const files = publicFiles.slice(0, 4);
  const subjects = uniqueStrings(draft.subjects ?? []).slice(0, 12);
  const series = uniqueStrings(draft.series ?? []).slice(0, 3).join(', ');
  const isbn = (draft.isbn ?? [])
    .map((value) => normalizeIsbn(value))
    .filter((value): value is string => Boolean(value));

  return {
    id: makeId(SOURCE_ID, draft.externalId),
    sourceId: SOURCE_ID,
    externalId: draft.externalId,
    title: cleanText(draft.title, 300) ?? draft.externalId,
    authors: uniqueStrings(draft.authors ?? []).slice(0, 5),
    year: draft.year,
    publishers: draft.publishers && draft.publishers.length > 0 ? uniqueStrings(draft.publishers).slice(0, 5) : undefined,
    languages: draft.languages && draft.languages.length > 0 ? uniqueStrings(draft.languages).slice(0, 5) : undefined,
    subjects,
    // У популярных книг бывают сотни ISBN разных изданий — для UI хватает первых.
    isbn: isbn.length > 0 ? [...new Set(isbn)].slice(0, 10) : undefined,
    series: series || undefined,
    rating: draft.rating,
    ratingsCount: draft.ratingsCount,
    coverUrl: draft.coverUrl ?? coverUrlOf(draft.coverId),
    files,
    access,
    accessUrl: access === 'download' ? undefined : pageUrl,
    accessNote:
      access === 'download'
        ? 'Открытый доступ в Internet Archive'
        : access === 'borrow'
          ? 'Чтение по подписке Open Library (нужен аккаунт)'
          : undefined,
    source: {
      sourceId: SOURCE_ID,
      sourceName: SOURCE_NAME,
      pageUrl,
      license: 'Данные Open Library (открытый каталог Internet Archive)',
    },
    fetchedAt: Date.now(),
  };
}

/** Нормализация документа поиска. */
function fromSearchDoc(doc: OlSearchDoc): CatalogBook | null {
  const externalId = keyOf(doc.key);
  const title = doc.title?.trim();
  if (!externalId || !title) return null;
  const access = accessOf(doc.ebook_access);
  return buildBook({
    externalId,
    title,
    authors: doc.author_name,
    year: toYear(doc.first_publish_year),
    isbn: doc.isbn,
    coverId: doc.cover_i,
    subjects: doc.subject,
    rating: doc.ratings_average,
    ratingsCount: doc.ratings_count,
    ebookAccess: doc.ebook_access,
    access,
    publishers: doc.publisher,
    languages: doc.language,
    ia: doc.ia,
    series: doc.series,
    pageUrl: `${BASE}/works/${externalId}`,
    files: access === 'download' ? archiveFiles(doc.ia) : [],
  });
}

/** Нормализация работы из раздела жанра. */
function fromSubjectWork(work: OlSubjectWork): CatalogBook | null {
  const externalId = keyOf(work.key);
  const title = work.title?.trim();
  if (!externalId || !title) return null;
  const access = subjectAccess(work);
  const authors = work.author_name ?? (work.authors ?? []).map((author) => author.name ?? '');
  return buildBook({
    externalId,
    title,
    authors,
    year: toYear(work.first_publish_year),
    coverId: work.cover_id ?? work.cover_i,
    subjects: work.subject,
    ebookAccess: work.ebook_access,
    access,
    ia: work.ia,
    pageUrl: `${BASE}/works/${externalId}`,
    files: access === 'download' ? archiveFiles(work.ia) : [],
  });
}

// --- запросы ----------------------------------------------------------------

/** Lucene-значение в кавычках (как в документации Open Library). */
function phrase(value: string): string {
  return `"${value.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`;
}

/** Строит q из полей SearchQuery. */
function buildQuery(query: SearchQuery): string | undefined {
  const parts: string[] = [];
  if (query.isbn) parts.push(`isbn:(${phrase(query.isbn)})`);
  if (query.title) parts.push(`title:(${phrase(query.title)})`);
  if (query.author) parts.push(`author:(${phrase(query.author)})`);
  if (query.subject) parts.push(`subject:(${phrase(query.subject)})`);
  if (query.language) parts.push(`language:(${phrase(query.language)})`);
  const text = query.text?.trim();
  if (text) parts.push(text);
  return parts.length > 0 ? parts.join(' AND ') : undefined;
}

/** slug для /subjects/: нижний регистр, пробелы → «_», мусор выкидываем. */
function subjectSlug(subject: string): string {
  return subject
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/_+/g, '_');
}

async function searchDocs(q: string, sort: string | undefined, ctx: SourceContext): Promise<OlSearchDoc[]> {
  const url = buildUrl(SEARCH_URL, {
    q,
    limit: limitOf(ctx),
    fields: SEARCH_FIELDS,
    sort,
  });
  const data = await fetchJson<OlSearchResponse>(url, { signal: ctx.signal, timeoutMs: 15_000 });
  return data.docs ?? [];
}

async function trendingDocs(ctx: SourceContext): Promise<OlSearchDoc[]> {
  const url = buildUrl(TRENDING_URL, { limit: limitOf(ctx) });
  const data = await fetchJson<OlSearchResponse & { works?: OlSearchDoc[] }>(url, {
    signal: ctx.signal,
    timeoutMs: 15_000,
  });
  // trending/daily.json отдаёт works, старые версии — docs
  return data.works ?? data.docs ?? [];
}

export const openLibrarySource: BookSource = {
  id: SOURCE_ID,
  name: SOURCE_NAME,
  homepage: BASE,
  licenseNote: 'Открытый каталог Internet Archive (Open Library)',
  capabilities: {
    search: true,
    byIsbn: true,
    newest: true,
    popular: true,
    bySubject: true,
    download: true,
    audio: false,
  },

  async search(query: SearchQuery, ctx: SourceContext): Promise<CatalogBook[]> {
    const q = buildQuery(query);
    if (!q) return [];
    const docs = await searchDocs(q, query.sort === 'newest' ? 'new' : undefined, ctx);
    return docs
      .map(fromSearchDoc)
      .filter((book): book is CatalogBook => Boolean(book))
      .slice(0, limitOf(ctx));
  },

  async byIsbn(isbn: string, ctx: SourceContext): Promise<CatalogBook[]> {
    const normalized = normalizeIsbn(isbn);
    if (!normalized) return [];
    const url = buildUrl(ISBN_URL, {
      bibkeys: `ISBN:${normalized}`,
      format: 'json',
      jscmd: 'data',
    });
    const data = await fetchJson<OlIsbnResponse>(url, { signal: ctx.signal, timeoutMs: 15_000 });
    const books: CatalogBook[] = [];
    for (const record of Object.values(data)) {
      if (!record) continue;
      const externalId = keyOf(record.key) ?? normalized;
      const title = record.title?.trim();
      if (!title) continue;
      const files: DownloadFile[] = [];
      let access: AccessMode = 'unknown';
      for (const ebook of record.ebooks ?? []) {
        if (ebook.availability !== 'full' || !ebook.formats) continue;
        for (const [rawFormat, formatData] of Object.entries(ebook.formats)) {
          if (!formatData?.url) continue;
          const kind = rawFormat.toLowerCase();
          const format: BookFormat | undefined =
            kind === 'epub' ? 'epub' : kind === 'pdf' ? 'pdf' : kind === 'txt' ? 'txt' : undefined;
          if (!format) continue;
          const size = Number(formatData.size);
          access = 'download';
          files.push({
            url: formatData.url,
            format,
            sizeBytes: Number.isFinite(size) && size > 0 ? size : undefined,
            requiresAuth: false,
          });
        }
      }
      const previewUrl = record.ebooks?.find((ebook) => ebook.preview_url)?.preview_url;
      if (files.length === 0) {
        access = record.ebooks && record.ebooks.length > 0 ? 'borrow' : 'unknown';
      }
      const identifiers = record.identifiers;
      books.push(
        buildBook({
          externalId,
          title,
          authors: (record.authors ?? []).map((author) => author.name ?? ''),
          year: toYear(record.publish_year) ?? toYear(record.publish_date),
          isbn: [...(identifiers?.isbn_10 ?? []), ...(identifiers?.isbn_13 ?? [])],
          coverUrl: record.cover?.medium ?? record.cover?.small,
          subjects: (record.subjects ?? []).map((subject) => subject.name ?? ''),
          publishers: (record.publishers ?? []).map((publisher) => publisher.name ?? ''),
          access,
          files,
          pageUrl: httpsUrl(record.url) ?? httpsUrl(previewUrl) ?? `${BASE}/books/${externalId}`,
        }),
      );
      if (books.length >= limitOf(ctx)) break;
    }
    return books;
  },

  async newest(ctx: SourceContext): Promise<CatalogBook[]> {
    const currentYear = new Date().getFullYear();
    const q = `first_publish_year:[${currentYear - 2} TO ${currentYear + 1}]`;
    const docs = await searchDocs(q, 'new', ctx);
    return docs
      .map(fromSearchDoc)
      .filter((book): book is CatalogBook => Boolean(book))
      .slice(0, limitOf(ctx));
  },

  async popular(ctx: SourceContext): Promise<CatalogBook[]> {
    const docs = await trendingDocs(ctx);
    return docs
      .map(fromSearchDoc)
      .filter((book): book is CatalogBook => Boolean(book))
      .slice(0, limitOf(ctx));
  },

  async bySubject(subject: string, ctx: SourceContext): Promise<CatalogBook[]> {
    const slug = subjectSlug(subject);
    if (!slug) return [];
    const url = buildUrl(`${SUBJECT_URL}${encodeURIComponent(slug)}.json`, {
      limit: limitOf(ctx),
      published_in: '2020-2024',
    });
    const data = await fetchJson<OlSubjectResponse>(url, { signal: ctx.signal, timeoutMs: 15_000 });
    return (data.works ?? [])
      .map(fromSubjectWork)
      .filter((book): book is CatalogBook => Boolean(book))
      .slice(0, limitOf(ctx));
  },

  async health(ctx: SourceContext): Promise<SourceHealth> {
    try {
      const url = buildUrl(SEARCH_URL, { q: 'test', limit: 1, fields: 'key' });
      const data = await fetchJson<OlSearchResponse>(url, { signal: ctx.signal, timeoutMs: 10_000 });
      const ok = (data.numFound ?? 0) > 0;
      return {
        ok,
        note: ok ? 'Поиск Open Library отвечает' : 'API отвечает, но выдача пуста',
        checkedAt: Date.now(),
      };
    } catch (error) {
      return {
        ok: false,
        note: error instanceof Error ? error.message : 'Источник недоступен',
        checkedAt: Date.now(),
      };
    }
  },
};
