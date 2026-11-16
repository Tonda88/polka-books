/**
 * Определение языка и жанра книги — независимо от источника.
 *
 * Источники отдают язык по-разному: ISO-код (en, ru), название («English»,
 * «Русский»), иногда массив. Жанры — свободные строки subjects/categories.
 * Модуль приводит это к единым подписям и категориям для фильтров.
 */
import type { CatalogBook } from './types';

export interface LanguageInfo {
  /** ISO 639-1/2 или исходный код. */
  code: string;
  /** Название по-русски. */
  label: string;
}

const LANGUAGES: Record<string, string> = {
  ru: 'Русский',
  en: 'Английский',
  de: 'Немецкий',
  fr: 'Французский',
  es: 'Испанский',
  it: 'Итальянский',
  pt: 'Португальский',
  uk: 'Украинский',
  be: 'Белорусский',
  pl: 'Польский',
  cs: 'Чешский',
  nl: 'Нидерландский',
  sv: 'Шведский',
  no: 'Норвежский',
  da: 'Датский',
  fi: 'Финский',
  tr: 'Турецкий',
  ar: 'Арабский',
  he: 'Иврит',
  zh: 'Китайский',
  ja: 'Японский',
  ko: 'Корейский',
  hi: 'Хинди',
  la: 'Латинский',
  grc: 'Древнегреческий',
  el: 'Греческий',
  eo: 'Эсперанто',
};

/** Названия языков, которые источники пишут словами. */
const LANGUAGE_WORDS: Record<string, string> = {
  russian: 'ru',
  english: 'en',
  german: 'de',
  french: 'fr',
  spanish: 'es',
  italian: 'it',
  portuguese: 'pt',
  ukrainian: 'uk',
  polish: 'pl',
  dutch: 'nl',
  swedish: 'sv',
  norwegian: 'no',
  danish: 'da',
  finnish: 'fi',
  turkish: 'tr',
  arabic: 'ar',
  hebrew: 'he',
  chinese: 'zh',
  japanese: 'ja',
  korean: 'ko',
  latin: 'la',
  greek: 'el',
  русский: 'ru',
  английский: 'en',
  немецкий: 'de',
  французский: 'fr',
  испанский: 'es',
  итальянский: 'it',
  украинский: 'uk',
  польский: 'pl',
};

/** ISO-код из произвольной строки источника. */
export function languageCode(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const raw = value.trim().toLowerCase();
  if (!raw) return undefined;
  const word = LANGUAGE_WORDS[raw];
  if (word) return word;
  // «en-US», «eng», «ru_RU»
  const short = raw.split(/[-_]/)[0];
  if (LANGUAGES[short]) return short;
  if (LANGUAGES[raw.slice(0, 3)]) return raw.slice(0, 3);
  if (LANGUAGES[raw.slice(0, 2)]) return raw.slice(0, 2);
  if (/^[a-z]{2,3}$/.test(short)) return short;
  return undefined;
}

export function languageLabel(value: string | undefined | null): string | undefined {
  const code = languageCode(value);
  if (!code) return undefined;
  return LANGUAGES[code] ?? code.toUpperCase();
}

/** Основной язык книги: первый распознанный, иначе undefined. */
export function bookLanguage(book: CatalogBook): LanguageInfo | undefined {
  for (const value of book.languages ?? []) {
    const code = languageCode(value);
    if (code) return { code, label: LANGUAGES[code] ?? code.toUpperCase() };
  }
  return undefined;
}

/** Язык текста в подписи: «Английский» или пусто. */
export function bookLanguageLabel(book: CatalogBook): string | undefined {
  return bookLanguage(book)?.label;
}

// ---------------------------------------------------------------------------
// Категории
// ---------------------------------------------------------------------------

export type CategoryId =
  | 'fiction'
  | 'fantasy'
  | 'mystery'
  | 'romance'
  | 'poetry'
  | 'drama'
  | 'history'
  | 'science'
  | 'philosophy'
  | 'children'
  | 'reference'
  | 'other';

export interface Category {
  id: CategoryId;
  label: string;
  /** Строка для поиска по subject у источников. */
  query: string;
}

