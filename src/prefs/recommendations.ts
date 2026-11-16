/**
 * Персональные рекомендации поверх реального каталога.
 *
 * В отличие от старого recommend.ts (только 14 встроенных книг), здесь
 * кандидаты берутся из сетевых источников по интересам пользователя:
 * любимые авторы, серии, жанры, похожие темы, новинки жанров.
 *
 * Никаких фиктивных книг: всё, что показывается, пришло из Open Library,
 * Internet Archive, Gutenberg или LibriVox и открывается в карточке.
 */
import { newestBooks, popularBooks, searchAll, subjectBooks } from '../catalog/aggregate';
import { CATEGORIES } from '../catalog/classify';
import type { CatalogBook } from '../catalog/types';
import { downloads } from '../downloads/manager';
import { authorKey, normalizeWeight, scoreCandidate, strength } from './engine';
import { loadState, toProfile, type PreferenceState } from './repository';
import type { BookProfile, ShelfBook, UserPreferencesEntity } from './types';

export interface Shelf {
  id: 'forYou' | 'authors' | 'series' | 'similar' | 'newInGenres' | 'maybe';
  title: string;
  subtitle: string;
  /** Заголовок-объяснение (например, автор). */
  note?: string;
  books: ShelfBook[];
}

export interface RecommendationBundle {
  shelves: Shelf[];
  state: PreferenceState;
  /** Холодный старт: сигналов слишком мало. */
  coldStart: boolean;
  tookMs: number;
}

export interface BuildOptions {
  signal?: AbortSignal;
  googleKey?: string | null;
  limit?: number;
  /** Книга, для которой нужны «похожие» (карточка книги). */
  seed?: CatalogBook | BookProfile;
  /** Не запрашивать сеть (только локальные кандидаты). */
  offline?: boolean;
}

interface CacheEntry {
  at: number;
  bundle: RecommendationBundle;
  key: string;
}

let cache: CacheEntry | null = null;
const CACHE_TTL = 5 * 60_000;

function isCatalogBook(book: CatalogBook | BookProfile): book is CatalogBook {
  return 'files' in book && 'source' in book;
}

function profileOf(book: CatalogBook | BookProfile): BookProfile {
  return isCatalogBook(book) ? toProfile(book) : book;
}

function catalogOf(book: CatalogBook | BookProfile): CatalogBook | undefined {
  return isCatalogBook(book) ? book : undefined;
}

