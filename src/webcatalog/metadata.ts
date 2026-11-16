/**
 * BookMetadataExtractor: вытаскивает название, автора, серию, жанр,
 * язык, описание, ISBN и обложку из самого файла, а недостающее —
 * дополняет через Open Library.
 */
import type { CatalogBook } from '../catalog/types';
import { openLibrarySource } from '../catalog/sources/openLibrary';
import { parseDownloadedFile } from '../downloads/parsers';
import { readZipFile } from '../downloads/parsers/epub';
import { detectFormat } from '../downloads/detect';
import { cleanText } from '../catalog/normalize';
import type { BookDraft, ExtractedMeta } from './types';

/** Uint8Array (с любым offset) → ArrayBuffer. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function parseXml(text: string): Document | null {
  try {
    return new DOMParser().parseFromString(text, 'application/xml');
  } catch {
    return null;
  }
}

function textOf(parent: Element | Document | null, tag: string): string | undefined {
  if (!parent) return undefined;
  const elements = parent.getElementsByTagName(tag);
  if (elements.length === 0) return undefined;
  const value = elements[0].textContent?.replace(/\s+/g, ' ').trim();
  return value || undefined;
}

function textsOf(parent: Element | Document | null, tag: string): string[] {
  if (!parent) return [];
  return [...parent.getElementsByTagName(tag)]
    .map((element) => element.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .filter(Boolean);
}

function guessFromFileName(fileName: string): { title: string; author?: string } {
  const base = fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // «Автор - Название», «Автор — Название», «Название (Автор)»
  const dash = base.match(/^(.{2,80}?)\s+[-—–]\s+(.{2,120})$/);
  if (dash) {
    return { author: dash[1].trim(), title: dash[2].trim() };
  }
  const brackets = base.match(/^(.{2,120})\s*\(([^()]{2,80})\)$/);
  if (brackets) {
    return { title: brackets[1].trim(), author: brackets[2].trim() };
  }
  return { title: base || 'Без названия' };
}

// ---------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------

async function extractEpub(bytes: Uint8Array): Promise<Partial<BookDraft>> {
  const buffer = toArrayBuffer(bytes);
  const container = await readZipFile(buffer, (path) => path.toLowerCase().endsWith('container.xml'));
  let opfPath: string | null = null;
  if (container) {
    const xml = new TextDecoder('utf-8').decode(container.data);
    const match = xml.match(/full-path="([^"]+)"/i);
    if (match) opfPath = decodeXml(match[1]);
  }
  const opf =
    (opfPath ? await readZipFile(buffer, (path) => path === opfPath) : null) ??
    (await readZipFile(buffer, (path) => path.toLowerCase().endsWith('.opf')));
  if (!opf) return {};

  const xml = new TextDecoder('utf-8').decode(opf.data);
  const doc = parseXml(xml);
  if (!doc) return {};

  const title = textOf(doc, 'dc:title') ?? textOf(doc, 'title');
  const authors = [...textsOf(doc, 'dc:creator'), ...textsOf(doc, 'creator')].filter(
    (value, index, array) => array.indexOf(value) === index,
  );
  const subjects = [...textsOf(doc, 'dc:subject'), ...textsOf(doc, 'subject')].filter(
    (value, index, array) => array.indexOf(value) === index,
  );
  const language = textOf(doc, 'dc:language') ?? textOf(doc, 'language');
  const description = cleanText(textOf(doc, 'dc:description') ?? textOf(doc, 'description'), 1500);
  const publisher = textOf(doc, 'dc:publisher') ?? textOf(doc, 'publisher');
  const date = textOf(doc, 'dc:date') ?? textOf(doc, 'date');
  const year = date?.match(/(1[0-9]{3}|20[0-9]{2})/)?.[1];

  const identifiers = textsOf(doc, 'dc:identifier');
  const isbn = identifiers
    .map((value) => value.replace(/[^0-9Xx]/g, ''))
    .find((value) => value.length === 13 || value.length === 10);

  // Серия: calibre:series или belongs-to-collection
  let series: string | undefined;
  const seriesMeta = [...doc.getElementsByTagName('meta')].find(
    (meta) => meta.getAttribute('name')?.toLowerCase() === 'calibre:series',
  );
  series = seriesMeta?.getAttribute('content') ?? undefined;
  if (!series) {
    const belongs = [...doc.getElementsByTagName('meta')].find(
      (meta) => meta.getAttribute('property') === 'belongs-to-collection',
    );
    series = belongs?.textContent?.trim() || undefined;
  }

  // Обложка: meta name="cover" → id манифеста → href
  let coverDataUrl: string | undefined;
  let coverHref: string | undefined;
  const coverMeta = [...doc.getElementsByTagName('meta')].find(
    (meta) => meta.getAttribute('name')?.toLowerCase() === 'cover',
  );
  const coverId = coverMeta?.getAttribute('content');
  if (coverId) {
    const item = [...doc.getElementsByTagName('item')].find((element) => element.getAttribute('id') === coverId);
    coverHref = item?.getAttribute('href') ?? undefined;
  }
  if (!coverHref) {
    const item = [...doc.getElementsByTagName('item')].find((element) =>
      /cover/i.test(element.getAttribute('href') ?? ''),
    );
    coverHref = item?.getAttribute('href') ?? undefined;
  }
  if (coverHref) {
    const baseDir = opf.path.includes('/') ? opf.path.slice(0, opf.path.lastIndexOf('/') + 1) : '';
    const fullPath = decodeURIComponent(`${baseDir}${coverHref}`).replace(/^\.\//, '');
    const cover = await readZipFile(
      buffer,
      (path) => path === fullPath || path.endsWith(coverHref ?? ''),
    );
    if (cover) {
      const mime = coverHref.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      let binary = '';
      for (let index = 0; index < cover.data.length; index += 1) binary += String.fromCharCode(cover.data[index]);
      coverDataUrl = `data:${mime};base64,${btoa(binary)}`;
    }
  }

  return {
    title,
    authors,
    series,
    genre: subjects[0],
    languages: language ? [language.split(/[-_]/)[0]] : [],
    description,
    publisher,
    year: year ? Number(year) : undefined,
    isbn,
    coverDataUrl,
  };
}

// ---------------------------------------------------------------------------
// FB2
// ---------------------------------------------------------------------------

function extractFb2(bytes: Uint8Array): Partial<BookDraft> {
  const text = new TextDecoder('utf-8').decode(bytes);
  const doc = parseXml(text);
  if (!doc) return {};
  const titleInfo = doc.getElementsByTagName('title-info')[0] ?? null;

  const title =
    textOf(titleInfo, 'book-title') ??
    textOf(doc, 'book-title');
  const authors = [...textsOf(titleInfo, 'author')]
    .filter((value) => value && !/^(translator|переводчик)$/i.test(value))
    .slice(0, 3);
  // Автор разделён тегами first-name/last-name — собираем вручную.
  const authorNodes = titleInfo ? [...titleInfo.getElementsByTagName('author')] : [];
  const authorsFromTags = authorNodes.map((author) => {
    const first = textOf(author, 'first-name') ?? '';
    const middle = textOf(author, 'middle-name') ?? '';
    const last = textOf(author, 'last-name') ?? '';
    const nickname = textOf(author, 'nickname') ?? '';
    return [first, middle, last].filter(Boolean).join(' ') || nickname;
  });
  const genre = textOf(titleInfo, 'genre');
  const language = textOf(titleInfo, 'lang');
  const description = cleanText(textOf(titleInfo, 'annotation'), 1500);
  const year = textOf(titleInfo, 'date-value') ?? textOf(titleInfo, 'date');
  const sequenceNode = titleInfo ? titleInfo.getElementsByTagName('sequence')[0] : undefined;
  const series = sequenceNode?.getAttribute('name') ?? undefined;
  const publishInfo = doc.getElementsByTagName('publish-info')[0];
  const publisher = textOf(publishInfo ?? null, 'publisher') ?? textOf(doc, 'publisher');
  const isbn = textOf(publishInfo ?? null, 'isbn') ?? textOf(doc, 'isbn');

  // Обложка: <binary id="cover.jpg" content-type="image/jpeg">base64</binary>
  const binaries = [...doc.getElementsByTagName('binary')];
  const coverBinary =
    binaries.find((node) => /cover/i.test(node.getAttribute('id') ?? '')) ?? binaries[0];
  const coverDataUrl = coverBinary
    ? `data:${coverBinary.getAttribute('content-type') ?? 'image/jpeg'};base64,${(coverBinary.textContent ?? '').replace(/\s+/g, '')}`
    : undefined;

  const normalizedAuthors: string[] = [];
  const seenAuthors = new Set<string>();
  for (const value of [...authorsFromTags, ...authors]) {
    const key = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (!key || seenAuthors.has(key)) continue;
    seenAuthors.add(key);
    normalizedAuthors.push(value);
  }
  return {
    title,
    authors: normalizedAuthors.slice(0, 3),
    series,
    genre,
    languages: language ? [language.split(/[-_]/)[0]] : [],
    description,
    year: year ? Number(year.match(/(1[0-9]{3}|20[0-9]{2})/)?.[1] ?? 0) || undefined : undefined,
    isbn: isbn?.replace(/[^0-9Xx]/g, ''),
    publisher,
    coverDataUrl,
  };
}

// ---------------------------------------------------------------------------
// PDF / TXT
// ---------------------------------------------------------------------------

async function extractPdf(bytes: Uint8Array): Promise<Partial<BookDraft>> {
  try {
    const parsed = await parseDownloadedFile({ bytes: toArrayBuffer(bytes), format: 'pdf' });
    const info = parsed.pdfInfo;
    if (!info) return {};
    return {
      title: info.title,
      authors: info.author ? [info.author] : [],
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Дополнение через Open Library
// ---------------------------------------------------------------------------

async function enrichFromOpenLibrary(draft: BookDraft): Promise<Partial<BookDraft>> {
  const query = draft.title && draft.authors[0] ? `${draft.title} ${draft.authors[0]}` : draft.title;
  if (!query) return {};
  try {
    const books: CatalogBook[] = await openLibrarySource.search(
      { title: draft.title || undefined, author: draft.authors[0] || undefined, text: draft.title ? undefined : query },
      { online: true, limit: 3 },
    );
    const best = books[0];
    if (!best) return {};
    return {
      title: draft.title || best.title,
      authors: draft.authors.length > 0 ? draft.authors : best.authors,
      series: best.series,
      genre: draft.genre ?? best.subjects[0],
      languages: draft.languages.length > 0 ? draft.languages : best.languages ?? [],
      year: draft.year ?? best.year,
      description: draft.description ?? best.description,
      publisher: draft.publisher ?? best.publishers?.[0],
      isbn: draft.isbn ?? best.isbn?.[0],
      coverUrl: draft.coverDataUrl ? undefined : best.coverUrl,
      matchedSource: `Open Library: ${best.title}`,
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Публичный API
// ---------------------------------------------------------------------------

export interface ExtractInput {
  bytes: Uint8Array;
  fileName: string;
  mime?: string;
  /** Не обращаться к сети за дополнением. */
  offline?: boolean;
}

