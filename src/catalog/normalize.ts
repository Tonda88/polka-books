import type { CatalogBook } from './types';

/** Нормализация названий и авторов для дедупликации. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[«»"'`]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s*[:;—–-]\s*(роман|повесть|рассказ|поэма|сборник|книга|роман в стихах|сказ)\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeAuthor(author: string): string {
  return author
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .slice(0, 4)
    .join(' ');
}

/** ISBN-10 → ISBN-13 (префикс 978 + контрольная цифра). */
export function isbn10To13(isbn10: string): string | undefined {
  const digits = isbn10.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (digits.length !== 10) return undefined;
  const body = '978' + digits.slice(0, 9);
  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += Number(body[index]) * (index % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return body + check;
}

/** ISBN-13 → ISBN-10 (только для префикса 978). */
export function isbn13To10(isbn13: string): string | undefined {
  const digits = isbn13.replace(/[^0-9]/g, '');
  if (digits.length !== 13 || !digits.startsWith('978')) return undefined;
  const body = digits.slice(3, 12);
  let sum = 0;
  for (let index = 0; index < 9; index += 1) {
    sum += Number(body[index]) * (10 - index);
  }
  const check = (11 - (sum % 11)) % 11;
  return body + (check === 10 ? 'X' : String(check));
}

export function normalizeIsbn(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (digits.length === 10 || digits.length === 13) return digits;
  return undefined;
}

/** Все эквивалентные записи ISBN: исходная, ISBN-13 и ISBN-10. */
export function isbnEquivalents(value: string | undefined | null): string[] {
  const normalized = normalizeIsbn(value);
  if (!normalized) return [];
  const result = new Set<string>([normalized]);
  if (normalized.length === 10) {
    const as13 = isbn10To13(normalized);
    if (as13) result.add(as13);
  } else {
    const as10 = isbn13To10(normalized);
    if (as10) result.add(as10);
  }
  return [...result];
}

export function cleanText(text: string | undefined | null, limit = 2000): string | undefined {
  if (!text) return undefined;
  const normalized = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return undefined;
  return normalized.length > limit ? `${normalized.slice(0, limit).trimEnd()}…` : normalized;
}

export function toYear(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const year = Math.trunc(value);
    return year >= 1000 && year <= new Date().getFullYear() + 2 ? year : undefined;
  }
  if (typeof value === 'string') {
    const match = value.match(/(1[0-9]{3}|20[0-9]{2})/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

/** Убирает повторы в списке строк без учёта регистра. */
export function uniqueStrings(values: (string | undefined | null)[]): string[] {
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

export function makeId(sourceId: string, externalId: string): string {
  return `${sourceId}:${externalId}`;
}

/** Доля схожести двух названий (0..1) — нужна для объединения дублей. */
export function titleSimilarity(a: string, b: string): number {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  if (shorter.length >= 8 && longer.includes(shorter)) return 0.85;
  const leftTokens = new Set(left.split(' '));
  const rightTokens = new Set(right.split(' '));
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

/**
 * Дубликаты ли это одной книги из разных источников.
 * Требуем совпадение названия и автора (или ISBN).
 */
export function isLikelyDuplicate(a: CatalogBook, b: CatalogBook): boolean {
  const isbnA = new Set((a.isbn ?? []).flatMap((value) => isbnEquivalents(value)));
  if (isbnA.size > 0) {
    for (const isbn of b.isbn ?? []) {
      if (isbnEquivalents(isbn).some((value) => isbnA.has(value))) return true;
    }
  }
  const titleScore = titleSimilarity(a.title, b.title);
  if (titleScore < 0.72) return false;
  if (a.authors.length === 0 || b.authors.length === 0) return titleScore >= 0.92;
  const authorA = normalizeAuthor(a.authors[0]);
  const authorB = normalizeAuthor(b.authors[0]);
  if (!authorA || !authorB) return titleScore >= 0.92;
  if (authorA === authorB) return true;
  // «Лев Толстой» и «Толстой Лев» — один автор: сравниваем наборы слов.
  const tokensA = new Set(authorA.split(' ').filter((token) => token.length > 1));
  const tokensB = new Set(authorB.split(' ').filter((token) => token.length > 1));
  let intersection = 0;
  for (const token of tokensA) if (tokensB.has(token)) intersection += 1;
  if (tokensA.size >= 2 && tokensB.size >= 2 && intersection >= 2) return true;
  // Одно слово (обычно фамилия) совпадает — достаточно при близком названии.
  const singleMatch = intersection >= 1 && Math.min(tokensA.size, tokensB.size) >= 1;
  return singleMatch && titleScore >= 0.86;
}
