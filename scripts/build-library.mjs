/**
 * Собирает демо-библиотеку:
 *  - content/books.json  (тексты, пишет контент-редактор)
 *  -> public/library/<id>.json  (файлы, которые приложение реально скачивает)
 *  -> src/data/catalog.json     (метаданные для каталога и рекомендаций)
 *
 * Запуск: node scripts/build-library.mjs
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOK_CONFIG } from './book-config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(root, 'content', 'books.json');
const libraryDir = join(root, 'public', 'library');
const catalogPath = join(root, 'src', 'data', 'catalog.json');

const words = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0);
const bytes = (text) => Buffer.byteLength(text, 'utf8');

if (!existsSync(sourcePath)) {
  console.error(`Нет файла текстов: ${sourcePath}`);
  process.exit(1);
}

let books;
try {
  books = JSON.parse(readFileSync(sourcePath, 'utf8'));
} catch (error) {
  console.error('content/books.json — невалидный JSON:', error.message);
  process.exit(1);
}

const byId = new Map(books.map((book) => [book.id, book]));
const knownIds = new Set(BOOK_CONFIG.map((config) => config.id));
const errors = [];

for (const config of BOOK_CONFIG) {
  const book = byId.get(config.id);
  if (!book) {
    errors.push(`Нет текста для книги «${config.id}»`);
    continue;
  }
  if (!Array.isArray(book.chapters) || book.chapters.length === 0) {
    errors.push(`«${config.id}»: нет глав`);
    continue;
  }
  for (const [index, chapter] of book.chapters.entries()) {
    if (!Array.isArray(chapter.paragraphs) || chapter.paragraphs.length === 0) {
      errors.push(`«${config.id}», глава ${index + 1}: нет абзацев`);
    }
    if (typeof chapter.title !== 'string' || !chapter.title.trim()) {
      errors.push(`«${config.id}», глава ${index + 1}: нет названия`);
    }
    for (const paragraph of chapter.paragraphs ?? []) {
      if (typeof paragraph !== 'string' || !paragraph.trim()) {
        errors.push(`«${config.id}», глава ${index + 1}: пустой абзац`);
      }
    }
  }
  if (!book.title || !book.author) errors.push(`«${config.id}»: нет автора или названия`);
  if (!Array.isArray(book.genres) || book.genres.length === 0) errors.push(`«${config.id}»: нет жанров`);
  if (!Array.isArray(book.tags) || book.tags.length === 0) errors.push(`«${config.id}»: нет тегов`);
  if (typeof book.description !== 'string' || book.description.length < 80) {
    errors.push(`«${config.id}»: слишком короткое описание`);
  }
}

for (const book of books) {
  if (!knownIds.has(book.id)) errors.push(`Неизвестная книга «${book.id}» — добавьте её в scripts/book-config.mjs`);
}

if (errors.length) {
  console.error('Ошибки контента:\n- ' + errors.join('\n- '));
  process.exit(1);
}

mkdirSync(libraryDir, { recursive: true });
mkdirSync(dirname(catalogPath), { recursive: true });

const catalog = [];
let totalBytes = 0;
const rows = [];

// Убираем файлы книг, которых больше нет в каталоге.
if (existsSync(libraryDir)) {
  for (const file of readdirSync(libraryDir)) {
    if (file.endsWith('.json') && !knownIds.has(file.replace(/\.json$/, ''))) {
      unlinkSync(join(libraryDir, file));
    }
  }
}

for (const config of BOOK_CONFIG) {
  const book = byId.get(config.id);
  if (!book.source?.name || !book.source?.url) {
    throw new Error(`У книги «${config.id}» нет источника. Запустите scripts/sync-library.py`);
  }
  const content = { id: config.id, chapters: book.chapters };
  const payload = JSON.stringify(content);
  const size = bytes(payload);
  totalBytes += size;
  writeFileSync(join(libraryDir, `${config.id}.json`), payload, 'utf8');

  const wordCount = book.chapters.reduce(
    (sum, chapter) => sum + chapter.paragraphs.reduce((acc, paragraph) => acc + words(paragraph), 0),
    0,
  );

  catalog.push({
    id: config.id,
    title: book.title,
    author: book.author,
    year: Number(book.year) || 1900,
    genres: book.genres,
    tags: book.tags,
    description: book.description,
    pages: Number(book.pages) || config.pages,
    minutes: Number(book.minutes) || config.minutes,
    rating: config.rating,
    reviews: config.reviews,
    narrator: config.narrator,
    cover: config.cover,
    chapters: book.chapters.map((chapter) => chapter.title),
    words: wordCount,
    bytes: size,
    source: book.source,
  });

  rows.push({
    id: config.id,
    title: book.title,
    chapters: book.chapters.length,
    words: wordCount,
    kb: (size / 1024).toFixed(1),
    source: book.source.page,
  });
}

writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

console.log(`Библиотека собрана: ${rows.length} книг, ${(totalBytes / 1024).toFixed(1)} КБ текстов.\n`);
for (const row of rows) {
  console.log(
    `${row.id.padEnd(22)} ${String(row.chapters).padStart(3)} гл. ${String(row.words).padStart(6)} слов ${String(row.kb).padStart(8)} КБ  ${row.title}`,
  );
  console.log(`    источник: ${row.source}`);
}
console.log(`\nКаталог: ${catalogPath}`);
console.log(`Файлы книг: ${libraryDir}`);
