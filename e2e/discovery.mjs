/**
 * E2E универсального интернет-поиска:
 *  - поиск книги через серверный агрегатор поисковых API;
 *  - анализ найденных страниц, форматы и статусы доступности;
 *  - скачивание файла прямо в приложение с прогрессом;
 *  - книга появляется в библиотеке и читается;
 *  - у недоступных файлов нет фиктивной кнопки;
 *  - переход в каталоги (старый поиск) работает.
 *
 * Запуск: node e2e/discovery.mjs (нужен сервер на 127.0.0.1:4173)
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
page.setDefaultTimeout(90_000);
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !/403|404|CORS|ERR_/.test(message.text())) errors.push(message.text());
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

try {
  await step('Открытие интернет-поиска и проверка сервера', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    if (await page.locator('.onboarding').count()) {
      await page.getByRole('button', { name: 'Пропустить' }).click();
      await page.waitForSelector('.home');
    }
    await page.locator('.tab-bar__item', { hasText: 'Поиск' }).click();
    await page.waitForSelector('.internet-search-screen');
    await page.waitForTimeout(1500);
    const providersText = (await page.locator('.discovery-providers').textContent()) ?? '';
    assert(/Сервер доступен|провайдер/i.test(providersText), `Сервер поиска недоступен: ${providersText}`);
    await shot('90-internet-search');
    pass('Сервер интернет-поиска подключён', providersText.replace(/\s+/g, ' ').slice(0, 90));
  });

  await step('Поиск книги и анализ страниц', async () => {
    const input = page.locator('.search-field input').first();
    await input.fill('frankenstein');
    await page.getByRole('button', { name: /Найти книгу/ }).click();
    await page.waitForSelector('.discovery-card', { timeout: 120_000 });
    await page.waitForTimeout(1500);
    const cards = await page.locator('.discovery-card').count();
    const summary = (await page.locator('.discovery-summary').textContent()) ?? '';
    assert(cards > 0, 'Нет результатов поиска');
    const withFiles = await page.locator('.discovery-file').count();
    assert(withFiles > 0, 'Ни у одной книги не найдены файлы');
    await shot('91-internet-results');
    pass('Поиск вернул книги с файлами', `${cards} карточек, ${withFiles} файлов · ${summary.replace(/\s+/g, ' ').slice(0, 70)}`);
  });

  await step('Нет фиктивных кнопок для недоступных файлов', async () => {
    const offFiles = await page.locator('.discovery-file.is-off').count();
    const okFiles = await page.locator('.discovery-file.is-ok').count();
    if (offFiles > 0) {
      const offButtons = await page.locator('.discovery-file.is-off button').count();
      assert(offButtons === 0, 'У недоступного файла есть кнопка скачивания');
    }
    assert(okFiles > 0, 'Нет доступных файлов для проверки скачивания');
    pass('Статусы доступности честные', `доступно: ${okFiles}, недоступно: ${offFiles}`);
  });

  await step('Скачивание файла прямо в приложение', async () => {
    const downloadButton = page.locator('.discovery-file.is-ok button', { hasText: 'Скачать' }).first();
    assert((await downloadButton.count()) > 0, 'Нет кнопки «Скачать» у доступного файла');
    await downloadButton.click();
    await page.waitForTimeout(800);
    await shot('92-downloading');
    // Ждём, пока кнопка «Читать» появится у карточки (импорт завершён).
    await page.waitForFunction(
      () => [...document.querySelectorAll('.discovery-card__footer .link-button')].some((node) => node.textContent?.includes('Читать')),
      null,
      { timeout: 120_000 },
    );
    const netbooks = await readNetBooks();
    assert(netbooks.some((book) => String(book.id).startsWith('net:import:')), 'Книга не сохранилась в памяти приложения');
    await shot('93-downloaded');
    pass('Файл скачан, проверен и добавлен в библиотеку', `${netbooks.length} книг в базе`);
  });

  await step('Книга читается и видна в «Моих книгах»', async () => {
    await page.locator('.discovery-card__footer button', { hasText: 'Читать' }).first().click();
    await page.waitForSelector('.reader__p, .reader__pdf-frame', { timeout: 60_000 });
    await page.waitForTimeout(800);
    const chars = await page.evaluate(
      () => [...document.querySelectorAll('.reader__p')].map((node) => node.textContent ?? '').join(' ').length,
    );
    assert(chars > 40, `Текст не отображается (${chars} символов)`);
    await shot('94-reader');
    pass('Скачанная из интернета книга читается', `${chars} символов`);

    await page.evaluate(() => {
      location.hash = '/my';
    });
    await page.waitForSelector('.mybooks-stats');
    await page.waitForTimeout(1200);
    const listed = await page.locator('.mybooks-stats').evaluate((node) => node.parentElement?.textContent ?? '');
    const cards = await page.locator('.lib-card').count();
    assert(cards > 0 || /Интернет|import|Frankenstein/i.test(listed), `Книга не появилась в «Моих книгах» (карточек: ${cards})`);
    pass('Книга на полке «Мои книги»');
  });

  await step('Каталоги книг по-прежнему доступны', async () => {
    await page.evaluate(() => {
      location.hash = '/search';
    });
    await page.waitForSelector('.internet-search-screen');
    await page.getByRole('button', { name: /Каталоги/ }).click();
    await page.waitForSelector('.search-hero');
    const text = (await page.locator('.search-screen').textContent()) ?? '';
    assert(/Источники/i.test(text), 'Экран каталогов не открылся');
    await shot('95-catalogs');
    pass('Прежний поиск по каталогам сохранён');
  });
} catch (error) {
  fail('Сценарий интернет-поиска', error.message);
  await shot('99-discovery-failure').catch(() => {});
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
  writeFileSync(join(root, 'e2e', 'discovery-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n=== Интернет-поиск: ${report.passed} прошло, ${report.failed} упало ===`);
  if (errors.length) console.log('Ошибки страницы:', errors.slice(0, 5));
  await browser.close();
  if (failed.length) process.exitCode = 1;
}
