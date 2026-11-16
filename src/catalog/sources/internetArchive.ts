/**
 * Internet Archive — реальные скачиваемые материалы общественного достояния.
 *
 * Поиск: advancedsearch.php (только mediatype:texts, без закрытых коллекций).
 * Детали и файлы: /metadata/<identifier>.
 * Скачивание: /download/<identifier>/<file>.
 *
 * Из этого файла также экспортируются общие помощники для адаптеров
 * Project Gutenberg и LibriVox: они работают через тот же API, но с другими
 * коллекциями.
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

const SOURCE_ID = 'archive';
const SOURCE_NAME = 'Internet Archive';
const SEARCH_URL = 'https://archive.org/advancedsearch.php';
const METADATA_URL = 'https://archive.org/metadata/';
const DETAILS_URL = 'https://archive.org/details/';
const DOWNLOAD_URL = 'https://archive.org/download/';
const LICENSE = 'Общественное достояние / открытый доступ';

/** Поля выдачи advancedsearch. */
const SEARCH_FIELDS = [
  'identifier',
  'title',
  'creator',
  'year',
  'subject',
  'language',
  'downloads',
  'publicdate',
  'mediatype',
] as const;

/** Сортировки Internet Archive. */
export type IaSort = 'publicdate desc' | 'downloads desc';

export interface IaSearchDoc {
  identifier?: string;
  title?: string | string[];
  creator?: string | string[];
  year?: number | string;
  subject?: string | string[];
  language?: string | string[];
  downloads?: number;
  publicdate?: string;
  mediatype?: string;
}

export interface IaSearchResponse {
  response?: { numFound?: number; docs?: IaSearchDoc[] };
}

export interface IaFile {
  name?: string;
  format?: string;
  size?: string | number;
  private?: boolean | string;
  title?: string;
  length?: string;
}

export interface IaMetadata {
  title?: unknown;
  creator?: unknown;
  author?: unknown;
  description?: unknown;
  year?: unknown;
  date?: unknown;
  publicdate?: unknown;
  subject?: unknown;
  publisher?: unknown;
  language?: unknown;
  collection?: unknown;
  isbn?: unknown;
  narrator?: unknown;
  runtime?: unknown;
  [key: string]: unknown;
}

export interface IaItemResponse {
  metadata?: IaMetadata;
  files?: IaFile[];
  is_dark?: boolean;
}

/** Лимит записей на один запрос: 1..30, по умолчанию 20. */
export function limitOf(ctx: SourceContext): number {
  const value = ctx.limit ?? 20;
  return Math.min(30, Math.max(1, Math.trunc(value)));
}

/** Приводит значение API (строка, массив, число) к массиву строк. */
export function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => toList(item));
  if (typeof value === 'string') {
    return value
      .split(/[;\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)];
  return [];
}

/** Текст из поля IA: чистит HTML и лишние пробелы. */
export function iaText(value: unknown, limit = 2000): string | undefined {
  const joined = toList(value)
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('; ');
  return cleanText(joined, limit);
}

/** Lucene-строка в кавычках — защищает пробелы и служебные символы. */
export function iaQuote(value: string): string {
  const clean = value.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return `"${clean}"`;
}

/** Клаузулы запроса по полям SearchQuery. */
export function iaTextClauses(query: SearchQuery): string[] {
  const clauses: string[] = [];
  if (query.isbn) clauses.push(`isbn:(${iaQuote(query.isbn)})`);
  if (query.title) clauses.push(`title:(${iaQuote(query.title)})`);
  if (query.author) clauses.push(`creator:(${iaQuote(query.author)})`);
  if (query.subject) clauses.push(`subject:(${iaQuote(query.subject)})`);
  if (query.language) clauses.push(`language:(${iaQuote(query.language)})`);
  if (query.text) clauses.push(`(${iaQuote(query.text)})`);
  return clauses;
}

/**
 * Запрос advancedsearch.php. Повторяющиеся параметры fl[] и sort[]
 * собираем через URLSearchParams — buildUrl их схлопывает.
 */
