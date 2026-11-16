import type { BookContent, BookStats, ChapterContent, DownloadProgress, Locator, ParagraphRef } from '../types';
import { idbDeleteBook, idbGetBook, idbPutBook } from './db';

const memory = new Map<string, BookContent>();
const BASE = import.meta.env.BASE_URL || '/';

export function libraryUrl(bookId: string): string {
  return `${BASE}library/${bookId}.json`;
}

export function computeBookStats(content: BookContent): BookStats {
  const paragraphs: ParagraphRef[] = [];
  const chapterStart: number[] = [];
  let chars = 0;
  let words = 0;
  content.chapters.forEach((chapter, chapterIndex) => {
    chapterStart.push(paragraphs.length);
    chapter.paragraphs.forEach((text, paragraphIndex) => {
      paragraphs.push({
        chapter: chapterIndex,
        paragraph: paragraphIndex,
        text,
        chapterTitle: chapter.title,
        startChars: chars,
      });
      chars += text.length + 1;
      words += text.trim() ? text.trim().split(/\s+/).length : 0;
    });
  });
  return { paragraphs, totalChars: chars, totalWords: words, chapterStart };
}

export function flatIndexAt(stats: BookStats, locator: Locator): number {
  const start = stats.chapterStart[locator.chapter];
  if (start === undefined) return 0;
  const index = start + locator.paragraph;
  return Math.min(Math.max(0, index), Math.max(0, stats.paragraphs.length - 1));
}

export function locatorAtFlat(stats: BookStats, flatIndex: number): Locator {
  const safe = Math.min(Math.max(0, flatIndex), stats.paragraphs.length - 1);
  const ref = stats.paragraphs[safe];
  if (!ref) return { chapter: 0, paragraph: 0 };
  return { chapter: ref.chapter, paragraph: ref.paragraph };
}

export function percentAtFlat(stats: BookStats, flatIndex: number): number {
  if (stats.paragraphs.length === 0) return 0;
  const ref = stats.paragraphs[flatIndex];
  if (!ref) return 100;
  return Math.min(100, Math.max(0, (ref.startChars / stats.totalChars) * 100));
}

export function percentAtLocator(stats: BookStats, locator: Locator): number {
  return percentAtFlat(stats, flatIndexAt(stats, locator));
}

export function locatorFromPercent(stats: BookStats, percent: number): Locator {
  const target = (percent / 100) * stats.totalChars;
  let index = 0;
  for (let i = 0; i < stats.paragraphs.length; i += 1) {
    if (stats.paragraphs[i].startChars <= target) index = i;
    else break;
  }
  return locatorAtFlat(stats, index);
}

export function chapterCharCounts(content: BookContent): number[] {
  return content.chapters.map((chapter) =>
    chapter.paragraphs.reduce((sum, paragraph) => sum + paragraph.length + 1, 0),
  );
}

export async function loadBookContent(bookId: string): Promise<BookContent> {
  const cached = memory.get(bookId);
  if (cached) return cached;

  const stored = await idbGetBook(bookId);
  if (stored) {
    const content: BookContent = { id: stored.id, chapters: stored.chapters };
    memory.set(bookId, content);
    return content;
  }

  let response: Response;
  try {
    response = await fetch(libraryUrl(bookId));
  } catch {
    throw new Error('Нет соединения с интернетом. Скачайте книгу заранее, чтобы читать офлайн.');
  }
  if (!response.ok) throw new Error('Не удалось загрузить книгу. Попробуйте позже.');
  const data = (await response.json()) as BookContent;
  if (!data?.chapters?.length) throw new Error('Файл книги повреждён.');
  memory.set(bookId, data);
  return data;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Скачивает текст книги по-настоящему: fetch + чтение потока с прогрессом,
 * затем сохраняет главы в IndexedDB — после этого книга доступна без интернета.
 */
export async function downloadBook(
  bookId: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<{ bytes: number; chapters: ChapterContent[] }> {
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(libraryUrl(bookId), { cache: 'no-cache' });
  } catch {
    throw new Error('Нет соединения. Проверьте интернет и попробуйте снова.');
  }
  if (!response.ok) throw new Error('Сервер не отдал файл книги. Попробуйте позже.');

  const total = Number(response.headers.get('content-length') ?? 0);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) throw new Error('Некорректный ответ сервера.');

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  onProgress?.({ loaded: 0, total, percent: 0 });

  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        const percent = total ? Math.min(99, Math.round((loaded / total) * 100)) : Math.min(90, loaded / 800);
        onProgress?.({ loaded, total, percent });
      }
      // Небольшая пауза, чтобы прогресс был видимым на маленьких текстовых файлах.
      await delay(45);
    }
  } else {
    const buffer = new Uint8Array(await response.arrayBuffer());
    chunks.push(buffer);
    loaded = buffer.byteLength;
  }

  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder('utf-8').decode(merged);

  let parsed: BookContent;
  try {
    parsed = JSON.parse(text) as BookContent;
  } catch {
    throw new Error('Не удалось прочитать файл книги.');
  }
  if (!parsed.chapters?.length) throw new Error('Книга пришла пустой.');

  const bytes = merged.byteLength;

  // Дорисовываем прогресс до 100%, если файл прилетел слишком быстро.
  const elapsed = performance.now() - startedAt;
  if (elapsed < 700) {
    const steps = 6;
    for (let step = 1; step <= steps; step += 1) {
      await delay(45);
      const percent = Math.min(100, 92 + Math.round((step / steps) * 8));
      onProgress?.({ loaded: bytes, total: bytes, percent });
    }
  } else {
    onProgress?.({ loaded: bytes, total: bytes, percent: 100 });
  }

  await idbPutBook({
    id: bookId,
    chapters: parsed.chapters,
    bytes,
    savedAt: Date.now(),
  });
  memory.set(bookId, { id: bookId, chapters: parsed.chapters });
  return { bytes, chapters: parsed.chapters };
}

export async function deleteDownloadedBook(bookId: string): Promise<void> {
  memory.delete(bookId);
  await idbDeleteBook(bookId);
}

export function isContentCached(bookId: string): boolean {
  return memory.has(bookId);
}
