/**
 * Встроенная библиотека «Полки» — 14 книг из Викитеки.
 *
 * Данные уже лежат в приложении (src/data/books.ts), тексты — в
 * public/library/<id>.json, поэтому источник работает офлайн и не делает
 * ни одного сетевого запроса.
 */
import { BOOKS } from '../../data/books';
import { cleanText, makeId, uniqueStrings } from '../normalize';
import type { BookMeta } from '../../types';
import type { BookSource, CatalogBook, SearchQuery, SourceContext, SourceHealth } from '../types';

const SOURCE_ID = 'local';
const SOURCE_NAME = 'Полка';

/** Лимит записей на запрос: 1..30, по умолчанию 20. */
function limitOf(ctx: SourceContext): number {
  const value = ctx.limit ?? 20;
  return Math.min(30, Math.max(1, Math.trunc(value)));
}

/** Ссылка на JSON-файл книги относительно BASE_URL приложения. */
function fileUrl(bookId: string): string {
  return `${import.meta.env.BASE_URL}library/${bookId}.json`;
}

/** BookMeta → CatalogBook. */
function toBook(meta: BookMeta): CatalogBook {
  return {
    id: makeId(SOURCE_ID, meta.id),
    sourceId: SOURCE_ID,
    externalId: meta.id,
    title: meta.title,
    authors: uniqueStrings([meta.author]),
    year: meta.year,
    languages: ['ru'],
    description: cleanText(meta.description, 1200),
    subjects: uniqueStrings([...meta.genres, ...meta.tags]).slice(0, 12),
    rating: meta.rating,
    ratingsCount: meta.reviews,
    files: [
      {
        url: fileUrl(meta.id),
        format: 'epub',
        sizeBytes: meta.bytes,
        label: `EPUB, ${Math.round(meta.bytes / 1024)} КБ`,
        requiresAuth: false,
      },
    ],
    access: 'download',
    accessNote: 'Файл уже в приложении — книга читается офлайн',
    source: {
      sourceId: SOURCE_ID,
      sourceName: SOURCE_NAME,
      pageUrl: meta.source?.url,
      license: meta.source?.license ?? 'Общественное достояние',
    },
    fetchedAt: Date.now(),
  };
}

/** Поиск по названию, автору, жанрам и тегам (ISBN у книг Викитеки нет). */
function searchLocal(query: SearchQuery, limit: number): CatalogBook[] {
  if (query.isbn) return [];
  const text = query.text?.trim().toLowerCase();
  const title = query.title?.trim().toLowerCase();
  const author = query.author?.trim().toLowerCase();
  const subject = query.subject?.trim().toLowerCase();
  if (!text && !title && !author && !subject) return BOOKS.slice(0, limit).map(toBook);

  const result = BOOKS.filter((meta) => {
    const genres = meta.genres.map((genre) => genre.toLowerCase());
    const tags = meta.tags.map((tag) => tag.toLowerCase());
    const titleLower = meta.title.toLowerCase();
    const authorLower = meta.author.toLowerCase();
    if (title && !titleLower.includes(title) && !authorLower.includes(title)) return false;
    if (author && !authorLower.includes(author)) return false;
    if (subject && ![...genres, ...tags].some((value) => value.includes(subject))) return false;
    if (text) {
      const haystack = [meta.title, meta.author, ...meta.genres, ...meta.tags, String(meta.year)]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });
  return result.slice(0, limit).map(toBook);
}

/** Новинки и популярное для локальной библиотеки совпадают — сортировка по рейтингу. */
function sortedByRating(ctx: SourceContext): CatalogBook[] {
  return [...BOOKS]
    .sort((a, b) => b.rating - a.rating)
    .slice(0, limitOf(ctx))
    .map(toBook);
}

export const localLibrarySource: BookSource = {
  id: SOURCE_ID,
  name: SOURCE_NAME,
  homepage: 'https://ru.wikisource.org',
  licenseNote: 'Викитека, общественное достояние; разметка — CC BY-SA',
  capabilities: {
    search: true,
    byIsbn: false,
    newest: true,
    popular: true,
    bySubject: true,
    download: true,
    audio: false,
  },

  async search(query: SearchQuery, ctx: SourceContext): Promise<CatalogBook[]> {
    return searchLocal(query, limitOf(ctx));
  },

  async newest(ctx: SourceContext): Promise<CatalogBook[]> {
    return sortedByRating(ctx);
  },

  async popular(ctx: SourceContext): Promise<CatalogBook[]> {
    return sortedByRating(ctx);
  },

  async bySubject(subject: string, ctx: SourceContext): Promise<CatalogBook[]> {
    const target = subject.trim().toLowerCase();
    if (!target) return [];
    return BOOKS.filter((meta) =>
      [...meta.genres, ...meta.tags].some((value) => value.toLowerCase().includes(target)),
    )
      .sort((a, b) => b.rating - a.rating)
      .slice(0, limitOf(ctx))
      .map(toBook);
  },

  async health(): Promise<SourceHealth> {
    // Офлайн-источник: проверять нечего, книги уже внутри приложения.
    return { ok: true, note: 'Встроенная библиотека работает офлайн', checkedAt: Date.now() };
  },
};
