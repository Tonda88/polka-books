/**
 * BookDownloadManager: скачивание найденного файла прямо в приложение.
 *
 * Прогресс → проверка целостности и формата → проверка DRM → извлечение
 * метаданных → сохранение в библиотеку. Пользователю не нужно открывать
 * сайт и искать кнопку скачивания.
 */
import { detectFormat } from '../downloads/detect';
import { readZipFile } from '../downloads/parsers/epub';
import { commitImport, prepareImport } from '../webcatalog/library';
import type { BookDraft } from '../webcatalog/types';
import { localUrl } from './config';
import type { BookFile } from './types';

export interface DownloadOutcome {
  ok: boolean;
  draft?: BookDraft;
  localId?: string;
  bytes?: number;
  error?: string;
}

export interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number, percent: number) => void;
  /** Не сохранять в библиотеку, только подготовить черновик. */
  prepareOnly?: boolean;
}

const MAX_BYTES = 512 * 1024 * 1024;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

/** Проверка EPUB на DRM: в ZIP есть META-INF/encryption.xml. */
async function hasDrm(bytes: Uint8Array, format: string): Promise<boolean> {
  if (format !== 'epub') return false;
  try {
    const encrypted = await readZipFile(
      toArrayBuffer(bytes),
      (path) => path.toLowerCase() === 'meta-inf/encryption.xml',
    );
    if (!encrypted) return false;
    // Пустой encryption.xml бывает даже без DRM — смотрим на наличие алгоритмов.
    const text = new TextDecoder('utf-8').decode(encrypted.data);
    return /EncryptedData|EncryptionMethod|AES|FontObfuscation/i.test(text);
  } catch {
    return false;
  }
}

function fileNameFor(file: BookFile, response: Response): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (match && match[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  const fromUrl = file.url.split('?')[0].split('/').pop();
  if (fromUrl && fromUrl.includes('.')) return decodeURIComponent(fromUrl);
  return `book.${file.format || 'bin'}`;
}

/**
 * Скачивает файл через серверный прокси (устраняет CORS), с прогрессом,
 * проверками и добавлением в библиотеку.
 */
export async function downloadBookFile(file: BookFile, options: DownloadOptions = {}): Promise<DownloadOutcome> {
  if (file.access !== 'ok') {
    return { ok: false, error: file.message || 'Файл недоступен для скачивания' };
  }

  // Сначала через прокси приложения (снимает CORS), затем напрямую.
  let response: Response | null = null;
  try {
    const proxied = await fetch(localUrl(`/api/fetch?url=${encodeURIComponent(file.url)}`), {
      signal: options.signal,
      headers: { Accept: '*/*' },
    });
    if (proxied.ok) response = proxied;
  } catch {
    response = null;
  }
  if (!response) {
    try {
      const directFetch = await fetch(file.url, { signal: options.signal, redirect: 'follow' });
      if (directFetch.ok) response = directFetch;
    } catch {
      response = null;
    }
  }
  if (!response) {
    return { ok: false, error: 'Не удалось скачать файл: сайт или прокси недоступны' };
  }

  const total = Number(response.headers.get('content-length') ?? 0);
  if (total > MAX_BYTES) {
    return { ok: false, error: 'Файл больше допустимого размера (512 МБ)' };
  }

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        if (loaded > MAX_BYTES) {
          await reader.cancel();
          return { ok: false, error: 'Файл превысил лимит при скачивании' };
        }
        const percent = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
        options.onProgress?.(loaded, total, percent);
        if (loaded > 2 * 1024 * 1024 && total === 0) {
          // Неизвестный размер: показываем хотя бы «качаем».
          options.onProgress?.(loaded, 0, 50);
        }
      }
    } else {
      const buffer = new Uint8Array(await response.arrayBuffer());
      chunks.push(buffer);
      loaded = buffer.byteLength;
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Скачивание прервалось' };
  }

  options.onProgress?.(loaded, total || loaded, 100);
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (bytes.length < 1024) {
    return { ok: false, error: 'Скачанный файл пустой или повреждён' };
  }

  // Проверка реального формата по сигнатурам, а не по расширению.
  const detected = detectFormat(bytes, response.headers.get('content-type') ?? '', file.url);
  if (detected.format === 'html' || detected.format === 'unknown') {
    return {
      ok: false,
      error: 'Сайт отдал не файл книги (HTML-страницу). Скачивание отменено.',
    };
  }
  if (await hasDrm(bytes, detected.format)) {
    return { ok: false, error: 'Файл защищён DRM — приложение не обходит защиту. Найдите издание без DRM.' };
  }

  const fileName = fileNameFor(file, response);
  const prepared = await prepareImport({
    kind: 'url',
    name: fileName,
    bytes,
    origin: file.url,
    mime: response.headers.get('content-type') ?? undefined,
  });
  if (!prepared.ok || !prepared.draft) {
    return { ok: false, error: prepared.error ?? 'Не удалось распознать книгу' };
  }

  if (options.prepareOnly) {
    return { ok: true, draft: prepared.draft, bytes: bytes.length };
  }

  const committed = await commitImport(prepared.draft, bytes);
  if (!committed.ok) {
    return { ok: false, error: committed.error ?? 'Не удалось добавить книгу в библиотеку' };
  }
  return {
    ok: true,
    draft: prepared.draft,
    localId: committed.localId,
    bytes: bytes.length,
  };
}