function topEntries(map: Record<string, number>, limit: number, exclude: Set<string> = new Set()): Array<[string, number]> {
  return Object.entries(map)
    .map(([key, score]) => [key, normalizeWeight(score)] as [string, number])
    .filter(([key, score]) => score > 0.08 && !exclude.has(key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function categoryQueries(categories: string[], genres: string[]): Array<{ label: string; query: string }> {
  const result: Array<{ label: string; query: string }> = [];
  for (const id of categories) {
    const category = CATEGORIES.find((item) => item.id === id);
    if (category) result.push({ label: category.label, query: category.query });
  }
  for (const genre of genres) {
    if (result.length >= 4) break;
    if (result.some((item) => item.query.toLowerCase() === genre.toLowerCase())) continue;
    result.push({ label: genre, query: genre });
  }
  return result.slice(0, 4);
}

function toShelfBook(
  book: CatalogBook | BookProfile,
  prefs: UserPreferencesEntity,
  source: ShelfBook['source'],
  extraReasons: string[] = [],
): ShelfBook {
  const profile = profileOf(book);
  const scored = scoreCandidate(prefs, profile);
  return {
    book: profile,
    score: scored.score,
    reasons: [...extraReasons, ...scored.reasons].slice(0, 3),
    source,
    catalogBook: catalogOf(book),
  };
}

/** Уже известные книги: сохранённые карточки, скачанные, оценённые. */
function knownIds(state: PreferenceState): Set<string> {
  const ids = new Set(state.books.map((book) => book.id));
  for (const rating of state.ratings) ids.add(rating.bookId);
  try {
    for (const book of downloads.getLibrary()) ids.add(book.id);
    for (const task of downloads.getTasks()) ids.add(task.book.id);
  } catch {
    /* менеджер может быть не инициализирован в тестах */
  }
  return ids;
}

function dedupe(books: Array<CatalogBook | BookProfile>): Array<CatalogBook | BookProfile> {
  const seen = new Set<string>();
  const result: Array<CatalogBook | BookProfile> = [];
  for (const book of books) {
    const id = profileOf(book).id;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(book);
  }
  return result;
}

/**
 * Собирает персональные полки. При отсутствии истории возвращает
 * «холодный старт» — популярные книги и новинки реального каталога.
 */
export async function buildRecommendations(options: BuildOptions = {}): Promise<RecommendationBundle> {
  const started = Date.now();
  const limit = options.limit ?? 10;
  const state = await loadState();
  const known = knownIds(state);
  if (options.seed) known.add(profileOf(options.seed).id);
  const prefs = state.prefs;
  const coldStart = prefs.signalCount < 3;

  const cacheKey = JSON.stringify({
    authors: topEntries(prefs.authors, 3).map(([key]) => key),
    series: topEntries(prefs.series, 2).map(([key]) => key),
    categories: topEntries(prefs.categories, 2).map(([key]) => key),
    genres: topEntries(prefs.genres, 3).map(([key]) => key),
    signals: prefs.signalCount,
    seed: options.seed ? profileOf(options.seed).id : null,
    offline: Boolean(options.offline),
  });
  const fresh =
    cache !== null && cache.key === cacheKey && Date.now() - cache.at < CACHE_TTL && !options.signal;
  if (fresh && cache) return cache.bundle;

  const hiddenAuthors = new Set(prefs.manualOverrides?.hiddenAuthors ?? []);
  const hiddenGenres = new Set(prefs.manualOverrides?.hiddenGenres ?? []);
  const topAuthors = topEntries(prefs.authors, 3, hiddenAuthors);
  const topSeries = topEntries(prefs.series, 2, hiddenGenres);
  const topCategories = topEntries(prefs.categories, 2, hiddenGenres);
  const topGenres = topEntries(prefs.genres, 3, hiddenGenres);
  const queries = categoryQueries(topCategories.map(([key]) => key), topGenres.map(([key]) => key));

  const emptyResult = { books: [] as CatalogBook[] };
  const [authorResults, seriesResults, genreResults, similarResults, newest, popular] = options.offline
    ? [
        [] as Array<{ key: string; name: string; result: { books: CatalogBook[] } }>,
        [] as Array<{ key: string; label: string; score: number; result: { books: CatalogBook[] } }>,
        [] as Array<{ query: { label: string; query: string }; result: { books: CatalogBook[] } }>,
        emptyResult,
        emptyResult,
        emptyResult,
      ]
    : await Promise.all([
        Promise.all(
          topAuthors.map(async ([key]) => {
            const authorName = state.authors.find((author) => author.key === key)?.name ?? key;
            const result = await searchAll({ author: authorName, limit: 8 }, { signal: options.signal, googleKey: options.googleKey });
            return { key, name: authorName, result };
          }),
        ),
        Promise.all(
          topSeries.map(async ([key, score]) => {
            const label = state.genres.find((genre) => genre.key === key)?.label ?? key;
            const result = await searchAll({ title: label, limit: 6 }, { signal: options.signal, googleKey: options.googleKey });
            return { key, label, score, result };
          }),
        ),
        Promise.all(
          queries.map(async (query) => {
            const result = await subjectBooks(query.query, {
              signal: options.signal,
              googleKey: options.googleKey,
              limit: 8,
            });
            return { query, result };
          }),
        ),
        options.seed
          ? (async () => {
              const seedProfile = profileOf(options.seed!);
              const subject = seedProfile.subgenres[0] ?? seedProfile.genres[0] ?? seedProfile.categories[0];
              if (!subject) return { books: [] };
              return subjectBooks(subject, { signal: options.signal, googleKey: options.googleKey, limit: 8 });
            })()
          : Promise.resolve({ books: [] }),
        newestBooks({ signal: options.signal, googleKey: options.googleKey, limit: 12 }),
        popularBooks({ signal: options.signal, googleKey: options.googleKey, limit: 12 }),
      ]);

  const shelves: Shelf[] = [];

  // 1. Для тебя — смесь лучших сигналов.
  const forYou: ShelfBook[] = dedupe([
    ...authorResults.flatMap((item) => item.result.books),
    ...seriesResults.flatMap((item) => item.result.books),
    ...genreResults.flatMap((item) => item.result.books),
    ...popular.books,
    ...newest.books,
  ])
    .filter((book) => !known.has(profileOf(book).id))
    .map((book) => toShelfBook(book, prefs, coldStart ? 'popular' : 'similar'))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (forYou.length > 0) {
    shelves.push({
      id: 'forYou',
      title: 'Для тебя',
      subtitle: coldStart ? 'Пока это популярные книги — оцените пару, и подборка станет личной' : 'Подобрано по вашим авторам, жанрам и оценкам',
      books: forYou,
    });
  }

  // 2. Авторы, которые тебе нравятся.
  const authorShelf = dedupe(authorResults.flatMap((item) => item.result.books));
  if (authorShelf.length > 0) {
    const books = authorShelf
      .filter((book) => !known.has(profileOf(book).id))
      .map((book) => {
        const profile = profileOf(book);
        const matchedAuthor = topAuthors.find(([key]) => profile.authors.some((author) => authorKey(author) === key));
        return toShelfBook(book, prefs, 'author', matchedAuthor ? [`Автор: ${matchedAuthor[0]}`] : []);
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    if (books.length > 0) {
      shelves.push({
        id: 'authors',
        title: 'Авторы, которые тебе нравятся',
        subtitle: 'Другие книги авторов из вашей истории',
        note: topAuthors.slice(0, 2).map(([key]) => key).join(', '),
        books,
      });
    }
  }

  // 3. Серии и циклы.
  const seriesBooks = dedupe(seriesResults.flatMap((item) => item.result.books)).filter(
    (book) => !known.has(profileOf(book).id),
  );
  if (seriesBooks.length > 0) {
    shelves.push({
      id: 'series',
      title: 'Продолжения и серии',
      subtitle: 'Книги из серий, которые вы читаете',
      note: topSeries.slice(0, 2).map(([key]) => key).join(', '),
      books: seriesBooks
        .map((book) => toShelfBook(book, prefs, 'series', [`Серия: ${profileOf(book).series ?? topSeries[0]?.[0] ?? ''}`]))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit),
    });
  }

  // 4. Похожие книги (для карточки книги — по теме seed).
  const similar = dedupe(similarResults.books)
    .filter((book) => !known.has(profileOf(book).id))
    .map((book) => toShelfBook(book, prefs, 'similar', options.seed ? [`Похоже на «${profileOf(options.seed).title}»`] : []))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (similar.length > 0 && options.seed) {
    shelves.push({
      id: 'similar',
      title: 'Похожие книги',
      subtitle: 'Та же тематика и жанр, другие авторы',
      books: similar,
    });
  }

  // 5. Новинки любимых жанров.
  const newInGenres = newest.books
    .filter((book) => {
      const profile = profileOf(book);
      if (known.has(profile.id)) return false;
      if (prefs.signalCount < 3) return true;
      const categoryHit = profile.categories.some((category) => (prefs.categories[category] ?? 0) > 0);
      const genreHit = profile.genres.some((genre) => (prefs.genres[genre.toLowerCase()] ?? 0) > 0);
      return categoryHit || genreHit;
    })
    .map((book) => toShelfBook(book, prefs, 'new'))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (newInGenres.length > 0) {
    shelves.push({
      id: 'newInGenres',
      title: 'Новинки твоих любимых жанров',
      subtitle: 'Свежие поступления из открытых библиотек',
      books: newInGenres,
    });
  }

  // 6. Возможно, тебе понравится — популярное с учётом негатива.
  const maybe = dedupe(popular.books)
    .filter((book) => !known.has(profileOf(book).id))
    .map((book) => toShelfBook(book, prefs, 'popular'))
    .filter((item) => item.score > -10)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (maybe.length > 0) {
    shelves.push({
      id: 'maybe',
      title: 'Возможно, тебе понравится',
      subtitle: 'Популярное у читателей — с учётом ваших оценок',
      books: maybe,
    });
  }

  const bundle: RecommendationBundle = {
    shelves,
    state,
    coldStart,
    tookMs: Date.now() - started,
  };
  cache = { at: Date.now(), bundle, key: cacheKey };
  return bundle;
}

/** Сбросить кэш рекомендаций (после новой оценки/скачивания). */
export function invalidateRecommendations(): void {
  cache = null;
}

/** «Похожие» для карточки книги: без изменения глобального кэша. */
export async function recommendationsFor(seed: CatalogBook | BookProfile, options: BuildOptions = {}): Promise<ShelfBook[]> {
  const bundle = await buildRecommendations({ ...options, seed, limit: options.limit ?? 8 });
  const similar = bundle.shelves.find((shelf) => shelf.id === 'similar');
  if (similar) return similar.books;
  const forYou = bundle.shelves.find((shelf) => shelf.id === 'forYou');
  return forYou?.books ?? [];
}

/** Сила вкуса (0..1) — для индикатора «система обучена на N%». */
export function tasteStrength(prefs: UserPreferencesEntity): number {
  return strength(Math.min(1, prefs.signalCount / 12));
}
