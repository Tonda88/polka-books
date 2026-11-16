/**
 * BookImportManager + BookLibraryRepository + BookDownloadManager.
 *
 * Импорт файла (из встроенного браузера, файловой системы, share) →
 * распознавание метаданных → сохранение в память приложения так,
 * чтобы книга сразу появилась в «Моих книгах», читалась офлайн
 * и участвовала в рекомендациях.
 */
import type { CatalogBook } from '../catalog/types';
import { categoriesOf } from '../catalog/classify';
import { downloads } from '../downloads/manager';
import type { BookContent } from '../types';
import { idbGetBook, idbGetNetBook, idbListNetBooks, idbPutBook, idbPutFile, idbPutNetBook, type StoredNetBookRecord } from '../lib/db';
import { parseDownloadedFile } from '../downloads/parsers';
import { detectFormat } from '../downloads/detect';
import { isProxyAvailable } from '../catalog/proxy';
import { recordLibraryAdd } from '../prefs/repository';
import type { BookProfile } from '../prefs/types';
import { extractMetadata } from './metadata';
import type { BookDraft, ImportResult, ImportSource } from './types';

const IMPORT_FORMATS = new Set(['epub', 'fb2', 'pdf', 'txt', 'mobi']);

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function hashBytes(bytes: Uint8Array): string {
  // FNV-1a: быстрый детерминированный id для дедупликации.
  let hash = 0x811c9dc5;
  const step = Math.max(1, Math.floor(bytes.length / 65536));
  for (let index = 0; index < bytes.length; index += step) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function fileNameOf(input: ImportSource): string {
  if (input.name && input.name.trim()) return input.name.trim();
  const fromUrl = input.origin?.split('/').pop()?.split('?')[0];
  return fromUrl && fromUrl.includes('.') ? decodeURIComponent(fromUrl) : `book-${Date.now()}`;
}

function formatLabel(format: string): string {
  return format.toUpperCase();
}

/** Дубликат по названию+автору или ISBN в уже сохранённых книгах. */
async function findDuplicate(draft: BookDraft): Promise<string | undefined> {
  const rows = (await idbListNetBooks<StoredNetBookRecord>()) as Array<Record<string, unknown>>;
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const title = normalize(draft.title ?? '');
  const author = normalize(draft.authors[0] ?? '');
  for (const row of rows) {
    const rowTitle = normalize(String(row.title ?? ''));
    const rowAuthors = Array.isArray(row.authors) ? normalize(row.authors.join(' ')) : '';
    if (draft.isbn && String(row.isbn ?? '') === draft.isbn) return String(row.id);
    if (title && rowTitle && (rowTitle === title || rowTitle.includes(title) || title.includes(rowTitle))) {
      if (!author || !rowAuthors || rowAuthors.includes(author) || author.includes(rowAuthors)) {
        return String(row.id);
      }
    }
  }
  return undefined;
}

/**
 * Сохранение импортированной книги. Возвращает локальный id для открытия
 * в читалке (`net:import:<hash>`).
 */
export async function saveDraftToLibrary(
  draft: BookDraft,
  bytes: Uint8Array,
  options: { origin?: string } = {},
): Promise<{ ok: boolean; localId?: string; duplicateOf?: string; error?: string }> {
  try {
    const duplicateOf = await findDuplicate(draft);
    if (duplicateOf) return { ok: true, localId: duplicateOf, duplicateOf };

    const externalId = hashBytes(bytes);
    const localId = `net:import:${externalId}`;
    const storageKey = `${localId}.${draft.format === 'unknown' ? 'bin' : draft.format}`;
    const mime = mimeFor(draft.format);

    // 1. Файл — в память приложения (доступен офлайн и для PDF-просмотрщика).
    const blob = new Blob([toArrayBuffer(bytes)], {
      type: mime,
    });
    await idbPutFile({ key: storageKey, blob, bytes: bytes.length, mime, savedAt: Date.now() });

    // 2. Текст — в хранилище читалки (если формат читается).
    let chapters = 0;
    let kind: 'text' | 'pdf' | 'audio' = draft.format === 'pdf' ? 'pdf' : 'text';
    if (draft.format === 'pdf') {
      chapters = 0;
    } else if (draft.format !== 'mobi' && draft.format !== 'unknown') {
      try {
        const parsed = await parseDownloadedFile({
          bytes: toArrayBuffer(bytes),
          format: draft.format as 'epub' | 'fb2' | 'txt',
        });
        if (parsed.content) {
          const content: BookContent = parsed.content;
          await idbPutBook({
            id: localId,
            chapters: content.chapters,
            bytes: bytes.length,
            savedAt: Date.now(),
          });
          chapters = content.chapters.length;
        }
      } catch (error) {
        // Файл повреждён — не сохраняем «пустую» книгу.
        const message = error instanceof Error ? error.message : 'Не удалось разобрать файл';
        return { ok: false, error: `Файл не читается: ${message}` };
      }
    }

    // 3. Запись в библиотеку (её читают «Мои книги», читалка и загрузки).
    const record = {
      id: localId,
      sourceId: 'import',
      sourceName: 'Интернет',
      externalId,
      title: draft.title || draft.fileName,
      authors: draft.authors.length > 0 ? draft.authors : ['Автор неизвестен'],
      year: draft.year,
      subjects: [draft.genre, draft.series].filter(Boolean),
      description: draft.description,
      publisher: draft.publisher,
      coverUrl: draft.coverDataUrl ?? draft.coverUrl,
      sourceUrl: options.origin,
      license: 'Файл добавлен пользователем',
      format: draft.format,
      kind,
      bytes: bytes.length,
      storageKey,
      savedAt: Date.now(),
      chapters,
    };
    await idbPutNetBook(record);
    await downloads.refreshLibrary();

    // 4. Интеграция с рекомендациями: автор, жанры, серия, язык.
    const profile: BookProfile = {
      id: `import:${externalId}`,
      sourceId: 'import',
      sourceName: 'Интернет',
      title: record.title,
      authors: record.authors,
      genres: [draft.genre, ...(draft.series ? [`Серия: ${draft.series}`] : [])].filter(Boolean) as string[],
      subgenres: draft.genre ? [draft.genre] : [],
      categories: categoriesOf({
        id: '',
        sourceId: 'import',
        externalId,
        title: record.title,
        authors: record.authors,
        subjects: [draft.genre].filter(Boolean) as string[],
        files: [],
        access: 'download',
        source: { sourceId: 'import', sourceName: 'Интернет' },
        fetchedAt: Date.now(),
      } as CatalogBook).map((category) => category.id),
      series: draft.series,
      languages: draft.languages,
      year: draft.year,
      description: draft.description,
      coverUrl: draft.coverDataUrl ?? draft.coverUrl,
      externalRating: undefined,
      externalRatingsCount: undefined,
      formats: [draft.format],
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    await recordLibraryAdd(profile);

    return { ok: true, localId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Не удалось сохранить книгу' };
  }
}

function mimeFor(format: string): string {
  switch (format) {
    case 'epub':
      return 'application/epub+zip';
    case 'fb2':
      return 'application/x-fictionbook+xml';
    case 'pdf':
      return 'application/pdf';
    case 'txt':
      return 'text/plain; charset=utf-8';
    case 'mobi':
      return 'application/x-mobipocket-ebook';
    default:
      return 'application/octet-stream';
  }
}

// ---------------------------------------------------------------------------
// BookImportManager
// ---------------------------------------------------------------------------

export interface PreparedImport {
  draft: BookDraft;
  bytes: Uint8Array;
}

/**
 * Готовит файл к добавлению: определяет формат, разбирает метаданные.
 * Файл ещё не сохранён в библиотеку — пользователь сначала видит карточку
 * и может исправить данные.
 */
export async function prepareImport(
  source: ImportSource,
  options: { offline?: boolean } = {},
): Promise<ImportResult> {
  try {
    const bytes = source.bytes;
    if (!bytes || bytes.length === 0) return { ok: false, error: 'Файл пуст' };
    if (bytes.length > 512 * 1024 * 1024) return { ok: false, error: 'Файл больше 512 МБ' };

    const fileName = fileNameOf(source);
    const detected = detectFormat(bytes, source.mime ?? '', fileName);
    if (!IMPORT_FORMATS.has(detected.format)) {
      return {
        ok: false,
        error: `Формат не поддерживается (${formatLabel(detected.format)}). Нужен EPUB, FB2, PDF, TXT или MOBI.`,
      };
    }
    const meta = await extractMetadata({
      bytes,
      fileName,
      mime: source.mime,
      offline: options.offline ?? false,
    });
    const draft: BookDraft = {
      ...meta,
      draftId: `draft:${Date.now()}`,
      fileName,
      fileSize: bytes.length,
      format: detected.format as BookDraft['format'],
      storageKey: '',
      confidence: meta.confidence,
      filledFrom: meta.filledFrom,
    };
    const duplicateOf = await findDuplicate(draft);
    if (duplicateOf) draft.duplicateOf = duplicateOf;
    return { ok: true, draft };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Не удалось прочитать файл' };
  }
}

/** Сохранение подготовленного черновика в библиотеку. */
export async function commitImport(draft: BookDraft, bytes: Uint8Array): Promise<{ ok: boolean; localId?: string; duplicateOf?: string; error?: string }> {
  return saveDraftToLibrary(draft, bytes);
}

// ---------------------------------------------------------------------------
// BookDownloadManager
// ---------------------------------------------------------------------------

function isFileUrl(url: string): boolean {
  return /\.(epub|fb2|pdf|txt|mobi)(\?|#|$)/i.test(url);
}

/** Скачивает файл по прямой ссылке (для PWA и для повторной попытки). */
export async function downloadToImport(url: string): Promise<ImportResult> {
  try {
    if (!isFileUrl(url)) {
      return { ok: false, error: 'Ссылка не похожа на файл книги (нужен EPUB/FB2/PDF/TXT/MOBI)' };
    }
    let target = url;
    if (url.startsWith('/')) {
      target = new URL(url, window.location.origin).toString();
    }
    let response: Response;
    try {
      response = await fetch(target, { redirect: 'follow' });
    } catch {
      // CORS/сеть: пробуем через наш прокси.
      if (await isProxyAvailable()) {
        response = await fetch(`/api/fetch?url=${encodeURIComponent(target)}`);
      } else {
        throw new Error('Не удалось скачать файл: сайт запрещает прямое скачивание (CORS)');
      }
    }
    if (!response.ok) throw new Error(`Сайт ответил ${response.status}`);
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const name = decodeURIComponent(target.split('/').pop()?.split('?')[0] ?? 'download');
    return prepareImport({ kind: 'url', name, bytes, origin: url, mime: response.headers.get('content-type') ?? undefined });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Не удалось скачать файл' };
  }
}

/** Проверяет, что книга уже сохранена (для кнопок «Читать»). */
export async function findSavedBook(localId: string): Promise<StoredNetBookRecord | undefined> {
  const book = await idbGetNetBook<StoredNetBookRecord>(localId);
  if (book) return book;
  const content = await idbGetBook(localId);
  return content ? ({ id: localId } as StoredNetBookRecord) : undefined;
}
