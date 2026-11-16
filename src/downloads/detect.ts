/**
 * Проверка и определение формата скачанного файла.
 *
 * Главный принцип: доверяем байтам, а не заголовку Content-Type. Источники
 * регулярно отдают `application/octet-stream`, а вместо книги — HTML-страницу
 * с ошибкой/заглушкой. Поэтому формат определяется по магическим сигнатурам,
 * а MIME и расширение используются только как подсказки.
 */
import type { BookFormat } from '../catalog/types';
import type { ContentKind } from './types';
import { AUDIO_FORMATS, DEFAULT_LIMITS, FORMAT_LABEL, READABLE_FORMATS, VIEWABLE_FORMATS } from './types';

export type DetectionConfidence = 'magic' | 'mime' | 'extension' | 'unknown';

export interface DetectedFormat {
  format: BookFormat;
  kind: ContentKind;
  mime: string;
  confidence: DetectionConfidence;
}

// --------------------------------------------------------------------------- //
// Байтовые утилиты
// --------------------------------------------------------------------------- //

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return '';
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

function startsWithBytes(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

function extensionOf(url: string): string {
  if (!url) return '';
  let path = url;
  try {
    path = new URL(url, 'https://polka.local/').pathname;
  } catch {
    path = url.split('?')[0].split('#')[0];
  }
  const match = /\.([a-z0-9]{2,5})$/i.exec(path.toLowerCase());
  return match ? match[1] : '';
}

function cleanMime(mime: string): string {
  return (mime || '').split(';')[0].trim().toLowerCase();
}

// --------------------------------------------------------------------------- //
// ZIP: чтение центральной директории (общая часть для EPUB/FB2-zip)
// --------------------------------------------------------------------------- //

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

export interface ZipDirectoryEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function decodeZipName(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return latin1(bytes);
  }
}

function findLocalSignature(bytes: Uint8Array, from: number): number {
  for (let i = Math.max(0, from); i + 4 <= bytes.length; i += 1) {
    if (u32(bytes, i) === SIG_LOCAL) return i;
  }
  return -1;
}

/**
 * Читает список файлов ZIP. Возвращает null, если это не ZIP или архив сильно
 * повреждён (нет ни центральной директории, ни читаемых local-заголовков).
 */
export function readZipDirectory(bytes: Uint8Array): ZipDirectoryEntry[] | null {
  if (bytes.length < 22) return null;
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) return null;
  if (!(bytes[2] === 3 || bytes[2] === 5 || bytes[2] === 7)) return null;

  const minEocd = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= minEocd; i -= 1) {
    if (u32(bytes, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }

  if (eocd >= 0) {
    const count = u16(bytes, eocd + 10);
    const centralOffset = u32(bytes, eocd + 16);
    if (count !== 0xffff && centralOffset !== 0xffffffff && centralOffset < bytes.length) {
      const entries: ZipDirectoryEntry[] = [];
      let pos = centralOffset;
      for (let i = 0; i < count; i += 1) {
        if (pos + 46 > bytes.length || u32(bytes, pos) !== SIG_CENTRAL) break;
        const nameLength = u16(bytes, pos + 28);
        const extraLength = u16(bytes, pos + 30);
        const commentLength = u16(bytes, pos + 32);
        if (pos + 46 + nameLength > bytes.length) break;
        entries.push({
          name: decodeZipName(bytes.subarray(pos + 46, pos + 46 + nameLength)),
          method: u16(bytes, pos + 10),
          compressedSize: u32(bytes, pos + 20),
          uncompressedSize: u32(bytes, pos + 24),
          localOffset: u32(bytes, pos + 42),
        });
        pos += 46 + nameLength + extraLength + commentLength;
      }
      if (entries.length > 0) return entries;
    }
  }

  // Fallback: архив без читаемого EOCD (например, обрезанный). Собираем, что можем,
  // по local-заголовкам — этого достаточно для определения формата.
  const entries: ZipDirectoryEntry[] = [];
  let pos = 0;
  while (pos + 30 <= bytes.length) {
    if (u32(bytes, pos) !== SIG_LOCAL) {
      const next = findLocalSignature(bytes, pos + 1);
      if (next < 0) break;
      pos = next;
      continue;
    }
    const method = u16(bytes, pos + 8);
    const compressedSize = u32(bytes, pos + 18);
    const uncompressedSize = u32(bytes, pos + 22);
    const nameLength = u16(bytes, pos + 26);
    const extraLength = u16(bytes, pos + 28);
    if (pos + 30 + nameLength + extraLength > bytes.length) break;
    const name = decodeZipName(bytes.subarray(pos + 30, pos + 30 + nameLength));
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset: pos });
    const dataStart = pos + 30 + nameLength + extraLength;
    if (compressedSize === 0) {
      const next = findLocalSignature(bytes, dataStart);
      if (next < 0) break;
      pos = next;
    } else {
      pos = dataStart + compressedSize;
    }
  }
  return entries.length > 0 ? entries : null;
}

