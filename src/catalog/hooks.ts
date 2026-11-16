/**
 * React-хуки сетевого каталога: поиск, новинки, жанры, карточка книги,
 * состояние источников, избранное и подписка на загрузки.
 *
 * Все хуки безопасны при размонтировании: сетевые запросы отменяются
 * через AbortController, поздние ответы не трогают состояние, а свежие
 * результаты кладутся в кэш каталога (TTL из cache.ts), чтобы не дёргать
 * сеть повторно на тот же запрос.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { downloads } from '../downloads/manager';
import type { DownloadTask, NetworkBook } from '../downloads/types';
import { newestBooks, popularBooks, searchAll, subjectBooks } from './aggregate';
import { booksCacheKey, cacheGet, cacheSet, recallBook, rememberBooks, searchCacheKey, TTL } from './cache';
import { checkSources, getSource } from './registry';
import type { CatalogBook, SearchQuery, SearchResult, SourceHealth } from './types';

export type DiscoverSection = 'newest' | 'popular';

/** Общее состояние любой подборки/поисковой выдачи. */
export interface CachedSearchState {
  result: SearchResult | null;
  loading: boolean;
  error: string | null;
  /** Данные взяты из кэша каталога, а не из сети. */
  fromCache: boolean;
  offline: boolean;
  refresh: () => void;
}

export interface CatalogSearchOptions {
  /** Не запускать запрос (например, пока пустая строка). */
  enabled?: boolean;
  limit?: number;
  /** Ограничить поиск конкретными источниками ([] — ни одного). */
  sourceIds?: string[];
  googleKey?: string | null;
  perSourceLimit?: number;
}

export interface DiscoverOptions {
  enabled?: boolean;
  limit?: number;
  googleKey?: string | null;
  perSourceLimit?: number;
}

export interface BookDetailsState {
  book: CatalogBook | null;
  loading: boolean;
  error: string | null;
  fromCache: boolean;
  offline: boolean;
  refresh: () => void;
}

export interface SourceHealthState {
  health: Record<string, SourceHealth>;
  loading: boolean;
  checkedAt: number | null;
  error: string | null;
  check: () => void;
}

export interface FavoritesState {
  favorites: string[];
  isFavorite: (bookId: string) => boolean;
  toggle: (bookId: string) => void;
  remove: (bookId: string) => void;
}

// --------------------------------------------------------------------------- //
// Базовые утилиты и общий загрузчик подборок
// --------------------------------------------------------------------------- //

function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

/** Дебаунс значения: не гоняем сеть на каждое нажатие клавиши. */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (delay <= 0) {
      setDebounced(value);
      return;
    }
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

/** Статус сети с подпиской на online/offline. */
function useOnlineState(): boolean {
  const [online, setOnline] = useState(isOnline);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return online;
}

/**
 * Общий загрузчик: кэш (TTL) → сеть → ошибка.
 * При офлайне отдаёт сохранённый результат, при появлении сети
 * автоматически повторяет запрос, а refresh() принудительно обновляет.
 */
