/**
 * Кэш каталога: поисковые выдачи, карточки и состояния источников.
 * Хранится в отдельной IndexedDB, чтобы не смешивать с библиотекой пользователя.
 * TTL разный: выдача поиска 15 минут, карточка — 6 часов, новинки — 30 минут.
 */
import type { CatalogBook } from './types';

const DB_NAME = 'polka-catalog';
const DB_VERSION = 1;
const STORE = 'cache';

export const TTL = {
  search: 15 * 60_000,
  details: 6 * 60 * 60_000,
  discover: 30 * 60_000,
  cover: 7 * 24 * 60 * 60_000,
} as const;

interface CacheEntry<T> {
  key: string;
  value: T;
  expiresAt: number;
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('expiresAt', 'expiresAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Не удалось открыть кэш каталога'));
  });
  return dbPromise;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Ошибка IndexedDB'));
  });
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const entry = await request<CacheEntry<T> | undefined>(tx.objectStore(STORE).get(key));
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      void cacheDelete(key);
      return null;
    }
    return entry.value;
  } catch {
    return null;
  }
}

export async function cacheSet<T>(key: string, value: T, ttlMs: number): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const entry: CacheEntry<T> = {
      key,
      value,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };
    tx.objectStore(STORE).put(entry);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* кэш не критичен */
  }
}

export async function cacheDelete(key: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
  } catch {
    /* noop */
  }
}

export async function cacheClear(): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
  } catch {
    /* noop */
  }
}

export async function cacheStats(): Promise<{ entries: number; bytes: number }> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const rows = await request<CacheEntry<unknown>[]>(tx.objectStore(STORE).getAll());
    const bytes = rows.reduce((sum, row) => sum + JSON.stringify(row.value).length, 0);
    return { entries: rows.length, bytes };
  } catch {
    return { entries: 0, bytes: 0 };
  }
}

export function searchCacheKey(parts: Record<string, string | number | undefined>): string {
  const normalized = Object.entries(parts)
    .filter(([, value]) => value !== undefined && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value).trim().toLowerCase()}`)
    .join('&');
  return `search:${normalized}`;
}

export function detailsCacheKey(sourceId: string, externalId: string): string {
  return `details:${sourceId}:${externalId}`;
}

export function booksCacheKey(prefix: string, extra?: string): string {
  return extra ? `${prefix}:${extra}` : prefix;
}

/** Запоминает карточки по id, чтобы открывать их без повторного запроса. */
export async function rememberBooks(books: CatalogBook[]): Promise<void> {
  await Promise.all(
    books.map((book) => cacheSet(detailsCacheKey(book.sourceId, book.externalId), book, TTL.details)),
  );
}

export async function recallBook(bookId: string): Promise<CatalogBook | null> {
  const [sourceId, ...rest] = bookId.split(':');
  if (!sourceId || rest.length === 0) return null;
  return cacheGet<CatalogBook>(detailsCacheKey(sourceId, rest.join(':')));
}
