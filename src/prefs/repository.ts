/**
 * RecommendationRepository + BookHistoryRepository.
 *
 * Единая точка записи действий пользователя и чтения профиля.
 * Все данные лежат в IndexedDB (`polka-prefs`) и переживают перезапуск.
 *
 * Реакция на действия:
 *  - поиск/просмотр — слабый интерес, сохраняем карточку книги и запрос;
 *  - скачивание/добавление в библиотеку — сильный интерес (но не оценка);
 *  - чтение/завершение — сигнал вкуса;
 *  - оценка/реакция — явное мнение, пересчитывает веса сразу.
 */
import { BOOKS, BOOK_MAP } from '../data/books';
import type { BookMeta } from '../types';
import type { CatalogBook } from '../catalog/types';
import { categoriesOf } from '../catalog/classify';
import { normalizeCoverUrl } from '../catalog/covers';
import { authorKey, buildModel, emptyPreferences, genreKey } from './engine';
import { prefs as store } from './storage';
import {
  REACTIONS,
  reactionFromStars,
  starsFromReaction,
  type AuthorPreferenceEntity,
  type BookProfile,
  type BookRatingEntity,
  type GenrePreferenceEntity,
  type HistoryEvent,
  type Reaction,
  type UserPreferencesEntity,
} from './types';

// ---------------------------------------------------------------------------
// Преобразование карточек в BookProfile
// ---------------------------------------------------------------------------

