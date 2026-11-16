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

export function normalizeIsbn(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (digits.length === 10 || digits.length === 13) return digits;
  return undefined;
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
  const isbnA = new Set((a.isbn ?? []).map((value) => normalizeIsbn(value)).filter(Boolean) as string[]);
  if (isbnA.size > 0) {
    for (const isbn of b.isbn ?? []) {
      const normalized = normalizeIsbn(isbn);
      if (normalized && isbnA.has(normalized)) return true;
    }
  }
  const titleScore = titleSimilarity(a.title, b.title);
  if (titleScore < 0.72) return false;
  if (a.authors.length === 0 || b.authors.length === 0) return titleScore >= 0.92;
  const authorA = normalizeAuthor(a.authors[0]);
  const authorB = normalizeAuthor(b.authors[0]);
  if (!authorA || !authorB) return titleScore >= 0.92;
  if (authorA === authorB) return true;
  // Фамилия совпадает — достаточно при почти идентичном названии.
  const surnameA = authorA.split(' ').slice(-1)[0];
  const surnameB = authorB.split(' ').slice(-1)[0];
  return surnameA === surnameB && titleScore >= 0.86;
}