export async function iaAdvancedSearch(
  query: string,
  sort: IaSort | undefined,
  ctx: SourceContext,
  rows?: number,
): Promise<IaSearchDoc[]> {
  const url = new URL(
    buildUrl(SEARCH_URL, {
      q: query,
      rows: rows ?? limitOf(ctx),
      page: 1,
      output: 'json',
    }),
  );
  for (const field of SEARCH_FIELDS) url.searchParams.append('fl[]', field);
  if (sort) url.searchParams.append('sort[]', sort);
  const data = await fetchJson<IaSearchResponse>(url.toString(), {
    signal: ctx.signal,
    timeoutMs: 12_000, retries: 1,
  });
  return data.response?.docs ?? [];
}

/** Метаданные и список файлов записи. Ошибка одной записи не ломает выдачу. */
export async function iaFetchItem(identifier: string, ctx: SourceContext): Promise<IaItemResponse | null> {
  if (!identifier) return null;
  try {
    return await fetchJson<IaItemResponse>(`${METADATA_URL}${encodeURIComponent(identifier)}`, {
      signal: ctx.signal,
      timeoutMs: 12_000,
      retries: 0,
    });
  } catch {
    return null;
  }
}

/** Закрытые материалы: доступ по подписке/для слабовидящих. */
export function iaIsRestricted(item: IaItemResponse): boolean {
  if (item.is_dark) return true;
  const metadata = item.metadata ?? {};
  const restricted = metadata['access-restricted-item'];
  if (restricted === true || String(restricted).toLowerCase() === 'true') return true;
  const collections = toList(metadata.collection).map((value) => value.toLowerCase());
  return collections.includes('inlibrary') || collections.includes('printdisabled');
}

const IA_FORMAT_BY_LABEL: Record<string, BookFormat> = {
  epub: 'epub',
  'text pdf': 'pdf',
  'additional text pdf': 'pdf',
  text: 'txt',
  fb2: 'fb2',
};

const FORMAT_ORDER: Record<string, number> = { epub: 0, pdf: 1, txt: 2, fb2: 3 };
const FORMAT_LABEL: Record<string, string> = { epub: 'EPUB', pdf: 'PDF', txt: 'TXT', fb2: 'FB2' };

/** Служебные файлы IA, которые не нужно предлагать к скачиванию. */
const SKIP_FILE_NAME = /(_text\.pdf|_meta\.xml|_files\.xml|_reviews\.xml|^meta\.xml$|_chocr\.html|_hocr\.html)/i;

