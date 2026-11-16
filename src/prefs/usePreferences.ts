/**
 * React-хуки системы предпочтений.
 *
 * Компоненты не работают с IndexedDB напрямую: они подписываются на
 * repository и получают уже посчитанные данные. Любое действие
 * (оценка, скачивание, чтение) обновляет версию — полки пересчитываются.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CatalogBook } from '../catalog/types';
import { useApp } from '../lib/store';
import {
  allRatings,
  clearRating,
  getBookProfile,
  libraryCategories,
  loadState,
  rateBook,
  ratingHistory,
  reactToBook,
  resetPreferences,
  setManualPreference,
  subscribePrefs,
  prefsVersion,
  toProfile,
  type AnyBook,
  type LibraryCategory,
  type PreferenceState,
} from './repository';
import { buildRecommendations, invalidateRecommendations, recommendationsFor } from './recommendations';
import type { BookProfile, BookRatingEntity, Reaction, ShelfBook } from './types';

export { buildRecommendations, recommendationsFor, invalidateRecommendations };

function updateStoreRating(
  app: ReturnType<typeof useApp> | null,
  bookId: string,
  stars: number,
  reaction: Reaction,
): void {
  if (!app) return;
  // Синхронизация со старым хранилищем (экраны первой версии читают app.state.ratings).
  app.rateBook(bookId, stars, stars >= 4);
  app.pushToast(
    stars >= 4 ? `Оценено: ${stars} ★ — учтём в рекомендациях` : `Оценено: ${stars} ★ — предпочтения обновлены`,
    stars >= 4 ? 'success' : 'info',
  );
  // reaction используется движком через prefs/ratings, store хранит только stars/liked.
  void reaction;
}

/** Полное состояние предпочтений с подпиской на изменения. */
export function usePreferenceState(): {
  state: PreferenceState | null;
  loading: boolean;
  reload: () => Promise<void>;
} {
  const [state, setState] = useState<PreferenceState | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    const next = await loadState();
    if (mounted.current) {
      setState(next);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    const unsubscribe = subscribePrefs(() => {
      void reload();
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [reload]);

  return { state, loading, reload };
}

/** Оценка книги: значение + действия (поставить, изменить, сбросить). */
export function useBookRating(book: AnyBook | null): {
  rating: BookRatingEntity | undefined;
  setRating: (stars: number, reaction?: Reaction) => Promise<void>;
  setReaction: (reaction: Reaction) => Promise<void>;
  reset: () => Promise<void>;
  loading: boolean;
} {
  const app = useApp();
  const [rating, setRatingState] = useState<BookRatingEntity | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const bookId = book ? ('sourceId' in book ? book.id : book.id) : null;
  const bookRef = useRef(book);
  bookRef.current = book;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void allRatings().then((list) => {
      if (!alive) return;
      setRatingState(bookId ? list.find((item) => item.bookId === bookId) : undefined);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [bookId]);

  const setRating = useCallback(
    async (stars: number, reaction?: Reaction) => {
      const current = bookRef.current;
      if (!current) return;
      const entry = await rateBook(current, stars, reaction);
      setRatingState(entry);
      invalidateRecommendations();
      updateStoreRating(app, entry.bookId, entry.stars, entry.reaction);
    },
    [app],
  );

  const setReaction = useCallback(
    async (reaction: Reaction) => {
      const current = bookRef.current;
      if (!current) return;
      const entry = await reactToBook(current, reaction);
      setRatingState(entry);
      invalidateRecommendations();
      updateStoreRating(app, entry.bookId, entry.stars, entry.reaction);
    },
    [app],
  );

  const reset = useCallback(async () => {
    const current = bookRef.current;
    if (!current) return;
    await clearRating(current.id);
    setRatingState(undefined);
    invalidateRecommendations();
    app?.pushToast('Оценка сброшена — учтено в рекомендациях', 'info');
  }, [app]);

  return { rating, setRating, setReaction, reset, loading };
}

/** Персональные полки с рекомендациями из сети. */
export function useRecommendationShelves(options: {
  googleKey?: string | null;
  limit?: number;
  seed?: CatalogBook | BookProfile | null;
} = {}): {
  bundle: Awaited<ReturnType<typeof buildRecommendations>> | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const app = useApp();
  const googleKey = options.googleKey ?? app?.state.settings.googleBooksKey ?? null;
  const [bundle, setBundle] = useState<Awaited<ReturnType<typeof buildRecommendations>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(prefsVersion());

  useEffect(() => subscribePrefs(() => setVersion(prefsVersion())), []);

  const load = useCallback(
    async (force = false) => {
      setLoading(true);
      setError(null);
      try {
        if (force) invalidateRecommendations();
        const next = await buildRecommendations({
          googleKey,
          limit: options.limit ?? 10,
          seed: options.seed ?? undefined,
        });
        setBundle(next);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Не удалось построить рекомендации');
      } finally {
        setLoading(false);
      }
    },
    [googleKey, options.limit, options.seed],
  );

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleKey, options.limit, version]);

  return { bundle, loading, error, refresh: () => load(true) };
}

/** Похожие книги для карточки книги (сетевые + локальные). */
export function useSimilarBooks(book: AnyBook | null, limit = 8): ShelfBook[] {
  const app = useApp();
  const [books, setBooks] = useState<ShelfBook[]>([]);
  const googleKey = app?.state.settings.googleBooksKey ?? null;
  const id = book?.id ?? null;

  useEffect(() => {
    if (!book || !id) return;
    let alive = true;
    const seed = toProfile(book);
    void recommendationsFor(seed, { googleKey, limit })
      .then((list) => {
        if (alive) setBooks(list);
      })
      .catch(() => {
        if (alive) setBooks([]);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, limit, googleKey]);

  return books;
}

/** Категории личной библиотеки. */
export function useLibraryCategories(): LibraryCategory[] {
  const [categories, setCategories] = useState<LibraryCategory[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void libraryCategories().then((list) => {
        if (alive) setCategories(list);
      });
    };
    load();
    const unsubscribe = subscribePrefs(load);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return categories;
}

/** История оценок (для экрана предпочтений). */
export function useRatingHistory(): Awaited<ReturnType<typeof ratingHistory>> {
  const [history, setHistory] = useState<Awaited<ReturnType<typeof ratingHistory>>>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void ratingHistory().then((list: Awaited<ReturnType<typeof ratingHistory>>) => {
        if (alive) setHistory(list);
      });
    };
    load();
    const unsubscribe = subscribePrefs(load);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return history;
}

export { getBookProfile, setManualPreference, resetPreferences };