function readStoredZipEntry(bytes: Uint8Array, entry: ZipDirectoryEntry): Uint8Array | null {
  if (entry.method !== 0) return null;
  const pos = entry.localOffset;
  if (pos + 30 > bytes.length || u32(bytes, pos) !== SIG_LOCAL) return null;
  const nameLength = u16(bytes, pos + 26);
  const extraLength = u16(bytes, pos + 28);
  const start = pos + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.length) return null;
  return bytes.subarray(start, end);
}

// --------------------------------------------------------------------------- //
// Эвристики
// --------------------------------------------------------------------------- //

function looksLikeHtml(bytes: Uint8Array): boolean {
  const sample = latin1(bytes.subarray(0, Math.min(bytes.length, 2048))).trimStart().toLowerCase();
  if (!sample.startsWith('<')) return false;
  if (sample.startsWith('<!doctype html') || sample.startsWith('<html')) return true;
  if (sample.startsWith('<!--')) {
    const end = sample.indexOf('-->');
    if (end >= 0) {
      const rest = sample.slice(end + 3).trimStart();
      if (rest.startsWith('<!doctype html') || rest.startsWith('<html')) return true;
    }
  }
  const head = sample.slice(0, 1024);
  return (
    (head.includes('<html') || head.includes('<!doctype html')) &&
    (head.includes('<head') || head.includes('<body') || head.includes('<title') || head.includes('<meta'))
  );
}

function printableRatio(text: string): number {
  if (text.length === 0) return 0;
  let printable = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) {
      printable += 1;
      continue;
    }
    if (code < 32 || code === 127) continue;
    if (code >= 0xd800 && code <= 0xdfff) continue;
    printable += 1;
  }
  return printable / text.length;
}

interface TextGuess {
  confidence: DetectionConfidence;
}

function guessPlainText(bytes: Uint8Array, url: string): TextGuess | null {
  const sample = bytes.subarray(0, Math.min(bytes.length, 65536));
  if (sample.length === 0) return null;
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) return null;
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = new TextDecoder('utf-8').decode(bytes.subarray(3, Math.min(bytes.length, 65539)));
    return printableRatio(text) > 0.9 ? { confidence: 'magic' } : null;
  }
  let utf8Text: string | null = null;
  try {
    utf8Text = new TextDecoder('utf-8', { fatal: true }).decode(sample);
  } catch {
    utf8Text = null;
  }
  if (utf8Text !== null && utf8Text.trim().length > 0 && printableRatio(utf8Text) > 0.9) {
    return { confidence: 'magic' };
  }
  const cp1251Text = new TextDecoder('windows-1251').decode(sample);
  if (cp1251Text.trim().length > 0 && printableRatio(cp1251Text) > 0.9) {
    return { confidence: extensionOf(url) === 'txt' ? 'extension' : 'mime' };
  }
  return null;
}

// --------------------------------------------------------------------------- //
// Определение формата
// --------------------------------------------------------------------------- //