export function formatBytes(bytes?: number): string | undefined {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return undefined;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** Подпись файла: «EPUB, 28,4 МБ». */
export function fileLabel(format: BookFormat, bytes?: number): string {
  const size = formatBytes(bytes);
  const name = FORMAT_LABEL[format] ?? format.toUpperCase();
  return size ? `${name}, ${size}` : name;
}

/** URL файла на скачивание с экранированием каждого сегмента пути. */
export function iaDownloadUrl(identifier: string, name: string): string {
  const path = name
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${DOWNLOAD_URL}${encodeURIComponent(identifier)}/${path}`;
}

/** Скачиваемые файлы записи: только EPUB/PDF/TXT/FB2/DjVu, по одному на формат. */
export function iaFiles(
  identifier: string,
  item: IaItemResponse,
  allowed?: readonly BookFormat[],
): DownloadFile[] {
  const seen = new Set<BookFormat>();
  const files: DownloadFile[] = [];
  for (const file of item.files ?? []) {
    const name = file?.name ?? '';
    if (!name || SKIP_FILE_NAME.test(name)) continue;
    if (file.private === true || file.private === 'true') continue;
    const format = IA_FORMAT_BY_LABEL[(file.format ?? '').trim().toLowerCase()];
    if (!format || seen.has(format)) continue;
    if (allowed && !allowed.includes(format)) continue;
    seen.add(format);
    const size = Number(file.size);
    const sizeBytes = Number.isFinite(size) && size > 0 ? size : undefined;
    files.push({
      url: iaDownloadUrl(identifier, name),
      format,
      sizeBytes,
      label: fileLabel(format, sizeBytes),
      requiresAuth: false,
    });
  }
  return files.sort((a, b) => (FORMAT_ORDER[a.format] ?? 9) - (FORMAT_ORDER[b.format] ?? 9));
}

/** Авторы из metadata.creator: убираем служебные пометки и даты жизни. */
export function iaAuthors(metadata: IaMetadata): string[] {
  const raw = toList(metadata.creator ?? metadata.author);
  const cleaned = raw.map((value) => {
    let name = value.replace(/\s+/g, ' ').trim();
    name = name.replace(/,\s*(author|editor|translator|illustrator|narrator)\.?$/gi, '');
    name = name.replace(/,\s*(ca\.\s*)?\d{3,4}(\s*[-–]\s*\d{3,4})?$/i, '');
    name = name.replace(/,\s*(author|editor|translator|illustrator|narrator)\.?$/gi, '').trim();
    // «Doyle, Arthur Conan» → «Arthur Conan Doyle»
    const parts = name.split(',');
    if (parts.length === 2 && parts[0].trim() && parts[1].trim() && !/\d/.test(name)) {
      name = `${parts[1].trim()} ${parts[0].trim()}`;
    }
    return name;
  });
  return uniqueStrings(cleaned).slice(0, 5);
}

/** Год из year/date/publicdate. */
export function iaYearOf(metadata: IaMetadata, fallback?: number): number | undefined {
  const candidates = [metadata.year, ...toList(metadata.date), ...toList(metadata.publicdate)];
  for (const value of candidates) {
    const year = toYear(value);
    if (year) return year;
  }
  return fallback;
}

export function iaSubjectsOf(metadata: IaMetadata): string[] {
  const subjects = toList(metadata.subject).map((value) => cleanText(value, 120));
  return uniqueStrings(subjects).slice(0, 12);
}

export function iaLanguagesOf(metadata: IaMetadata): string[] {
  return uniqueStrings(toList(metadata.language)).slice(0, 5);
}

export function iaPublishersOf(metadata: IaMetadata): string[] {
  return uniqueStrings(toList(metadata.publisher).map((value) => cleanText(value, 120))).slice(0, 5);
}

export function iaDescriptionOf(metadata: IaMetadata): string | undefined {
  return cleanText(toList(metadata.description).join(' '), 1200);
}

export function iaIsbnOf(metadata: IaMetadata): string[] | undefined {
  const values = toList(metadata.isbn)
    .map((value) => normalizeIsbn(value))
    .filter((value): value is string => Boolean(value));
  return values.length > 0 ? [...new Set(values)] : undefined;
}

/** Обложка IA — официальный сервис превью. */
export function iaCoverUrl(identifier: string): string {
  return `https://archive.org/services/img/${encodeURIComponent(identifier)}`;
}

/** Параллельная обработка с ограничением числа одновременных запросов. */
export async function mapLimited<T, R>(values: T[], concurrency: number, worker: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Запрос IA по текстовым полям + обязательные фильтры открытых текстов. */
function archiveQuery(query: SearchQuery): string {
  const clauses = iaTextClauses(query);
  clauses.push('mediatype:texts', '-collection:inlibrary', '-collection:printdisabled');
  return clauses.join(' AND ');
}

/** Сортировка IA по режиму из SearchQuery. */
function archiveSort(query: SearchQuery): IaSort | undefined {
  if (query.sort === 'newest') return 'publicdate desc';
  if (query.sort === 'popular' || query.sort === 'rating') return 'downloads desc';
  return undefined;
}

/** Собирает CatalogBook из метаданных IA. */
function toBook(identifier: string, item: IaItemResponse, files: DownloadFile[]): CatalogBook {
  const metadata = item.metadata ?? {};
  const pageUrl = `${DETAILS_URL}${encodeURIComponent(identifier)}`;
  const access: AccessMode = files.length > 0 ? 'download' : 'unknown';
  return {
    id: makeId(SOURCE_ID, identifier),
    sourceId: SOURCE_ID,
    externalId: identifier,
    title: iaText(metadata.title, 300) ?? identifier,
    authors: iaAuthors(metadata),
    year: iaYearOf(metadata),
    publishers: nonEmpty(iaPublishersOf(metadata)),
    languages: nonEmpty(iaLanguagesOf(metadata)),
    description: iaDescriptionOf(metadata),
    subjects: iaSubjectsOf(metadata),
    isbn: iaIsbnOf(metadata),
    coverUrl: iaCoverUrl(identifier),
    files,
    access,
    accessUrl: files.length === 0 ? pageUrl : undefined,
    accessNote:
      files.length > 0
        ? 'Файлы лежат в открытом доступе на Internet Archive'
        : 'Открытая запись Internet Archive, но скачиваемых EPUB/PDF/TXT не найдено',
    source: {
      sourceId: SOURCE_ID,
      sourceName: SOURCE_NAME,
      pageUrl,
      license: LICENSE,
    },
    fetchedAt: Date.now(),
  };
}

function nonEmpty(values: string[]): string[] | undefined {
  return values.length > 0 ? values : undefined;
}

/**
 * Находит записи и подгружает файлы для каждой (пачками, чтобы не ждать всех).
 * requireFiles — для витрин (новинки/популярное/жанры) берём только то, что
 * реально можно скачать: карточки без EPUB/PDF/TXT/DjVu там бесполезны.
 */
async function collect(
  query: string,
  sort: IaSort | undefined,
  ctx: SourceContext,
  requireFiles = false,
): Promise<CatalogBook[]> {
  const limit = limitOf(ctx);
  const docs = await iaAdvancedSearch(query, sort, ctx, limit);
  const identifiers = docs
    .map((doc) => doc.identifier)
    .filter((value): value is string => Boolean(value));

  const books: CatalogBook[] = [];
  const seen = new Set<string>();
  const chunkSize = 6;
  for (let start = 0; start < identifiers.length && books.length < limit; start += chunkSize) {
    const chunk = identifiers.slice(start, start + chunkSize);
    const items = await mapLimited(chunk, chunkSize, (identifier) => iaFetchItem(identifier, ctx));
    for (let index = 0; index < chunk.length; index += 1) {
      const identifier = chunk[index];
      const item = items[index];
      if (!identifier || !item || seen.has(identifier) || iaIsRestricted(item)) continue;
      seen.add(identifier);
      const files = iaFiles(identifier, item);
      if (requireFiles && files.length === 0) continue;
      books.push(toBook(identifier, item, files));
      if (books.length >= limit) break;
    }
  }
  return books;
}

export const internetArchiveSource: BookSource = {
  id: SOURCE_ID,
  name: SOURCE_NAME,
  homepage: 'https://archive.org',
  licenseNote: LICENSE,
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
    return collect(archiveQuery(query), archiveSort(query), ctx);
  },

  async byIsbn(isbn: string, ctx: SourceContext): Promise<CatalogBook[]> {
    return collect(archiveQuery({ isbn }), undefined, ctx);
  },

  async details(externalId: string, ctx: SourceContext): Promise<CatalogBook | null> {
    const item = await iaFetchItem(externalId, ctx);
    if (!item || iaIsRestricted(item)) return null;
    return toBook(externalId, item, iaFiles(externalId, item));
  },

  async newest(ctx: SourceContext): Promise<CatalogBook[]> {
    return collect(archiveQuery({}), 'publicdate desc', ctx, true);
  },

  async popular(ctx: SourceContext): Promise<CatalogBook[]> {
    return collect(archiveQuery({}), 'downloads desc', ctx, true);
  },

  async bySubject(subject: string, ctx: SourceContext): Promise<CatalogBook[]> {
    return collect(archiveQuery({ subject }), undefined, ctx, true);
  },

  async health(ctx: SourceContext): Promise<SourceHealth> {
    try {
      const docs = await iaAdvancedSearch('mediatype:texts AND -collection:inlibrary', undefined, ctx, 1);
      return {
        ok: true,
        note: docs.length > 0 ? 'Поиск открытых текстов работает' : 'API отвечает, но выдача пуста',
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
