import { BOOK_MAP, BOOKS } from '../data/books';
import type { AppState, BookMeta, Mode, ProgressEntry } from '../types';
import { clamp, hashCode } from './format';

export interface BookSignal {
  book: BookMeta;
  percent: number;
  weight: number;
  at: number;
  mode: Mode;
  finished: boolean;
}

export interface Taste {
  genres: Record<string, number>;
  tags: Record<string, number>;
  authors: Record<string, number>;
  read: BookSignal[];
  strength: number;
}

export interface Recommendation {
  book: BookMeta;
  score: number;
  reasons: string[];
  because?: BookMeta;
}

const HALF_LIFE_DAYS = 120;

function recency(ts: number, now: number): number {
  const days = Math.max(0, (now - ts) / 86_400_000);
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
}

function addCapped(target: Record<string, number>, key: string, value: number): void {
  target[key] = (target[key] ?? 0) + value;
}

function normalize(map: Record<string, number>): void {
  const max = Math.max(0, ...Object.values(map));
  if (max <= 0) return;
  for (const key of Object.keys(map)) map[key] = map[key] / max;
}

function ratingBoost(state: AppState, bookId: string): number {
  const rating = state.ratings[bookId];
  if (!rating) return 0.75;
  const starsPart = 0.55 + (rating.stars - 3) * 0.2;
  return clamp(starsPart + (rating.liked ? 0.25 : 0), 0.2, 1.2);
}

