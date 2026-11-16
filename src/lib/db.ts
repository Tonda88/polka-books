import type { BookContent, ChapterContent } from '../types';

const DB_NAME = 'polka-library';
const DB_VERSION = 2;
const STORE_KV = 'kv';
const STORE_BOOKS = 'books';
/** Файлы скачанных сетевых книг (blob) и метаданные загрузок. */
const STORE_FILES = 'files';
const STORE_NETBOOKS = 'netbooks';

export const KV_KEYS = [
  'profile',
  'settings',
  'progress',
  'sessions',
  'goals',
  'ratings',
  'bookmarks',
  'downloads',
] as const;

export type KvKey = (typeof KV_KEYS)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
      if (!db.objectStoreNames.contains(STORE_BOOKS)) db.createObjectStore(STORE_BOOKS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORE_NETBOOKS)) {
        const store = db.createObjectStore(STORE_NETBOOKS, { keyPath: 'id' });
        store.createIndex('savedAt', 'savedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Не удалось открыть IndexedDB'));
  });
  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Ошибка IndexedDB'));
  });
}

export async function kvGet<T>(key: KvKey): Promise<T | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE_KV, 'readonly');
  const store = tx.objectStore(STORE_KV);
  return requestToPromise<T | undefined>(store.get(key));
}

export async function kvSet<T>(key: KvKey, value: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_KV, 'readwrite');
  tx.objectStore(STORE_KV).put(value, key);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Ошибка записи IndexedDB'));
    tx.onabort = () => reject(tx.error ?? new Error('Запись отменена'));
  });
}

export interface StoredBook {
  id: string;
  chapters: ChapterContent[];
  bytes: number;
  savedAt: number;
}

export async function idbGetBook(id: string): Promise<StoredBook | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE_BOOKS, 'readonly');
  return requestToPromise<StoredBook | undefined>(tx.objectStore(STORE_BOOKS).get(id));
}

export async function idbPutBook(book: StoredBook): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_BOOKS, 'readwrite');
  tx.objectStore(STORE_BOOKS).put(book);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Не удалось сохранить книгу'));
  });
}

export async function idbDeleteBook(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_BOOKS, 'readwrite');
  tx.objectStore(STORE_BOOKS).delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Не удалось удалить книгу'));
  });
}

export async function idbListBookIds(): Promise<string[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_BOOKS, 'readonly');
  const keys = await requestToPromise(tx.objectStore(STORE_BOOKS).getAllKeys());
  return keys.map(String);
}

export async function clearAllData(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_KV, STORE_BOOKS, STORE_FILES, STORE_NETBOOKS], 'readwrite');
  tx.objectStore(STORE_KV).clear();
  tx.objectStore(STORE_BOOKS).clear();
  tx.objectStore(STORE_FILES).clear();
  tx.objectStore(STORE_NETBOOKS).clear();
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Не удалось очистить данные'));
  });
}

export async function loadStoredBookContent(id: string): Promise<BookContent | undefined> {
  const stored = await idbGetBook(id);
  if (!stored) return undefined;
  return { id: stored.id, chapters: stored.chapters };
}

// --------------------------------------------------------------------------- //
// Файлы скачанных сетевых книг и их метаданные
// --------------------------------------------------------------------------- //

export interface StoredFile {
  key: string;
  blob: Blob;
  bytes: number;
  mime: string;
  savedAt: number;
}

export interface StoredNetBookRecord {
  id: string;
  savedAt: number;
  [key: string]: unknown;
}

export async function idbPutFile(file: StoredFile): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_FILES, 'readwrite');
  tx.objectStore(STORE_FILES).put(file);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Не удалось сохранить файл книги'));
  });
}

export async function idbGetFile(key: string): Promise<StoredFile | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE_FILES, 'readonly');
  return requestToPromise<StoredFile | undefined>(tx.objectStore(STORE_FILES).get(key));
}

export async function idbDeleteFile(key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_FILES, 'readwrite');
  tx.objectStore(STORE_FILES).delete(key);
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function idbPutNetBook(record: StoredNetBookRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_NETBOOKS, 'readwrite');
  tx.objectStore(STORE_NETBOOKS).put(record);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Не удалось сохранить книгу'));
  });
}

export async function idbGetNetBook<T extends StoredNetBookRecord = StoredNetBookRecord>(
  id: string,
): Promise<T | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE_NETBOOKS, 'readonly');
  return requestToPromise<T | undefined>(tx.objectStore(STORE_NETBOOKS).get(id));
}

export async function idbListNetBooks<T extends StoredNetBookRecord = StoredNetBookRecord>(): Promise<T[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_NETBOOKS, 'readonly');
  const rows = await requestToPromise<T[]>(tx.objectStore(STORE_NETBOOKS).getAll());
  return rows.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
}

export async function idbDeleteNetBook(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_NETBOOKS, 'readwrite');
  tx.objectStore(STORE_NETBOOKS).delete(id);
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** Суммарный объём скачанных сетевых книг. */
export async function idbNetBooksBytes(): Promise<number> {
  const rows = await idbListNetBooks();
  return rows.reduce((sum, row) => sum + (typeof row.bytes === 'number' ? row.bytes : 0), 0);
}