function useCachedSearchResult(
  cacheKey: string | null,
  ttlMs: number,
  load: ((signal: AbortSignal) => Promise<SearchResult>) | null,
  enabled: boolean,
): CachedSearchState {
  const online = useOnlineState();
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [nonce, setNonce] = useState(0);

  const loadRef = useRef(load);
  const bypassCache = useRef(false);
  const prevOnline = useRef(online);
  loadRef.current = load;

  const refresh = useCallback(() => {
    bypassCache.current = true;
    setNonce((value) => value + 1);
  }, []);

  // Вернулась сеть — пробуем получить свежие данные, если показывали кэш/ошибку.
  useEffect(() => {
    if (online && !prevOnline.current) setNonce((value) => value + 1);
    prevOnline.current = online;
  }, [online]);

  const active = enabled && cacheKey !== null && load !== null;

  useEffect(() => {
    if (!active || cacheKey === null) {
      setResult(null);
      setLoading(false);
      setError(null);
      setFromCache(false);
      return;
    }

    const runner = loadRef.current;
    if (!runner) return;

    const controller = new AbortController();
    let alive = true;
    const bypass = bypassCache.current;
    bypassCache.current = false;

    const run = async () => {
      setLoading(true);
      setError(null);
      const offlineNow = !isOnline();

      const cached = bypass && !offlineNow ? null : await cacheGet<SearchResult>(cacheKey);
      if (!alive) return;
      if (cached) {
        setResult(cached);
        setFromCache(true);
        setLoading(false);
        if (offlineNow) return;
        // Кэш ещё свежий (TTL проверил cache.ts) — сеть не дёргаем.
        return;
      }

      if (offlineNow) {
        setLoading(false);
        setError('Нет сети — показаны сохранённые результаты');
        return;
      }

      try {
        const fresh = await runner(controller.signal);
        if (!alive || controller.signal.aborted) return;
        setResult(fresh);
        setFromCache(false);
        setError(null);
        void cacheSet(cacheKey, fresh, ttlMs);
        void rememberBooks(fresh.books);
      } catch {
        if (!alive || controller.signal.aborted) return;
        setError('Не удалось получить книги: проверьте соединение и попробуйте ещё раз');
      } finally {
        if (alive) setLoading(false);
      }
    };

    void run();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [active, cacheKey, nonce, ttlMs]);

  return { result, loading, error, fromCache, offline: !online, refresh };
}

// --------------------------------------------------------------------------- //
// Поиск и подборки
// --------------------------------------------------------------------------- //

/** Объединённый поиск по источникам с кэшем, отменой и офлайн-фолбэком. */
export function useCatalogSearch(query: SearchQuery, options: CatalogSearchOptions = {}): CachedSearchState {
  const { enabled = true, limit = 30, sourceIds, googleKey = null, perSourceLimit } = options;

  const text = query.text?.trim() ?? '';
  const title = query.title?.trim() ?? '';
  const author = query.author?.trim() ?? '';
  const isbn = query.isbn?.trim() ?? '';
  const subject = query.subject?.trim() ?? '';
  const sort = query.sort;
  const sourceTag = sourceIds ? [...sourceIds].sort().join('|') : 'all';
  const hasQuery = Boolean(text || title || author || isbn || subject);

  const cacheKey = useMemo(
    () =>
      hasQuery
        ? searchCacheKey({
            text: text || undefined,
            title: title || undefined,
            author: author || undefined,
            isbn: isbn || undefined,
            subject: subject || undefined,
            sort: sort ?? 'relevance',
            limit,
            sources: sourceTag || 'all',
          })
        : null,
    [hasQuery, text, title, author, isbn, subject, sort, limit, sourceTag],
  );

  const load = useCallback(
    (signal: AbortSignal) =>
      searchAll(
        {
          text: text || undefined,
          title: title || undefined,
          author: author || undefined,
          isbn: isbn || undefined,
          subject: subject || undefined,
          sort,
          limit,
        },
        { signal, sourceIds, googleKey, perSourceLimit: perSourceLimit ?? limit },
      ),
    [text, title, author, isbn, subject, sort, limit, sourceIds, googleKey, perSourceLimit],
  );

  return useCachedSearchResult(cacheKey, TTL.search, load, enabled);
}

/** Новинки или популярное из источников. */
export function useDiscover(section: DiscoverSection, options: DiscoverOptions = {}): CachedSearchState {
  const { enabled = true, limit = 12, googleKey = null, perSourceLimit } = options;

  const cacheKey = useMemo(
    () => booksCacheKey('discover', `${section}:${limit}:${googleKey ? 'key' : 'nokey'}`),
    [section, limit, googleKey],
  );

  const load = useCallback(
    (signal: AbortSignal) => {
      const request = { signal, googleKey, limit, perSourceLimit: perSourceLimit ?? limit };
      return section === 'newest' ? newestBooks(request) : popularBooks(request);
    },
    [section, googleKey, limit, perSourceLimit],
  );

  return useCachedSearchResult(cacheKey, TTL.discover, load, enabled);
}

/** Книги по теме/жанру. */
export function useSubjectBooks(
  subject: string | null | undefined,
  options: DiscoverOptions = {},
): CachedSearchState {
  const { enabled = true, limit = 24, googleKey = null, perSourceLimit } = options;
  const normalized = (subject ?? '').trim();

  const cacheKey = useMemo(
    () => (normalized ? booksCacheKey('subject', normalized.toLowerCase()) : null),
    [normalized],
  );

  const load = useCallback(
    (signal: AbortSignal) =>
      subjectBooks(normalized, { signal, googleKey, limit, perSourceLimit: perSourceLimit ?? limit }),
    [normalized, googleKey, limit, perSourceLimit],
  );

  return useCachedSearchResult(cacheKey, TTL.search, load, enabled && normalized.length > 0);
}

// --------------------------------------------------------------------------- //
// Карточка книги
// --------------------------------------------------------------------------- //

function splitBookId(bookId: string): { sourceId: string; externalId: string } {
  const index = bookId.indexOf(':');
  if (index === -1) return { sourceId: bookId, externalId: '' };
  return { sourceId: bookId.slice(0, index), externalId: bookId.slice(index + 1) };
}

/** Карточка книги: сначала recallBook из кэша, затем details() у источника. */
export function useBookDetails(bookId: string | undefined): BookDetailsState {
  const online = useOnlineState();
  const [book, setBook] = useState<CatalogBook | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [nonce, setNonce] = useState(0);
  const prevOnline = useRef(online);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (online && !prevOnline.current) setNonce((value) => value + 1);
    prevOnline.current = online;
  }, [online]);

  // Новый id — не показываем карточку предыдущей книги.
  useEffect(() => {
    setBook(null);
    setError(null);
    setFromCache(false);
  }, [bookId]);

  useEffect(() => {
    if (!bookId) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let alive = true;

    const run = async () => {
      setLoading(true);
      setError(null);

      const cached = await recallBook(bookId);
      if (!alive) return;
      if (cached) {
        setBook(cached);
        setFromCache(true);
      }

      if (!isOnline()) {
        setLoading(false);
        if (!cached) setError('Нет сети — карточка книги недоступна');
        return;
      }

      const { sourceId, externalId } = splitBookId(bookId);
      const source = getSource(sourceId);
      let fresh: CatalogBook | null = null;
      if (source?.details && externalId) {
        try {
          fresh = await source.details(externalId, { signal: controller.signal, online: true });
        } catch {
          fresh = null;
        }
      }
      if (!alive) return;

      if (fresh) {
        setBook(fresh);
        setFromCache(false);
        setError(null);
        void rememberBooks([fresh]);
      } else if (!cached) {
        setError(
          source?.details
            ? 'Не удалось загрузить карточку книги — попробуйте ещё раз'
            : 'Источник не отдаёт подробную карточку этой книги',
        );
      }
      setLoading(false);
    };

    void run();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [bookId, nonce]);

  return { book, loading, error, fromCache, offline: !online, refresh };
}