/** Строит «вкус» читателя из прогресса, оценок и времени чтения. */
export function buildTaste(state: AppState, now = Date.now()): Taste {
  const genres: Record<string, number> = {};
  const tags: Record<string, number> = {};
  const authors: Record<string, number> = {};
  const read: BookSignal[] = [];
  let strength = 0;

  const signals = new Map<string, { percent: number; at: number; mode: Mode; finishedAt?: number; startedAt: number }>();
  for (const [bookId, entry] of Object.entries(state.progress)) {
    signals.set(bookId, {
      percent: entry.percent,
      at: entry.updatedAt,
      mode: entry.lastMode,
      finishedAt: entry.finishedAt,
      startedAt: entry.startedAt,
    });
  }
  for (const [bookId, rating] of Object.entries(state.ratings)) {
    const existing = signals.get(bookId);
    if (existing) existing.at = Math.max(existing.at, rating.at);
    else
      signals.set(bookId, {
        percent: 0,
        at: rating.at,
        mode: 'read',
        startedAt: rating.at,
      });
  }

  for (const [bookId, signal] of signals) {
    const book = BOOK_MAP.get(bookId);
    if (!book) continue;
    const progressPart = signal.percent > 0 ? 0.35 + 0.65 * clamp(signal.percent / 100, 0, 1) : 0.3;
    const finishedBoost = signal.finishedAt ? 1.2 : 1;
    const weight = progressPart * ratingBoost(state, bookId) * recency(signal.at, now) * finishedBoost;
    if (weight <= 0.02) continue;
    strength += weight;
    addCapped(authors, book.author, weight);
    book.genres.forEach((genre) => addCapped(genres, genre, weight / book.genres.length));
    book.tags.forEach((tag) => addCapped(tags, tag, (weight * 0.8) / book.tags.length));
    read.push({
      book,
      percent: signal.percent,
      weight,
      at: signal.at,
      mode: signal.mode,
      finished: Boolean(signal.finishedAt),
    });
    if (signal.finishedAt) strength += 0.15;
  }

  normalize(genres);
  normalize(tags);
  normalize(authors);
  read.sort((a, b) => b.at - a.at);

  return { genres, tags, authors, read, strength };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const value of setA) if (setB.has(value)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

export function similarity(a: BookMeta, b: BookMeta): number {
  const genre = jaccard(a.genres, b.genres);
  const tag = jaccard(a.tags, b.tags);
  const author = a.author === b.author ? 1 : 0;
  return genre * 0.55 + tag * 0.33 + author * 0.12;
}

function reasonsFor(book: BookMeta, taste: Taste, state: AppState): { reasons: string[]; because?: BookMeta } {
  const reasons: string[] = [];
  let because: BookMeta | undefined;

  let bestSimilarity = 0;
  for (const signal of taste.read) {
    if (signal.book.id === book.id) continue;
    const value = similarity(book, signal.book);
    if (value > bestSimilarity) {
      bestSimilarity = value;
      because = signal.book;
    }
  }
  if (because && bestSimilarity >= 0.2) {
    reasons.push(`Похоже на «${because.title}»`);
  }

  const genreMatch = [...book.genres]
    .map((genre) => ({ genre, score: taste.genres[genre] ?? 0 }))
    .sort((a, b) => b.score - a.score)[0];
  if (genreMatch && genreMatch.score >= 0.55) {
    reasons.push(`Ваш любимый жанр — ${genreMatch.genre}`);
  }

  if ((taste.authors[book.author] ?? 0) >= 0.5) {
    reasons.push(`Вы цените ${book.author}`);
  }

  const tagMatch = [...book.tags]
    .map((tag) => ({ tag, score: taste.tags[tag] ?? 0 }))
    .sort((a, b) => b.score - a.score)[0];
  if (tagMatch && tagMatch.score >= 0.6 && reasons.length < 2) {
    reasons.push(`Атмосфера: ${tagMatch.tag.toLowerCase()}`);
  }

  if (reasons.length === 0) {
    const interest = book.genres.find((genre) => state.profile.interests.includes(genre));
    if (interest) reasons.push(`Вы выбрали «${interest}» при настройке`);
    else if (book.rating >= 4.8) reasons.push(`Высокий рейтинг — ${book.rating.toFixed(1)}`);
    else if (book.pages <= 130) reasons.push('Короткая — можно за вечер');
    else reasons.push('Популярно у читателей');
  }

  return { reasons: reasons.slice(0, 2), because };
}

function scoreBook(book: BookMeta, taste: Taste, state: AppState): { score: number; reasons: string[]; because?: BookMeta } {
  const genreScore = mean(book.genres.map((genre) => taste.genres[genre] ?? 0));
  const tagScore = mean(book.tags.map((tag) => taste.tags[tag] ?? 0));
  const authorScore = taste.authors[book.author] ?? 0;
  const quality = clamp((book.rating - 4.2) / 0.7, 0, 1);
  const popularity = clamp(Math.log10(book.reviews + 10) / 5.2, 0, 1);
  const interest = book.genres.some((genre) => state.profile.interests.includes(genre)) ? 1 : 0;
  const jitter = (hashCode(book.id) % 1000) / 100000;
  const coldStart = taste.strength < 0.15;

  const score = coldStart
    ? 0.3 * quality + 0.17 * popularity + 0.1 * interest + jitter
    : 0.4 * genreScore + 0.22 * tagScore + 0.16 * authorScore + 0.09 * quality + 0.06 * popularity + 0.07 * interest + jitter;

  const { reasons, because } = reasonsFor(book, taste, state);
  return { score, reasons, because };
}

export interface RecommendOptions {
  limit?: number;
  excludeIds?: string[];
  seedId?: string;
}

/** Персональные рекомендации: чем больше читаешь и оцениваешь, тем точнее выдача. */
export function recommend(state: AppState, options: RecommendOptions = {}): Recommendation[] {
  const { limit = 8, excludeIds = [], seedId } = options;
  const now = Date.now();
  const taste = buildTaste(state, now);
  const excluded = new Set(excludeIds);
  if (seedId) excluded.add(seedId);
  for (const [bookId, entry] of Object.entries(state.progress)) {
    if (entry.finishedAt || entry.percent > 2) excluded.add(bookId);
  }

  return BOOKS.filter((book) => !excluded.has(book.id))
    .map((book) => {
      const scored = scoreBook(book, taste, state);
      return { book, score: scored.score, reasons: scored.reasons, because: scored.because };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Похожие книги для карточки книги — не зависят от личного вкуса, но учитывают оценки. */
export function similarTo(state: AppState, bookId: string, limit = 6): Recommendation[] {
  const seed = BOOK_MAP.get(bookId);
  if (!seed) return [];
  const excluded = new Set<string>([bookId]);
  for (const [id, entry] of Object.entries(state.progress)) {
    if (entry.finishedAt) excluded.add(id);
  }
  return BOOKS.filter((book) => !excluded.has(book.id))
    .map((book) => {
      const base = similarity(seed, book);
      const likedAuthor = state.ratings[book.id]?.liked ? 0.04 : 0;
      const quality = clamp((book.rating - 4.2) / 0.7, 0, 1) * 0.03;
      const reasons: string[] = [];
      if (book.author === seed.author) reasons.push('Тот же автор');
      if (base >= 0.25) reasons.push(`Похожа на «${seed.title}»`);
      const sharedTag = book.tags.find((tag) => seed.tags.includes(tag));
      if (reasons.length < 2 && sharedTag) reasons.push(`Общая атмосфера: ${sharedTag.toLowerCase()}`);
      if (reasons.length === 0) reasons.push(`Жанр: ${book.genres[0]}`);
      return { book, score: base + likedAuthor + quality, reasons: reasons.slice(0, 2), because: seed };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Книга, по которой строится рекомендательная полка «Потому что вы читали…». */
export function becauseBook(state: AppState): { book: BookMeta; mode: Mode; percent: number } | null {
  const entries = Object.values(state.progress);
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => b.updatedAt - a.updatedAt);
  const active = sorted.find((entry) => !entry.finishedAt) ?? sorted[0];
  const book = BOOK_MAP.get(active.bookId);
  if (!book) return null;
  return { book, mode: active.lastMode, percent: active.percent };
}

/** Самая свежая незавершённая книга для блока «Продолжить». */
export function continueReading(state: AppState): { book: BookMeta; entry: ProgressEntry } | null {
  const entries = Object.values(state.progress).filter((entry) => !entry.finishedAt);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  const entry = entries[0];
  const book = BOOK_MAP.get(entry.bookId);
  if (!book) return null;
  return { book, entry };
}

export function favoriteGenres(state: AppState, limit = 3): string[] {
  const taste = buildTaste(state);
  return Object.entries(taste.genres)
    .filter(([, score]) => score > 0.2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([genre]) => genre);
}
