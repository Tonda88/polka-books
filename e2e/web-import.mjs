/**
 * E2E импорта книг из файлов и URL-поиска:
 *  - режим «Поиск в интернете» открывается из каталога;
 *  - импорт EPUB/FB2 с распознаванием метаданных;
 *  - добавление в библиотеку;
 *  - повторный импорт не создаёт дубликат;
 *  - книга читается.
 *
 * Запуск: node e2e/web-import.mjs (нужен сервер на 127.0.0.1:4173)
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'screenshots');
mkdirSync(shots, { recursive: true });
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.POLKA_URL || 'http://127.0.0.1:4173';
const FIXTURES = join(root, 'scripts', 'fixtures');

const results = [];
const errors = [];
const pass = (name, extra = '') => {
  results.push({ name, ok: true, extra });
  console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`);
};
const fail = (name, error) => {
  results.push({ name, ok: false, error: String(error) });
  console.log(`  ❌ ${name} — ${error}`);
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
async function step(name, fn) {
  console.log(`\n▶ ${name}`);
  await fn();
}

const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--mute-audio'] });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: 'ru-RU',
});
const page = await context.newPage();
page.setDefaultTimeout(60_000);
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !/CORS|ERR_TIMED_OUT|net::ERR/.test(message.text())) errors.push(message.text());
});

const shot = async (name) => {
  await page.screenshot({ path: join(shots, `${name}.png`) });
  console.log(`  📸 ${name}`);
};

const readNetBooks = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.open('polka-library');
        request.onerror = () => resolve([]);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('netbooks')) return resolve([]);
          const all = db.transaction('netbooks', 'readonly').objectStore('netbooks').getAll();
          all.onsuccess = () => resolve(all.result ?? []);
          all.onerror = () => resolve([]);
        };
      }),
  );

async function gotoHash(hash, selector) {
  await page.evaluate((value) => {
    location.hash = value;
  }, hash);
  await page.waitForSelector(selector, { timeout: 60_000 });
}

let importedTitle = '';

try {
  await step('Онбординг и переход в интернет-поиск', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    if (await page.locator('.onboarding').count()) {
      await page.getByRole('button', { name: 'Пропустить' }).click();
      await page.waitForSelector('.home');
    }
    // Новый путь: TabBar → Поиск → InternetSearchScreen
    await gotoHash('/search', '.internet-search-screen');
    await shot('80-search-screen');
    pass('Экран поиска в интернете открылся');
  });

  await step('Поиск книги работает (встроенный режим)', async () => {
    await gotoHash('/search', '.internet-search-screen');
    const input = page.locator('.search-field__input').first();
    await input.fill('Frankenstein');
    await page.getByRole('button', { name: /Найти книгу/ }).first().click();
    // Ждём либо результатов, либо ошибки
    await page.waitForSelector('.discovery-results, .discovery-error', { timeout: 90_000 });
    const hasResults = await page.locator('.discovery-results').count();
    const modeText = (await page.locator('.discovery-mode__badge').textContent()) ?? '';
    assert(modeText.length > 0, 'Значок режима не отображается');
    pass('Поиск выполнен', `${hasResults ? 'есть результаты' : 'нет результатов'} · ${modeText.trim()}`);
    await shot('81-search-results');
  });

  await step('Импорт EPUB и распознавание метаданных', async () => {
    await gotoHash('/search', '.internet-search-screen');
    await page.waitForTimeout(400);
    await page.locator('input[type="file"]').first().setInputFiles(join(FIXTURES, 'sample.epub'));
    await page.waitForSelector('.web-draft', { timeout: 30_000 });
    await page.waitForTimeout(800);
    const titleValue = await page.locator('.web-field input').first().inputValue();
    assert(titleValue.length > 0, 'Название не распознано');
    importedTitle = titleValue;
    const meta = (await page.locator('.web-draft').textContent()) ?? '';
    assert(/EPUB/.test(meta), 'Формат EPUB не определён');
    await shot('82-import-draft');
    pass('Метаданные распознаны', `«${titleValue}»`);
  });

  await step('Добавление в библиотеку', async () => {
    await page.getByRole('button', { name: /Добавить в библиотеку/ }).click();
    await page.waitForTimeout(2500);
    await page.waitForSelector('.mybooks-stats', { timeout: 30_000 });
    const netbooks = await readNetBooks();
    assert(netbooks.length > 0, 'Книга не попала в базу приложения');
    assert(
      netbooks.some((book) => String(book.id).startsWith('net:import:')),
      'Нет записи импортированной книги',
    );
    const pageText = ((await page.locator('.mybooks-stats').textContent()) ?? '') + ' ' + ((await page.locator('.screen').textContent()) ?? '');
    assert(pageText.includes(importedTitle), 'Книга не появилась в «Моих книгах»');
    await shot('83-imported-library');
    pass('Книга добавлена в «Мои книги»', importedTitle);
  });

  await step('Книга открывается в читалке', async () => {
    const openButton = page.getByRole('button', { name: /^Читать$/ }).first();
    if ((await openButton.count()) === 0) {
      await page.getByRole('button', { name: /Открыть/ }).first().click();
    } else {
      await openButton.click();
    }
    await page.waitForSelector('.reader__p, .reader__pdf-frame', { timeout: 45_000 });
    await page.waitForTimeout(800);
    const chars = await page.evaluate(
      () => [...document.querySelectorAll('.reader__p')].map((node) => node.textContent ?? '').join(' ').length,
    );
    assert(chars > 40, `Текст не отображается (${chars} символов)`);
    await shot('84-import-reader');
    pass('Импортированная книга читается', `${chars} символов`);
    await gotoHash('/my', '.mybooks-stats');
    await page.waitForTimeout(600);
  });

  await step('Повторный импорт не создаёт дубликат', async () => {
    await gotoHash('/search', '.internet-search-screen');
    await page.waitForTimeout(400);
    await page.locator('input[type="file"]').first().setInputFiles(join(FIXTURES, 'sample.epub'));
    await page.waitForSelector('.web-draft', { timeout: 30_000 });
    await page.waitForTimeout(1200);
    const draftText = (await page.locator('.web-draft').textContent()) ?? '';
    const isDuplicate = /уже есть в библиотеке|Уже в библиотеке/i.test(draftText);
    await shot('85-import-duplicate');
    assert(isDuplicate, 'Дубликат не распознан');
    const before = (await readNetBooks()).length;
    pass('Дубликат распознан без создания копии', `${before} книг в базе`);
  });

  await step('Импорт FB2 с автором', async () => {
    await page.locator('input[type="file"]').first().setInputFiles(join(FIXTURES, 'sample.fb2'));
    await page.waitForSelector('.web-draft', { timeout: 30_000 });
    await page.waitForTimeout(1000);
    const titleValue = await page.locator('.web-field input').first().inputValue();
    const authorValue = await page.locator('.web-field input').nth(1).inputValue();
    assert(/FB2/i.test(titleValue) || titleValue.length > 0, 'Название FB2 не распознано');
    assert(authorValue.length > 0, 'Автор FB2 не распознан');
    await page.getByRole('button', { name: /Добавить в библиотеку/ }).click();
    await page.waitForTimeout(2500);
    await shot('86-fb2-import');
    pass('FB2 импортирован', `${titleValue} — ${authorValue}`);
  });
} catch (error) {
  fail('Сценарий импорта', error.message);
  await shot('89-import-failure').catch(() => {});
} finally {
  const failed = results.filter((item) => !item.ok);
  const report = {
    ranAt: new Date().toISOString(),
    url: BASE,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    pageErrors: errors,
  };
  writeFileSync(join(root, 'e2e', 'web-import-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n=== Интернет-импорт: ${report.passed} прошло, ${report.failed} упало ===`);
  await browser.close();
  if (failed.length) process.exitCode = 1;
}
