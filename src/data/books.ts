import catalog from './catalog.json';
import type { BookMeta } from '../types';

export const BOOKS = catalog as BookMeta[];

export const BOOK_MAP: Map<string, BookMeta> = new Map(BOOKS.map((book) => [book.id, book]));

export function getBook(bookId: string | undefined): BookMeta | undefined {
  if (!bookId) return undefined;
  return BOOK_MAP.get(bookId);
}

export const GENRES: string[] = [...new Set(BOOKS.flatMap((book) => book.genres))].sort((a, b) =>
  a.localeCompare(b, 'ru'),
);

export const TOTAL_LIBRARY_MINUTES = BOOKS.reduce((sum, book) => sum + book.minutes, 0);

export function searchBooks(query: string): BookMeta[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return BOOKS;
  return BOOKS.filter((book) => {
    const haystack = [book.title, book.author, ...book.genres, ...book.tags, String(book.year)]
      .join(' ')
      .toLowerCase();
    return haystack.includes(normalized);
  });
}
