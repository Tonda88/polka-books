/**
 * Модель данных системы предпочтений.
 *
 * Названия сущностей повторяют Room-схему из задания
 * (UserPreferencesEntity, BookRatingEntity, AuthorPreferenceEntity,
 * GenrePreferenceEntity), но проект — React + IndexedDB, поэтому это
 * интерфейсы записей в локальной базе, а не @Entity-классы.
 */

export type Reaction = 'love' | 'like' | 'neutral' | 'dislike' | 'hate';

/** Быстрые реакции и их шкала (1..5 звёзд). */
export const REACTIONS: Array<{ id: Reaction; label: string; stars: number; emoji: string }> = [
  { id: 'love', label: 'Очень понравилась', stars: 5, emoji: '🔥' },
  { id: 'like', label: 'Понравилась', stars: 4, emoji: '👍' },
  { id: 'neutral', label: 'Нейтрально', stars: 3, emoji: '😐' },
  { id: 'dislike', label: 'Не понравилась', stars: 2, emoji: '👎' },
  { id: 'hate', label: 'Совсем не моё', stars: 1, emoji: '🚫' },
];

export function reactionFromStars(stars: number): Reaction {
  if (stars >= 5) return 'love';
  if (stars === 4) return 'like';
  if (stars === 3) return 'neutral';
  if (stars === 2) return 'dislike';
  return 'hate';
}

export function starsFromReaction(reaction: Reaction): number {
  return REACTIONS.find((item) => item.id === reaction)?.stars ?? 3;
}

export function reactionLabel(reaction: Reaction): string {
  return REACTIONS.find((item) => item.id === reaction)?.label ?? 'Нейтрально';
}

export function isNegativeReaction(reaction: Reaction): boolean {
  return reaction === 'dislike' || reaction === 'hate';
}

export function isPositiveReaction(reaction: Reaction): boolean {
  return reaction === 'love' || reaction === 'like';
}

/**
 * Сохранённая карточка книги — «мини-каталог» всего, с чем
 * взаимодействовал пользователь. Нужна, чтобы рекомендации работали
 * и для сетевых книг, которых нет во встроенной библиотеке.
 */
export interface BookProfile {
  /** Стабильный id: `local:<id>` или `<sourceId>:<externalId>`. */
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  authors: string[];
  /** Жанры/категории (как их отдал источник и как их понял классификатор). */
  genres: string[];
  /** Поджанры / темы (subjects). */
  subgenres: string[];
  /** Литературная категория из классификатора (fiction/fantasy/…). */
  categories: string[];
  /** Серия/цикл, если источник сообщает. */
  series?: string;
  languages: string[];
  year?: number;
  description?: string;
  coverUrl?: string;
  /** Рейтинг источника (не пользовательский!). */
  externalRating?: number;
  externalRatingsCount?: number;
  /** Форматы, доступные к скачиванию. */
  formats: string[];
  /** Официальная страница источника. */
  pageUrl?: string;
  bytes?: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface RatingChange {
  at: number;
  stars: number;
  reaction: Reaction;
  /** Предыдущее значение (null — оценки не было). */
  previousStars: number | null;
  previousReaction: Reaction | null;
}

/** BookRatingEntity: пользовательская оценка (не смешивается с рейтингом источника). */
export interface BookRatingEntity {
  bookId: string;
  stars: number;
  reaction: Reaction;
  at: number;
  /** История изменений — пользователь может корректировать решения. */
  history: RatingChange[];
}

/** AuthorPreferenceEntity: накопленный вес автора. */
export interface AuthorPreferenceEntity {
  /** Нормализованный ключ (нижний регистр, без инициалов). */
  key: string;
  /** Отображаемое имя. */
  name: string;
  /** Вес интереса: >0 нравится, <0 не нравится. */
  score: number;
  /** Сырые счётчики для обучения и объяснений. */
  downloads: number;
  searches: number;
  reads: number;
  finished: number;
  positives: number;
  negatives: number;
  lastAt: number;
  /** Пользователь вручную скрыл автора из рекомендаций. */
  hidden?: boolean;
}

/** GenrePreferenceEntity: вес жанра/категории. */
export interface GenrePreferenceEntity {
  key: string;
  label: string;
  kind: 'genre' | 'category' | 'subgenre' | 'series';
  score: number;
  downloads: number;
  searches: number;
  reads: number;
  positives: number;
  negatives: number;
  lastAt: number;
  hidden?: boolean;
}

/** UserPreferencesEntity: агрегированный вкус + настройки. */
export interface UserPreferencesEntity {
  id: 'self';
  /** Веса характеристик (ключ → вес). */
  authors: Record<string, number>;
  genres: Record<string, number>;
  categories: Record<string, number>;
  subgenres: Record<string, number>;
  series: Record<string, number>;
  languages: Record<string, number>;
  /** Отрицательные веса: что отталкивает (снижает приоритет, но не запрещает). */
  negativeAuthors: Record<string, number>;
  negativeGenres: Record<string, number>;
  negativeCategories: Record<string, number>;
  negativeSubgenres: Record<string, number>;
  /** Число сигналов — определяет «холодный старт». */
  signalCount: number;
  updatedAt: number;
  /** Ручной сброс: изменить предпочтения вручную. */
  manualOverrides?: {
    hiddenAuthors?: string[];
    hiddenGenres?: string[];
    pinnedAuthors?: string[];
  };
}

export type HistoryKind =
  | 'search'
  | 'view'
  | 'download'
  | 'add_library'
  | 'read_start'
  | 'read_progress'
  | 'finish'
  | 'rating'
  | 'wishlist'
  | 'remove';

/** Событие истории: всё, что делал пользователь с книгами. */
export interface HistoryEvent {
  id: string;
  kind: HistoryKind;
  /** Поисковый запрос для kind=search. */
  query?: string;
  bookId?: string;
  title?: string;
  author?: string;
  genres?: string[];
  at: number;
  /** Дополнительные данные (звёзды, реакция, процент…). */
  meta?: Record<string, string | number | boolean>;
}

export interface ShelfBook {
  book: BookProfile;
  score: number;
  reasons: string[];
  /** Почему рекомендация: автор/серия/жанр/похожесть/новинка. */
  source: 'author' | 'series' | 'genre' | 'similar' | 'new' | 'popular' | 'continue';
  /** Карточка каталога для открытия и скачивания (заполняется в UI-слое). */
  catalogBook?: unknown;
}

export interface PreferenceSnapshot {
  at: number;
  topAuthors: Array<{ name: string; score: number }>;
  topGenres: Array<{ label: string; score: number }>;
  topSeries: Array<{ label: string; score: number }>;
  signalCount: number;
}
