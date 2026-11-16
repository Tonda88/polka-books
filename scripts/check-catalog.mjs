#!/usr/bin/env node
/**
 * Проверка мульти-источникового каталога «Полки».
 *
 * Покрывает то, что нельзя проверить простыми HTTP-запросами:
 *  - определение языка и категорий;
 *  - дедупликацию по ISBN (10/13), названию и автору;
 *  - выбор и нормализацию обложек;
 *  - проверку доступности файлов (probeFile/verifyBookFiles);
 *  - изоляцию источников: Google Books без ключа не ломает выдачу;
 *  - серверный прокси Google Books (ключ не в клиенте).
 *
 * Запуск: node scripts/check-catalog.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BUNDLE = join(ROOT, 'tmp', 'catalog-bundle');
const SERVER = process.env.POLKA_URL || 'http://127.0.0.1:4173';

const FORM = { green: '\u001b[32m', red: '\u001b[31m', dim: '\u001b[2m', bold: '\u001b[1m', reset: '\u001b[0m' };
const color = process.stdout.isTTY === true;
const paint = (name, text) => (color ? `${FORM[name]}${text}${FORM.reset}` : text);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ${paint('green', 'OK  ')} ${name}${detail ? paint('dim', ` — ${detail}`) : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ${paint('red', 'FAIL')} ${name}${detail ? paint('dim', ` — ${detail}`) : ''}`);
  }
}

function section(title) {
  console.log(`\n${paint('bold', `══ ${title} ══`)}`);
}

// --- сборка тестового бандла ------------------------------------------------
// Бандл собираем заново: тесты должны видеть актуальный код.
if (process.env.SKIP_CATALOG_BUILD !== '1') {
  console.log('Собираем бандл каталога…');
  execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'scripts/vite.catalog.config.mjs'],
    { cwd: ROOT, stdio: 'inherit' },
  );
}

const classify = await import(new URL(`file:///${BUNDLE.replace(/\\/g, '/')}/classify.js`).href);
const normalize = await import(new URL(`file:///${BUNDLE.replace(/\\/g, '/')}/normalize.js`).href);
const covers = await import(new URL(`file:///${BUNDLE.replace(/\\/g, '/')}/covers.js`).href);
const availability = await import(new URL(`file:///${BUNDLE.replace(/\\/g, '/')}/availability.js`).href);
const aggregate = await import(new URL(`file:///${BUNDLE.replace(/\\/g, '/')}/aggregate.js`).href);
const registry = await import(new URL(`file:///${BUNDLE.replace(/\\/g, '/')}/registry.js`).href);
const limits = await import(new URL(`file:///${BUNDLE.replace(/\\/g, '/')}/limits.js`).href);

const sampleBook = (overrides = {}) => ({
  id: 'test:1',
  sourceId: 'openlibrary',
  externalId: '1',
  title: 'Frankenstein; or, The Modern Prometheus',
  authors: ['Mary Wollstonecraft Shelley'],
  subjects: ['Science fiction', 'Horror tales'],
  languages: ['en'],
  files: [],
  access: 'download',
  source: { sourceId: 'openlibrary', sourceName: 'Open Library' },
  fetchedAt: Date.now(),
  ...overrides,
});

// ===========================================================================
section('Язык книги');
check('«en» → Английский', classify.languageLabel('en') === 'Английский');
check('«English» → en', classify.languageCode('English') === 'en');
check('«Русский» → ru', classify.languageLabel('Русский') === 'Русский');
check('«en-US» → Английский', classify.languageLabel('en-US') === 'Английский');
check('«deu» → Немецкий', classify.languageLabel('deu') === 'Немецкий');
check('пустая строка → undefined', classify.languageLabel('') === undefined);
check(
  'bookLanguage берёт первый распознанный',
  classify.bookLanguage(sampleBook({ languages: ['ru', 'en'] }))?.code === 'ru',
);
check('bookLanguageLabel на реальной записи', classify.bookLanguageLabel(sampleBook()) === 'Английский');

// ===========================================================================
section('Жанры и категории');
const fantasy = sampleBook({ subjects: ['Science fiction', 'space travel'], title: 'Dune' });
const mystery = sampleBook({ title: 'Убийство в «Восточном экспрессе»', subjects: ['detective stories'] });
const poetry = sampleBook({ title: 'Стихотворения', subjects: ['poetry'] });
check('фантастика распознана', classify.primaryCategory(fantasy)?.id === 'fantasy');
check('детектив распознан (рус.)', classify.primaryCategory(mystery)?.id === 'mystery');
check('поэзия распознана', classify.primaryCategory(poetry)?.id === 'poetry');
check('категорий может быть несколько', classify.categoriesOf(sampleBook({ subjects: ['fiction', 'poetry'] })).length >= 2);
check('жанр в подписи', Boolean(classify.genreLabel(fantasy)));
check('фильтр по категории работает', classify.filterByCategory(fantasy, 'fantasy') && !classify.filterByCategory(fantasy, 'poetry'));
check('«all» пропускает всё', classify.filterByCategory(fantasy, 'all'));

// ===========================================================================
section('ISBN и дедупликация');
check('ISBN-10 → ISBN-13', normalize.isbn10To13('0306406152') === '9780306406157', normalize.isbn10To13('0306406152'));
check('ISBN-13 → ISBN-10', normalize.isbn13To10('9780306406157') === '0306406152', normalize.isbn13To10('9780306406157'));
check('эквиваленты содержат обе формы', normalize.isbnEquivalents('0-306-40615-2').includes('9780306406157'));
check(
  'дубль по ISBN-10/13',
  normalize.isLikelyDuplicate(sampleBook({ isbn: ['0306406152'] }), sampleBook({ isbn: ['9780306406157'] })),
);
check(
  'не дубль при разных ISBN и названиях',
  !normalize.isLikelyDuplicate(sampleBook({ isbn: ['9780306406157'] }), sampleBook({ isbn: ['9780141439518'], title: 'Pride and Prejudice' })),
);
check(
  'дубль по названию+автору',
  normalize.isLikelyDuplicate(
    sampleBook({ title: 'Война и мир', authors: ['Лев Толстой'] }),
    sampleBook({ title: 'Война и мир. Том 1', authors: ['Толстой Лев'] }),
  ),
);
check(
  'не дубль при разных авторах',
  !normalize.isLikelyDuplicate(
    sampleBook({ title: 'Война и мир', authors: ['Лев Толстой'] }),
    sampleBook({ title: 'Война и мир', authors: ['Иван Тургенев'] }),
  ),
);

// ===========================================================================
section('Обложки');
check(
  'Open Library: размер S → L',
  covers.normalizeCoverUrl('https://covers.openlibrary.org/b/id/12345-S.jpg') === 'https://covers.openlibrary.org/b/id/12345-L.jpg',
);
check('http → https', covers.normalizeCoverUrl('http://covers.openlibrary.org/b/id/1-M.jpg')?.startsWith('https://'));
check(
  'Google Books: убран edge=curl',
  !covers.normalizeCoverUrl('https://books.google.com/books/content?id=X&printsec=frontcover&edge=curl')?.includes('edge=curl'),
);
check('пустая обложка → undefined', covers.normalizeCoverUrl(undefined) === undefined);
check(
  'приоритет: Open Library важнее Google',
  covers.bestCover(
    sampleBook({
      coverUrl: 'https://books.google.com/books/content?id=X',
      coverAlternatives: ['https://covers.openlibrary.org/b/id/9-S.jpg'],
    }),
  ) === 'https://covers.openlibrary.org/b/id/9-L.jpg',
);

// ===========================================================================
section('Проверка доступности файлов');
const txtUrl = 'https://archive.org/download/mropp25070gut/25070-8.txt';
const txtProbe = await availability.probeFile({ url: txtUrl, format: 'txt' });
check('TXT-файл доступен', txtProbe.ok, `HTTP ${txtProbe.status}, ${txtProbe.sizeBytes ?? '?'} байт`);

const missingProbe = await availability.probeFile({
  url: 'https://archive.org/download/mropp25070gut/no-such-file.txt',
  format: 'txt',
});
check('несуществующий файл отклонён', !missingProbe.ok, `HTTP ${missingProbe.status ?? '—'}`);

let serverUp = false;
try {
  const health = await fetch(`${SERVER}/api/health`, { signal: AbortSignal.timeout(3000) });
  serverUp = health.ok;
} catch {
  serverUp = false;
}
if (serverUp) {
  const epubUrl = 'https://archive.org/download/jaleikkikuvailus52530gut/pg52530.epub';
  const viaProxy = await availability.probeFile({
    url: `${SERVER}/api/fetch?url=${encodeURIComponent(epubUrl)}`,
    format: 'epub',
  });
  check('EPUB через серверный прокси доступен', viaProxy.ok, `HTTP ${viaProxy.status}, ${viaProxy.sizeBytes ?? '?'} байт`);

  const verified = await availability.verifyBookFiles(
    sampleBook({ files: [{ url: txtUrl, format: 'txt' }, { url: `${SERVER}/api/fetch?url=${encodeURIComponent(epubUrl)}`, format: 'epub' }] }),
  );
  check('verifyBookFiles проверяет все файлы', verified.files.every((file) => typeof file.available === 'boolean'));
  check('verifyBookFiles проставляет размеры', verified.files.some((file) => (file.sizeBytes ?? 0) > 0));
} else {
  console.log(paint('dim', '  (сервер не запущен — проверки прокси пропущены)'));
}


// ===========================================================================
section('Предохранитель: отмена ≠ ошибка источника');
const busy = 'test-busy-source';
limits.resetSourceGuard();
const abortError = () => {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
};
for (let index = 0; index < 5; index += 1) {
  await limits
    .withSourceGuard(busy, async () => {
      throw abortError();
    }, { skipDelay: true })
    .catch(() => null);
}
check('пять отмен не открывают предохранитель', !limits.isCircuitOpen(busy));

const failing = 'test-failing-source';
limits.resetSourceGuard();
for (let index = 0; index < 3; index += 1) {
  await limits
    .withSourceGuard(failing, async () => {
      throw new Error('503 Service Unavailable');
    }, { skipDelay: true })
    .catch(() => null);
}
check('три реальные ошибки открывают предохранитель', limits.isCircuitOpen(failing));
check('источник пропускается без запроса', (await limits.withSourceGuard(failing, async () => 'ok', { skipDelay: true })) === null);
limits.resetSourceGuard();
check('ручной сброс возвращает источник', !limits.isCircuitOpen(failing));

const healthy = 'test-healthy-source';
limits.resetSourceGuard();
let ran = 0;
await limits.withSourceGuard(healthy, async () => {
  ran += 1;
  throw new Error('разовая ошибка');
}, { skipDelay: true }).catch(() => null);
const value = await limits.withSourceGuard(healthy, async () => {
  ran += 1;
  return 'ok';
}, { skipDelay: true });
check('успех после ошибки продолжает работу', value === 'ok' && ran === 2);

// ===========================================================================
section('Источники и изоляция сбоев');
const sources = registry.listSources();
check('зарегистрировано 6 источников', sources.length === 6, sources.map((s) => s.id).join(', '));
check(
  'Google Books помечен как требующий ключ',
  sources.find((source) => source.id === 'googlebooks')?.capabilities.requiresKey === true,
);

const withoutKey = await aggregate.searchAll({ text: 'tolkien', limit: 10 });
check('поиск без ключа Google вернул книги', withoutKey.books.length > 0, `${withoutKey.books.length} книг`);
check('Open Library участвовал', (withoutKey.perSource.openlibrary ?? 0) > 0);
check('Google Books без ключа не опрашивался', (withoutKey.perSource.googlebooks ?? 0) === 0);
check(
  'ошибок Google в выдаче нет',
  !withoutKey.errors.some((error) => error.sourceId === 'googlebooks'),
  withoutKey.errors.map((error) => error.sourceId).join(', ') || 'нет ошибок',
);
check(
  'в выдаче нет дублей',
  withoutKey.books.every((book, index) => withoutKey.books.slice(index + 1).every((other) => !normalize.isLikelyDuplicate(book, other))),
);

const badKey = await aggregate.searchAll({ text: 'tolkien', limit: 5, googleKey: 'INVALID_TEST_KEY' }, { googleKey: 'INVALID_TEST_KEY' });
check('с неверным ключом остальные источники работают', badKey.books.length > 0, `${badKey.books.length} книг`);
check(
  'ошибка Google изолирована',
  badKey.errors.some((error) => error.sourceId === 'googlebooks') && badKey.errors.length < 5,
  badKey.errors.map((error) => `${error.sourceId}:${error.status ?? '—'}`).join(', '),
);

check('у книг определяется язык', withoutKey.books.filter((book) => classify.bookLanguage(book)).length >= Math.ceil(withoutKey.books.length / 2));
check('у книг определяется категория', withoutKey.books.every((book) => Boolean(classify.primaryCategory(book))));
check('реальные обложки есть', withoutKey.books.some((book) => Boolean(book.coverUrl)), withoutKey.books.filter((book) => book.coverUrl).length + ' с обложкой');

// ===========================================================================
section('Серверный прокси Google Books');
if (serverUp) {
  const health = await (await fetch(`${SERVER}/api/health`)).json();
  check('health сообщает о прокси', health.proxy === true);
  const proxyResponse = await fetch(`${SERVER}/api/googlebooks?path=volumes&q=tolkien&maxResults=1`);
  const payload = await proxyResponse.json();
  const hasServerKey = Boolean(process.env.GOOGLE_BOOKS_KEY);
  if (hasServerKey || proxyResponse.status === 200) {
    check('прокси Google Books отвечает (ключ задан)', proxyResponse.status === 200, `HTTP ${proxyResponse.status}`);
  } else {
    check(
      'прокси Google Books без ключа отвечает понятной ошибкой',
      proxyResponse.status === 503 && String(payload.error ?? '').includes('GOOGLE_BOOKS_KEY'),
      `HTTP ${proxyResponse.status}`,
    );
  }
  const blocked = await fetch(`${SERVER}/api/fetch?url=${encodeURIComponent('https://example.com/a.epub')}`);
  check('прокси файлов блокирует чужие домены', blocked.status === 403, `HTTP ${blocked.status}`);
} else {
  console.log(paint('dim', '  (сервер не запущен — проверки прокси пропущены)'));
}

// ===========================================================================
console.log(`\n${paint('bold', '══ Итог ══')}`);
console.log(`  Проверок успешно: ${passed} · с ошибками: ${failed}`);
if (failed > 0) {
  console.log(`  Провалено: ${failures.join(', ')}`);
  process.exitCode = 1;
}
