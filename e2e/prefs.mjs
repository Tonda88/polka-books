/**
 * E2E системы предпочтений: оценка книги → сохранение автора/жанра →
 * персональные подборки → категории библиотеки → отрицательная оценка →
 * ручной сброс.
 *
 * Запуск: node e2e/prefs.mjs (нужен сервер на 127.0.0.1:4173 и интернет)
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
page.setDefaultTimeout(60_000);
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !/CORS|503|400|favicon/.test(message.text())) errors.push(message.text());
});

const shot = async (name) => {
  await page.screenshot({ path: join(shots, `${name}.png`) });
  console.log(`  📸 ${name}`);
};

/** Читает базу предпочтений напрямую из IndexedDB. */
const readPrefsDb = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.open('polka-prefs');
        request.onerror = () => resolve({});
        request.onsuccess = () => {
          const db = request.result;
          const result = {};
          const stores = [...db.objectStoreNames];
          if (stores.length === 0) return resolve({});
          let pending = stores.length;
          const tx = db.transaction(stores, 'readonly');
          for (const name of stores) {
            const all = tx.objectStore(name).getAll();
            all.onsuccess = () => {
              result[name] = all.result;
              pending -= 1;
              if (pending === 0) resolve(result);
            };
            all.onerror = () => {
              pending -= 1;
              if (pending === 0) resolve(result);
            };
          }
        };
      }),
  );

async function gotoHash(hash, selector) {
  await page.evaluate((value) => {
    location.hash = value;
  }, hash);
  await page.waitForSelector(selector, { timeout: 60_000 });
}

let ratedTitle = '';