export const CATEGORIES: Category[] = [
  { id: 'fiction', label: 'Художественная', query: 'fiction' },
  { id: 'fantasy', label: 'Фантастика', query: 'science fiction' },
  { id: 'mystery', label: 'Детективы', query: 'mystery' },
  { id: 'romance', label: 'Любовные романы', query: 'romance' },
  { id: 'poetry', label: 'Поэзия', query: 'poetry' },
  { id: 'drama', label: 'Драма', query: 'drama' },
  { id: 'history', label: 'История', query: 'history' },
  { id: 'science', label: 'Наука', query: 'science' },
  { id: 'philosophy', label: 'Философия', query: 'philosophy' },
  { id: 'children', label: 'Детям', query: 'juvenile fiction' },
  { id: 'reference', label: 'Справочная', query: 'reference' },
];

/** Ключевые слова для распознавания категории по subjects и названию. */
const CATEGORY_KEYWORDS: Array<{ id: CategoryId; words: string[] }> = [
  {
    id: 'fantasy',
    words: ['science fiction', 'fantasy', 'фантастика', 'фэнтези', 'space', 'космос', 'dystop', 'utop'],
  },
  {
    id: 'mystery',
    words: ['mystery', 'detective', 'crime', 'thriller', 'детектив', 'триллер', 'убийств', 'сыщик'],
  },
  {
    id: 'romance',
    words: ['romance', 'love stories', 'любовн', 'мелодрам'],
  },
  {
    id: 'poetry',
    words: ['poetry', 'poem', 'verse', 'поэзия', 'поэма', 'стихи', 'стихотворен'],
  },
  {
    id: 'drama',
    words: ['drama', 'plays', 'theatre', 'theater', 'драма', 'пьеса', 'театр'],
  },
  {
    id: 'children',
    words: ['juvenile', 'children', 'fairy tales', 'сказк', 'детск', 'для детей'],
  },
  {
    id: 'history',
    words: ['history', 'historical', 'war', 'истори', 'война', 'биограф', 'biography', 'memoir'],
  },
  {
    id: 'science',
    words: ['science', 'physics', 'mathematics', 'biology', 'medicine', 'наука', 'физика', 'математ', 'биолог'],
  },
  {
    id: 'philosophy',
    words: ['philosophy', 'religion', 'ethics', 'философ', 'религи', 'этик'],
  },
  {
    id: 'reference',
    words: ['reference', 'dictionary', 'encyclopedia', 'справочн', 'словарь', 'энциклопед'],
  },
  {
    id: 'fiction',
    words: ['fiction', 'novel', 'prose', 'роман', 'повесть', 'рассказ', 'проза', 'literature'],
  },
];

function haystack(book: CatalogBook): string {
  return `${book.subjects.join(' ')} ${book.title} ${book.description ?? ''}`.toLowerCase();
}

/** Категории книги (может быть несколько). */
export function categoriesOf(book: CatalogBook): Category[] {
  const text = haystack(book);
  const found: Category[] = [];
  const seen = new Set<CategoryId>();
  for (const rule of CATEGORY_KEYWORDS) {
    if (seen.has(rule.id)) continue;
    if (rule.words.some((word) => text.includes(word))) {
      seen.add(rule.id);
      const category = CATEGORIES.find((item) => item.id === rule.id);
      if (category) found.push(category);
    }
  }
  if (found.length === 0) {
    const other = CATEGORIES.find((item) => item.id === 'fiction');
    if (other) found.push(other);
  }
  return found.slice(0, 3);
}

/** Основная категория книги (для бейджа и группировки). */
export function primaryCategory(book: CatalogBook): Category | undefined {
  return categoriesOf(book)[0];
}

/** Человекочитаемая подпись жанра: категория + первый subject. */
export function genreLabel(book: CatalogBook): string | undefined {
  const category = primaryCategory(book);
  const subject = book.subjects[0];
  if (category && subject && subject.toLowerCase() !== category.label.toLowerCase()) {
    return `${category.label} · ${subject}`;
  }
  return category?.label ?? subject;
}

/** Фильтр выдачи по категории (клиентский, без сетевых запросов). */
export function filterByCategory(book: CatalogBook, categoryId: CategoryId | 'all'): boolean {
  if (categoryId === 'all') return true;
  return categoriesOf(book).some((category) => category.id === categoryId);
}
