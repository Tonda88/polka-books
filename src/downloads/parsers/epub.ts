/**
 * Разбор EPUB без внешних библиотек.
 *
 * ZIP читается вручную: центральная директория → OPF → spine → XHTML-главы.
 * Метод 0 (store) поддерживается напрямую, метод 8 (deflate) — через
 * DecompressionStream('deflate-raw'). Декомпрессор можно подменить (третий
 * аргумент parseEpub), чтобы гонять парсер в Node/тестах через node:zlib.
 */
import type { BookContent, ChapterContent } from '../../types';
import { readZipDirectory, type ZipDirectoryEntry } from '../detect';

export type DecompressFn = (data: Uint8Array) => Promise<Uint8Array>;

const SIG_LOCAL = 0x04034b50;

interface ZipEntry extends ZipDirectoryEntry {
  /** Нормализованный путь (без ведущих слэшей, с раскрытыми %20). */
  path: string;
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

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizePath(value: string): string {
  return safeDecodeUri(value.replace(/\\/g, '/')).replace(/^\/+/, '');
}

function decodeMarkup(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 512)));
  const declared = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1]?.toLowerCase();
  if (declared === 'windows-1251' || declared === 'cp1251') {
    return new TextDecoder('windows-1251').decode(bytes);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

// --------------------------------------------------------------------------- //
// ZIP
// --------------------------------------------------------------------------- //

async function defaultDecompress(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Браузер не поддерживает распаковку EPUB (нет DecompressionStream).');
  }
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const reading = new Response(stream.readable).arrayBuffer();
  try {
    await writer.write(toArrayBuffer(data));
    await writer.close();
  } catch (error) {
    throw new Error(`EPUB повреждён: не удалось распаковать содержимое архива (${String(error)}).`);
  }
  return new Uint8Array(await reading);
}

function readEntryData(bytes: Uint8Array, entry: ZipEntry, decompress: DecompressFn): Promise<Uint8Array> {
  const pos = entry.localOffset;
  if (pos + 30 > bytes.length || u32(bytes, pos) !== SIG_LOCAL) {
    return Promise.reject(new Error('EPUB повреждён: битые заголовки ZIP-архива.'));
  }
  const nameLength = u16(bytes, pos + 26);
  const extraLength = u16(bytes, pos + 28);
  const start = pos + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (start > bytes.length || end > bytes.length) {
    return Promise.reject(new Error('EPUB повреждён: архив обрезан, часть файлов недоступна.'));
  }
  const raw = bytes.subarray(start, end);
  if (entry.method === 0) return Promise.resolve(raw);
  if (entry.method === 8) {
    return decompress(raw).then((data) => {
      if (data.byteLength === 0) throw new Error(`EPUB повреждён: пустой файл «${entry.name}» внутри архива.`);
      return data;
    });
  }
  return Promise.reject(new Error(`EPUB: неподдерживаемый метод сжатия ZIP (${entry.method}) в «${entry.name}».`));
}

function buildZipIndex(bytes: Uint8Array): { entries: ZipEntry[]; byPath: Map<string, ZipEntry> } {
  const directory = readZipDirectory(bytes);
  if (!directory) throw new Error('EPUB повреждён: не удалось прочитать ZIP-архив (файл обрезан или это не EPUB).');
  const entries: ZipEntry[] = directory.map((entry) => ({ ...entry, path: normalizePath(entry.name) }));
  const byPath = new Map<string, ZipEntry>();
  for (const entry of entries) {
    if (entry.path.endsWith('/')) continue;
    byPath.set(entry.path, entry);
    byPath.set(entry.path.toLowerCase(), entry);
  }
  return { entries, byPath };
}