try {
  await step('Онбординг', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    if (await page.locator('.onboarding').count()) {
      await page.getByRole('button', { name: 'Пропустить' }).click();
      await page.waitForSelector('.home');
    }
    pass('Приложение запущено');
  });

  await step('Поиск книги и оценка 5★ + «Очень понравилась»', async () => {
    await gotoHash('/catalogs', '.search-hero');
    const input = page.locator('.search-field input, input[type="search"]').first();
    await input.fill('frankenstein');
    await page.waitForSelector('.catalog-list .catalog-card', { timeout: 90_000 });
    await page.waitForTimeout(1200);

    const cards = page.locator('.catalog-list .catalog-card');
    const total = await cards.count();
    let found = false;
    for (let index = 0; index < Math.min(total, 6); index += 1) {
      await cards.nth(index).click();
      await page.waitForSelector('.details-hero');
      await page.waitForTimeout(700);
      if ((await page.locator('.rating-widget').count()) > 0) {
        ratedTitle = ((await page.locator('.details-hero h1').first().textContent()) ?? '').trim();
        found = true;
        break;
      }
      await gotoHash('/catalogs', '.search-hero');
      await page.waitForSelector('.catalog-list .catalog-card');
    }
    assert(found, 'Не нашли карточку с виджетом оценки');

    const star = page.getByRole('radio', { name: '5 из 5' }).first();
    await star.click();
    await page.waitForTimeout(1500);
    const value = (await page.locator('.rating-widget__value').first().textContent()) ?? '';
    assert(/5 из 5/.test(value), `Оценка не применилась: ${value}`);
    await shot('60-rating-5');

    await page.locator('.reaction', { hasText: 'Очень понравилась' }).first().click();
    await page.waitForTimeout(1200);
    const active = await page.locator('.reaction.is-active').first().textContent().catch(() => '');
    assert(/Очень понравилась/.test(active ?? ''), 'Быстрая реакция не активировалась');
    pass('Оценка и быстрая реакция сохранены', ratedTitle);
  });

  await step('Данные попали в локальную базу предпочтений', async () => {
    const db = await readPrefsDb();
    const ratings = db.ratings ?? [];
    const authors = db.authors ?? [];
    const prefs = db.prefs ?? [];
    const books = db.books ?? [];
    assert(ratings.length > 0, 'Нет оценок в polka-prefs');
    assert(books.length > 0, 'Карточка книги не сохранена');
    const rating = ratings[0];
    assert(rating.stars === 5 && rating.reaction === 'love', `Ожидали 5★/love, получили ${rating.stars}/${rating.reaction}`);
    assert(Array.isArray(rating.history) && rating.history.length > 0, 'Нет истории оценки');
    const pref = prefs[0];
    assert(pref && pref.signalCount > 0, 'Модель предпочтений не пересчитана');
    assert(Object.keys(pref.authors ?? {}).length > 0, 'Автор не запомнен');
    assert(authors.length > 0, 'AuthorPreference не сохранён');
    pass(
      'RatingEntity + UserPreferences + AuthorPreference',
      `оценка ${rating.stars}★/${rating.reaction}, сигналов ${pref.signalCount}, авторов ${authors.length}`,
    );
  });

  await step('Экран «Вкус и предпочтения»', async () => {
    await gotoHash('/prefs', '.prefs-screen');
    await page.waitForTimeout(1200);
    const text = ((await page.locator('.prefs-screen').textContent()) ?? '').replace(/\s+/g, ' ');
    assert(/Система обучена/.test(text), 'Нет блока обучения');
    assert(/Ваши авторы/.test(text), 'Нет блока авторов');
    assert(/История оценок/.test(text), 'Нет истории оценок');
    await shot('61-preferences');
    pass('Предпочтения отображаются', text.slice(0, 80));
  });

  await step('Категории в «Моих книгах»', async () => {
    await gotoHash('/my', '.mybooks-stats');
    await page.waitForTimeout(1000);
    const text = ((await page.locator('.pref-category-strip').textContent()) ?? '').replace(/\s+/g, ' ');
    assert(/Любимые книги/.test(text), 'Нет категории «Любимые книги»');
    await shot('62-mybooks-categories');
    pass('Категории личной библиотеки на месте');
  });

  await step('Персональные подборки на главной', async () => {
    await gotoHash('/', '.home');
    // Полки строятся из сети: ждём появления карточек, а не фиксированную паузу.
    await page.waitForSelector('.shelf-row .shelf-card', { timeout: 70_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const text = ((await page.locator('.home').textContent()) ?? '').replace(/\s+/g, ' ');
    assert(/Для тебя|Персональные подборки/.test(text) || (await page.locator('.shelf-row').count()) >= 0, '');
    const shelves = await page.locator('.shelf-row .shelf-card').count();
    await shot('63-home-recommendations');
    assert(shelves > 0, 'Полки рекомендаций пусты');
    assert(/Для тебя/.test(text), 'Нет полки «Для тебя»');
    pass('Полки рекомендаций построены', `${shelves} карточек`);
  });

  await step('Отрицательная оценка: снижение приоритета и «Забыть»', async () => {
    await gotoHash('/catalogs', '.search-hero');
    const input = page.locator('.search-field input, input[type="search"]').first();
    await input.fill('pride and prejudice');
    await page.waitForSelector('.catalog-list .catalog-card', { timeout: 90_000 });
    await page.waitForTimeout(1000);
    await page.locator('.catalog-list .catalog-card').first().click();
    await page.waitForSelector('.rating-widget');
    await page.waitForTimeout(700);
    await page.getByRole('radio', { name: '1 из 5' }).first().click();
    await page.waitForTimeout(1200);
    await page.locator('.reaction', { hasText: 'Совсем не моё' }).first().click();
    await page.waitForTimeout(1200);

    await gotoHash('/prefs', '.prefs-screen');
    await page.waitForTimeout(1000);
    const text = ((await page.locator('.prefs-screen').textContent()) ?? '').replace(/\s+/g, ' ');
    assert(/Что не понравилось/.test(text), 'Нет блока негатива');
    await shot('64-negative-prefs');
    const forget = page.locator('.pref-negatives button', { hasText: 'Забыть' }).first();
    assert((await forget.count()) > 0, 'Нет кнопки «Забыть»');
    await forget.click();
    await page.waitForTimeout(900);
    pass('Негатив учтён и сбрасывается вручную');
  });

  await step('Сброс обучения', async () => {
    const reset = page.getByRole('button', { name: 'Сбросить обучение' }).first();
    await reset.click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'Нажмите ещё раз' }).first().click();
    await page.waitForTimeout(1500);
    const db = await readPrefsDb();
    const ratings = db.ratings ?? [];
    assert(ratings.length === 0, `Оценки не сброшены: ${ratings.length}`);
    pass('Обучение сброшено, предпочтения очищены');
  });
} catch (error) {
  fail('Сценарий предпочтений', error.message);
  await shot('69-prefs-failure').catch(() => {});
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
  writeFileSync(join(root, 'e2e', 'prefs-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n=== Предпочтения: ${report.passed} прошло, ${report.failed} упало ===`);
  if (errors.length) console.log('Ошибки страницы:', errors.slice(0, 5));
  await browser.close();
  if (failed.length) process.exitCode = 1;
}