// --------------------------------------------------------------------------- //
// Источники
// --------------------------------------------------------------------------- //

/** Проверка доступности источников: один раз при монтировании и по кнопке. */
export function useSourceHealth(ids?: string[]): SourceHealthState {
  const [health, setHealth] = useState<Record<string, SourceHealth>>({});
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const idsRef = useRef(ids);
  const mountedRef = useRef(true);
  const startedRef = useRef(false);
  idsRef.current = ids;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runCheck = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await checkSources(idsRef.current);
      if (!mountedRef.current) return;
      setHealth(next);
      setCheckedAt(Date.now());
    } catch {
      if (!mountedRef.current) return;
      setError('Не удалось проверить источники');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void runCheck();
  }, [runCheck]);

  const check = useCallback((): void => {
    void runCheck();
  }, [runCheck]);

  return { health, loading, checkedAt, error, check };
}

// --------------------------------------------------------------------------- //
// Избранное (localStorage + событие для синхронизации между компонентами)
// --------------------------------------------------------------------------- //

const FAVORITES_KEY = 'polka:favorites';
const FAVORITES_EVENT = 'polka:favorites';

function readFavorites(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function writeFavorites(next: string[]): void {
  try {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
  } catch {
    /* приватный режим или переполнение — избранное просто не сохранится */
  }
  window.dispatchEvent(new Event(FAVORITES_EVENT));
}

/** Избранные сетевые книги: массив bookId в localStorage. */
export function useFavorites(): FavoritesState {
  const [favorites, setFavorites] = useState<string[]>(readFavorites);

  useEffect(() => {
    const sync = () => setFavorites(readFavorites());
    window.addEventListener(FAVORITES_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(FAVORITES_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const toggle = useCallback((bookId: string) => {
    const current = readFavorites();
    const next = current.includes(bookId)
      ? current.filter((id) => id !== bookId)
      : [...current, bookId];
    writeFavorites(next);
  }, []);

  const remove = useCallback((bookId: string) => {
    const current = readFavorites();
    if (!current.includes(bookId)) return;
    writeFavorites(current.filter((id) => id !== bookId));
  }, []);

  const isFavorite = useCallback((bookId: string) => favorites.includes(bookId), [favorites]);

  return { favorites, isFavorite, toggle, remove };
}

// --------------------------------------------------------------------------- //
// Подписка на менеджер загрузок
// --------------------------------------------------------------------------- //

let downloadsInit: Promise<void> | null = null;

/** Manager.init() идемпотентен — читаем библиотеку один раз на приложение. */
function ensureDownloadsReady(): Promise<void> {
  if (!downloadsInit) {
    try {
      downloadsInit = downloads.init().catch(() => undefined);
    } catch {
      downloadsInit = Promise.resolve();
    }
  }
  return downloadsInit;
}

function readTaskList(catalogId: string | undefined): DownloadTask[] {
  if (!catalogId) return [];
  try {
    return downloads.getTasks().filter((task) => task.book.id === catalogId);
  } catch {
    return [];
  }
}

function readDownloaded(catalogId: string | undefined): NetworkBook | undefined {
  if (!catalogId) return undefined;
  try {
    return downloads.findByCatalogId(catalogId);
  } catch {
    return undefined;
  }
}

/** Скачанная ли книга (реактивно обновляется после загрузок). */
export function useDownloadedBook(catalogId: string | undefined): NetworkBook | undefined {
  const [entry, setEntry] = useState<NetworkBook | undefined>(() => readDownloaded(catalogId));

  useEffect(() => {
    let alive = true;
    const update = () => {
      if (alive) setEntry(readDownloaded(catalogId));
    };
    update();
    void ensureDownloadsReady().then(update);
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = downloads.subscribe(update);
    } catch {
      unsubscribe = undefined;
    }
    return () => {
      alive = false;
      if (unsubscribe) unsubscribe();
    };
  }, [catalogId]);

  return entry;
}

/** Задачи скачивания именно этой книги. */
export function useDownloadTasks(catalogId: string | undefined): DownloadTask[] {
  const [tasks, setTasks] = useState<DownloadTask[]>(() => readTaskList(catalogId));

  useEffect(() => {
    let alive = true;
    const update = () => {
      if (alive) setTasks(readTaskList(catalogId));
    };
    update();
    void ensureDownloadsReady().then(update);
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = downloads.subscribe(update);
    } catch {
      unsubscribe = undefined;
    }
    return () => {
      alive = false;
      if (unsubscribe) unsubscribe();
    };
  }, [catalogId]);

  return tasks;
}