function resolvePath(baseDirectory: string, href: string): string {
  const clean = normalizePath(href.split('#')[0]);
  if (/^[a-z]+:\/\//i.test(clean) || clean.startsWith('data:')) return clean;
  const segments = (baseDirectory ? baseDirectory.split('/') : []).concat(clean.split('/'));
  const stack: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

// --------------------------------------------------------------------------- //
// HTML/XHTML → абзацы
// --------------------------------------------------------------------------- //

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  copy: '©',
  reg: '®',
  middot: '·',
  bull: '•',
  sect: '§',
  para: '¶',
  times: '×',
  euro: '€',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function cleanInline(text: string): string {
  return text.replace(/[\s\u00a0]+/g, ' ').trim();
}

function stripNonText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

function extractParagraphs(html: string): string[] {
  const marked = stripNonText(html)
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
    .replace(/<title\b[\s\S]*?<\/title>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<\/?(?:p|div|h[1-6]|blockquote|li|ul|ol|tr|td|th|table|section|article|header|footer|aside|nav|pre|figure|figcaption|hr|dl|dt|dd)\b[^>]*>/gi,
      '\n',
    )
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(marked)
    .split(/\n+/)
    .map(cleanInline)
    .filter((line) => line.length > 0);
}

function extractTitle(html: string): { title: string; body: string } {
  let body = html;
  for (const tag of ['h1', 'h2', 'h3'] as const) {
    const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(body);
    if (!match) continue;
    const title = cleanInline(decodeEntities(match[1].replace(/<[^>]+>/g, ' ')));
    if (!title) continue;
    body = body.slice(0, match.index) + body.slice(match.index + match[0].length);
    return { title, body };
  }
  const documentTitle = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (documentTitle) {
    const title = cleanInline(decodeEntities(documentTitle[1].replace(/<[^>]+>/g, ' ')));
    if (title) return { title, body };
  }
  return { title: '', body };
}

// --------------------------------------------------------------------------- //
// OPF
// --------------------------------------------------------------------------- //

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
}

function parseManifest(opf: string): Map<string, ManifestItem> {
  const items = new Map<string, ManifestItem>();
  const re = /<item\b([^>]*?)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(opf)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (!attrs.id || !attrs.href) continue;
    items.set(attrs.id, {
      id: attrs.id,
      href: attrs.href,
      mediaType: (attrs['media-type'] ?? '').toLowerCase(),
    });
  }
  return items;
}

function parseSpine(opf: string): string[] {
  const spineMatch = /<spine\b([^>]*)>([\s\S]*?)<\/spine>/i.exec(opf);
  if (!spineMatch) return [];
  const ids: string[] = [];
  const re = /<itemref\b([^>]*?)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(spineMatch[2])) !== null) {
    const attrs = parseAttributes(match[1]);
    if (!attrs.idref) continue;
    if ((attrs.linear ?? '').toLowerCase() === 'no') continue;
    ids.push(attrs.idref);
  }
  return ids;
}

function isMarkupItem(item: ManifestItem): boolean {
  if (item.mediaType === 'application/xhtml+xml' || item.mediaType === 'text/html') return true;
  const href = item.href.split('#')[0].toLowerCase();
  return /\.x?html?$/.test(href);
}

// --------------------------------------------------------------------------- //
// Главы
// --------------------------------------------------------------------------- //

function joinTitles(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  if (left === right) return left;
  return `${left} · ${right}`;
}

/** Короткие главы (<5 абзацев) приклеиваем к соседней, чтобы читалка не мельчила. */
function mergeShortChapters(chapters: ChapterContent[]): ChapterContent[] {
  const MIN_PARAGRAPHS = 5;
  const merged: ChapterContent[] = [];
  for (const chapter of chapters) {
    if (chapter.paragraphs.length === 0) continue;
    const previous = merged[merged.length - 1];
    if (previous && chapter.paragraphs.length < MIN_PARAGRAPHS) {
      previous.paragraphs.push(...chapter.paragraphs);
      previous.title = joinTitles(previous.title, chapter.title);
      continue;
    }
    merged.push({ title: chapter.title, paragraphs: [...chapter.paragraphs] });
  }
  if (merged.length > 1 && merged[0].paragraphs.length < MIN_PARAGRAPHS) {
    const first = merged.shift();
    if (first) {
      merged[0] = {
        title: joinTitles(first.title, merged[0].title),
        paragraphs: [...first.paragraphs, ...merged[0].paragraphs],
      };
    }
  }
  return merged;
}

