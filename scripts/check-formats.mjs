#!/usr/bin/env node
/**
 * Проверка распознавания форматов и парсеров загрузок.
 *
 * Скрипт без внешних зависимостей:
 *  1. генерирует фикстуры в scripts/fixtures/ (EPUB-архив вручную, FB2 в
 *     UTF-8 и windows-1251, TXT, PDF, HTML-заглушку, битые файлы);
 *  2. собирает чистые модули src/downloads (парсеры + detect) в ESM-бандл
 *     через Vite (scripts/vite.test.config.mjs);
 *  3. прогоняет detectFormat/assertSafeDownload/парсеры в Node и печатает отчёт.
 *
 * Запуск: node scripts/check-formats.mjs [--no-build]
 * Код выхода 0 — все проверки прошли, 1 — есть падения.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const fixturesDir = path.join(projectRoot, 'scripts', 'fixtures');
const bundleDir = path.join(projectRoot, 'tmp', 'test-bundle');

// --------------------------------------------------------------------------- //
// Утилиты
// --------------------------------------------------------------------------- //

function encodeWindows1251(text) {
  const extra = {
    '«': 0xab,
    '»': 0xbb,
    '—': 0x97,
    '–': 0x96,
    '…': 0x85,
    '“': 0x93,
    '”': 0x94,
    '‘': 0x91,
    '’': 0x92,
    '№': 0xb9,
  };
  const bytes = [];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code >= 0x0410 && code <= 0x044f) {
      bytes.push(code - 0x0410 + 0xc0);
    } else if (code === 0x0401) {
      bytes.push(0xa8);
    } else if (code === 0x0451) {
      bytes.push(0xb8);
    } else if (extra[char] !== undefined) {
      bytes.push(extra[char]);
    } else {
      bytes.push(0x3f);
    }
  }
  return Buffer.from(bytes);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Минимальный ZIP-писатель: store (0) и deflate (8), без ZIP64. */
function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.method === 0 ? 0 : 8;
    const compressed = method === 8 ? deflateRawSync(raw) : raw;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

// --------------------------------------------------------------------------- //
// Генерация фикстур
// --------------------------------------------------------------------------- //

function paragraphSet(prefix) {
  return Array.from({ length: 6 }, (_, index) => `${prefix}: абзац номер ${index + 1}.`);
}

function chapterXhtml(title, paragraphs) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${title}</title>
  <style>p { color: red; }</style>
  <script>alert('не должно попасть в текст');</script>
</head>
<body>
  <h1>${title}</h1>
  ${paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join('\n  ')}
</body>
</html>`;
}

function buildEpub({ shortChapter = false, emptySpine = false } = {}) {
  const first = paragraphSet('Глава 1');
  first[0] = 'Абзац с сущностями: &amp; &laquo;кавычки&raquo; &mdash; тире.';
  const second = shortChapter ? ['Один короткий абзац.'] : paragraphSet('Глава 2');
  const secondTitle = shortChapter ? 'Короткая глава' : 'Глава вторая';
  const third = paragraphSet('Глава 3');

  const manifest = ['ch1', 'ch2', 'ch3']
    .map((id, index) => `    <item id="${id}" href="chapter${index + 1}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n');
  const spine = emptySpine
    ? ''
    : ['ch1', 'ch2', 'ch3'].map((id) => `    <itemref idref="${id}"/>`).join('\n');

  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Тестовая книга</dc:title>
    <dc:language>ru</dc:language>
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine>
${spine}
  </spine>
</package>`;

  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip', method: 0 },
    { name: 'META-INF/container.xml', data: container, method: 8 },
    { name: 'OEBPS/content.opf', data: opf, method: 8 },
    { name: 'OEBPS/chapter1.xhtml', data: chapterXhtml('Глава первая', first), method: 8 },
    { name: 'OEBPS/chapter2.xhtml', data: chapterXhtml(secondTitle, second), method: 8 },
    { name: 'OEBPS/chapter3.xhtml', data: chapterXhtml('Глава третья', third), method: 8 },
  ]);
}

function buildFb2() {
  return `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description>
    <title-info>
      <book-title>Тестовая FB2</book-title>
      <author><first-name>Иван</first-name><last-name>Тестов</last-name></author>
    </title-info>
  </description>
  <body>
    <title><p>Тестовая FB2</p></title>
    <section>
      <title><p>Глава первая</p></title>
      <p>Первый абзац главы. &amp; проверка сущностей.</p>
      <p>Второй абзац главы.</p>
      <p>Третий абзац главы.</p>
      <poem>
        <title><p>Стихотворение</p></title>
        <stanza><v>Строка первая</v><v>Строка вторая</v></stanza>
        <stanza><v>Строка третья</v></stanza>
      </poem>
      <section>
        <title><p>Подглава</p></title>
        <p>Вложенный абзац подглавы.</p>
      </section>
    </section>
    <section>
      <title><p>Глава вторая</p></title>
      <p>Единственный абзац второй главы.</p>
    </section>
  </body>
