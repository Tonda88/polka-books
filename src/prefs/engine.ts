/**
 * RecommendationEngine: система весов предпочтений.
 *
 * Чистые функции без IndexedDB и React — их проверяет scripts/check-prefs.mjs.
 *
 * Принципы из задания:
 *  - положительная оценка повышает интерес к характеристикам книги;
 *  - отрицательная снижает интерес к похожим характеристикам, но НЕ запрещает
 *    автора/жанр после одной оценки;
 *  - скачивание = интерес, но не «понравилось» (вес ниже, чем у оценки);
 *  - завершение чтения — дополнительный сигнал, не заменяет оценку;
 *  - всё затухает со временем (старые впечатления важны меньше);
 *  - ручные настройки пользователя имеют приоритет над автоматикой.
 */
import {
  isNegativeReaction,
  isPositiveReaction,
  type BookProfile,
  type BookRatingEntity,
  type HistoryEvent,
  type PreferenceSnapshot,
  type UserPreferencesEntity,
} from './types';

/** Полураспад веса сигнала, дней. */
const HALF_LIFE_DAYS = 180;
/** Насыщение веса: tanh(score / SCALE). */
const SCALE = 6;
/** После стольких негативных оценок автора его приоритет резко снижается. */
const NEGATIVE_AUTHOR_THRESHOLD = 2;
/** После стольких негативных оценок жанра его приоритет снижается. */
const NEGATIVE_GENRE_THRESHOLD = 3;

export function nowMs(): number {
  return Date.now();
}

/** Затухание сигнала по времени: 1 сейчас, 0.5 через полгода. */
export function decay(at: number, now = Date.now()): number {
  const days = Math.max(0, (now - at) / 86_400_000);
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
}

/** Вес события истории (до затухания). */
export function eventWeight(event: HistoryEvent): number {
  switch (event.kind) {
    case 'search':
      return 0.6;
    case 'view':
      return 0.9;
    case 'download':
      // Интерес, но не подтверждение вкуса.
      return 2.2;
    case 'add_library':
    case 'wishlist':
      return 1.2;
    case 'read_start':
      return 1.4;
    case 'read_progress': {
      const percent = Number(event.meta?.percent ?? 0);
      return 0.4 + Math.min(1.6, Math.max(0, percent) / 100 * 1.6);
    }
    case 'finish':
      // Дополнительный сигнал: книга дочитана, но это не оценка.
      return 2.4;
    case 'rating': {
      const stars = Number(event.meta?.stars ?? 3);
      return ratingWeight(stars);
    }
    case 'remove':
      return -0.6;
    default:
      return 0;
  }
}

/** Вес оценки: 1★ = −4 … 5★ = +5. Нейтральная 3★ — ноль. */
export function ratingWeight(stars: number): number {
  const map: Record<number, number> = { 1: -4, 2: -2.5, 3: 0, 4: 3, 5: 5 };
  return map[Math.round(stars)] ?? 0;
}

/** Нормализация суммы весов в диапазон (−1..1) с насыщением. */
export function normalizeWeight(score: number): number {
  return Math.tanh(score / SCALE);
}

function add(map: Record<string, number>, key: string, value: number): void {
  if (!key) return;
  map[key] = (map[key] ?? 0) + value;
}