// --------------------------------------------------------------------------- //
// Публичный API
// --------------------------------------------------------------------------- //

/**
 * Разбирает EPUB в формат читалки.
 *
 * @param buffer — содержимое .epub
 * @param decompress — необязательная подмена распаковщика deflate-raw
 *   (по умолчанию DecompressionStream; в Node-тестах можно передать zlib).
 */
export async function parseEpub(buffer: ArrayBuffer, decompress: DecompressFn = defaultDecompress): Promise<BookContent> {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('EPUB: файл не является ZIP-архивом (нет сигнатуры PK).');
  }

  const { byPath } = buildZipIndex(bytes);

  const containerEntry = byPath.get('META-INF/container.xml') ?? byPath.get('meta-inf/container.xml');
  if (!containerEntry) throw new Error('EPUB повреждён: нет файла META-INF/container.xml.');
  const containerXml = decodeMarkup(await readEntryData(bytes, containerEntry, decompress));
  const opfPathRaw = /<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i.exec(containerXml)?.[1];
  if (!opfPathRaw) throw new Error('EPUB повреждён: container.xml не указывает на OPF-файл.');
  const opfPath = normalizePath(opfPathRaw);
  const opfEntry = byPath.get(opfPath) ?? byPath.get(opfPath.toLowerCase());
  if (!opfEntry) throw new Error(`EPUB повреждён: не найден OPF-файл «${opfPath}».`);

  const opf = decodeMarkup(await readEntryData(bytes, opfEntry, decompress));
  const manifest = parseManifest(opf);
  const spine = parseSpine(opf);
  if (spine.length === 0) throw new Error('EPUB повреждён: пустой spine — в книге нет глав.');

  const opfDirectory = directoryOf(opfPath);
  const chapters: ChapterContent[] = [];
  let readDocuments = 0;

  for (const idref of spine) {
    const item = manifest.get(idref);
    if (!item || !isMarkupItem(item)) continue;
    const path = resolvePath(opfDirectory, item.href);
    const entry = byPath.get(path) ?? byPath.get(path.toLowerCase());
    if (!entry) continue;

    const html = decodeMarkup(await readEntryData(bytes, entry, decompress));
    readDocuments += 1;
    const { title, body } = extractTitle(html);
    const paragraphs = extractParagraphs(body);
    if (paragraphs.length === 0) continue;
    chapters.push({ title: title || `Глава ${chapters.length + 1}`, paragraphs });
  }

  if (readDocuments === 0) throw new Error('EPUB повреждён: не удалось прочитать ни одного документа из spine.');
  const normalized = mergeShortChapters(chapters);
  if (normalized.length === 0) throw new Error('EPUB: в книге нет текста — возможно, это комикс или файл защищён DRM.');

  return { id: 'epub', chapters: normalized };
}

/** Вспомогательное: достать один файл из EPUB-архива (используется диспетчером для FB2-zip). */
export async function readZipFile(
  buffer: ArrayBuffer,
  matcher: (path: string) => boolean,
  decompress: DecompressFn = defaultDecompress,
): Promise<{ path: string; data: Uint8Array } | null> {
  const bytes = new Uint8Array(buffer);
  const { entries } = buildZipIndex(bytes);
  const entry = entries.find((candidate) => !candidate.path.endsWith('/') && matcher(candidate.path));
  if (!entry) return null;
  return { path: entry.path, data: await readEntryData(bytes, entry, decompress) };
}

export { toArrayBuffer as epubBytesToArrayBuffer };