export function detectFormat(bytes: Uint8Array, mime: string, url: string): DetectedFormat {
  const declaredMime = cleanMime(mime);
  const extension = extensionOf(url);
  const size = bytes.length;

  // PDF — самая однозначная сигнатура.
  if (startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46])) {
    return { format: 'pdf', kind: 'pdf', mime: 'application/pdf', confidence: 'magic' };
  }

  // ZIP-контейнеры: EPUB и «FB2 в архиве».
  if (size >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5 || bytes[2] === 7)) {
    const zipEntries = readZipDirectory(bytes);
    if (zipEntries) {
      const names = zipEntries.map((entry) => entry.name.replace(/\\/g, '/').toLowerCase());
      const mimetypeEntry = zipEntries.find((entry) => entry.name.replace(/\\/g, '/').toLowerCase() === 'mimetype');
      if (mimetypeEntry) {
        const stored = readStoredZipEntry(bytes, mimetypeEntry);
        if (stored) {
          const declared = latin1(stored).trim().toLowerCase();
          if (declared.includes('application/epub+zip')) {
            return { format: 'epub', kind: 'text', mime: 'application/epub+zip', confidence: 'magic' };
          }
        }
      }
      if (names.some((name) => name === 'meta-inf/container.xml') || names.some((name) => name.endsWith('.opf'))) {
        return { format: 'epub', kind: 'text', mime: 'application/epub+zip', confidence: 'magic' };
      }
      if (names.some((name) => name.endsWith('.fb2'))) {
        return { format: 'fb2', kind: 'text', mime: 'application/x-fictionbook+xml', confidence: 'magic' };
      }
    }
    if (extension === 'epub') {
      return { format: 'epub', kind: 'text', mime: 'application/epub+zip', confidence: 'extension' };
    }
    // ZIP без опознавательных знаков книги — не книга.
    return { format: 'unknown', kind: 'text', mime: declaredMime || 'application/zip', confidence: 'unknown' };
  }

  // MOBI: сигнатура «BOOKMOBI» по смещению 60 (PalmDOC header).
  if (size >= 68 && ascii(bytes, 60, 8) === 'BOOKMOBI') {
    return { format: 'mobi', kind: 'text', mime: 'application/x-mobipocket-ebook', confidence: 'magic' };
  }

  // Аудио.
  if (startsWithBytes(bytes, [0x49, 0x44, 0x33])) {
    return { format: 'audio', kind: 'audio', mime: 'audio/mpeg', confidence: 'magic' };
  }
  if (size >= 2 && bytes[0] === 0xff && (bytes[1] === 0xfb || bytes[1] === 0xf3 || bytes[1] === 0xf2)) {
    return { format: 'audio', kind: 'audio', mime: 'audio/mpeg', confidence: 'magic' };
  }
  if (ascii(bytes, 0, 4) === 'OggS') {
    return { format: 'audio', kind: 'audio', mime: 'audio/ogg', confidence: 'magic' };
  }
  if (ascii(bytes, 4, 4) === 'ftyp') {
    return { format: 'audio', kind: 'audio', mime: 'audio/mp4', confidence: 'magic' };
  }
  if (ascii(bytes, 0, 4) === 'fLaC') {
    return { format: 'audio', kind: 'audio', mime: 'audio/flac', confidence: 'magic' };
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') {
    return { format: 'audio', kind: 'audio', mime: 'audio/wav', confidence: 'magic' };
  }

  // FB2: XML с корневым элементом <FictionBook> (UTF-8 или windows-1251).
  const xmlSample = latin1(bytes.subarray(0, Math.min(bytes.length, 16384))).toLowerCase();
  if (xmlSample.includes('<fictionbook')) {
    return { format: 'fb2', kind: 'text', mime: 'application/x-fictionbook+xml', confidence: 'magic' };
  }

  // HTML-страница ошибки/заглушки — это не книга, даже если сервер соврал про MIME.
  if (looksLikeHtml(bytes)) {
    return { format: 'html', kind: 'text', mime: 'text/html', confidence: 'magic' };
  }

  // Заявленный text/html без признаков книги — почти наверняка заглушка.
  if (declaredMime === 'text/html' || declaredMime === 'application/xhtml+xml') {
    return { format: 'html', kind: 'text', mime: 'text/html', confidence: 'mime' };
  }

  // TXT: валидный UTF-8 / windows-1251 с высокой долей печатных символов.
  const textGuess = guessPlainText(bytes, url);
  if (textGuess) {
    return {
      format: 'txt',
      kind: 'text',
      mime: declaredMime && declaredMime.startsWith('text/') ? declaredMime : 'text/plain',
      confidence: textGuess.confidence,
    };
  }

  // Расширение без подтверждения байтами не считаем форматом:
  // лучше отказаться, чем сохранить битый файл.
  return { format: 'unknown', kind: 'text', mime: declaredMime || 'application/octet-stream', confidence: 'unknown' };
}