export function authorKey(author: string): string {
  return author
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\s.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function genreKey(genre: string): string {
  return genre.toLowerCase().replace(/\s+/g, ' ').trim();
}

export interface BuildOptions {
  now?: number;
  /** Учитывать историю поиска при построении профиля. */
  includeSearch?: boolean;
}

export interface BuiltModel {
  prefs: UserPreferencesEntity;
  authors: Record<string, { score: number; positives: number; negatives: number }>;
  genres: Record<string, number>;
  /** Диагностика: сколько событий каждого типа учтено. */
  counted: Record<string, number>;
}

/**
 * Строит модель предпочтений из истории событий, оценок и карточек книг.
 * Вызывается после каждого действия (поиск, скачивание, оценка, чтение).
 */
export function buildModel(
  events: HistoryEvent[],
  ratings: BookRatingEntity[],
  books: BookProfile[],
  options: BuildOptions = {},
): BuiltModel {
  const now = options.now ?? Date.now();
  const includeSearch = options.includeSearch ?? true;
  const bookMap = new Map(books.map((book) => [book.id, book]));
  const prefs: UserPreferencesEntity = {
    id: 'self',
    authors: {},
    genres: {},
    categories: {},
    subgenres: {},
    series: {},
    languages: {},
    negativeAuthors: {},
    negativeGenres: {},
    negativeCategories: {},
    negativeSubgenres: {},
    signalCount: 0,
    updatedAt: now,
  };
  const authorStats: Record<string, { score: number; positives: number; negatives: number }> = {};
  const genreScores: Record<string, number> = {};
  const counted: Record<string, number> = {};

  const applyBook = (book: BookProfile | undefined, weight: number, isNegative: boolean): void => {
    if (!book || weight === 0) return;
    if (isNegative) {
      const magnitude = Math.abs(weight);
      for (const author of book.authors) {
        const key = authorKey(author);
        add(prefs.negativeAuthors, key, magnitude);
        if (!authorStats[key]) authorStats[key] = { score: 0, positives: 0, negatives: 0 };
        authorStats[key].negatives += 1;
        authorStats[key].score -= magnitude;
      }
      for (const genre of book.genres) {
        add(prefs.negativeGenres, genreKey(genre), magnitude / Math.max(1, book.genres.length));
      }
      for (const category of book.categories) {
        add(prefs.negativeCategories, category, magnitude);
        genreScores[category] = (genreScores[category] ?? 0) - magnitude;
      }
      for (const subject of book.subgenres) {
        add(prefs.negativeSubgenres, genreKey(subject), magnitude / Math.max(1, book.subgenres.length));
      }
      return;
    }

    for (const author of book.authors) {
      const key = authorKey(author);
      const share = weight / book.authors.length;
      add(prefs.authors, key, share);
      if (!authorStats[key]) authorStats[key] = { score: 0, positives: 0, negatives: 0 };
      authorStats[key].score += share;
      authorStats[key].positives += weight > 1.5 ? 1 : 0;
    }
    for (const genre of book.genres) {
      const share = weight / Math.max(1, book.genres.length);
      add(prefs.genres, genreKey(genre), share);
      genreScores[genreKey(genre)] = (genreScores[genreKey(genre)] ?? 0) + share;
    }
    for (const category of book.categories) {
      add(prefs.categories, category, weight);
      genreScores[category] = (genreScores[category] ?? 0) + weight;
    }
    for (const subject of book.subgenres) {
      add(prefs.subgenres, genreKey(subject), weight / Math.max(1, book.subgenres.length));
    }
    if (book.series) add(prefs.series, genreKey(book.series), weight);
    for (const language of book.languages) add(prefs.languages, language.toLowerCase(), weight / 2);
  };

  for (const event of events) {
    if (event.kind === 'search') {
      if (!includeSearch) continue;
      // Поиск сам по себе — слабый сигнал: интерес к запросу, а не к книге.
      const weight = eventWeight(event) * decay(event.at, now);
      if (weight === 0) continue;
      for (const key of searchBookIds(event)) {
        applyBook(bookMap.get(key), weight * 0.5, false);
      }
      counted.search = (counted.search ?? 0) + 1;
      continue;
    }
    const book = event.bookId ? bookMap.get(event.bookId) : undefined;
    if (!book) continue;
    const raw = eventWeight(event);
    const weight = raw * decay(event.at, now);
    if (weight === 0) continue;
    applyBook(book, weight, raw < 0);
    counted[event.kind] = (counted[event.kind] ?? 0) + 1;
    prefs.signalCount += 1;
  }

  // Оценки — отдельно и с приоритетом над историей: это явное мнение.
  for (const rating of ratings) {
    const book = bookMap.get(rating.bookId);
    if (!book) continue;
    const weight = ratingWeight(rating.stars) * decay(rating.at, now) * 1.4;
    applyBook(book, weight, isNegativeReaction(rating.reaction));
    prefs.signalCount += 1;
    counted.rating = (counted.rating ?? 0) + 1;
  }

  for (const [key, value] of Object.entries(genreScores)) {
    genreScores[key] = value;
  }
  return { prefs, authors: authorStats, genres: genreScores, counted };
}

function searchBookIds(event: HistoryEvent): string[] {
  const ids = event.meta?.bookIds;
  if (typeof ids !== 'string' || !ids) return [];
  return ids.split('|').filter(Boolean);
}

/** Нормализованная сила предпочтения (для UI и сравнений). */
export function strength(value: number): number {
  return normalizeWeight(value);
}

/** Оценка книги для рекомендаций: учитывает и позитив, и негатив. */
export interface ScoreBreakdown {
  score: number;
  reasons: string[];
  penalized: boolean;
  hidden: boolean;
}

export function scoreCandidate(prefs: UserPreferencesEntity, book: BookProfile): ScoreBreakdown {
  const reasons: string[] = [];
  let positive = 0;
  let negative = 0;
  let penalized = false;

  const hidden =
    Boolean(prefs.manualOverrides?.hiddenAuthors?.some((author) => book.authors.some((item) => authorKey(item) === author))) ||
    Boolean(prefs.manualOverrides?.hiddenGenres?.some((genre) => book.genres.some((item) => genreKey(item) === genre) || book.categories.includes(genre)));

  const authorScores = book.authors.map((author) => normalizeWeight(prefs.authors[authorKey(author)] ?? 0));
  const bestAuthor = Math.max(0, ...authorScores);
  if (bestAuthor > 0.1) {
    positive += bestAuthor * 3.2;
    const name = book.authors[authorScores.indexOf(bestAuthor)];
    reasons.push(`Автор: ${name}`);
  }

  const genreScores = book.genres.map((genre) => normalizeWeight(prefs.genres[genreKey(genre)] ?? 0));
  const bestGenre = Math.max(0, ...genreScores);
  if (bestGenre > 0.1) {
    positive += bestGenre * 2.0;
    const name = book.genres[genreScores.indexOf(bestGenre)];
    reasons.push(`Жанр: ${name}`);
  }

  const categoryScores = book.categories.map((category) => normalizeWeight(prefs.categories[category] ?? 0));
  const bestCategory = Math.max(0, ...categoryScores);
  if (bestCategory > 0.1) {
    positive += bestCategory * 1.6;
    if (reasons.length < 2) reasons.push(`Категория: ${book.categories[categoryScores.indexOf(bestCategory)]}`);
  }

  const subjectScores = book.subgenres.map((subject) => normalizeWeight(prefs.subgenres[genreKey(subject)] ?? 0));
  const bestSubject = Math.max(0, ...subjectScores);
  if (bestSubject > 0.08) {
    positive += bestSubject * 1.1;
    if (reasons.length < 2) reasons.push(`Тема: ${book.subgenres[subjectScores.indexOf(bestSubject)]}`);
  }

  if (book.series) {
    const seriesScore = normalizeWeight(prefs.series[genreKey(book.series)] ?? 0);
    if (seriesScore > 0.05) {
      positive += seriesScore * 2.4;
      reasons.unshift(`Серия: ${book.series}`);
    }
  }

  const languageScores = book.languages.map((language) => normalizeWeight(prefs.languages[language.toLowerCase()] ?? 0));
  const bestLanguage = Math.max(0, ...languageScores);
  if (bestLanguage > 0.1) positive += bestLanguage * 0.5;

  // Негатив снижает приоритет, но не обнуляет.
  const authorNegatives = book.authors.map((author) => prefs.negativeAuthors[authorKey(author)] ?? 0);
  const maxAuthorNegative = Math.max(0, ...authorNegatives);
  if (maxAuthorNegative > 1.5) {
    negative += normalizeWeight(maxAuthorNegative) * 2.6;
    penalized = true;
    if (maxAuthorNegative >= NEGATIVE_AUTHOR_THRESHOLD * 2) negative += 1.2;
  }

  const genreNegatives = book.genres.map((genre) => prefs.negativeGenres[genreKey(genre)] ?? 0);
  const maxGenreNegative = Math.max(0, ...genreNegatives);
  if (maxGenreNegative > 1.5) {
    negative += normalizeWeight(maxGenreNegative) * 1.8;
    penalized = true;
    if (maxGenreNegative >= NEGATIVE_GENRE_THRESHOLD * 2) negative += 0.8;
  }

  const categoryNegatives = book.categories.map((category) => prefs.negativeCategories[category] ?? 0);
  const maxCategoryNegative = Math.max(0, ...categoryNegatives);
  if (maxCategoryNegative > 1.5) {
    negative += normalizeWeight(maxCategoryNegative) * 1.2;
    penalized = true;
  }

  // Качество и популярность источника — только как небольшой бонус.
  const quality = book.externalRating ? Math.max(0, (book.externalRating - 3.5) / 1.5) : 0;
  positive += Math.min(1, quality) * 0.6;

  const total = prefs.signalCount;
  const coldStart = total < 3;
  const score = hidden ? -100 : positive - negative + (coldStart ? 0.1 : 0);

  if (penalized && reasons.length > 0) reasons.push('Учтены прошлые негативные оценки');
  return { score, reasons: reasons.slice(0, 3), penalized, hidden };
}

/** Ручной сброс/скрытие авторов и жанров. */
export function withManualOverride(
  prefs: UserPreferencesEntity,
  kind: 'author' | 'genre',
  key: string,
  action: 'hide' | 'unhide' | 'pin' | 'unpin',
): UserPreferencesEntity {
  const overrides = {
    hiddenAuthors: [...(prefs.manualOverrides?.hiddenAuthors ?? [])],
    hiddenGenres: [...(prefs.manualOverrides?.hiddenGenres ?? [])],
    pinnedAuthors: [...(prefs.manualOverrides?.pinnedAuthors ?? [])],
  };
  const list =
    kind === 'author'
      ? action === 'pin' || action === 'unpin'
        ? overrides.pinnedAuthors
        : overrides.hiddenAuthors
      : overrides.hiddenGenres;
  const index = list.indexOf(key);
  if (action === 'hide' || action === 'pin') {
    if (index === -1) list.push(key);
  } else if (index >= 0) {
    list.splice(index, 1);
  }
  return { ...prefs, manualOverrides: overrides, updatedAt: Date.now() };
}

/** Снимок предпочтений для экрана профиля. */
export function preferenceSnapshot(prefs: UserPreferencesEntity, limit = 6): PreferenceSnapshot {
  const topAuthors = Object.entries(prefs.authors)
    .map(([key, score]) => ({ name: key, score: normalizeWeight(score) }))
    .filter((item) => item.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const topGenres = [
    ...Object.entries(prefs.categories).map(([label, score]) => ({ label, score: normalizeWeight(score) })),
    ...Object.entries(prefs.genres).map(([label, score]) => ({ label, score: normalizeWeight(score) })),
  ]
    .filter((item) => item.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const topSeries = Object.entries(prefs.series)
    .map(([label, score]) => ({ label, score: normalizeWeight(score) }))
    .filter((item) => item.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { at: prefs.updatedAt, topAuthors, topGenres, topSeries, signalCount: prefs.signalCount };
}

/** Пустые предпочтения (первый запуск). */
export function emptyPreferences(): UserPreferencesEntity {
  return {
    id: 'self',
    authors: {},
    genres: {},
    categories: {},
    subgenres: {},
    series: {},
    languages: {},
    negativeAuthors: {},
    negativeGenres: {},
    negativeCategories: {},
    negativeSubgenres: {},
    signalCount: 0,
    updatedAt: Date.now(),
  };
}

export { isNegativeReaction, isPositiveReaction };
export { reactionFromStars, starsFromReaction } from './types';
