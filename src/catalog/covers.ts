/**
 * Обложки: выбор лучшей и нормализация URL.
 *
 * Источники отдают разные адреса:
 *  - Open Library: `covers.openlibrary.org/b/id/<id>-S.jpg` (есть размеры S/M/L);
 *  - Internet Archive: `https://archive.org/services/img/<id>`;
 *  - Google Books: `books.google.com/books/content?id=…&printsec=frontcover`;
 *  - встроенная библиотека: обложек нет (рисуется буква).
 *
 * Правила: только https, максимально крупный размер Open Library, без
 * служебных параметров Google. Если обложки нет — UI рисует заглушку.
 */
import type { CatalogBook } from './types';

const OL_COVER = /covers\.openlibrary\.org\/b\/id\/(\d+)-[SML]\.jpg/i;

/** Приводит адрес обложки к https и оптимальному размеру. */
export function normalizeCoverUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  let value = url.trim();
  if (!value) return undefined;

  // Open Library: просим размер L (крупнее и чётче).
  const ol = value.match(OL_COVER);
  if (ol) return `https://covers.openlibrary.org/b/id/${ol[1]}-L.jpg`;

  if (value.startsWith('//')) value = `https:${value}`;
  if (/^http:\/\//i.test(value)) value = value.replace(/^http:\/\//i, 'https://');

  // Google Books: убираем обрезку страницы и просим вменяемый размер.
  if (/books\.google\.com\/books\/content/.test(value)) {
    value = value.replace(/([?&])edge=curl(&|$)/i, '$1').replace(/[?&]$/, '');
    if (!/[?&]zoom=/.test(value)) value += `${value.includes('?') ? '&' : '?'}zoom=1`;
    if (!/[?&]w=/.test(value)) value += '&w=480';
  }

  // Internet Archive: служебные адреса уже https, ничего не делаем.
  return value;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Приоритет источника обложки: Open Library → Internet Archive → Google. */
const COVER_PRIORITY: Array<{ test: (host: string) => boolean; score: number }> = [
  { test: (host) => host === 'covers.openlibrary.org', score: 30 },
  { test: (host) => host.endsWith('archive.org'), score: 20 },
  { test: (host) => host.endsWith('google.com'), score: 10 },
];

function coverScore(url: string): number {
  const host = hostOf(url);
  for (const rule of COVER_PRIORITY) {
    if (rule.test(host)) return rule.score;
  }
  return 0;
}

/** Лучшая обложка из всех вариантов книги (учитывая слитые дубли). */
export function bestCover(book: CatalogBook): string | undefined {
  const candidates = [book.coverUrl, ...(book.coverAlternatives ?? [])]
    .map((url) => normalizeCoverUrl(url))
    .filter((url): url is string => Boolean(url));
  if (candidates.length === 0) return undefined;
  return candidates.sort((a, b) => coverScore(b) - coverScore(a))[0];
}

/** Проставляет книге лучшую обложку (используется после объединения дублей). */
export function withBestCover(book: CatalogBook): CatalogBook {
  const cover = bestCover(book);
  if (cover === book.coverUrl) return book;
  return { ...book, coverUrl: cover };
}