// --------------------------------------------------------------------------- //
// Безопасная проверка перед сохранением
// --------------------------------------------------------------------------- //

export interface SafeDownloadInput {
  bytes: Uint8Array;
  mime?: string;
  url?: string;
  /** Формат, который заявил источник (DownloadFile.format). */
  expectedFormat?: BookFormat;
  maxBytes?: number;
  minBytes?: number;
}

export interface SafeDownloadResult extends DetectedFormat {
  /** Фактический размер файла. */
  size: number;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} КБ`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} МБ`;
  return `${(mb / 1024).toFixed(2)} ГБ`;
}

/**
 * Полная проверка скачанного файла. Бросает Error с понятным русским текстом.
 * Всегда проверяет магические байты, а не только MIME.
 */
export function assertSafeDownload(input: SafeDownloadInput): SafeDownloadResult {
  const maxBytes = input.maxBytes ?? DEFAULT_LIMITS.maxBytes;
  const minBytes = input.minBytes ?? DEFAULT_LIMITS.minBytes;
  const size = input.bytes.byteLength;

  if (size > maxBytes) {
    throw new Error(
      `Файл слишком большой: ${formatBytes(size)} при лимите ${formatBytes(maxBytes)}. Скачивание отменено.`,
    );
  }
  if (size < minBytes) {
    throw new Error(
      `Файл слишком маленький: ${formatBytes(size)}. Похоже, источник вернул пустую заглушку вместо книги.`,
    );
  }

  const detected = detectFormat(input.bytes, input.mime ?? '', input.url ?? '');

  if (detected.format === 'html') {
    throw new Error(
      'Источник вернул HTML-страницу вместо файла книги. Возможно, ссылка устарела или требует входа на сайт.',
    );
  }
  if (detected.format === 'unknown' || detected.confidence === 'unknown') {
    const hint = detected.mime ? ` (${detected.mime})` : '';
    throw new Error(
      `Не удалось распознать формат файла${hint}. Скачивание отменено, чтобы не сохранить повреждённый файл.`,
    );
  }

  const expected = input.expectedFormat;
  if (expected && expected !== 'unknown' && expected !== detected.format) {
    const expectedLabel = FORMAT_LABEL[expected] ?? expected;
    const actualLabel = FORMAT_LABEL[detected.format] ?? detected.format;
    throw new Error(
      `Источник заявил формат ${expectedLabel}, а внутри файла ${actualLabel}. Скачивание отменено.`,
    );
  }

  return { ...detected, size };
}

// --------------------------------------------------------------------------- //
// Возможности формата
// --------------------------------------------------------------------------- //

/** Формат можно открыть встроенной читалкой (текст). */
export function isReadable(format: string): boolean {
  return READABLE_FORMATS.has(format);
}

/** Формат можно показать встроенным просмотрщиком (PDF). */
export function isViewable(format: string): boolean {
  return VIEWABLE_FORMATS.has(format);
}

/** Формат — аудиокнига/дорожка. */
export function isAudio(format: string): boolean {
  return AUDIO_FORMATS.has(format);
}
