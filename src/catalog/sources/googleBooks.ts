/**
 * Google Books — официальный API с ключом пользователя.
 *
 * Без ключа Google отдаёт HTTP 429 (общая квота исчерпана), поэтому источник
 * требует ключ из настроек профиля (capabilities.requiresKey). Ошибку не
 * глотаем: показываем понятное сообщение в ошибках поиска.
 *
 * Нормализация: volumeInfo → CatalogBook, accessInfo → файлы/режим доступа,
 * saleInfo → покупка в Google Play Books.
 */
import { ApiError, buildUrl, fetchJson } from '../http';
import { googleBooksProxyUrl, hasServerGoogleKey, isProxyMode } from '../proxy';
import { cleanText, makeId, normalizeIsbn, toYear, uniqueStrings } from '../normalize';
import type {
  AccessMode,
  BookSource,
  CatalogBook,
  DownloadFile,
  SearchQuery,
  SourceContext,
  SourceHealth,
} from '../types';

const SOURCE_ID = 'googlebooks';
const SOURCE_NAME = 'Google Books';
const API_BASE = 'https://www.googleapis.com/books/v1/';
const PLAY_BASE = 'https://play.google.com/store/books/details?id=';
const KEY_HINT =
  'Google Books: нужен API-ключ. Добавьте свой ключ в Профиле или настройте GOOGLE_BOOKS_KEY на сервере — остальные источники работают без него.';

/** Лимит записей на запрос: 1..30, по умолчанию 20. */
function limitOf(ctx: SourceContext): number {
  const value = ctx.limit ?? 20;
  return Math.min(30, Math.max(1, Math.trunc(value)));
}

// --- ответы API -------------------------------------------------------------

interface GbImageLinks {
  smallThumbnail?: string;
  thumbnail?: string;
}

interface GbIndustryIdentifier {
  type?: string;
  identifier?: string;
}

interface GbVolumeInfo {
  title?: string;
  subtitle?: string;
  authors?: string[];
  publishedDate?: string;
  publisher?: string;
  description?: string;
  categories?: string[];
  language?: string;
  averageRating?: number;
  ratingsCount?: number;
  imageLinks?: GbImageLinks;
  industryIdentifiers?: GbIndustryIdentifier[];
  infoLink?: string;
  canonicalVolumeLink?: string;
}

interface GbSaleInfo {
  saleability?: string;
  buyLink?: string;
  isEbook?: boolean;
}

interface GbAccessInfo {
  epub?: { isAvailable?: boolean; downloadLink?: string };
  pdf?: { isAvailable?: boolean; downloadLink?: string };
  accessViewStatus?: string;
  viewability?: string;
  publicDomain?: boolean;
  webReaderLink?: string;
}

interface GbVolume {
  id?: string;
  volumeInfo?: GbVolumeInfo;
  saleInfo?: GbSaleInfo;
  accessInfo?: GbAccessInfo;
}

interface GbVolumesResponse {
  totalItems?: number;
  items?: GbVolume[];
}

// --- запросы ----------------------------------------------------------------

/**
 * Доступен ли Google Books: ключ пользователя ИЛИ серверный прокси
 * (ключ в переменной окружения сервера, в клиент не попадает).
 */
function hasAccess(ctx: SourceContext): boolean {
  // Режим прокси сам по себе не даёт доступа: нужен ключ — свой у пользователя
  // или настроенный на сервере. Так Google не мешает, когда ключа нет вовсе.
  return Boolean(ctx.apiKey) || hasServerGoogleKey();
}