</FictionBook>`;
}

function buildTxt() {
  return [
    'ГЛАВА I',
    '',
    'Первый абзац первой главы. Он состоит из двух строк,',
    'которые должны склеиться в один абзац.',
    '',
    'Второй абзац первой главы.',
    '',
    'ГЛАВА II',
    '',
    'Абзац второй главы.',
    '',
    'Chapter 3',
    '',
    'The final chapter.',
    '',
  ].join('\n');
}

function buildPlainTxt() {
  return [
    'Первый абзац безглавого текста.',
    '',
    'Второй абзац безглавого текста.',
    '',
    'Третий абзац безглавого текста.',
    '',
    'Четвёртый абзац безглавого текста.',
    '',
  ].join('\n');
}

function buildLongTxt() {
  const sentences = Array.from({ length: 260 }, (_, index) => `Это очень длинное предложение номер ${index + 1}.`);
  return sentences.join(' ');
}

function buildPdf() {
  const chunks = [];
  const offsets = [];
  let size = 0;

  const add = (buffer) => {
    chunks.push(buffer);
    size += buffer.length;
  };
  const addObject = (parts) => {
    const number = offsets.length + 1;
    offsets.push(size);
    add(Buffer.from(`${number} 0 obj\n`, 'latin1'));
    for (const part of parts) add(Buffer.isBuffer(part) ? part : Buffer.from(part, 'latin1'));
    add(Buffer.from('\nendobj\n', 'latin1'));
    return number;
  };

  add(Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'));
  addObject(['<< /Type /Catalog /Pages 2 0 R >>']);
  addObject(['<< /Type /Pages /Kids [3 0 R] /Count 3 >>']);
  addObject(['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>']);
  const infoNumber = addObject([
    Buffer.from('<< /Title (', 'latin1'),
    encodeWindows1251('Полка: тестовая книга'),
    Buffer.from(') /Author (', 'latin1'),
    encodeWindows1251('Иван Тестов'),
    Buffer.from(') >>', 'latin1'),
  ]);

  const xrefOffset = size;
  const xrefLines = ['xref', `0 ${offsets.length + 1}`, '0000000000 65535 f '];
  for (const offset of offsets) xrefLines.push(`${String(offset).padStart(10, '0')} 00000 n `);
  add(Buffer.from(`${xrefLines.join('\n')}\n`, 'latin1'));
  add(
    Buffer.from(
      `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R /Info ${infoNumber} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      'latin1',
    ),
  );

  return Buffer.concat(chunks);
}

function buildHtmlStub() {
  return `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>Ошибка 404</title></head>
<body>
  <h1>Страница не найдена</h1>
  <p>${'Эта страница — заглушка вместо файла книги. '.repeat(40)}</p>
</body>
</html>`;
}

function writeFixtures() {
  mkdirSync(fixturesDir, { recursive: true });
  const epub = buildEpub();
  const fb2Utf8 = buildFb2();
  const txt = buildTxt();

  const fixtures = {
    'sample.epub': epub,
    'sample-short-chapter.epub': buildEpub({ shortChapter: true }),
    'sample-empty-spine.epub': buildEpub({ emptySpine: true }),
    'sample-broken.epub': epub.subarray(0, Math.floor(epub.length * 0.55)),
    'sample.fb2': Buffer.from(fb2Utf8, 'utf8'),
    'sample-1251.fb2': encodeWindows1251(fb2Utf8.replace('encoding="utf-8"', 'encoding="windows-1251"')),
    'sample-fb2.zip': makeZip([{ name: 'book.fb2', data: Buffer.from(fb2Utf8, 'utf8'), method: 8 }]),
    'sample.txt': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(txt, 'utf8')]),
    'sample-1251.txt': encodeWindows1251(txt),
    'sample-plain.txt': Buffer.from(buildPlainTxt(), 'utf8'),
    'sample-long.txt': Buffer.from(buildLongTxt(), 'utf8'),
    'sample.pdf': buildPdf(),
    'sample-broken.pdf': buildPdf().subarray(0, 120),
    'sample.html': Buffer.from(buildHtmlStub(), 'utf8'),
    'sample.mp3': Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2048, 0)]),
    'sample.mobi': Buffer.concat([Buffer.alloc(60, 0), Buffer.from('BOOKMOBI'), Buffer.alloc(64, 0)]),
    'random.bin': randomBytes(4096),
  };

  for (const [name, data] of Object.entries(fixtures)) {
    writeFileSync(path.join(fixturesDir, name), data);
  }
  return fixtures;
}

