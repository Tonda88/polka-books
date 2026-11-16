/**
 * BookPageAnalyzer + BookFileDiscovery на сервере.
 *
 * Приложение не парсит выдачу поисковиков (это запрещено). Оно анализирует
 * сами найденные страницы: вытаскивает метаданные книги, ссылки на файлы
 * EPUB/FB2/PDF/TXT/MOBI и обложку. Никакой авторизации и DRM не обходим.
 *
 * Безопасность: только http(s), запрет приватных адресов (SSRF), лимит
 * размера и таймаут.
 */
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT = 15_000;

const BOOK_FORMATS = new Set(['epub', 'fb2', 'pdf', 'txt', 'mobi', 'azw3', 'djvu']);

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  // IPv4-литералы
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  // IPv6-литералы
  if (host.includes(':')) {
    return host === '::1' || host.startsWith('fd') || host.startsWith('fe80');
  }
  return false;
}

export function validateUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'Некорректный URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Разрешены только http(s)-адреса' };
  }
  if (isPrivateHost(url.hostname)) {
    return { ok: false, error: 'Внутренние адреса запрещены' };
  }
  return { ok: true, url };
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function text(value) {
  return decodeEntities(String(value ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function meta(html, names) {
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

function absoluteUrl(href, base) {
  try {
    return new URL(decodeEntities(href), base).toString();
  } catch {
    return null;
  }
}

const BOOK_EXTENSIONS = {
  epub: 'epub',
  fb2: 'fb2',
  pdf: 'pdf',
  txt: 'txt',
  mobi: 'mobi',
  azw3: 'azw3',
  djvu: 'djvu',
};

/**
 * Формат только по расширению файла в пути.
 * Подстрочный поиск («mobi» в «qrcode.mobile.png») давал ложные файлы.
 */
function formatOf(value) {
  let pathname = String(value ?? '');
  try {
    pathname = new URL(pathname, 'https://example.com').pathname;
  } catch {
    pathname = pathname.split(/[?#]/)[0];
  }
  const segment = pathname.split('/').pop() ?? '';
  const dot = segment.lastIndexOf('.');
  if (dot < 0) return null;
  const extension = segment.slice(dot + 1).toLowerCase();
  return BOOK_EXTENSIONS[extension] ?? null;
}

function guessTitle(html) {
  return (
    meta(html, ['og:title', 'twitter:title']) ??
    text(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]) ??
    text(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1])
  );
}

function parseJsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const books = [];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(decodeEntities(block[1]));
      const list = Array.isArray(parsed) ? parsed : parsed['@graph'] ?? [parsed];
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const type = String(item['@type'] ?? '');
        if (/Book|PublicationVolume|CreativeWork/i.test(type)) {
          books.push(item);
        }
      }
    } catch {
      /* битый JSON-LD пропускаем */
    }
  }
  return books;
}

function authorsFromJsonLd(books) {
  const result = [];
  for (const book of books) {
    const raw = book.author ?? book.creator;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const item of list) {
      const name = typeof item === 'string' ? item : item?.name;
      if (name) result.push(text(name));
    }
  }
  return [...new Set(result.filter(Boolean))];
}

