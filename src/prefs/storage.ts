/**
 * Локальная база предпочтений (Room-эквивалент на IndexedDB).
 *
 * Отдельная БД `polka-prefs`, чтобы не смешивать с текстами книг
 * (polka-library) и кэшем каталога (polka-catalog).
 *
 * Хранилища:
 *  - `books`   — карточки книг, с которыми взаимодействовал пользователь;
 *  - `prefs`   — UserPreferencesEntity (агрегированный вкус);
 *  - `authors` — AuthorPreferenceEntity;
 *  - `genres`  — GenrePreferenceEntity (жанры, категории, поджанры, серии);
 *  - `ratings` — BookRatingEntity с историей изменений;
 *  - `events`  — история поиска/скачивания/чтения (индекс по at).
 */
import type {
  AuthorPreferenceEntity,
  BookProfile,
  BookRatingEntity,
  GenrePreferenceEntity,
  HistoryEvent,
  UserPreferencesEntity,
} from './types';

const DB_NAME = 'polka-prefs';
const DB_VERSION = 1;

export const STORES = {
  books: 'books',
  prefs: 'prefs',
  authors: 'authors',
  genres: 'genres',
  ratings: 'ratings',
  events: 'events',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.books)) {
        const store = db.createObjectStore(STORES.books, { keyPath: 'id' });
        store.createIndex('lastSeenAt', 'lastSeenAt');
      }
      if (!db.objectStoreNames.contains(STORES.prefs)) {
        db.createObjectStore(STORES.prefs, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.authors)) {
        const store = db.createObjectStore(STORES.authors, { keyPath: 'key' });
        store.createIndex('score', 'score');
      }
      if (!db.objectStoreNames.contains(STORES.genres)) {
        db.createObjectStore(STORES.genres, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.ratings)) {
        const store = db.createObjectStore(STORES.ratings, { keyPath: 'bookId' });
        store.createIndex('at', 'at');
      }
      if (!db.objectStoreNames.contains(STORES.events)) {
        const store = db.createObjectStore(STORES.events, { keyPath: 'id' });
        store.createIndex('at', 'at');
        store.createIndex('kind', 'kind');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Не удалось открыть базу предпочтений'));
  });
  return dbPromise;
}

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Ошибка IndexedDB'));
  });
}

export async function prefsGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  try {
    const db = await openDb();
    const tx = db.transaction(store, 'readonly');
    return await wrap<T | undefined>(tx.objectStore(store).get(key));
  } catch {
    return undefined;
  }
}

export async function prefsPut<T>(store: string, value: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value as unknown);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Ошибка записи'));
  });
}

export async function prefsDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function prefsAll<T>(store: string): Promise<T[]> {
  try {
    const db = await openDb();
    const tx = db.transaction(store, 'readonly');
    return (await wrap<T[]>(tx.objectStore(store).getAll())) ?? [];
  } catch {
    return [];
  }
}

export async function prefsClear(store?: string): Promise<void> {
  try {
    const db = await openDb();
    const stores = store ? [store] : Object.values(STORES);
    const tx = db.transaction(stores, 'readwrite');
    for (const name of stores) tx.objectStore(name).clear();
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* сброс не критичен */
  }
}

// --- типизированные обёртки -------------------------------------------------

export const prefs = {
  getPrefs: () => prefsGet<UserPreferencesEntity>(STORES.prefs, 'self'),
  putPrefs: (value: UserPreferencesEntity) => prefsPut(STORES.prefs, value),

  getBook: (id: string) => prefsGet<BookProfile>(STORES.books, id),
  putBook: (value: BookProfile) => prefsPut(STORES.books, value),
  allBooks: () => prefsAll<BookProfile>(STORES.books),
  deleteBook: (id: string) => prefsDelete(STORES.books, id),

  getAuthor: (key: string) => prefsGet<AuthorPreferenceEntity>(STORES.authors, key),
  putAuthor: (value: AuthorPreferenceEntity) => prefsPut(STORES.authors, value),
  allAuthors: () => prefsAll<AuthorPreferenceEntity>(STORES.authors),
  deleteAuthor: (key: string) => prefsDelete(STORES.authors, key),

  getGenre: (key: string) => prefsGet<GenrePreferenceEntity>(STORES.genres, key),
  putGenre: (value: GenrePreferenceEntity) => prefsPut(STORES.genres, value),
  allGenres: () => prefsAll<GenrePreferenceEntity>(STORES.genres),
  deleteGenre: (key: string) => prefsDelete(STORES.genres, key),

  getRating: (bookId: string) => prefsGet<BookRatingEntity>(STORES.ratings, bookId),
  putRating: (value: BookRatingEntity) => prefsPut(STORES.ratings, value),
  allRatings: () => prefsAll<BookRatingEntity>(STORES.ratings),
  deleteRating: (bookId: string) => prefsDelete(STORES.ratings, bookId),

  putEvent: (value: HistoryEvent) => prefsPut(STORES.events, value),
  allEvents: () => prefsAll<HistoryEvent>(STORES.events),
  clearEvents: () => prefsClear(STORES.events),

  clearAll: () => prefsClear(),
};