// --------------------------------------------------------------------------- //
// Сборка бандла и загрузка модулей
// --------------------------------------------------------------------------- //

function buildBundle() {
  if (process.argv.includes('--no-build')) return;
  const viteBin = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--config', 'scripts/vite.test.config.mjs', '--logLevel', 'warn'],
    { cwd: projectRoot, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    console.error('Не удалось собрать тестовый бандл (vite build).');
    process.exit(1);
  }
}

async function loadModules() {
  const stamp = `?t=${Date.now()}`;
  const parsers = await import(pathToFileURL(path.join(bundleDir, 'parsers.js')).href + stamp);
  const detect = await import(pathToFileURL(path.join(bundleDir, 'detect.js')).href + stamp);
  return { parsers, detect };
}

// --------------------------------------------------------------------------- //
// Отчёт
// --------------------------------------------------------------------------- //

const sections = [];
let currentSection = null;

function section(title) {
  currentSection = { title, rows: [] };
  sections.push(currentSection);
}

async function check(name, run) {
  try {
    const detail = await run();
    currentSection.rows.push({ ok: true, name, detail: detail ?? '' });
  } catch (error) {
    currentSection.rows.push({ ok: false, name, detail: error instanceof Error ? error.message : String(error) });
  }
}

async function expectError(run, fragment) {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (fragment && !message.includes(fragment)) {
      throw new Error(`Ожидали ошибку со словами «${fragment}», а получили: ${message}`);
    }
    return message;
  }
  throw new Error('Ожидали ошибку, но операция завершилась успешно.');
}