function unique(values: (string | undefined | null)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function joinAuthors(authors: string[]): string {
  return authors.join(', ');
}

function catalogToProfile(book: CatalogBook, now = Date.now()): BookProfile {
  const categories = categoriesOf(book).map((category) => category.id);
  return {
    id: book.id,
    sourceId: book.sourceId,
    sourceName: book.source.sourceName,
    title: book.title,
    authors: book.authors.length > 0 ? book.authors : ['Автор неизвестен'],
    genres: unique([...book.subjects.slice(0, 8)]),
    subgenres: unique([...book.subjects.slice(0, 8)]),
    categories: categories.length > 0 ? categories : ['fiction'],
    series: book.series,
    languages: book.languages ?? [],
    year: book.year,
    description: book.description,
    coverUrl: normalizeCoverUrl(book.coverUrl),
    externalRating: book.rating,
    externalRatingsCount: book.ratingsCount,
    formats: book.files.filter((file) => !file.requiresAuth).map((file) => file.format),
    pageUrl: book.source.pageUrl,
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

function localToProfile(book: BookMeta, now = Date.now()): BookProfile {
  return {
    id: book.id,
    sourceId: 'local',
    sourceName: book.source?.name ?? 'Полка',
    title: book.title,
    authors: book.author ? [book.author] : ['Автор неизвестен'],
    genres: unique(book.genres),
    subgenres: unique(book.tags),
    categories: unique(book.genres),
    languages: ['ru'],
    year: book.year,
    description: book.description,
    coverUrl: undefined,
    externalRating: book.rating,
    externalRatingsCount: book.reviews,
    formats: ['epub'],
    pageUrl: book.source?.page,
    bytes: book.bytes,
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

/** Приводит любую книгу (сетевую, встроенную или уже профиль) к BookProfile. */
export function toProfile(book: AnyBook | BookProfile): BookProfile {
  if ('subgenres' in book && 'firstSeenAt' in book) return book;
  if ('sourceId' in book) return catalogToProfile(book);
  return localToProfile(book);
}

export type AnyBook = CatalogBook | BookMeta | BookProfile;

/** Пытается найти карточку книги в уже сохранённых профилях/встроенной библиотеке. */
export function fallbackProfile(bookId: string): BookProfile | undefined {
  const local = BOOK_MAP.get(bookId);
  return local ? localToProfile(local) : undefined;
}

// ---------------------------------------------------------------------------
// Подписка на изменения (для React-хуков)
// ---------------------------------------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;

export function subscribePrefs(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  version += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* один подписчик не должен ломать остальных */
    }
  }
}

export function prefsVersion(): number {
  return version;
}

// ---------------------------------------------------------------------------
// Запись действий
// ---------------------------------------------------------------------------

async function saveBookProfile(profile: BookProfile): Promise<void> {
  const existing = await store.getBook(profile.id);
  await store.putBook({
    ...(existing ?? profile),
    ...profile,
    firstSeenAt: existing?.firstSeenAt ?? profile.firstSeenAt,
    lastSeenAt: Date.now(),
  });
}

async function pushEvent(event: Omit<HistoryEvent, 'id'>): Promise<void> {
  const id = `${event.kind}:${event.at}:${Math.random().toString(36).slice(2, 8)}`;
  await store.putEvent({ ...event, id });
}

/** Сохраняет историю поиска и карточки найденных книг. */
export async function recordSearch(query: string, books: Array<CatalogBook | BookMeta>): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) return;
  const profiles = books.slice(0, 8).map((book) => toProfile(book));
  for (const profile of profiles) await saveBookProfile(profile);
  await pushEvent({
    kind: 'search',
    query: trimmed,
    at: Date.now(),
    meta: {
      results: books.length,
      bookIds: profiles.map((profile) => profile.id).join('|'),
    },
  });
  await rebuildPreferences();
}

/** Открытие карточки книги — интерес (не чаще раза в 5 минут на книгу). */
export async function recordView(book: AnyBook): Promise<void> {
  const profile = toProfile(book);
  await saveBookProfile(profile);
  const recent = (await store.allEvents()).filter(
    (event) => event.kind === 'view' && event.bookId === profile.id && Date.now() - event.at < 5 * 60_000,
  );
  if (recent.length > 0) return;
  await pushEvent({
    kind: 'view',
    bookId: profile.id,
    title: profile.title,
    author: joinAuthors(profile.authors),
    genres: profile.genres,
    at: Date.now(),
  });
  await rebuildPreferences();
}

/** Скачивание книги — сильный интерес (не «понравилось»). */
export async function recordDownload(book: AnyBook): Promise<void> {
  const profile = toProfile(book);
  await saveBookProfile(profile);
  await pushEvent({
    kind: 'download',
    bookId: profile.id,
    title: profile.title,
    author: joinAuthors(profile.authors),
    genres: profile.genres,
    at: Date.now(),
    meta: { formats: profile.formats.join(',') },
  });
  await rebuildPreferences();
}

/** Добавление в локальную библиотеку / «хочу прочитать». */
export async function recordLibraryAdd(book: AnyBook, kind: 'add_library' | 'wishlist' = 'add_library'): Promise<void> {
  const profile = toProfile(book);
  await saveBookProfile(profile);
  await pushEvent({
    kind,
    bookId: profile.id,
    title: profile.title,
    author: joinAuthors(profile.authors),
    genres: profile.genres,
    at: Date.now(),
  });
  await rebuildPreferences();
}

/** Чтение/прослушивание: прогресс и завершение. */
export async function recordReading(
  book: AnyBook,
  percent: number,
  finished = false,
): Promise<void> {
  const profile = toProfile(book);
  await saveBookProfile(profile);
  const now = Date.now();
  const rounded = Math.round(percent);
  const events = await store.allEvents();
  const last = [...events]
    .reverse()
    .find((event) => event.bookId === profile.id && (event.kind === 'read_progress' || event.kind === 'read_start'));
  // Не плодим события на каждый абзац: не чаще раза в 10 минут или при шаге 10%.
  const lastPercent = Number(last?.meta?.percent ?? -100);
  const shouldWrite =
    !last || now - last.at > 10 * 60_000 || Math.abs(rounded - lastPercent) >= 10 || finished;
  if (shouldWrite) {
    await pushEvent({
      kind: finished ? 'finish' : percent > 0 ? 'read_progress' : 'read_start',
      bookId: profile.id,
      title: profile.title,
      author: joinAuthors(profile.authors),
      genres: profile.genres,
      at: now,
      meta: { percent: rounded },
    });
    await rebuildPreferences();
  }
}

/**
 * Оценка книги: 1..5 звёзд + быстрая реакция. Сохраняется история
 * изменений, чтобы пользователь мог менять решение.
 */
export async function rateBook(
  book: AnyBook,
  stars: number,
  reaction?: Reaction,
): Promise<BookRatingEntity> {
  const profile = toProfile(book);
  await saveBookProfile(profile);
  const normalizedStars = Math.max(1, Math.min(5, Math.round(stars)));
  const finalReaction = reaction ?? reactionFromStars(normalizedStars);
  const previous = await store.getRating(profile.id);
  const entry: BookRatingEntity = {
    bookId: profile.id,
    stars: normalizedStars,
    reaction: finalReaction,
    at: Date.now(),
    history: [
      ...(previous?.history ?? []),
      {
        at: Date.now(),
        stars: normalizedStars,
        reaction: finalReaction,
        previousStars: previous?.stars ?? null,
        previousReaction: previous?.reaction ?? null,
      },
    ].slice(-40),
  };
  await store.putRating(entry);
  await pushEvent({
    kind: 'rating',
    bookId: profile.id,
    title: profile.title,
    author: joinAuthors(profile.authors),
    genres: profile.genres,
    at: Date.now(),
    meta: { stars: normalizedStars, reaction: finalReaction },
  });
  await rebuildPreferences();
  return entry;
}

/** Быстрая реакция без выбора звёзд. */
export async function reactToBook(book: AnyBook, reaction: Reaction): Promise<BookRatingEntity> {
  return rateBook(book, starsFromReaction(reaction), reaction);
}

/** Сброс оценки (книга остаётся в истории, но мнение убирается). */
export async function clearRating(bookId: string): Promise<void> {
  await store.deleteRating(bookId);
  const profile = await store.getBook(bookId);
  await pushEvent({
    kind: 'remove',
    bookId,
    title: profile?.title,
    at: Date.now(),
  });
  await rebuildPreferences();
}

/** Пересчёт модели предпочтений из истории и оценок. */
export async function rebuildPreferences(): Promise<UserPreferencesEntity> {
  const [events, ratings, books] = await Promise.all([store.allEvents(), store.allRatings(), store.allBooks()]);
  const { prefs, authors } = buildModel(events, ratings, books);
  const previous = await store.getPrefs();
  const merged: UserPreferencesEntity = {
    ...prefs,
    // Ручные настройки пользователя не теряются при автоматическом пересчёте.
    manualOverrides: previous?.manualOverrides,
  };
  await store.putPrefs(merged);
  await saveAuthorPreferences(authors, books, merged);
  await saveGenrePreferences(merged);
  notify();
  return merged;
}

async function saveAuthorPreferences(
  authors: Record<string, { score: number; positives: number; negatives: number }>,
  books: BookProfile[],
  prefs: UserPreferencesEntity,
): Promise<void> {
  const statsByName = new Map<string, { downloads: number; searches: number; reads: number }>();
  for (const book of books) {
    for (const author of book.authors) {
      const key = authorKey(author);
      const stat = statsByName.get(key) ?? { downloads: 0, searches: 0, reads: 0 };
      if (book.formats.length > 0) stat.downloads += 1;
      statsByName.set(key, stat);
    }
  }
  for (const [key, stat] of Object.entries(authors)) {
    const existing = await store.getAuthor(key);
    const display = prefs.authors[key] !== undefined ? key : key;
    const entity: AuthorPreferenceEntity = {
      key,
      name: existing?.name ?? display,
      score: stat.score,
      downloads: existing?.downloads ?? 0,
      searches: existing?.searches ?? 0,
      reads: existing?.reads ?? 0,
      finished: existing?.finished ?? 0,
      positives: stat.positives,
      negatives: stat.negatives,
      lastAt: Date.now(),
      hidden: existing?.hidden,
    };
    await store.putAuthor(entity);
  }
}

async function saveGenrePreferences(prefs: UserPreferencesEntity): Promise<void> {
  const entries: Array<[string, number, GenrePreferenceEntity['kind']]> = [
    ...Object.entries(prefs.categories).map(([key, score]) => [key, score, 'category'] as [string, number, 'category']),
    ...Object.entries(prefs.genres).map(([key, score]) => [key, score, 'genre'] as [string, number, 'genre']),
    ...Object.entries(prefs.subgenres).map(([key, score]) => [key, score, 'subgenre'] as [string, number, 'subgenre']),
    ...Object.entries(prefs.series).map(([key, score]) => [key, score, 'series'] as [string, number, 'series']),
  ];
  for (const [key, score, kind] of entries) {
    const existing = await store.getGenre(key);
    await store.putGenre({
      key,
      label: existing?.label ?? key,
      kind,
      score,
      downloads: existing?.downloads ?? 0,
      searches: existing?.searches ?? 0,
      reads: existing?.reads ?? 0,
      positives: existing?.positives ?? 0,
      negatives: existing?.negatives ?? 0,
      lastAt: Date.now(),
      hidden: existing?.hidden,
    });
  }
}

// ---------------------------------------------------------------------------
// Чтение профиля
// ---------------------------------------------------------------------------

export interface PreferenceState {
  prefs: UserPreferencesEntity;
  books: BookProfile[];
  ratings: BookRatingEntity[];
  events: HistoryEvent[];
  authors: AuthorPreferenceEntity[];
  genres: GenrePreferenceEntity[];
}

export async function loadState(): Promise<PreferenceState> {
  const [prefsRaw, books, ratings, events, authors, genres] = await Promise.all([
    store.getPrefs(),
    store.allBooks(),
    store.allRatings(),
    store.allEvents(),
    store.allAuthors(),
    store.allGenres(),
  ]);
  return {
    prefs: prefsRaw ?? emptyPreferences(),
    books,
    ratings,
    events,
    authors,
    genres,
  };
}

/** Профили по списку id — для категорий «Моей библиотеки». */
export async function profilesByIds(ids: string[]): Promise<BookProfile[]> {
  const unique = [...new Set(ids)].slice(0, 100);
  const result: BookProfile[] = [];
  for (const id of unique) {
    const profile = await getBookProfile(id);
    if (profile) result.push(profile);
  }
  return result;
}

/** Сохранённый профиль книги по id (для рекомендаций и оценок). */
export async function getBookProfile(bookId: string): Promise<BookProfile | undefined> {
  return (await store.getBook(bookId)) ?? fallbackProfile(bookId);
}

/** Оценка книги: пользовательская (не смешивается с рейтингом источника). */
export async function getRating(bookId: string): Promise<BookRatingEntity | undefined> {
  return store.getRating(bookId);
}

export async function allRatings(): Promise<BookRatingEntity[]> {
  return store.allRatings();
}

// ---------------------------------------------------------------------------
// Категории личной библиотеки
// ---------------------------------------------------------------------------

export interface LibraryCategory {
  id: string;
  label: string;
  count: number;
  bookIds: string[];
}

/** Категории «Моей библиотеки» из задания (все данные — из локальной базы). */
export async function libraryCategories(): Promise<LibraryCategory[]> {
  const { books, ratings, events } = await loadState();
  const ratingMap = new Map(ratings.map((rating) => [rating.bookId, rating]));
  const readStarted = new Set(events.filter((event) => event.kind === 'read_start' || event.kind === 'read_progress' || event.kind === 'finish').map((event) => event.bookId ?? ''));
  const finished = new Set(events.filter((event) => event.kind === 'finish').map((event) => event.bookId ?? ''));
  const wishlist = new Set(events.filter((event) => event.kind === 'wishlist' || event.kind === 'add_library').map((event) => event.bookId ?? ''));
  const downloaded = new Set(events.filter((event) => event.kind === 'download').map((event) => event.bookId ?? ''));

  const favorite = books.filter((book) => (ratingMap.get(book.id)?.stars ?? 0) >= 4).map((book) => book.id);
  const disliked = books.filter((book) => (ratingMap.get(book.id)?.stars ?? 3) <= 2).map((book) => book.id);
  const reading = books
    .filter((book) => readStarted.has(book.id) && !finished.has(book.id) && wishlist.size >= 0)
    .map((book) => book.id);
  const read = books.filter((book) => finished.has(book.id)).map((book) => book.id);
  const want = books.filter((book) => (wishlist.has(book.id) || downloaded.has(book.id)) && !finished.has(book.id)).map((book) => book.id);

  return [
    { id: 'favorite', label: 'Любимые книги', count: favorite.length, bookIds: favorite },
    { id: 'reading', label: 'Читаю сейчас', count: reading.length, bookIds: reading },
    { id: 'read', label: 'Прочитанное', count: read.length, bookIds: read },
    { id: 'want', label: 'Хочу прочитать', count: want.length, bookIds: want },
    { id: 'disliked', label: 'Не понравилось', count: disliked.length, bookIds: disliked },
  ];
}

/** Вручную скрыть/вернуть автора или жанр в рекомендациях. */
export async function setManualPreference(
  kind: 'author' | 'genre',
  key: string,
  action: 'hide' | 'unhide',
): Promise<UserPreferencesEntity> {
  const current = (await store.getPrefs()) ?? emptyPreferences();
  const overrides = {
    hiddenAuthors: [...(current.manualOverrides?.hiddenAuthors ?? [])],
    hiddenGenres: [...(current.manualOverrides?.hiddenGenres ?? [])],
    pinnedAuthors: [...(current.manualOverrides?.pinnedAuthors ?? [])],
  };
  const list = kind === 'author' ? overrides.hiddenAuthors : overrides.hiddenGenres;
  const index = list.indexOf(key);
  if (action === 'hide' && index === -1) list.push(key);
  if (action === 'unhide' && index >= 0) list.splice(index, 1);
  const next: UserPreferencesEntity = { ...current, manualOverrides: overrides, updatedAt: Date.now() };
  await store.putPrefs(next);
  notify();
  return next;
}

/** Убирает накопленный негатив по автору или жанру (ручная коррекция). */
export async function clearNegative(kind: 'author' | 'genre', key: string): Promise<UserPreferencesEntity> {
  const current = (await store.getPrefs()) ?? emptyPreferences();
  const next: UserPreferencesEntity = { ...current };
  if (kind === 'author') {
    next.negativeAuthors = { ...next.negativeAuthors };
    delete next.negativeAuthors[key];
  } else {
    next.negativeGenres = { ...next.negativeGenres };
    delete next.negativeGenres[key];
    next.negativeCategories = { ...next.negativeCategories };
    delete next.negativeCategories[key];
  }
  next.updatedAt = Date.now();
  await store.putPrefs(next);
  notify();
  return next;
}

/** Полный сброс предпочтений и истории (кнопка «Сбросить обучение»). */
export async function resetPreferences(options: { keepRatings?: boolean } = {}): Promise<void> {
  if (options.keepRatings) {
    await store.clearEvents();
  } else {
    await store.clearAll();
  }
  await rebuildPreferences();
  notify();
}

/** История изменений оценок — для экрана «Мои оценки». */
export async function ratingHistory(): Promise<Array<{ bookId: string; title?: string; changes: BookRatingEntity['history'] }>> {
  const [ratings, books] = await Promise.all([store.allRatings(), store.allBooks()]);
  const titles = new Map(books.map((book) => [book.id, book.title]));
  return ratings
    .slice()
    .sort((a, b) => b.at - a.at)
    .map((rating) => ({ bookId: rating.bookId, title: titles.get(rating.bookId), changes: rating.history }));
}

/** Все реакции для UI. */
export const ALL_REACTIONS = REACTIONS;

/** Сколько всего сигналов накоплено (для «холодного старта»). */
export async function signalCount(): Promise<number> {
  const prefs = await store.getPrefs();
  return prefs?.signalCount ?? 0;
}

/** Встроенная библиотека как BookProfile — удобно для тестов и подсказок. */
export function builtinProfiles(): BookProfile[] {
  return BOOKS.map((book) => localToProfile(book));
}

export { authorKey, genreKey };