/**
 * Разбирает файл и возвращает черновик книги. Поля, которые не удалось
 * получить из файла, дополняются из Open Library.
 */
export async function extractMetadata(input: ExtractInput): Promise<ExtractedMeta> {
  const detected = detectFormat(input.bytes, input.mime ?? '', input.fileName);
  const format = detected.format;
  let parsed: Partial<BookDraft> = {};
  const filled: string[] = [];

  if (format === 'epub') {
    parsed = await extractEpub(input.bytes);
    if (parsed.title) filled.push('файл EPUB');
  } else if (format === 'fb2') {
    parsed = extractFb2(input.bytes);
    if (parsed.title) filled.push('файл FB2');
  } else if (format === 'pdf') {
    parsed = await extractPdf(input.bytes);
    if (parsed.title) filled.push('файл PDF');
  }

  const fromName = guessFromFileName(input.fileName);
  const base = {
    title: parsed.title ?? fromName.title,
    authors: parsed.authors?.filter(Boolean) ?? (fromName.author ? [fromName.author] : []),
    series: parsed.series,
    genre: parsed.genre,
    languages: parsed.languages ?? [],
    year: parsed.year,
    description: parsed.description,
    publisher: parsed.publisher,
    isbn: parsed.isbn,
    coverUrl: parsed.coverUrl,
    coverDataUrl: parsed.coverDataUrl,
    format: (format === 'unknown' ? 'unknown' : format) as BookDraft['format'],
  };
  if (!parsed.title && fromName.title) filled.push('имя файла');

  const draft: BookDraft = {
    ...base,
    draftId: `draft:${Date.now()}`,
    fileSize: input.bytes.length,
    fileName: input.fileName,
    storageKey: '',
    confidence: filled.length > 0 ? 0.7 : 0.4,
    filledFrom: filled,
  };

  if (!input.offline) {
    const enriched = await enrichFromOpenLibrary(draft);
    Object.assign(draft, {
      title: draft.title || enriched.title || '',
      authors: draft.authors.length > 0 ? draft.authors : enriched.authors ?? [],
      series: draft.series ?? enriched.series,
      genre: draft.genre ?? enriched.genre,
      languages: draft.languages.length > 0 ? draft.languages : enriched.languages ?? [],
      year: draft.year ?? enriched.year,
      description: draft.description ?? enriched.description,
      publisher: draft.publisher ?? enriched.publisher,
      isbn: draft.isbn ?? enriched.isbn,
      coverUrl: draft.coverUrl ?? enriched.coverUrl,
      matchedSource: enriched.matchedSource,
    });
    if (enriched.matchedSource) draft.filledFrom = [...draft.filledFrom, enriched.matchedSource];
  }
  if (draft.coverDataUrl) draft.coverUrl = undefined;
  draft.confidence = Math.min(1, 0.35 + draft.filledFrom.length * 0.2 + (draft.authors.length > 0 ? 0.15 : 0));
  return draft;
}
