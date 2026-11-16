#!/usr/bin/env node
/**
 * Проверка книжных API «Полки».
 *
 * Скрипт без зависимостей: дёргает ровно те URL, которые используют адаптеры
 * в src/catalog/sources/*.ts, и печатает HTTP-статус, число найденных записей
 * и по два примера (название / автор / год / форматы).
 *
 * Запуск:  node scripts/check-sources.mjs
 *
 * Ожидаемое поведение:
 *   • Open Library, Internet Archive, Gutenberg (через IA), LibriVox — реальные данные;
 *   • Google Books без ключа — HTTP 429 «Quota exceeded» (нужен ключ);
 *   • gutenberg.org напрямую — HTTP 503 и без CORS (поэтому работаем через IA);
 *   • встроенная библиотека — 14 книг, работает офлайн.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const LIMIT = 10; // запрашиваем 10 записей, показываем 2
const TIMEOUT_MS = 25_000;

const FORM = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  bold: '\u001b[1m',
};
const useColor = process.stdout.isTTY === true;
const paint = (color, text) => (useColor ? `${FORM[color]}${text}${FORM.reset}` : text);

let passed = 0;
let failed = 0;

/** HTTP-запрос JSON с таймаутом. Возвращает статус и тело даже при ошибке. */
async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { status: response.status, ok: response.ok, data, text, ms: Date.now() - started };
  } catch (error) {
    return { status: 0, ok: false, data: null, text: String(error), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const trunc = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function section(title) {
  console.log(`\n${paint('cyan', `══ ${title} ${'═'.repeat(Math.max(2, 62 - title.length))}`)}`);
}

/** Печать строки результата: OK/FAIL + статус + число записей. */
function report(ok, label, status, count, ms, note = '') {
  const mark = ok ? paint('green', 'OK  ') : paint('red', 'FAIL');
  const parts = [`HTTP ${status}`];
  if (typeof count === 'number') parts.push(`${count} записей`);
  if (note) parts.push(note);
  parts.push(`${ms} мс`);
  console.log(`  ${mark} ${label.padEnd(34)} ${parts.join(' · ')}`);
}

/** Два примера книг в общем формате. */
function examples(books) {
  books.slice(0, 2).forEach((book, index) => {
    const formats = book.files.length > 0 ? book.files.map((file) => file.format).join('/') : '—';
    const author = book.authors[0] ?? 'автор не указан';
    console.log(
      `       ${index + 1}. ${paint('bold', trunc(book.title, 56))} — ${trunc(author, 26)} · ${
        book.year ?? 'год ?'
      } · форматы: ${formats} · доступ: ${book.access}`,
    );
  });
}

// --------------------------------------------------------------------------- //
// Общие помощники нормализации (зеркалят адаптеры)
// --------------------------------------------------------------------------- //

const IA_FORMAT_BY_LABEL = {
  epub: 'epub',
  'text pdf': 'pdf',
  'additional text pdf': 'pdf',
  text: 'txt',
  'djvu xml': 'djvu',
  djvu: 'djvu',
  fb2: 'fb2',
};

const IA_SKIP_NAME = /(_text\.pdf|_meta\.xml|_files\.xml|_reviews\.xml|^meta\.xml$|_chocr\.html|_hocr\.html)/i;

/** Скачиваемые форматы записи IA (как в адаптере). */
function iaFormats(files) {
  const seen = new Set();
  const formats = [];
  for (const file of files ?? []) {
    const name = file?.name ?? '';
    if (!name || IA_SKIP_NAME.test(name)) continue;
    if (file.private === true || file.private === 'true') continue;
    const format = IA_FORMAT_BY_LABEL[(file.format ?? '').trim().toLowerCase()];
    if (!format || seen.has(format)) continue;
    seen.add(format);
    formats.push({ format });
  }
  return formats;
}

function iaList(value) {
  if (Array.isArray(value)) return value.flatMap(iaList);
  if (typeof value === 'string') {
    return value
      .split(/[;\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)];
  return [];
}

const yearOf = (value) => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1000 && value <= 2100) return Math.trunc(value);
  if (typeof value === 'string') {
    const match = value.match(/(1[0-9]{3}|20[0-9]{2})/);
    if (match) return Number(match[1]);
  }
  return undefined;
};

/** Автор без дат жизни и служебных пометок (как в адаптерах). */
function cleanAuthor(value) {
  let name = String(value ?? '').replace(/\s+/g, ' ').trim();
  name = name.replace(/,\s*(author|editor|translator|illustrator|narrator)\.?$/gi, '');
  name = name.replace(/,\s*(ca\.\s*)?\d{3,4}(\s*[-–]\s*\d{3,4})?$/i, '');
  name = name.replace(/,\s*(author|editor|translator|illustrator|narrator)\.?$/gi, '').trim();
  // «Doyle, Arthur Conan» → «Arthur Conan Doyle»
  const parts = name.split(',');
  if (parts.length === 2 && parts[0].trim() && parts[1].trim() && !/\d/.test(name)) {
    name = `${parts[1].trim()} ${parts[0].trim()}`;
  }
  return name;
}

/** Разбор записи IA в компактный объект для печати. */
function iaBook(doc, item) {
  const metadata = item?.metadata ?? doc ?? {};
  return {
    title: iaList(metadata.title)[0] ?? doc?.identifier ?? '?',
    authors: iaList(metadata.creator ?? metadata.author).map(cleanAuthor),
    year: yearOf(metadata.year) ?? yearOf(iaList(metadata.date)[0]) ?? yearOf(doc?.year),
    files: iaFormats(item?.files),
    access: iaFormats(item?.files).length > 0 ? 'download' : 'unknown',
  };
}

/**
 * Подгружает метаданные первых записей и возвращает карточки так, как их
 * видит адаптер (с форматами файлов). requireFiles повторяет фильтр витрин:
 * в «новинках»/«популярном» адаптер оставляет только скачиваемое.
 */
async function iaSample(docs, { requireFiles = false, take = 8 } = {}) {
  const selected = docs.filter((doc) => Boolean(doc?.identifier)).slice(0, take);
  const metas = await Promise.all(selected.map((doc) => iaMetadata(doc.identifier)));
  const books = [];
  const probes = [];
  selected.forEach((doc, index) => {
    const meta = metas[index];
    const book = iaBook(doc, meta?.data);
    if (requireFiles && book.files.length === 0) return;
    probes.push({
      identifier: doc.identifier,
      status: meta?.status ?? 0,
      files: meta?.data?.files?.length ?? 0,
      formats: book.files.map((file) => file.format),
    });
    books.push(book);
  });
  return { books, probes };
}

/** Печать фактов о metadata первой записи — доказательство работы /metadata. */
function printProbe(probe) {
  if (!probe) return;
  console.log(
    `       metadata(${probe.identifier}): HTTP ${probe.status} · файлов: ${probe.files} · форматы: ${
      probe.formats.join('/') || '—'
    }`,
  );
}

// --------------------------------------------------------------------------- //
// 1. Open Library
// --------------------------------------------------------------------------- //

const OL_FIELDS = [
  'key',
  'title',
  'author_name',
  'first_publish_year',
  'isbn',
  'cover_i',
  'subject',
  'edition_count',
  'ratings_average',
  'ratings_count',
  'ebook_access',
  'publisher',
  'language',
  'ia',
  'series',
].join(',');

function olBook(doc) {
  const access =
    doc.ebook_access === 'public' ? 'download' : doc.ebook_access === 'borrowable' ? 'borrow' : 'unknown';
  const iaIds = iaList(doc.ia);
  return {
    title: doc.title ?? '?',
    authors: iaList(doc.author_name),
    year: yearOf(doc.first_publish_year),
    access,
    files: access === 'download' && iaIds.length > 0 ? iaIds.slice(0, 3).map(() => ({ format: 'html' })) : [],
  };
}

async function checkOpenLibrary() {
  section('Open Library (id: openlibrary)');

  const search = await getJson(
    `https://openlibrary.org/search.json?q=${encodeURIComponent('tolkien')}&limit=${LIMIT}&fields=${OL_FIELDS}`,
  );
  const docs = search.data?.docs ?? [];
  report(search.ok && docs.length > 0, 'search «tolkien»', search.status, search.data?.numFound ?? docs.length, search.ms);
  examples(docs.map(olBook));
  search.ok && docs.length > 0 ? (passed += 1) : (failed += 1);

  const newestQuery = `first_publish_year:[${new Date().getFullYear() - 2} TO ${new Date().getFullYear()}]`;
  const newest = await getJson(
    `https://openlibrary.org/search.json?q=${encodeURIComponent(newestQuery)}&sort=new&limit=${LIMIT}&fields=${OL_FIELDS}`,
  );
  const newestDocs = newest.data?.docs ?? [];
  report(newest.ok && newestDocs.length > 0, 'newest (sort=new)', newest.status, newest.data?.numFound ?? newestDocs.length, newest.ms);
  examples(newestDocs.map(olBook));
  newest.ok && newestDocs.length > 0 ? (passed += 1) : (failed += 1);

  const trending = await getJson(`https://openlibrary.org/trending/daily.json?limit=${LIMIT}`);
  const trendingDocs = trending.data?.works ?? trending.data?.docs ?? [];
  report(trending.ok && trendingDocs.length > 0, 'popular (trending/daily)', trending.status, trendingDocs.length, trending.ms);
  examples(trendingDocs.map(olBook));
  trending.ok && trendingDocs.length > 0 ? (passed += 1) : (failed += 1);

  const subject = await getJson(
    `https://openlibrary.org/subjects/fantasy.json?limit=${LIMIT}&published_in=2020-2024`,
  );
  const works = subject.data?.works ?? [];
  report(subject.ok && works.length > 0, 'bySubject «fantasy»', subject.status, subject.data?.work_count ?? works.length, subject.ms);
  examples(
    works.map((work) => {
      const status = work.availability?.status;
      const access = status === 'open' ? 'download' : status === 'borrowable' ? 'borrow' : 'unknown';
      const iaIds = iaList(work.ia);
      return {
        title: work.title ?? '?',
        authors: iaList(work.author_name).length > 0
          ? iaList(work.author_name)
          : (work.authors ?? []).map((author) => author.name),
        year: yearOf(work.first_publish_year),
        access,
        files: access === 'download' && iaIds.length > 0 ? iaIds.slice(0, 3).map(() => ({ format: 'html' })) : [],
      };
    }),
  );
  subject.ok && works.length > 0 ? (passed += 1) : (failed += 1);

  const isbn = await getJson(
    'https://openlibrary.org/api/books?bibkeys=ISBN:9780141439518&format=json&jscmd=data',
  );
  const records = Object.values(isbn.data ?? {}).filter(Boolean);
  report(isbn.ok && records.length > 0, 'byIsbn 9780141439518', isbn.status, records.length, isbn.ms);
  examples(
    records.slice(0, 2).map((record) => ({
      title: record.title ?? '?',
      authors: (record.authors ?? []).map((author) => author.name),
      year: yearOf(record.publish_year) ?? yearOf(record.publish_date),
      access: 'borrow',
      files: [],
    })),
  );
  isbn.ok && records.length > 0 ? (passed += 1) : (failed += 1);
}

// --------------------------------------------------------------------------- //
// 2. Internet Archive
// --------------------------------------------------------------------------- //

const IA_FL = ['identifier', 'title', 'creator', 'year', 'subject', 'language', 'downloads', 'publicdate', 'mediatype'];

async function iaSearch(q, sort) {
  const params = new URLSearchParams();
  params.set('q', q);
  for (const field of IA_FL) params.append('fl[]', field);
  if (sort) params.append('sort[]', sort);
  params.set('rows', String(LIMIT));
  params.set('page', '1');
  params.set('output', 'json');
  return getJson(`https://archive.org/advancedsearch.php?${params.toString()}`);
}

async function iaMetadata(identifier) {
  return getJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
}

const IA_FILTERS = ' AND mediatype:texts AND -collection:inlibrary AND -collection:printdisabled';
/** Фильтр закрытых материалов — общий для текстов и аудио. */
const IA_OPEN_ONLY = ' AND -collection:inlibrary AND -collection:printdisabled';

async function checkInternetArchive() {
  section('Internet Archive (id: archive)');

  const search = await iaSearch(`("sherlock holmes")${IA_FILTERS}`);
  const docs = search.data?.response?.docs ?? [];
  report(search.ok && docs.length > 0, 'search «sherlock holmes»', search.status, search.data?.response?.numFound ?? docs.length, search.ms);
  const searchSample = await iaSample(docs, { take: 3 });
  printProbe(searchSample.probes[0]);
  examples(searchSample.books);
  search.ok && docs.length > 0 ? (passed += 1) : (failed += 1);

  const newest = await iaSearch(`mediatype:texts${IA_OPEN_ONLY}`, 'publicdate desc');
  const newestDocs = newest.data?.response?.docs ?? [];
  report(newest.ok && newestDocs.length > 0, 'newest (publicdate desc)', newest.status, newest.data?.response?.numFound ?? newestDocs.length, newest.ms);
  const newestSample = await iaSample(newestDocs, { requireFiles: true });
  printProbe(newestSample.probes[0]);
  examples(newestSample.books);
  newest.ok && newestDocs.length > 0 ? (passed += 1) : (failed += 1);

  const popular = await iaSearch(`mediatype:texts${IA_OPEN_ONLY}`, 'downloads desc');
  const popularDocs = popular.data?.response?.docs ?? [];
  report(popular.ok && popularDocs.length > 0, 'popular (downloads desc)', popular.status, popular.data?.response?.numFound ?? popularDocs.length, popular.ms);
  const popularSample = await iaSample(popularDocs, { requireFiles: true });
  printProbe(popularSample.probes[0]);
  examples(popularSample.books);
  popular.ok && popularDocs.length > 0 ? (passed += 1) : (failed += 1);

  const bySubject = await iaSearch(`subject:("science fiction")${IA_FILTERS}`);
  const subjectDocs = bySubject.data?.response?.docs ?? [];
  report(bySubject.ok && subjectDocs.length > 0, 'bySubject «science fiction»', bySubject.status, bySubject.data?.response?.numFound ?? subjectDocs.length, bySubject.ms);
  const subjectSample = await iaSample(subjectDocs, { requireFiles: true });
  printProbe(subjectSample.probes[0]);
  examples(subjectSample.books);
  bySubject.ok && subjectDocs.length > 0 ? (passed += 1) : (failed += 1);

  // ISBN есть далеко не у всех сканов: у старых книг его просто нет.
  const byIsbn = await iaSearch(`isbn:("5030008004")${IA_FILTERS}`);
  const isbnDocs = byIsbn.data?.response?.docs ?? [];
  report(byIsbn.ok, 'byIsbn 5030008004', byIsbn.status, byIsbn.data?.response?.numFound ?? isbnDocs.length, byIsbn.ms);
  const isbnSample = await iaSample(isbnDocs, { take: 3 });
  printProbe(isbnSample.probes[0]);
  examples(isbnSample.books);
  byIsbn.ok ? (passed += 1) : (failed += 1);
}

// --------------------------------------------------------------------------- //
// 3. Project Gutenberg (через IA)
// --------------------------------------------------------------------------- //

async function checkGutenberg() {
  section('Project Gutenberg через Internet Archive (id: gutenberg)');

  const search = await iaSearch(`collection:gutenberg AND mediatype:texts AND ("alice")${IA_OPEN_ONLY}`);
  const docs = search.data?.response?.docs ?? [];
  report(search.ok && docs.length > 0, 'search «alice»', search.status, search.data?.response?.numFound ?? docs.length, search.ms);
  const sample = await iaSample(docs, { take: 3 });
  printProbe(sample.probes[0]);
  examples(sample.books);
  sample.probes[0]?.status === 200 && (sample.probes[0]?.formats.length ?? 0) > 0 ? (passed += 1) : (failed += 1);

  const popular = await iaSearch(`collection:gutenberg AND mediatype:texts${IA_OPEN_ONLY}`, 'downloads desc');
  const popularDocs = popular.data?.response?.docs ?? [];
  report(popular.ok && popularDocs.length > 0, 'popular (downloads desc)', popular.status, popular.data?.response?.numFound ?? popularDocs.length, popular.ms);
  const popularSample = await iaSample(popularDocs, { requireFiles: true });
  printProbe(popularSample.probes[0]);
  examples(popularSample.books);
  popular.ok && popularDocs.length > 0 ? (passed += 1) : (failed += 1);

  // Прямой gutenberg.org — ожидаемо недоступен (503, без CORS).
  const direct = await getJson('https://www.gutenberg.org/ebooks/search/?query=alice');
  const directDown = !direct.ok;
  report(directDown, 'gutenberg.org напрямую (ожидаемо 503)', direct.status, undefined, direct.ms, directDown ? 'недоступен — работаем через IA' : 'доступен');
  directDown ? (passed += 1) : (failed += 1);
}

// --------------------------------------------------------------------------- //
// 4. LibriVox (через IA)
// --------------------------------------------------------------------------- //

async function checkLibrivox() {
  section('LibriVox через Internet Archive (id: librivox)');

  const search = await iaSearch(`collection:librivoxaudio AND mediatype:audio AND ("sherlock")${IA_OPEN_ONLY}`);
  const docs = search.data?.response?.docs ?? [];
  report(search.ok && docs.length > 0, 'search «sherlock»', search.status, search.data?.response?.numFound ?? docs.length, search.ms);
  search.ok && docs.length > 0 ? (passed += 1) : (failed += 1);

  const detail = docs[0]?.identifier ? await iaMetadata(docs[0].identifier) : null;
  const mp3 = (detail?.data?.files ?? []).filter(
    (file) => /\.mp3$/i.test(file.name ?? '') && !/_64kb\.mp3$/i.test(file.name ?? ''),
  );
  const tracks = mp3.length;
  console.log(
    `       metadata(${docs[0]?.identifier ?? '—'}): HTTP ${detail?.status ?? 0} · mp3-дорожек: ${tracks}`,
  );
  const book = iaBook(docs[0], detail?.data);
  book.files = tracks > 0 ? [{ format: 'audio' }] : [];
  book.access = tracks > 0 ? 'download' : 'unknown';
  const secondMeta = docs[1]?.identifier ? await iaMetadata(docs[1].identifier) : null;
  const secondBook = iaBook(docs[1], secondMeta?.data);
  const secondMp3 = (secondMeta?.data?.files ?? []).filter(
    (file) => /\.mp3$/i.test(file.name ?? '') && !/_64kb\.mp3$/i.test(file.name ?? ''),
  ).length;
  secondBook.files = secondMp3 > 0 ? [{ format: 'audio' }] : [];
  secondBook.access = secondMp3 > 0 ? 'download' : 'unknown';
  examples([book, secondBook]);
  detail?.ok && tracks > 0 ? (passed += 1) : (failed += 1);

  const popular = await iaSearch(
    `collection:librivoxaudio AND mediatype:audio${IA_OPEN_ONLY}`,
    'downloads desc',
  );
  const popularDocs = popular.data?.response?.docs ?? [];
  report(popular.ok && popularDocs.length > 0, 'popular (downloads desc)', popular.status, popular.data?.response?.numFound ?? popularDocs.length, popular.ms);
  const popularBooks = [];
  for (const doc of popularDocs.filter((item) => Boolean(item?.identifier)).slice(0, 4)) {
    const meta = await iaMetadata(doc.identifier);
    const audioBook = iaBook(doc, meta?.data);
    const mp3Count = (meta?.data?.files ?? []).filter(
      (file) => /\.mp3$/i.test(file.name ?? '') && !/_64kb\.mp3$/i.test(file.name ?? ''),
    ).length;
    audioBook.files = mp3Count > 0 ? [{ format: 'audio' }] : [];
    audioBook.access = mp3Count > 0 ? 'download' : 'unknown';
    if (mp3Count === 0) continue; // адаптер не возвращает записи без mp3
    popularBooks.push(audioBook);
    if (popularBooks.length >= 2) break;
  }
  examples(popularBooks);
  popular.ok && popularDocs.length > 0 ? (passed += 1) : (failed += 1);
}

// --------------------------------------------------------------------------- //
// 5. Google Books (ожидаемо 429 без ключа)
// --------------------------------------------------------------------------- //

async function checkGoogleBooks() {
  section('Google Books (id: googlebooks)');

  const result = await getJson(
    `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent('javascript')}&maxResults=2`,
  );
  const message = result.data?.error?.message ?? trunc(result.text, 120);
  const quota = result.status === 429;
  report(
    quota,
    'search без ключа (ожидаемо 429)',
    result.status,
    undefined,
    result.ms,
    quota ? 'нужен API-ключ' : 'неожиданный ответ',
  );
  console.log(`       ответ: ${trunc(message, 150)}`);
  quota ? (passed += 1) : (failed += 1);
}

// --------------------------------------------------------------------------- //
// 6. Встроенная библиотека (офлайн)
// --------------------------------------------------------------------------- //

async function checkLocalLibrary() {
  section('Встроенная библиотека «Полки» (id: local) — офлайн, без сети');

  const catalogPath = join(ROOT, 'src', 'data', 'catalog.json');
  if (!existsSync(catalogPath)) {
    report(false, 'src/data/catalog.json', 0, 0, 0, 'файл не найден');
    failed += 1;
    return;
  }
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const books = Array.isArray(catalog) ? catalog : [];
  const missing = books.filter(
    (book) => !existsSync(join(ROOT, 'public', 'library', `${book.id}.json`)),
  );
  const catalogOk = books.length > 0 && missing.length === 0;
  // Сети тут нет вообще: источник читает данные из самого приложения.
  console.log(
    `  ${catalogOk ? paint('green', 'OK  ') : paint('red', 'FAIL')} ${'каталог + файлы public/library'.padEnd(
      34,
    )} ${books.length} книг · ${missing.length === 0 ? 'все тексты на месте' : `нет файлов: ${missing.length}`} · без сети`,
  );
  examples(
    books.slice(0, 2).map((book) => ({
      title: book.title,
      authors: [book.author],
      year: book.year,
      access: 'download',
      files: [{ format: 'epub' }],
    })),
  );
  // Быстрая проверка «поиска» по локальным данным — сеть не используется.
  const query = 'Толстой';
  const found = books.filter((book) =>
    [book.title, book.author, ...(book.genres ?? []), ...(book.tags ?? [])]
      .join(' ')
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  console.log(`       поиск «${query}» по локальным данным: ${found.length} книг(и) без сети`);
  catalogOk ? (passed += 1) : (failed += 1);
}

// --------------------------------------------------------------------------- //
// Запуск
// --------------------------------------------------------------------------- //

console.log(paint('bold', 'Проверка книжных API «Полки»'));
console.log(`Node ${process.version} · ${new Date().toISOString()} · по ${LIMIT} записей на запрос`);

const started = Date.now();
await checkOpenLibrary();
await checkInternetArchive();
await checkGutenberg();
await checkLibrivox();
await checkGoogleBooks();
await checkLocalLibrary();

console.log(`\n${paint('cyan', '══ Итог ════════════════════════════════════════════════════════════')}`);
console.log(
  `  Проверок успешно: ${paint('green', String(passed))} · с ошибками: ${
    failed > 0 ? paint('red', String(failed)) : '0'
  } · всего ${((Date.now() - started) / 1000).toFixed(1)} с`,
);
console.log(
  failed === 0
    ? paint('green', '  Все ожидаемые источники отдали реальные данные (Google Books — 429 без ключа, gutenberg.org — 503).')
    : paint('red', '  Некоторые источники ответили не так, как ожидалось — смотрите строки FAIL выше.'),
);

process.exitCode = failed === 0 ? 0 : 1;
