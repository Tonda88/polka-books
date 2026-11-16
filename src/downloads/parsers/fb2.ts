/**
 * Разбор FB2 (FictionBook) без внешних библиотек.
 *
 * Собственный мини-XML-парсер: он нужен, потому что парсеры должны работать и в
 * браузере, и в Node-проверке (scripts/check-formats.mjs), где нет DOMParser.
 * Поддерживаются UTF-8/UTF-16/windows-1251 (по BOM или XML-декларации),
 * вложенные <section>, стихи (<poem><stanza><v>) и эпиграфы.
 */
import type { BookContent, ChapterContent } from '../../types';

export type Fb2Input = ArrayBuffer | Uint8Array | string;

// --------------------------------------------------------------------------- //
// Декодирование
// --------------------------------------------------------------------------- //

function decodeFb2Bytes(bytes: Uint8Array): string {
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

function toBytes(input: Fb2Input): Uint8Array {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(input);
}

// --------------------------------------------------------------------------- //
// Мини-XML
// --------------------------------------------------------------------------- //

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: Array<XmlNode | string>;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
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

function localName(name: string): string {
  const colon = name.indexOf(':');
  return (colon >= 0 ? name.slice(colon + 1) : name).toLowerCase();
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    attrs[localName(match[1])] = decodeEntities(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  let index = 0;

  const appendText = (text: string): void => {
    if (text) stack[stack.length - 1].children.push(text);
  };

  while (index < source.length) {
    const lt = source.indexOf('<', index);
    if (lt < 0) {
      appendText(source.slice(index));
      break;
    }
    if (lt > index) appendText(source.slice(index, lt));

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      appendText(source.slice(lt + 9, end < 0 ? source.length : end));
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }

    const gt = source.indexOf('>', lt);
    if (gt < 0) {
      appendText(source.slice(lt));
      break;
    }
    let raw = source.slice(lt + 1, gt).trim();
    if (raw.startsWith('/')) {
      const closing = localName(raw.slice(1).trim());
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (localName(stack[depth].name) === closing) {
          stack.length = depth;
          break;
        }
      }
      index = gt + 1;
      continue;
    }

    const selfClosing = raw.endsWith('/');
    if (selfClosing) raw = raw.slice(0, -1).trim();
    const spaceIndex = raw.search(/\s/);
    const name = spaceIndex < 0 ? raw : raw.slice(0, spaceIndex);
    if (!name) {
      index = gt + 1;
      continue;
    }
    const node: XmlNode = {
      name,
      attrs: parseAttributes(spaceIndex < 0 ? '' : raw.slice(spaceIndex)),
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    index = gt + 1;
  }

  return root;
}

function elementChildren(node: XmlNode): XmlNode[] {
  return node.children.filter((child): child is XmlNode => typeof child !== 'string');
}

function findChild(node: XmlNode, name: string): XmlNode | undefined {
  return elementChildren(node).find((child) => localName(child.name) === name);
}

function findChildDeep(node: XmlNode, name: string): XmlNode | undefined {
  for (const child of elementChildren(node)) {
    if (localName(child.name) === name) return child;
    const nested = findChildDeep(child, name);
    if (nested) return nested;
  }
  return undefined;
}

function textOf(node: XmlNode): string {
  let text = '';
  for (const child of node.children) {
    if (typeof child === 'string') {
      text += child;
      continue;
    }
    const name = localName(child.name);
    if (name === 'binary' || name === 'image') continue;
    text += textOf(child);
  }
  return decodeEntities(text).replace(/[\s\u00a0]+/g, ' ').trim();
}

// --------------------------------------------------------------------------- //
// Содержимое
// --------------------------------------------------------------------------- //

function titleText(title: XmlNode): string {
  const parts: string[] = [];
  for (const child of elementChildren(title)) {
    const name = localName(child.name);
    if (name === 'p' || name === 'empty-line') {
      if (name === 'empty-line') continue;
      const text = textOf(child);
      if (text) parts.push(text);
    }
  }
  if (parts.length === 0) {
    const text = textOf(title);
    if (text) parts.push(text);
  }
  return parts.join(' · ').slice(0, 200);
}

function poemParagraphs(poem: XmlNode): string[] {
  const stanzas: string[] = [];
  const directLines: string[] = [];
  for (const child of elementChildren(poem)) {
    const name = localName(child.name);
    if (name === 'stanza') {
      const lines: string[] = [];
      for (const line of elementChildren(child)) {
        const lineName = localName(line.name);
        if (lineName === 'v' || lineName === 'line' || lineName === 'subtitle' || lineName === 'text-author') {
          const text = textOf(line);
          if (text) lines.push(text);
        }
      }
      if (lines.length > 0) stanzas.push(lines.join('\n'));
    } else if (name === 'v' || name === 'line') {
      const text = textOf(child);
      if (text) directLines.push(text);
    }
  }
  if (directLines.length > 0) stanzas.unshift(directLines.join('\n'));
  if (stanzas.length === 0) {
    const fallback = textOf(poem);
    return fallback ? [fallback] : [];
  }
  return [stanzas.join('\n\n')];
}

function collectParagraphs(node: XmlNode, out: string[]): void {
  for (const child of elementChildren(node)) {
    const name = localName(child.name);
    switch (name) {
      case 'p':
      case 'subtitle': {
        const text = textOf(child);
        if (text) out.push(text);
        break;
      }
      case 'poem':
        out.push(...poemParagraphs(child));
        break;
      case 'epigraph':
      case 'annotation':
      case 'cite':
      case 'text-author': {
        const text = textOf(child);
        if (text) out.push(text);
        break;
      }
      default:
        break;
    }
  }
}

function joinTitles(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return `${left} · ${right}`;
}

function walkSection(section: XmlNode, parentTitle: string, chapters: ChapterContent[]): void {
  const titleNode = findChild(section, 'title');
  const ownTitle = titleNode ? titleText(titleNode) : '';
  const fullTitle = joinTitles(parentTitle, ownTitle);

  const paragraphs: string[] = [];
  collectParagraphs(section, paragraphs);
  if (paragraphs.length > 0) chapters.push({ title: fullTitle, paragraphs });

  for (const child of elementChildren(section)) {
    if (localName(child.name) === 'section') walkSection(child, fullTitle, chapters);
  }
}

// --------------------------------------------------------------------------- //
// Публичный API
// --------------------------------------------------------------------------- //

/**
 * Разбирает FB2 в формат читалки. Принимает ArrayBuffer/Uint8Array или уже
 * декодированную строку XML.
 */
export async function parseFb2(input: Fb2Input): Promise<BookContent> {
  const bytes = toBytes(input);
  const source = typeof input === 'string' ? input : decodeFb2Bytes(bytes);
  if (!source.trim()) throw new Error('FB2: файл пуст.');

  const root = parseXml(source);
  const fictionBook = findChildDeep(root, 'fictionbook');
  if (!fictionBook) {
    throw new Error('FB2: не найден корневой элемент <FictionBook> — файл повреждён или это не FB2.');
  }

  const chapters: ChapterContent[] = [];
  for (const body of elementChildren(fictionBook).filter((child) => localName(child.name) === 'body')) {
    const bodyTitleNode = findChild(body, 'title');
    const bodyTitle = bodyTitleNode ? titleText(bodyTitleNode) : '';
    const sections = elementChildren(body).filter((child) => localName(child.name) === 'section');

    if (sections.length === 0) {
      const paragraphs: string[] = [];
      collectParagraphs(body, paragraphs);
      if (paragraphs.length > 0) chapters.push({ title: bodyTitle || 'Книга', paragraphs });
      continue;
    }

    const preamble = elementChildren(body)
      .filter((child) => localName(child.name) === 'p')
      .map((child) => textOf(child))
      .filter((text) => text.length > 0);
    if (preamble.length > 0) chapters.push({ title: bodyTitle || 'Начало', paragraphs: preamble });

    for (const section of sections) walkSection(section, '', chapters);
  }

  const normalized = chapters
    .filter((chapter) => chapter.paragraphs.length > 0)
    .map((chapter, index) => ({
      title: chapter.title || `Глава ${index + 1}`,
      paragraphs: chapter.paragraphs,
    }));

  if (normalized.length === 0) throw new Error('FB2: в книге не найдено секций с текстом.');

  return { id: 'fb2', chapters: normalized };
}