function printReport() {
  let passed = 0;
  let failed = 0;
  for (const reportSection of sections) {
    console.log(`\n=== ${reportSection.title} ===`);
    for (const row of reportSection.rows) {
      if (row.ok) {
        passed += 1;
        console.log(`  OK   ${row.name}${row.detail ? ` — ${row.detail}` : ''}`);
      } else {
        failed += 1;
        console.log(`  FAIL ${row.name}\n       ${row.detail}`);
      }
    }
  }
  console.log(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.`);
  return failed;
}

// --------------------------------------------------------------------------- //
// Основной сценарий
// --------------------------------------------------------------------------- //

async function main() {
  const fixtures = writeFixtures();
  console.log(`Фикстуры: ${path.relative(projectRoot, fixturesDir)} (${Object.keys(fixtures).length} файлов)`);

  buildBundle();
  const { parsers, detect } = await loadModules();
  const { parseEpub, parseFb2, parseTxt, parsePdfInfo, parseDownloadedFile } = parsers;
  const { detectFormat, assertSafeDownload, isReadable, isViewable, isAudio } = detect;

  const fixture = (name) => fixtures[name];
  const u8 = (buffer) => new Uint8Array(buffer);
  const arrayBuffer = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const zlibDecompress = async (data) => new Uint8Array(inflateRawSync(Buffer.from(data)));
  const textOf = (buffer) => buffer.toString('utf8');

  // ----------------------------------------------------------------------- //
  section('Распознавание форматов (detectFormat)');
  const detections = [
    ['sample.epub', 'application/octet-stream', 'https://example.org/book.epub'],
    ['sample.fb2', 'application/x-fictionbook+xml', 'https://example.org/book.fb2'],
    ['sample-1251.fb2', '', 'https://example.org/book-1251.fb2'],
    ['sample-fb2.zip', '', 'https://example.org/book.zip'],
    ['sample.txt', 'text/plain', 'https://example.org/book.txt'],
    ['sample-1251.txt', '', 'https://example.org/book-1251.txt'],
    ['sample.pdf', 'application/pdf', 'https://example.org/book.pdf'],
    ['sample.html', 'text/html', 'https://example.org/book'],
    ['sample.mp3', 'audio/mpeg', 'https://example.org/track.mp3'],
    ['sample.mobi', '', 'https://example.org/book.mobi'],
    ['sample-broken.epub', '', 'https://example.org/broken.epub'],
    ['random.bin', '', 'https://example.org/random.bin'],
  ];
  for (const [name, mime, url] of detections) {
    await check(name, () => {
      const info = detectFormat(u8(fixture(name)), mime, url);
      return `format=${info.format} kind=${info.kind} mime=${info.mime} confidence=${info.confidence}`;
    });
  }

  await check('sample.epub → epub/magic', () => {
    const info = detectFormat(u8(fixture('sample.epub')), '', 'https://example.org/book.epub');
    assert.equal(info.format, 'epub');
    assert.equal(info.kind, 'text');
    assert.equal(info.confidence, 'magic');
  });
  await check('sample.fb2 → fb2/magic', () => {
    const info = detectFormat(u8(fixture('sample.fb2')), '', '');
    assert.equal(info.format, 'fb2');
    assert.equal(info.confidence, 'magic');
    assert.equal(info.kind, 'text');
  });
  await check('sample-1251.fb2 → fb2', () => {
    assert.equal(detectFormat(u8(fixture('sample-1251.fb2')), '', '').format, 'fb2');
  });
  await check('sample-fb2.zip → fb2 (архив)', () => {
    assert.equal(detectFormat(u8(fixture('sample-fb2.zip')), '', '').format, 'fb2');
  });
  await check('sample.pdf → pdf/magic', () => {
    const info = detectFormat(u8(fixture('sample.pdf')), '', '');
    assert.equal(info.format, 'pdf');
    assert.equal(info.kind, 'pdf');
    assert.equal(info.confidence, 'magic');
  });
  await check('sample.html → html', () => {
    assert.equal(detectFormat(u8(fixture('sample.html')), 'application/octet-stream', '').format, 'html');
  });
  await check('sample.mp3 → audio', () => {
    assert.equal(detectFormat(u8(fixture('sample.mp3')), '', '').format, 'audio');
  });
  await check('sample.mobi → mobi (BOOKMOBI@60)', () => {
    assert.equal(detectFormat(u8(fixture('sample.mobi')), '', '').format, 'mobi');
  });
  await check('random.bin → unknown', () => {
    assert.equal(detectFormat(u8(fixture('random.bin')), '', '').format, 'unknown');
  });
  await check('isReadable/isViewable/isAudio', () => {
    assert.equal(isReadable('epub') && isReadable('fb2') && isReadable('txt'), true);
    assert.equal(isReadable('pdf'), false);
    assert.equal(isViewable('pdf'), true);
    assert.equal(isAudio('audio'), true);
    assert.equal(isAudio('epub'), false);
  });

  // ----------------------------------------------------------------------- //
  section('Защита от битых/подменённых файлов (assertSafeDownload)');
  await check('корректный EPUB принимается', () => {
    const result = assertSafeDownload({
      bytes: u8(fixture('sample.epub')),
      mime: 'application/epub+zip',
      url: 'https://example.org/a.epub',
      expectedFormat: 'epub',
    });
    assert.equal(result.format, 'epub');
    assert.equal(result.kind, 'text');
  });
  await check('заявлен PDF, внутри EPUB → ошибка', () =>
    expectError(
      () =>
        assertSafeDownload({
          bytes: u8(fixture('sample.epub')),
          mime: '',
          url: 'https://example.org/a.epub',
          expectedFormat: 'pdf',
        }),
      'Источник заявил формат PDF',
    ),
  );
  await check('HTML-заглушка → ошибка', () =>
    expectError(
      () =>
        assertSafeDownload({
          bytes: u8(fixture('sample.html')),
          mime: 'text/html',
          url: 'https://example.org/book.epub',
        }),
      'HTML-страницу',
    ),
  );
  await check('text/html при текстовых байтах → ошибка', () => {
    const padded = Buffer.concat([fixture('sample.txt'), Buffer.alloc(1500, 0x20)]);
    return expectError(
      () => assertSafeDownload({ bytes: u8(padded), mime: 'text/html', url: 'https://example.org/book.epub' }),
      'HTML-страницу',
    );
  });
  await check('неизвестный бинарный формат → ошибка', () =>
    expectError(
      () => assertSafeDownload({ bytes: u8(fixture('random.bin')), mime: '', url: 'https://example.org/a.bin' }),
      'распознать формат',
    ),
  );
  await check('слишком маленький файл → ошибка', () =>
    expectError(
      () => assertSafeDownload({ bytes: u8(Buffer.alloc(512, 0x41)), mime: '', url: 'https://example.org/a.txt' }),
      'слишком маленький',
    ),
  );
  await check('превышение лимита размера → ошибка', () =>
    expectError(
      () => assertSafeDownload({ bytes: u8(fixture('sample.epub')), mime: '', url: '', maxBytes: 100 }),
      'слишком большой',
    ),
  );

  // ----------------------------------------------------------------------- //
  section('EPUB-парсер');
  await check('3 главы через инъекцию node:zlib', async () => {
    const content = await parseEpub(arrayBuffer(fixture('sample.epub')), zlibDecompress);
    assert.equal(content.id, 'epub');
    assert.equal(content.chapters.length, 3, `глав: ${content.chapters.length}`);
    assert.equal(content.chapters[0].title, 'Глава первая');
    assert.equal(content.chapters[0].paragraphs.length, 6);
    assert.equal(content.chapters[0].paragraphs[0], 'Абзац с сущностями: & «кавычки» — тире.');
    assert.ok(content.chapters[0].paragraphs.every((p) => !p.includes('<') && !p.includes('alert') && !p.includes('color')));
    return `глав 3, абзацев ${content.chapters.reduce((sum, chapter) => sum + chapter.paragraphs.length, 0)}`;
  });
  await check('3 главы через DecompressionStream (по умолчанию)', async () => {
    const content = await parseEpub(arrayBuffer(fixture('sample.epub')));
    assert.equal(content.chapters.length, 3);
    return `глав ${content.chapters.length}`;
  });
  await check('короткая глава объединяется с соседней', async () => {
    const content = await parseEpub(arrayBuffer(fixture('sample-short-chapter.epub')), zlibDecompress);
    assert.equal(content.chapters.length, 2, `глав: ${content.chapters.length}`);
    assert.ok(content.chapters[0].paragraphs.length >= 5, 'в первой главе должно быть ≥5 абзацев');
    assert.ok(content.chapters[0].title.includes('Короткая глава'));
    return `глав ${content.chapters.length}, первая объединённая: «${content.chapters[0].title}»`;
  });
  await check('битый (обрезанный) EPUB → понятная ошибка', () =>
    expectError(() => parseEpub(arrayBuffer(fixture('sample-broken.epub')), zlibDecompress), 'EPUB'),
  );
  await check('пустой spine → понятная ошибка', () =>
    expectError(() => parseEpub(arrayBuffer(fixture('sample-empty-spine.epub')), zlibDecompress), 'spine'),
  );

  // ----------------------------------------------------------------------- //
  section('FB2-парсер');
  await check('UTF-8: секции, вложенность, стихи', async () => {
    const content = await parseFb2(arrayBuffer(fixture('sample.fb2')));
    assert.equal(content.id, 'fb2');
    assert.equal(content.chapters.length, 3, `глав: ${content.chapters.length}`);
    assert.equal(content.chapters[0].title, 'Глава первая');
    assert.equal(content.chapters[0].paragraphs[0], 'Первый абзац главы. & проверка сущностей.');
    assert.equal(content.chapters[1].title, 'Глава первая · Подглава');
    const poem = content.chapters[0].paragraphs.find((paragraph) => paragraph.includes('Строка первая'));
    assert.ok(poem && poem.includes('\nСтрока вторая'), 'стихи должны быть с переносами строк');
    return `глав 3, вложенная: «${content.chapters[1].title}»`;
  });
  await check('windows-1251 совпадает с UTF-8', async () => {
    const utf8 = await parseFb2(arrayBuffer(fixture('sample.fb2')));
    const cp1251 = await parseFb2(arrayBuffer(fixture('sample-1251.fb2')));
    assert.equal(cp1251.chapters.length, utf8.chapters.length);
    assert.equal(cp1251.chapters[0].title, 'Глава первая');
    assert.equal(cp1251.chapters[0].paragraphs[1], 'Второй абзац главы.');
    return `глав ${cp1251.chapters.length}, кодировка определена верно`;
  });

  // ----------------------------------------------------------------------- //
  section('TXT-парсер');
  await check('UTF-8: главы по заголовкам', async () => {
    const content = await parseTxt(arrayBuffer(fixture('sample.txt')));
    assert.equal(content.chapters.length, 3, `глав: ${content.chapters.length}`);
    assert.equal(content.chapters[0].title, 'ГЛАВА I');
    assert.equal(content.chapters[0].paragraphs.length, 2);
    assert.ok(content.chapters[0].paragraphs[0].includes('склеиться'), 'строки абзаца должны склеиться');
    assert.equal(content.chapters[2].title, 'Chapter 3');
    return `глав 3, абзац склеен из двух строк`;
  });
  await check('windows-1251 без BOM', async () => {
    const content = await parseTxt(arrayBuffer(fixture('sample-1251.txt')));
    assert.equal(content.chapters.length, 3);
    assert.equal(content.chapters[1].title, 'ГЛАВА II');
    assert.equal(content.chapters[1].paragraphs[0], 'Абзац второй главы.');
    return `глав ${content.chapters.length}, кодировка определена верно`;
  });
  await check('без заголовков → одна глава', async () => {
    const content = await parseTxt(arrayBuffer(fixture('sample-plain.txt')));
    assert.equal(content.chapters.length, 1);
    assert.equal(content.chapters[0].paragraphs.length, 4);
    return `глав 1, абзацев 4`;
  });
  await check('«простыня» >5000 символов режется на куски', async () => {
    const content = await parseTxt(arrayBuffer(fixture('sample-long.txt')));
    assert.equal(content.chapters.length, 1);
    assert.ok(content.chapters[0].paragraphs.length > 3, `абзацев: ${content.chapters[0].paragraphs.length}`);
    const longest = Math.max(...content.chapters[0].paragraphs.map((paragraph) => paragraph.length));
    assert.ok(longest <= 1400, `самый длинный кусок: ${longest}`);
    return `глав 1, абзацев ${content.chapters[0].paragraphs.length}, макс. ${longest} символов`;
  });

  // ----------------------------------------------------------------------- //
  section('PDF: валидация и метаданные');
  await check('/Count, /Title, /Author', async () => {
    const info = await parsePdfInfo(arrayBuffer(fixture('sample.pdf')));
    assert.equal(info.pages, 3);
    assert.equal(info.title, 'Полка: тестовая книга');
    assert.equal(info.author, 'Иван Тестов');
    return `страниц ${info.pages}, «${info.title}», ${info.author}`;
  });
  await check('обрезанный PDF → понятная ошибка', () =>
    expectError(() => parsePdfInfo(arrayBuffer(fixture('sample-broken.pdf'))), 'PDF'),
  );

  // ----------------------------------------------------------------------- //
  section('Диспетчер parseDownloadedFile');
  await check('EPUB → BookContent', async () => {
    const parsed = await parseDownloadedFile({
      bytes: arrayBuffer(fixture('sample.epub')),
      format: 'epub',
      url: 'https://example.org/book.epub',
      decompress: zlibDecompress,
    });
    assert.ok(parsed.content);
    assert.equal(parsed.content.chapters.length, 3);
    return `глав ${parsed.content.chapters.length}`;
  });
  await check('FB2 в ZIP → BookContent', async () => {
    const parsed = await parseDownloadedFile({
      bytes: arrayBuffer(fixture('sample-fb2.zip')),
      format: 'fb2',
      url: 'https://example.org/book.zip',
      decompress: zlibDecompress,
    });
    assert.ok(parsed.content);
    assert.equal(parsed.content.chapters.length, 3);
    return `глав ${parsed.content.chapters.length}`;
  });
  await check('PDF → только pdfInfo, без BookContent', async () => {
    const parsed = await parseDownloadedFile({
      bytes: arrayBuffer(fixture('sample.pdf')),
      format: 'pdf',
      url: 'https://example.org/book.pdf',
    });
    assert.equal(parsed.content, undefined);
    assert.equal(parsed.pdfInfo?.pages, 3);
    return `pdfInfo.pages=${parsed.pdfInfo?.pages}`;
  });
  await check('MOBI → честная ошибка', () =>
    expectError(
      () => parseDownloadedFile({ bytes: arrayBuffer(fixture('sample.mobi')), format: 'mobi' }),
      'MOBI: браузер не умеет читать этот формат',
    ),
  );
  await check('HTML → ошибка вместо сохранения', () =>
    expectError(
      () => parseDownloadedFile({ bytes: arrayBuffer(fixture('sample.html')), format: 'html' }),
      'HTML-страницу',
    ),
  );
  await check('битый EPUB через диспетчер → ошибка', () =>
    expectError(
      () =>
        parseDownloadedFile({
          bytes: arrayBuffer(fixture('sample-broken.epub')),
          format: 'epub',
          decompress: zlibDecompress,
        }),
      'EPUB',
    ),
  );

  const failed = printReport();
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\nПроверка упала с необработанной ошибкой:', error);
  process.exitCode = 1;
});
