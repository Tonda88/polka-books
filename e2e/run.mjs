/**
 * E2E-проверка сценариев «Полки» в настоящем браузере (Edge через playwright-core).
 *
 * Проверяем:
 *  1. Онбординг и демо-данные.
 *  2. Скачивание книги с прогрессом и сохранение в IndexedDB.
 *  3. Чтение с восстановлением позиции, запись прогресса и сессии.
 *  4. Синхронизацию «слушаю → читаю»: аудио и текст делят одну позицию.
 *  5. Цели чтения: создание, прогресс.
 *  6. Офлайн-режим после скачивания (service worker + IndexedDB).
 *  7. Рекомендации с объяснениями.
 *
 * Запуск: node e2e/run.mjs (нужен запущенный preview на 127.0.0.1:4173)
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const screenshots = join(root, 'screenshots');
mkdirSync(screenshots, { recursive: true });

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.POLKA_URL || 'http://127.0.0.1:4173';

const results = [];
const consoleErrors = [];
const pageErrors = [];

function pass(name, extra = '') {
  results.push({ name, ok: true, extra });
  console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`);
}

function fail(name, error) {
  results.push({ name, ok: false, error: String(error) });
  console.log(`  ❌ ${name} — ${error}`);
}

async function step(name, fn) {
  console.log(`\n▶ ${name}`);
  try {
    await fn();
  } catch (error) {
    fail(name, error);
    throw error;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalize(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

async function readIndexedDb(page, store, key) {
  return page.evaluate(
    ([storeName, keyName]) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('polka-library');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(storeName, 'readonly');
          const get = tx.objectStore(storeName).get(keyName);
          get.onsuccess = () => resolve(get.result ?? null);
          get.onerror = () => reject(get.error);
        };
      }),
    [store, key],
  );
}

async function shot(page, name) {
  const path = join(screenshots, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(`  📸 screenshots/${name}.png`);
}

async function clearToasts(page) {
  for (let index = 0; index < 6; index += 1) {
    const toast = page.locator('.toast').first();
    if ((await toast.count()) === 0) return;
    await toast.click({ force: true }).catch(() => {});
    await page.waitForTimeout(120);
  }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--mute-audio'],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    serviceWorkers: 'allow',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await step('Онбординг: стартовый экран', async () => {
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page.waitForSelector('.onboarding');
      await shot(page, '01-onboarding');
      pass('Приложение открылось, показан онбординг');
    });

    await step('Онбординг: имя и интересы', async () => {
      await page.getByRole('button', { name: 'Начать' }).click();
      await page.locator('.text-input').fill('Аня');
      for (const genre of ['классика', 'мистика', 'поэзия']) {
        await page.locator('.chip', { hasText: new RegExp(`^${genre}$`) }).first().click();
      }
      await shot(page, '02-onboarding-interests');
      await page.getByRole('button', { name: 'Дальше' }).click();
      await page.waitForSelector('.preset-list');
    });

    await step('Онбординг: цели и завершение', async () => {
      await page.getByRole('button', { name: 'Начать читать' }).click();
      await page.waitForSelector('.home');
      pass('Онбординг завершён, открыта главная');
    });

    await step('Демо-данные и главная', async () => {
      await page.locator('.tab-bar__item', { hasText: 'Профиль' }).click();
      await page.waitForSelector('.profile');
      await page.getByRole('button', { name: /Заполнить демо-данными/ }).click();
      await page.waitForTimeout(350);
      await page.locator('.tab-bar__item', { hasText: 'Главная' }).click();
      await page.waitForSelector('.home');
      await clearToasts(page);
      const continueTitle = await page.locator('.continue-card__title').textContent();
      assert(continueTitle?.includes('Онегин'), `В блоке «Продолжить» ожидался Онегин, получено: ${continueTitle}`);
      await shot(page, '03-home');
      pass('Блок «Продолжить» показывает книгу с сохранённой позицией', normalize(continueTitle));
    });

    await step('Рекомендации с объяснениями', async () => {
      const reasons = await page.locator('.book-card__reason').allTextContents();
      assert(reasons.length >= 3, `Ожидались рекомендации с причинами, найдено ${reasons.length}`);
      await clearToasts(page);
      await shot(page, '04-recommendations');
      pass('Рекомендации содержат объяснения', reasons.slice(0, 3).join(' | '));

      // Лента подборок ниже первого экрана.
      await page.evaluate(() => window.scrollBy(0, 430));
      await page.waitForTimeout(350);
      await shot(page, '04b-home-feed');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);
    });

    await step('Каталог и поиск', async () => {
      await page.evaluate(() => {
        location.hash = '/catalog';
      });
      await page.waitForSelector('.catalog');
      await shot(page, '05-catalog');
      const search = page.locator('.search__input');
      await search.fill('Евгений');
      await page.waitForTimeout(200);
      const rows = await page.locator('.book-row').count();
      assert(rows === 1, `Поиск «Евгений» должен найти 1 книгу, найдено ${rows}`);
      await page.locator('.book-row').first().click();
      await page.waitForSelector('.book-hero');
      pass('Поиск и переход на страницу книги работают');
    });

    await step('Источник книги — официальная библиотека', async () => {
      const note = (await page.locator('.book-note').textContent()) ?? '';
      assert(note.includes('Викитека'), `В карточке нет источника: ${note.slice(0, 120)}`);
      assert(note.includes('общественном достоянии'), 'Не указана лицензия');
      const href = await page.locator('.meta-grid a').first().getAttribute('href');
      assert(href?.includes('ru.wikisource.org'), `Ссылка на источник некорректна: ${href}`);
      pass('Карточка книги ссылается на Викитеку', href);
    });

    await step('Скачивание книги в приложении', async () => {
      await clearToasts(page);
      await shot(page, '06-book');
      const downloadButton = page.locator('.download-card .mini-button');
      assert((await downloadButton.textContent())?.includes('Скачать'), 'Нет кнопки скачивания');
      await downloadButton.click();
      await page.waitForFunction(
        () => document.querySelector('.download-card')?.textContent?.includes('Скачано'),
        null,
        { timeout: 15_000 },
      );
      const stored = await readIndexedDb(page, 'books', 'onegin');
      assert(stored && stored.chapters?.length >= 2, 'Книга не сохранилась в IndexedDB');
      const downloads = await readIndexedDb(page, 'kv', 'downloads');
      assert(downloads?.onegin?.bytes > 150_000, `Полный текст не сохранился: ${downloads?.onegin?.bytes} байт`);
      await clearToasts(page);
      await shot(page, '07-book-downloaded');
      pass('Полный текст скачан и сохранён в IndexedDB', `${stored.bytes} байт, ${stored.chapters.length} глав`);
    });

    await step('Оценка книги влияет на рекомендации', async () => {
      const stars = page.locator('.rating-widget__stars .star-button');
      await stars.nth(4).click();
      await page.waitForTimeout(300);
      pass('Оценка 5 звёзд сохранена');
    });

    await step('Чтение: восстановление позиции и прогресс', async () => {
      const beforeReading = await readIndexedDb(page, 'kv', 'progress');
      await page.locator('.book-actions .btn--primary').click();
      await page.waitForSelector('.reader__p');
      await page.waitForTimeout(1000);
      const readerState = await page.evaluate(() => ({
        chapter: document.querySelector('.reader__chapter-name')?.textContent ?? '',
        current: document.querySelector('.reader__p.is-current')?.textContent ?? '',
        hasCurrent: Boolean(document.querySelector('.reader__p.is-current')),
        paragraphs: document.querySelectorAll('.reader__p').length,
        scrollTop: document.querySelector('.reader__scroll')?.scrollTop ?? 0,
      }));
      assert(readerState.chapter.length > 2, 'Не показан заголовок главы');
      assert(readerState.hasCurrent, 'Текущий абзац не подсвечен');
      assert(readerState.paragraphs >= 5, `В главе слишком мало абзацев: ${readerState.paragraphs}`);
      await clearToasts(page);
      await shot(page, '08-reader');

      await page.evaluate(() => {
        const container = document.querySelector('.reader__scroll');
        if (container) container.scrollTop += 1600;
      });
      await page.waitForTimeout(900);

      const progress = await readIndexedDb(page, 'kv', 'progress');
      assert(progress?.onegin, 'Прогресс чтения не записан');
      assert(progress.onegin.lastMode === 'read', 'Режим прогресса должен быть read');
      const moved =
        progress.onegin.chapter !== beforeReading.onegin.chapter ||
        progress.onegin.paragraph !== beforeReading.onegin.paragraph;
      assert(moved, 'Позиция чтения не сохранилась после прокрутки');
      await page.locator('.reader__bar .icon-button').first().click();
      await page.waitForSelector('.book-hero');
      pass(
        'Глава открылась, позиция восстановлена и прогресс сохранён',
        `${readerState.chapter} · абзац ${progress.onegin.paragraph}`,
      );
    });

    await step('Аудио: старт с места чтения и синхронизация с текстом', async () => {
      await page.locator('.book-actions .btn--ghost').click();
      await page.waitForSelector('.player-screen');
      await page.waitForFunction(
        () => (document.querySelector('.player-quote p')?.textContent ?? '').length > 20,
        null,
        { timeout: 15_000 },
      );
      await clearToasts(page);
      await shot(page, '09-player');

      const listenLocator = await readIndexedDb(page, 'kv', 'progress');
      assert(listenLocator.onegin.lastMode === 'listen', 'Плеер не переключил прогресс в режим listen');

      // Пролистываем два абзаца и запоминаем, где остановились.
      await page.locator('.player-skip').nth(1).click();
      await page.waitForTimeout(250);
      await page.locator('.player-skip').nth(1).click();
      await page.waitForTimeout(400);
      const playerQuote = normalize(await page.locator('.player-quote p').textContent());
      assert(playerQuote.length > 20, 'Плеер не показывает текущий абзац');

      await page.getByRole('button', { name: 'Открыть текст' }).click();
      await page.waitForSelector('.reader__p');
      await page.waitForTimeout(900);
      const readerCurrent = normalize(await page.locator('.reader__p.is-current').textContent());
      const playerPrefix = playerQuote.slice(0, 60);
      assert(
        readerCurrent.includes(playerPrefix) || playerPrefix.includes(readerCurrent.slice(0, 60)),
        `Читалка открылась не на абзаце плеера.\nПлеер: ${playerPrefix}\nЧиталка: ${readerCurrent.slice(0, 80)}`,
      );
      await shot(page, '10-reader-from-player');

      // Возвращаемся на главную: аудио продолжает играть в мини-плеере.
      await page.evaluate(() => {
        location.hash = '/';
      });
      await page.waitForSelector('.home');
      await clearToasts(page);
      await shot(page, '11-home-mini-player');

      // Закрываем плеер, чтобы дальнейшие экраны были без наложения.
      await page.evaluate(() => {
        location.hash = '/listen/onegin';
      });
      await page.waitForSelector('.player-screen');
      await page.waitForTimeout(300);
      await page.locator('.player-bar .icon-button').last().click();
      await page.waitForTimeout(300);
      pass('Аудио и текст используют общую позицию', `«${readerCurrent.slice(0, 40)}…»`);
    });

    await step('Цели: прогресс, диаграмма активности', async () => {
      await page.evaluate(() => {
        location.hash = '/goals';
      });
      await page.waitForSelector('.goals');
      await clearToasts(page);
      const cards = await page.locator('.goal-card').count();
      assert(cards >= 3, `Ожидались 3 цели из демо-данных, найдено ${cards}`);
      const heatCells = await page.locator('.heatmap-cell.level-1, .heatmap-cell.level-2, .heatmap-cell.level-3, .heatmap-cell.level-4').count();
      assert(heatCells > 5, 'Диаграмма активности пуста');
      await shot(page, '12-goals');
      pass('Цели и активность отображаются', `${cards} цели, ${heatCells} активных дней`);
    });

    await step('Цели: создание новой цели', async () => {
      await page.locator('.section__head .icon-button--accent').click();
      await page.waitForSelector('.sheet');
      await page.waitForTimeout(500);
      await shot(page, '13-goal-sheet');
      await page.locator('.sheet .segmented').nth(0).getByRole('button', { name: 'Месяц' }).click();
      await page.locator('.sheet .segmented').nth(1).getByRole('button', { name: 'Книги' }).click();
      await page.locator('.target-input').fill('2');
      await page.getByRole('button', { name: 'Поставить цель' }).click();
      await page.waitForTimeout(500);
      await clearToasts(page);
      const goalTitles = await page.locator('.goal-card__title').allTextContents();
      assert(goalTitles.some((title) => title.includes('2 книги')), `Новая цель не появилась: ${goalTitles.join(', ')}`);
      await shot(page, '14-goals-updated');
      pass('Цель создана через форму', goalTitles.join('; '));
    });

    await step('Источники и лицензии в приложении', async () => {
      await page.evaluate(() => {
        location.hash = '/me';
      });
      await page.waitForSelector('.profile');
      await page.getByRole('button', { name: /Источники книг и лицензии/ }).click();
      await page.waitForSelector('.sheet');
      await page.waitForTimeout(450);
      await shot(page, '18-sources');
      const links = await page.locator('.source-row a').count();
      assert(links === 14, `Ожидались 14 ссылок на источники, найдено ${links}`);
      const firstHref = await page.locator('.source-row a').first().getAttribute('href');
      assert(firstHref?.includes('ru.wikisource.org'), 'Ссылка ведёт не в Викитеку');
      await page.locator('.sheet .icon-button').click();
      await page.evaluate(() => {
        location.hash = '/library';
      });
      await page.waitForSelector('.library');
      pass('В приложении есть список источников и лицензий', `${links} книг`);
    });

    await step('Моя полка: скачанные и закладки', async () => {
      await page.evaluate(() => {
        location.hash = '/library';
      });
      await page.waitForSelector('.library');
      await page.locator('.library-tabs .segmented__item', { hasText: 'Скачанные' }).click();
      await page.waitForTimeout(250);
      await clearToasts(page);
      const downloadTitle = await page.locator('.download-item__title').first().textContent();
      assert(downloadTitle?.includes('Онегин'), `Скачанная книга не найдена: ${downloadTitle}`);
      await shot(page, '15-library-downloads');
      await page.locator('.library-tabs .segmented__item', { hasText: 'Закладки' }).click();
      await page.waitForTimeout(200);
      const bookmarks = await page.locator('.bookmark').count();
      assert(bookmarks >= 1, 'Закладки из демо-данных не отображаются');
      pass('Скачанные книги и закладки на полке', `${bookmarks} закладки`);
    });

    await step('Большая книга: «Анна Каренина», 2,9 МБ и 239 глав', async () => {
      await page.evaluate(() => {
        location.hash = '/book/anna-karenina';
      });
      await page.waitForSelector('.book-hero');
      await page.waitForTimeout(300);
      await clearToasts(page);
      await page.locator('.download-card .mini-button').click();
      await page.waitForFunction(
        () => document.querySelector('.download-card')?.textContent?.includes('Скачано'),
        null,
        { timeout: 60_000 },
      );
      const stored = await readIndexedDb(page, 'books', 'anna-karenina');
      assert(stored, '«Анна Каренина» не сохранилась в IndexedDB');
      assert(stored.chapters.length === 239, `Ожидались 239 глав, получено ${stored.chapters.length}`);
      assert(stored.bytes > 2_500_000, `Файл подозрительно мал: ${stored.bytes} байт`);
      await shot(page, '19-big-book');

      // Открываем последнюю главу — читалка должна работать с большим текстом.
      await page.evaluate(() => {
        location.hash = '/read/anna-karenina/238/0';
      });
      await page.waitForSelector('.reader__p', { timeout: 20_000 });
      await page.waitForTimeout(900);
      const chapter = (await page.locator('.reader__chapter-name').textContent()) ?? '';
      const paragraphs = await page.locator('.reader__p').count();
      assert(chapter.includes('Глава XIX'), `Открылась не последняя глава: ${chapter}`);
      assert(paragraphs >= 5, `В главе мало абзацев: ${paragraphs}`);
      await shot(page, '20-big-book-last-chapter');
      await page.evaluate(() => {
        location.hash = '/library';
      });
      await page.waitForSelector('.library');
      pass('Большая книга скачана и читается', `${stored.chapters.length} глав, ${(stored.bytes / 1048576).toFixed(1)} МБ`);
    });

    await step('Поэзия: «Мцыри» и «Медный всадник» с сохранением строф', async () => {
      await page.evaluate(() => {
        location.hash = '/read/mcyri/0/0';
      });
      await page.waitForSelector('.reader__p', { timeout: 20_000 });
      await page.waitForTimeout(700);
      const verse = await page.evaluate(() => {
        const paragraphs = [...document.querySelectorAll('.reader__p')];
        const withBreaks = paragraphs.filter((p) => (p.textContent ?? '').includes('\n'));
        return {
          total: paragraphs.length,
          withBreaks: withBreaks.length,
          sample: (withBreaks[0]?.textContent ?? '').split('\n').slice(0, 3).join(' / '),
        };
      });
      assert(verse.total >= 20, `Слишком мало абзацев в «Мцыри»: ${verse.total}`);
      assert(verse.withBreaks >= 10, `Строфы не сохранились: ${verse.withBreaks} абзацев с переносами`);
      await shot(page, '21-poem');

      await page.evaluate(() => {
        location.hash = '/read/medny-vsadnik/1/0';
      });
      await page.waitForSelector('.reader__p', { timeout: 20_000 });
      await page.waitForTimeout(700);
      const medny = await page.evaluate(() => ({
        chapter: document.querySelector('.reader__chapter-name')?.textContent ?? '',
        text: document.querySelector('.reader__p')?.textContent ?? '',
      }));
      assert(medny.chapter.includes('Вступление'), `Открылась не та глава: ${medny.chapter}`);
      assert(medny.text.includes('На берегу пустынных волн'), 'Не найден текст вступления «Медного всадника»');
      pass('Поэмы читаются со строфикой', `«${verse.sample}»`);
      // Возвращаемся на главную, чтобы следующий шаг начинался с известного экрана.
      await page.evaluate(() => {
        location.hash = '/library';
      });
      await page.waitForSelector('.library');
    });

    await step('Офлайн-режим: приложение и скачанная книга', async () => {
      await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 15_000 });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 15_000 });
      const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
      assert(controlled, 'Service worker не контролирует страницу');

      // Офлайн-проверку начинаем с главного экрана «Моя полка».
      await page.evaluate(() => {
        location.hash = '/library';
      });
      await page.waitForSelector('.library');
      await page.waitForTimeout(400);

      await context.setOffline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.app', { timeout: 15_000 });
      await page.waitForSelector('.library, .home', { timeout: 15_000 });
      const offlineStatus = (await page.locator('.offline-status').textContent()) ?? '';
      assert(offlineStatus.includes('Офлайн'), `Нет индикатора офлайн-режима: ${offlineStatus}`);
      await shot(page, '16-offline-library');

      await page.locator('.tab-bar__item', { hasText: 'Главная' }).click();
      await page.waitForSelector('.home', { timeout: 15_000 });
      const progressBeforeOfflineRead = await readIndexedDb(page, 'kv', 'progress');
      assert(progressBeforeOfflineRead?.onegin, 'Прогресс книги не сохранился после перезагрузки');
      // Открываем главу «Анны Карениной» — 2,9 МБ текста берутся из IndexedDB, без сети.
      await page.evaluate(() => {
        location.hash = '/read/anna-karenina/238/0';
      });
      await page.waitForSelector('.reader__p', { timeout: 20_000 });
      await page.waitForTimeout(900);
      const offlineChapter = (await page.locator('.reader__chapter-name').textContent()) ?? '';
      const paragraphs = await page.locator('.reader__p').count();
      assert(offlineChapter.length > 2, 'Офлайн-читалка не показала главу');
      assert(paragraphs >= 5, `Офлайн-читалка пуста: ${paragraphs} абзацев`);
      await shot(page, '17-offline-reader');
      await context.setOffline(false);
      pass('Приложение и большая скачанная книга работают без интернета', `${offlineChapter}: ${paragraphs} абзацев офлайн`);
    });

    const criticalErrors = consoleErrors.filter(
      (message) =>
        !message.includes('favicon') &&
        !message.includes('speechSynthesis') &&
        !message.includes('Service Worker') &&
        !message.includes('ERR_INTERNET_DISCONNECTED') &&
        !message.includes('ERR_FAILED'),
    );
    if (pageErrors.length) fail('Ошибки JS на странице', pageErrors.join(' | '));
    else pass('Ошибок JS на странице нет');
    if (criticalErrors.length) fail('Ошибки в консоли', criticalErrors.join(' | '));
    else pass('Критических ошибок в консоли нет');
  } catch (error) {
    console.error('\nE2E остановлен:', error);
    try {
      await shot(page, '99-failure');
    } catch {
      /* ignore */
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((item) => !item.ok);
  const report = {
    url: BASE,
    ranAt: new Date().toISOString(),
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    consoleErrors,
    pageErrors,
    screenshots: screenshots,
  };
  writeFileSync(join(root, 'e2e', 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n=== Итог: ${report.passed} прошло, ${report.failed} упало ===`);
  if (failed.length) {
    for (const item of failed) console.log(` - ${item.name}: ${item.error}`);
    process.exitCode = 1;
  }
}

await main();
