/**
 * Анализ HTML-страницы на устройстве: книга, метаданные, файлы.
 *
 * Порт серверного анализатора: нужен, чтобы интернет-поиск работал
 * на телефоне без сервера (страницу отдаёт локальный прокси APK).
 */

export interface DiscoveredFile {
  url: string;
  format: string;
  label?: string;
}

export interface PageAnalysis {
  title: string;
  authors: string[];
  description?: string;
  coverUrl?: string;
  language?: string;
  year?: number;
  isbn?: string;
  files: DiscoveredFile[];
  isBook: boolean;
  bookScore: number;
}

const BOOK_EXTENSIONS = new Set(['epub', 'fb2', 'pdf', 'txt', 'mobi', 'azw3', 'djvu']);

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function text(value: string | undefined): string {
  return decodeEntities(String(value ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function meta(html: string, names: string[]): string | undefined {
  for (const name of names) {
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i'),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1]) return text(match[1]);
    }
  }
  return undefined;
}

function absoluteUrl(href: string, base: string): string | null {
  try {
    return new URL(decodeEntities(href), base).toString();
  } catch {
    return null;
  }
}

/** Формат только по расширению файла в пути. */
function formatOf(value: string): string | null {
  let pathname = value;
  try {
    pathname = new URL(value, 'https://example.com').pathname;
  } catch {
    pathname = value.split(/[?#]/)[0];
  }
  const segment = pathname.split('/').pop() ?? '';
  const dot = segment.lastIndexOf('.');
  if (dot < 0) return null;
  const extension = segment.slice(dot + 1).toLowerCase();
  return BOOK_EXTENSIONS.has(extension) ? extension : null;
}

/** Ссылки на файлы книг. */
export function discoverFiles(html: string, baseUrl: string): DiscoveredFile[] {
  const found: DiscoveredFile[] = [];
  const seen = new Set<string>();

  const push = (rawHref: string | undefined, labelHint = ''): void => {
    if (!rawHref) return;
    const url = absoluteUrl(rawHref, baseUrl);
    if (!url) return;
    const format = formatOf(url) ?? formatOf(labelHint);
    if (!format) return;
    const key = url.replace(/[#?].*$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ url, format, label: text(labelHint) || format.toUpperCase() });
  };

  const anchorRegex = /<a\b([^>]*)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    const attrs = `${match[1]} ${match[3]}`;
    const label = text(match[4]);
    if (/download|скачать|загрузить|get\s*file|epub|fb2|pdf|mobi/i.test(`${attrs} ${match[2]} ${label}`)) {
      push(match[2], label);
    }
  }

  for (const raw of html.matchAll(/["'](https?:\/\/[^"'\s]+?\.(?:epub|fb2|pdf|txt|mobi|azw3|djvu))["']/gi)) {
    push(raw[1]);
  }

  return found.slice(0, 20);
}

function parseJsonLd(html: string): Array<Record<string, unknown>> {
  const books: Array<Record<string, unknown>> = [];
  for (const block of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(decodeEntities(block[1])) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : ((parsed as Record<string, unknown>)['@graph'] as unknown[]) ?? [parsed];
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const type = String((item as Record<string, unknown>)['@type'] ?? '');
        if (/Book|PublicationVolume|CreativeWork/i.test(type)) {
          books.push(item as Record<string, unknown>);
        }
      }
    } catch {
      /* битый JSON-LD пропускаем */
    }
  }
  return books;
}

function authorsFromJsonLd(books: Array<Record<string, unknown>>): string[] {
  const result: string[] = [];
  for (const book of books) {
    const raw = book.author ?? book.creator;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const item of list) {
      const name = typeof item === 'string' ? item : (item as { name?: string })?.name;
      if (name) result.push(text(String(name)));
    }
  }
  return [...new Set(result.filter(Boolean))];
}

function extractAuthors(html: string, jsonLdAuthors: string[], title: string): string[] {
  const found = [...jsonLdAuthors];
  const patterns = [
    /<a[^>]+rel=["']author["'][^>]*>([\s\S]*?)<\/a>/gi,
    /<[^>]+itemprop=["']author["'][^>]*>([\s\S]*?)<\/[^>]+>/gi,
    /<[^>]+class=["'][^"']*(?:author|writer|creator)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi,
    /<meta[^>]+name=["'](?:citation_author|book:author|dc\.creator)["'][^>]*content=["']([^"']+)["']/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const value = text(match[1]);
      if (value && value.length < 120) found.push(value);
    }
  }
  const byMatch = title.match(/\b(?:by|автор[а-я]*:?)\s+([A-ZА-ЯЁ][^,|·—–\n]{2,60})/);
  if (byMatch) {
    const raw = byMatch[1].split(/\s+[-—–|·]\s+/)[0].replace(/\b(free|ebook|download|скачать)\b.*$/i, '').trim();
    if (raw.length > 1) found.push(raw);
  }
  if (title.includes(' : ')) {
    const parts = title.split(' : ').map((part) => part.trim());
    if (parts.length >= 2 && parts[1] && parts[1].length < 80 && !/download|borrow|streaming/i.test(parts[1])) {
      found.push(parts[1]);
    }
  }
  return [
    ...new Set(
      found
        .map((value) => value.replace(/\s+/g, ' ').trim())
        .filter((value) => value.length > 1 && value.length < 80)
        .filter((value) => !/^(free|ebook|download|pdf|epub|txt|fb2)$/i.test(value)),
    ),
  ].slice(0, 4);
}

/** Разбирает HTML страницы книги. */
export function analyzeHtml(html: string, pageUrl: string): PageAnalysis {
  const jsonLd = parseJsonLd(html);
  const jsonBook = jsonLd[0] ?? {};

  const title =
    text(String(jsonBook.name ?? '')) ||
    meta(html, ['og:title', 'twitter:title']) ||
    text(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]) ||
    text(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]) ||
    '';

  const authors = extractAuthors(html, authorsFromJsonLd(jsonLd), title);
  const description =
    text(String(jsonBook.description ?? '')) ||
    meta(html, ['og:description', 'description', 'twitter:description']) ||
    text(
      html.match(/<p[^>]*class=["'][^"']*(?:description|annotation|summary)[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1],
    ) ||
    '';

  const coverRaw =
    (Array.isArray(jsonBook.image)
      ? (jsonBook.image[0] as string)
      : (jsonBook.image as { url?: string })?.url ?? (jsonBook.image as string)) ||
    meta(html, ['og:image', 'twitter:image', 'citation_cover_image']);
  const coverUrl = coverRaw ? absoluteUrl(String(coverRaw), pageUrl) ?? undefined : undefined;

  const language = (meta(html, ['citation_language', 'og:locale', 'language']) ??
    html.match(/<html[^>]*lang=["']([^"']+)/i)?.[1] ??
    '')
    .toLowerCase()
    .split(/[-_]/)[0];

  const yearMatch = `${description} ${html.slice(0, 4000)}`.match(/\b(1[5-9]\d{2}|20[0-2]\d)\b/);
  const isbnMatch = html.match(/(?:ISBN(?:-1[03])?:?\s*)((?:97[89][-\s]?)?[\d-]{9,17}[\dXx])/i);
  const files = discoverFiles(html, pageUrl);
  const isBook = Boolean(jsonBook.name || authors.length > 0 || files.length > 0);
  const bookScore =
    (jsonBook.name ? 2 : 0) + (authors.length > 0 ? 1 : 0) + (files.length > 0 ? 2 : 0) + (isbnMatch ? 1 : 0);

  return {
    title,
    authors,
    description: description.slice(0, 1500) || undefined,
    coverUrl,
    language: language || undefined,
    year: yearMatch ? Number(yearMatch[1]) : undefined,
    isbn: isbnMatch ? isbnMatch[1].replace(/[^0-9Xx]/g, '') : undefined,
    files,
    isBook,
    bookScore,
  };
}