/** Запрос к официальному API: напрямую с ключом или через серверный прокси. */
async function apiGet<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  ctx: SourceContext,
): Promise<T> {
  if (!hasAccess(ctx)) throw new ApiError(KEY_HINT, 429, false);

  const viaProxy = isProxyMode();
  const url = viaProxy
    ? googleBooksProxyUrl(path, params, ctx.apiKey)
    : buildUrl(`${API_BASE}${path}`, { ...params, key: ctx.apiKey });

  try {
    return await fetchJson<T>(url, {
      signal: ctx.signal,
      timeoutMs: viaProxy ? 25_000 : 15_000,
      retries: 0,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) {
      throw new ApiError(
        'Google Books: на сервере не настроен ключ. Добавьте GOOGLE_BOOKS_KEY на сервере или свой ключ в Профиле.',
        503,
        false,
      );
    }
    if (error instanceof ApiError && error.status === 429) {
      throw new ApiError(
        viaProxy
          ? 'Google Books: квота исчерпана даже с ключом — попробуйте позже'
          : KEY_HINT,
        429,
        false,
      );
    }
    if (error instanceof ApiError && (error.status === 400 || error.status === 403)) {
      throw new ApiError(
        `Google Books: ключ API отклонён (${error.status}). Проверьте ключ в Профиле.`,
        error.status,
        false,
      );
    }
    throw error;
  }
}

/** Phrase-обёртка для q. */
function phrase(value: string): string {
  return `"${value.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`;
}

/** q из SearchQuery (Google понимает intitle/inauthor/subject/isbn). */
function buildQuery(query: SearchQuery): string | undefined {
  const parts: string[] = [];
  if (query.isbn) parts.push(`isbn:${query.isbn.replace(/[^0-9Xx]/g, '')}`);
  if (query.title) parts.push(`intitle:${phrase(query.title)}`);
  if (query.author) parts.push(`inauthor:${phrase(query.author)}`);
  if (query.subject) parts.push(`subject:${phrase(query.subject)}`);
  if (query.language) parts.push(`lang:${query.language.replace(/[^a-zA-Z-]/g, '')}`);
  const text = query.text?.trim();
  if (text) parts.push(text);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

// --- нормализация -----------------------------------------------------------

/** Обложка Google Books всегда по https. */
function coverUrlOf(info?: GbVolumeInfo): string | undefined {
  const raw = info?.imageLinks?.thumbnail ?? info?.imageLinks?.smallThumbnail;
  if (!raw) return undefined;
  return raw.replace(/^http:\/\//i, 'https://');
}

/** ISBN из industryIdentifiers. */
function isbnOf(info?: GbVolumeInfo): string[] | undefined {
  const values = (info?.industryIdentifiers ?? [])
    .filter((item) => item.type === 'ISBN_10' || item.type === 'ISBN_13')
    .map((item) => normalizeIsbn(item.identifier))
    .filter((value): value is string => Boolean(value));
  return values.length > 0 ? [...new Set(values)] : undefined;
}

/** Скачиваемые файлы: только когда Google сам отдаёт downloadLink. */
function filesOf(access: GbAccessInfo): DownloadFile[] {
  const files: DownloadFile[] = [];
  if (access.epub?.isAvailable && access.epub.downloadLink) {
    files.push({ url: access.epub.downloadLink, format: 'epub', requiresAuth: false });
  }
  if (access.pdf?.isAvailable && access.pdf.downloadLink) {
    files.push({ url: access.pdf.downloadLink, format: 'pdf', requiresAuth: false });
  }
  return files;
}

/** Нормализация одного тома. */
function toBook(volume: GbVolume): CatalogBook | null {
  const externalId = volume.id;
  const info = volume.volumeInfo;
  const title = info?.title?.trim();
  if (!externalId || !title) return null;

  const accessInfo = volume.accessInfo ?? {};
  const saleInfo = volume.saleInfo ?? {};
  const files = filesOf(accessInfo);
  const playPage = `${PLAY_BASE}${encodeURIComponent(externalId)}`;
  const pageUrl = info?.infoLink ?? info?.canonicalVolumeLink ?? playPage;

  let access: AccessMode = 'unknown';
  let accessUrl: string | undefined = pageUrl;
  let accessNote: string | undefined;
  if (files.length > 0) {
    access = 'download';
    accessUrl = undefined;
    accessNote =
      accessInfo.publicDomain === true
        ? 'Общественное достояние: Google Books отдаёт EPUB/PDF бесплатно'
        : 'Google Books разрешает скачивание этого издания';
  } else if (
    accessInfo.accessViewStatus === 'SAMPLE' ||
    accessInfo.viewability === 'PARTIAL' ||
    accessInfo.viewability === 'ALL_PAGES'
  ) {
    access = 'preview';
    accessNote = 'Доступен просмотр фрагмента на сайте Google Books';
  } else if (saleInfo.saleability === 'FOR_SALE' || saleInfo.buyLink) {
    access = 'buy';
    accessUrl = saleInfo.buyLink ?? playPage;
    accessNote = 'Продаётся в Google Play Books';
  } else {
    accessNote = 'Только карточка издания в Google Books';
  }

  const authors = uniqueStrings(info?.authors ?? []).slice(0, 5);
  const subjects = uniqueStrings(info?.categories ?? []).slice(0, 12);
  const isbn = isbnOf(info);
  const publisher = cleanText(info?.publisher, 160);
  const language = cleanText(info?.language, 16);

  return {
    id: makeId(SOURCE_ID, externalId),
    sourceId: SOURCE_ID,
    externalId,
    title: cleanText(title, 300) ?? externalId,
    subtitle: cleanText(info?.subtitle, 300),
    authors,
    year: toYear(info?.publishedDate),
    publishers: publisher ? [publisher] : undefined,
    languages: language ? [language] : undefined,
    description: cleanText(info?.description, 1200),
    subjects,
    isbn,
    rating: typeof info?.averageRating === 'number' ? info.averageRating : undefined,
    ratingsCount: typeof info?.ratingsCount === 'number' ? info.ratingsCount : undefined,
    coverUrl: coverUrlOf(info),
    files,
    access,
    accessUrl,
    accessNote,
    source: {
      sourceId: SOURCE_ID,
      sourceName: SOURCE_NAME,
      pageUrl,
      license:
        accessInfo.publicDomain === true
          ? 'Общественное достояние'
          : 'Google Books API; условия зависят от издания',
    },
    fetchedAt: Date.now(),
  };
}

function toBooks(response: GbVolumesResponse): CatalogBook[] {
  const books: CatalogBook[] = [];
  for (const item of response.items ?? []) {
    const book = toBook(item);
    if (book) books.push(book);
  }
  return books;
}

/** Поиск с ограничением maxResults. */
async function searchVolumes(
  q: string,
  orderBy: string | undefined,
  ctx: SourceContext,
): Promise<CatalogBook[]> {
  const response = await apiGet<GbVolumesResponse>('volumes', {
    q,
    maxResults: limitOf(ctx),
    printType: 'books',
    orderBy,
  }, ctx);
  return toBooks(response).slice(0, limitOf(ctx));
}

export const googleBooksSource: BookSource = {
  id: SOURCE_ID,
  name: SOURCE_NAME,
  homepage: 'https://books.google.com',
  licenseNote: 'Официальный Google Books API; ключ необязателен: свой в Профиле или серверный прокси',
  capabilities: {
    search: true,
    byIsbn: true,
    newest: true,
    popular: false,
    bySubject: true,
    download: true,
    audio: false,
    requiresKey: true,
  },

  async search(query: SearchQuery, ctx: SourceContext): Promise<CatalogBook[]> {
    const q = buildQuery(query);
    if (!q) return [];
    return searchVolumes(q, query.sort === 'newest' ? 'newest' : undefined, ctx);
  },

  async byIsbn(isbn: string, ctx: SourceContext): Promise<CatalogBook[]> {
    const normalized = normalizeIsbn(isbn);
    if (!normalized) return [];
    return searchVolumes(`isbn:${normalized}`, undefined, ctx);
  },

  async details(externalId: string, ctx: SourceContext): Promise<CatalogBook | null> {
    if (!externalId) return null;
    const volume = await apiGet<GbVolume>(`volumes/${encodeURIComponent(externalId)}`, {}, ctx);
    return toBook(volume);
  },

  async bySubject(subject: string, ctx: SourceContext): Promise<CatalogBook[]> {
    const value = subject.trim();
    if (!value) return [];
    return searchVolumes(`subject:${phrase(value)}`, undefined, ctx);
  },

  async newest(ctx: SourceContext): Promise<CatalogBook[]> {
    // Google Books не имеет «ленты новинок»: сортируем самый общий книжный раздел.
    return searchVolumes('subject:fiction', 'newest', ctx);
  },

  async health(ctx: SourceContext): Promise<SourceHealth> {
    if (!hasAccess(ctx)) {
      return {
        ok: false,
        note: 'Нужен API-ключ: добавьте в Профиле или настройте GOOGLE_BOOKS_KEY на сервере',
        checkedAt: Date.now(),
      };
    }
    try {
      const response = await apiGet<GbVolumesResponse>('volumes', { q: 'test', maxResults: 1 }, ctx);
      return {
        ok: Boolean(response.items?.length),
        note: isProxyMode() ? 'Google Books API отвечает через серверный прокси' : 'Google Books API отвечает',
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
