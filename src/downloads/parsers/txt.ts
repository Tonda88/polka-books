/**
 * Разбор TXT без внешних библиотек.
 *
 * Кодировка: UTF-8 (с BOM и без) с откатом на windows-1251. Главы ищутся по
 * строкам-заголовкам («ГЛАВА I», «Chapter 1», «Часть первая», «***», markdown
 * #…). Абзацы разделяются пустыми строками; гигантские абзацы и «простыни»
 * текста режутся на куски ~1200 символов по границам предложений.
 */
import type { BookContent } from '../../types';

// --------------------------------------------------------------------------- //
// Декодирование
// --------------------------------------------------------------------------- //

function decodeTxt(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

// --------------------------------------------------------------------------- //
// Заголовки глав
// --------------------------------------------------------------------------- //

const HEADING_PATTERNS: RegExp[] = [
  /^глава\s+[ivxlcdm\d]+(?:[.:)\s—-]|$)/i,
  /^часть\s+(?:[ivxlcdm\d]+|перв\w*|втор\w*|трет\w*|четверт\w*|пят\w*|шест\w*|седьм\w*|восьм\w*|девят\w*|десят\w*)(?:[.:)\s—-]|$)/i,
  /^(?:chapter|part|book)\s+(?:[ivxlcdm\d]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:[.:)\s—-]|$)/i,
  /^(?:пролог|эпилог|введение|заключение|послесловие|предисловие|от автора|содержание)(?:[.:)\s—-]|$)/i,
];

function headingTitle(line: string): string | null {
  const text = line.trim();
  if (!text || text.length > 120) return null;
  if (/^(?:\*\s*){3,}$/.test(text)) return '* * *';
  if (/^[-–—_]{3,}$/.test(text)) return '* * *';
  const markdown = /^#{1,6}\s+(.+)$/.exec(text);
  if (markdown) return markdown[1].trim();
  for (const pattern of HEADING_PATTERNS) {
    if (pattern.test(text)) return text;
  }
  return null;
}

interface Draft {
  title: string;
  lines: string[];
}

function joinTitles(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return `${left} · ${right}`;
}

function splitIntoChapters(text: string): Draft[] {
  const drafts: Draft[] = [];
  let current: Draft = { title: '', lines: [] };
  const flush = (): void => {
    if (current.lines.some((line) => line.trim().length > 0)) drafts.push(current);
  };

  for (const line of text.split('\n')) {
    const heading = headingTitle(line);
    if (heading === null) {
      current.lines.push(line);
      continue;
    }
    const hasText = current.lines.some((value) => value.trim().length > 0);
    if (!hasText) {
      current.title = joinTitles(current.title, heading);
      continue;
    }
    flush();
    current = { title: heading, lines: [] };
  }
  flush();
  return drafts;
}

// --------------------------------------------------------------------------- //
// Абзацы
// --------------------------------------------------------------------------- //

function toParagraphs(lines: string[]): string[] {
  const paragraphs: string[] = [];
  let buffer: string[] = [];
  const flush = (): void => {
    if (buffer.length === 0) return;
    const paragraph = buffer.join(' ').replace(/[\s\u00a0]+/g, ' ').trim();
    if (paragraph) paragraphs.push(paragraph);
    buffer = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) buffer.push(trimmed);
    else flush();
  }
  flush();
  return paragraphs;
}

/** Режет текст на куски не длиннее ~target символов по границам предложений. */
function chunkBySentences(text: string, target = 1200): string[] {
  const chunks: string[] = [];
  let rest = text.replace(/[\s\u00a0]+/g, ' ').trim();
  while (rest.length > target) {
    const window = rest.slice(0, target);
    let cut = -1;
    const sentenceRe = /[.!?…][»"')\]]?(?=\s)/g;
    let match: RegExpExecArray | null;
    while ((match = sentenceRe.exec(window)) !== null) {
      if (match.index >= target * 0.4) cut = match.index + match[0].length;
    }
    if (cut < 0) {
      const space = window.lastIndexOf(' ');
      cut = space > target * 0.5 ? space : target;
    }
    const chunk = rest.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function splitLongParagraph(paragraph: string): string[] {
  if (paragraph.length <= 1500) return [paragraph];
  return chunkBySentences(paragraph, 1200);
}

// --------------------------------------------------------------------------- //
// Публичный API
// --------------------------------------------------------------------------- //

/** Разбирает TXT в формат читалки. */
export async function parseTxt(buffer: ArrayBuffer): Promise<BookContent> {
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) throw new Error('TXT: файл пуст.');
  const text = decodeTxt(bytes).replace(/\r\n?/g, '\n');
  if (!text.trim()) throw new Error('TXT: файл не содержит текста.');

  const drafts = splitIntoChapters(text);
  let chapters = drafts
    .map((draft, index) => ({
      title: draft.title || (index === 0 ? 'Начало' : `Глава ${index + 1}`),
      paragraphs: toParagraphs(draft.lines).flatMap(splitLongParagraph),
    }))
    .filter((chapter) => chapter.paragraphs.length > 0);

  if (chapters.length === 0) throw new Error('TXT: в файле нет читаемого текста.');

  const paragraphCount = chapters.reduce((sum, chapter) => sum + chapter.paragraphs.length, 0);
  const totalChars = text.replace(/[\s\u00a0]+/g, ' ').trim().length;

  // «Простыня» на 5000+ символов без нормальных абзацев: режем по предложениям.
  if (paragraphCount < 3 && totalChars > 5000) {
    const chunks = chunkBySentences(text, 1200);
    if (chunks.length > 1) {
      chapters = [{ title: chapters[0]?.title || 'Книга', paragraphs: chunks }];
    }
  }

  return { id: 'txt', chapters };
}