/** Авторы из разметки страницы: rel=author, itemprop, классы, «by …» в заголовке. */
function extractAuthors(html, jsonLdAuthors, title) {
  const found = [...jsonLdAuthors];
  const patterns = [
    /<a[^>]+rel=["']author["'][^>]*>([\s\S]*?)<\/a>/gi,
    /<[^>]+itemprop=["']author["'][^>]*>([\s\S]*?)<\/[^>]+>/gi,
    /<[^>]+class=["'][^"']*(?:author|writer|creator)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi,
    /<meta[^>]+name=["'](?:citation_author|book:author|dc\.creator)["'][^>]*content=["']([^"']+)["']/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const value = text(match[1]);
      if (value && value.length < 120 && !/^\s*(автор|author)\s*:?\s*$/i.test(value)) found.push(value);
    }
  }
  // «Frankenstein, by Mary Shelley» / «Книга — Лев Толстой»
  const titleAuthor =
    title?.match(/\b(?:by|автор[а-я]*:?)\s+([A-ZА-ЯЁ][^,|·—–\n]{2,60})/) ??
    null;
  // Internet Archive: «Название : Автор : Free Download, Borrow…»
  if (!titleAuthor && title && title.includes(' : ')) {
    const parts = title.split(' : ').map((part) => part.trim());
    if (parts.length >= 2 && parts[1] && parts[1].length < 80 && !/download|borrow|streaming|archive/i.test(parts[1])) {
      found.push(parts[1]);
    }
  }
  if (titleAuthor) {
    const raw = titleAuthor[1]
      .split(/\s+[-—–|·]\s+/)[0]
      .replace(/\b(free|ebook|download|скачать|читать онлайн|онлайн)\b.*$/i, '')
      .trim();
    if (raw.length > 1) found.push(raw);
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

/** Собирает ссылки на файлы книг из HTML. */
export function discoverFiles(html, baseUrl) {
  const found = [];
  const seen = new Set();

  const push = (rawHref, labelHint) => {
    if (!rawHref) return;
    const url = absoluteUrl(rawHref, baseUrl);
    if (!url) return;
    const format = formatOf(url) ?? formatOf(labelHint ?? '');
    if (!format || !BOOK_FORMATS.has(format)) return;
    const key = url.replace(/[#?].*$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ url, format, label: text(labelHint) || format.toUpperCase() });
  };

  const anchorRegex = /<a\b([^>]*)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    const attrs = `${match[1]} ${match[3]}`;
    const href = match[2];
    const label = text(match[4]);
    const downloadable =
      /download|скачать|загрузить|get\s*file|epub|fb2|pdf|mobi/i.test(`${attrs} ${href} ${label}`);
    if (downloadable) push(href, label);
  }

  // Прямые ссылки в тексте/JSON страницы.
  for (const raw of html.matchAll(/["'](https?:\/\/[^"'\s]+?\.(?:epub|fb2|pdf|txt|mobi|azw3|djvu))["']/gi)) {
    push(raw[1]);
  }

  // Формы скачивания (action → файл).
  for (const form of html.matchAll(/<form[^>]*action=["']([^"']+)["']/gi)) {
    if (formatOf(form[1])) push(form[1], 'download');
  }

  return found.slice(0, 20);
}

/** Извлекает книжные метаданные из страницы. */
function analyzeHtml(html, pageUrl) {
  const jsonLd = parseJsonLd(html);
  const jsonBook = jsonLd[0] ?? {};

  const title = text(jsonBook.name) || guessTitle(html) || '';
  const metaAuthors = [meta(html, ['citation_author', 'book:author']) ?? ''].filter(Boolean);
  const authors = extractAuthors(html, [...authorsFromJsonLd(jsonLd), ...metaAuthors], title);
  const description =
    text(jsonBook.description) ||
    meta(html, ['og:description', 'description', 'twitter:description']) ||
    text(html.match(/<p[^>]*class=["'][^"']*(?:description|annotation|summary)[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1]) ||
    '';
  const coverRaw =
    (Array.isArray(jsonBook.image) ? jsonBook.image[0] : jsonBook.image?.url ?? jsonBook.image) ||
    meta(html, ['og:image', 'twitter:image', 'citation_cover_image']);
  const coverUrl = coverRaw ? absoluteUrl(String(coverRaw), pageUrl) : undefined;
  const language = (meta(html, ['citation_language', 'og:locale', 'language']) ?? html.match(/<html[^>]*lang=["']([^"']+)/i)?.[1] ?? '')
    .toLowerCase()
    .split(/[-_]/)[0];
  const yearMatch = `${description} ${html.slice(0, 4000)}`.match(/\b(1[5-9]\d{2}|20[0-2]\d)\b/);
  const isbnMatch = html.match(/(?:ISBN(?:-1[03])?:?\s*)((?:97[89][-\s]?)?[\d-]{9,17}[\dXx])/i);
  const isbn = isbnMatch ? isbnMatch[1].replace(/[^0-9Xx]/g, '') : undefined;
  const files = discoverFiles(html, pageUrl);

  const hasBookData = Boolean(jsonBook.name || authors.length > 0 || files.length > 0);
  const bookScore =
    (jsonBook.name ? 2 : 0) + (authors.length > 0 ? 1 : 0) + (files.length > 0 ? 2 : 0) + (isbn ? 1 : 0);

  return {
    url: pageUrl,
    title,
    authors: [...new Set(authors)].slice(0, 4),
    description: description.slice(0, 1500),
    coverUrl,
    language: language || undefined,
    year: yearMatch ? Number(yearMatch[1]) : undefined,
    isbn,
    files,
    isBook: hasBookData,
    bookScore,
  };
}

/** Скачивает страницу и анализирует её. */
export async function analyzePage(rawUrl) {
  const valid = validateUrl(rawUrl);
  if (!valid.ok) return { ok: false, error: valid.error };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(valid.url.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) PolkaBooks/1.4',
        'Accept-Language': 'ru,en;q=0.8',
      },
    });
    if (!response.ok) {
      return { ok: false, status: response.status, error: `Страница ответила ${response.status}` };
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml/i.test(contentType)) {
      return { ok: false, error: 'Ссылка ведёт не на HTML-страницу' };
    }
    const reader = response.body?.getReader();
    let received = 0;
    const chunks = [];
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_HTML_BYTES) break;
        chunks.push(value);
      }
    }
    const buffer = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const html = new TextDecoder('utf-8').decode(buffer);
    return { ok: true, ...analyzeHtml(html, valid.url.toString()) };
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError' ? 'Страница не ответила вовремя' : 'Не удалось открыть страницу';
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}
